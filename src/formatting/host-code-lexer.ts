// Splits C-family host-language source (Java, C#, JavaScript/TypeScript) into tokens, so SQL pasted
// in from application code can be read in that language's terms before anything treats it as SQL.
// It knows each language's string forms - "..." and '...' with backslash escapes, JS `...${x}...`
// templates, C# @"..." verbatim and $"...{x}..." interpolated strings, Java """...""" text blocks -
// and its comments, and returns every string's decoded value. It never fails: anything it doesn't
// recognize is a one-character punctuation token, and an unterminated string runs to the end of its
// line (a template literal or text block, to the end of the text).
//
// The same text may turn out to be plain DB2 SQL, so the lexer is careful not to make SQL's own
// syntax look like host code: a "--" after whitespace, at the start, or after "(" or "," is a line
// comment (as in SQL) rather than two minus signs, which keeps an apostrophe in a SQL comment from
// opening a string that swallows the statements after it.
export class HostCodeLexer {
	private static readonly MULTI_CHAR_PUNCTUATION = ['>>>=', '===', '!==', '>>>', '<<=', '>>=', '**=', '...', '??=', '&&=', '||=',
		'+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '==', '!=', '<=', '>=', '=>', '&&', '||', '??', '?.', '++', '--', '->', '::', '<<', '>>', '**'];

	static lex(text: string): HostCodeLexer.Token[] {
		let tokens: HostCodeLexer.Token[] = [];
		let i = 0;

		while(i < text.length) {
			let start = i;
			let char = text[i];
			let next = text[i + 1];
			let token: Omit<HostCodeLexer.Token, 'text' | 'start' | 'end'> & {end: number};

			if(/\s/.test(char)) {
				while(i < text.length && /\s/.test(text[i])) {
					i++;
				}

				token = {type: 'whitespace', end: i};
			} else if(char === '/' && next === '/') {
				token = {type: 'lineComment', end: HostCodeLexer.endOfLine(text, i)};
			} else if(char === '-' && next === '-' && HostCodeLexer.startsSqlComment(text, i)) {
				token = {type: 'lineComment', end: HostCodeLexer.endOfLine(text, i)};
			} else if(char === '/' && next === '*') {
				let close = text.indexOf('*/', i + 2);
				token = {type: 'blockComment', end: close === -1 ? text.length : close + 2};
			} else if(text.startsWith('"""', i)) {
				token = HostCodeLexer.lexTextBlock(text, i);
			} else if(char === '"' || char === `'`) {
				token = HostCodeLexer.lexQuoted(text, i);
			} else if(char === '`') {
				token = HostCodeLexer.lexInterpolated(text, i + 1, '`', 'template');
			} else if(/^(?:\$@|@\$)"/.test(text.substring(i, i + 3))) {
				token = HostCodeLexer.lexInterpolated(text, i + 3, '"', 'verbatimInterpolated');
			} else if(char === '$' && next === '"') {
				token = HostCodeLexer.lexInterpolated(text, i + 2, '"', 'interpolated');
			} else if(char === '@' && next === '"') {
				token = HostCodeLexer.lexVerbatim(text, i);
			} else if(/[A-Za-z_$@#]/.test(char)) {
				i++;

				while(i < text.length && /[\w$@#]/.test(text[i])) {
					i++;
				}

				token = {type: 'word', end: i};
			} else if(/\d/.test(char) || (char === '.' && /\d/.test(next ?? ''))) {
				i++;

				while(i < text.length && /[\w.]/.test(text[i])) {
					i++;
				}

				token = {type: 'number', end: i};
			} else {
				let punctuation = HostCodeLexer.MULTI_CHAR_PUNCTUATION.find(candidate => text.startsWith(candidate, i)) ?? char;
				token = {type: 'punctuation', end: i + punctuation.length};
			}

			i = token.end;
			tokens.push({...token, text: text.substring(start, i), start});
		}

		return tokens;
	}

	static isTrivia(token: HostCodeLexer.Token | undefined): boolean {
		return token?.type === 'whitespace' || HostCodeLexer.isComment(token);
	}

	static isComment(token: HostCodeLexer.Token | undefined): boolean {
		return token?.type === 'lineComment' || token?.type === 'blockComment';
	}

	static isString(token: HostCodeLexer.Token | undefined): boolean {
		return token?.type === 'string' || token?.type === 'template';
	}

	private static endOfLine(text: string, from: number): number {
		let end = text.indexOf('\n', from);
		return end === -1 ? text.length : end;
	}

	private static startsSqlComment(text: string, i: number): boolean {
		let before = text[i - 1];
		return before == null || /[\s(,]/.test(before);
	}

	// "..." or '...', with backslash escapes; stops at the end of the line when it isn't closed.
	private static lexQuoted(text: string, start: number): HostCodeLexer.LexedString {
		let quote = text[start];
		let value = '';
		let i = start + 1;

		while(i < text.length && text[i] !== quote && text[i] !== '\n') {
			if(text[i] === '\\' && i + 1 < text.length) {
				let escape = HostCodeLexer.decodeEscape(text, i);
				value += escape.value;
				i = escape.end;
				continue;
			}

			value += text[i];
			i++;
		}

		return {type: 'string', value, end: text[i] === quote ? i + 1 : i};
	}

	// Java's """ text block: everything up to the closing """, escapes decoded.
	private static lexTextBlock(text: string, start: number): HostCodeLexer.LexedString {
		let value = '';
		let i = start + 3;

		while(i < text.length && !text.startsWith('"""', i)) {
			if(text[i] === '\\' && i + 1 < text.length) {
				let escape = HostCodeLexer.decodeEscape(text, i);
				value += escape.value;
				i = escape.end;
				continue;
			}

			value += text[i];
			i++;
		}

		return {type: 'string', value, end: Math.min(text.length, i + 3)};
	}

	// C#'s @"..." verbatim string: no escapes, a doubled "" is one quote, and it may span lines.
	private static lexVerbatim(text: string, start: number): HostCodeLexer.LexedString {
		let value = '';
		let i = start + 2;

		while(i < text.length) {
			if(text[i] === '"') {
				if(text[i + 1] === '"') {
					value += '"';
					i += 2;
					continue;
				}

				return {type: 'string', value, end: i + 1};
			}

			value += text[i];
			i++;
		}

		return {type: 'string', value, end: i};
	}

	// A JS template literal (`...${expr}...`) or a C# interpolated string ($"...{expr}...", or its
	// verbatim form $@"..."), starting just past the opening delimiter. Its parts alternate between
	// literal text and the source of each interpolated expression.
	private static lexInterpolated(text: string, from: number, close: string, form: 'template' | 'interpolated' | 'verbatimInterpolated'): HostCodeLexer.LexedString {
		let segments: HostCodeLexer.Segment[] = [];
		let literal = '';
		let i = from;
		let escapes = form !== 'verbatimInterpolated';

		let flushLiteral = () => {
			if(literal.length > 0) {
				segments.push({kind: 'literal', text: literal});
				literal = '';
			}
		};

		while(i < text.length) {
			let char = text[i];

			if(char === '\\' && escapes && i + 1 < text.length) {
				let escape = HostCodeLexer.decodeEscape(text, i);
				literal += escape.value;
				i = escape.end;
				continue;
			}

			if(char === close) {
				if(form === 'verbatimInterpolated' && text[i + 1] === '"') {
					literal += '"';
					i += 2;
					continue;
				}

				i++;
				break;
			}

			if(form === 'interpolated' && char === '\n') {
				break;
			}

			let opensExpression = form === 'template' ? char === '$' && text[i + 1] === '{' : char === '{';

			if(form !== 'template' && char === '{' && text[i + 1] === '{') {
				literal += '{';
				i += 2;
				continue;
			}

			if(form !== 'template' && char === '}' && text[i + 1] === '}') {
				literal += '}';
				i += 2;
				continue;
			}

			if(opensExpression) {
				flushLiteral();
				let exprStart = i + (form === 'template' ? 2 : 1);
				let exprEnd = HostCodeLexer.findClosingBrace(text, exprStart);
				let expression = text.substring(exprStart, exprEnd);

				// C#'s "{value,10:N2}" alignment and format belong to the value's display, not the value.
				if(form !== 'template') {
					expression = HostCodeLexer.stripFormat(expression);
				}

				segments.push({kind: 'expression', text: expression});
				i = Math.min(text.length, exprEnd + 1);
				continue;
			}

			literal += char;
			i++;
		}

		flushLiteral();
		let value = segments.map(segment => segment.kind === 'literal' ? segment.text : '').join('');
		return {type: 'template', value, segments, end: i};
	}

	// "count,5:N0" -> "count": the value ahead of the first top-level "," or ":".
	private static stripFormat(expression: string): string {
		let depth = 0;

		for(let i = 0; i < expression.length; i++) {
			let char = expression[i];

			if(char === '(' || char === '[') {
				depth++;
			} else if(char === ')' || char === ']') {
				depth--;
			} else if(depth === 0 && (char === ',' || char === ':')) {
				return expression.substring(0, i).trim();
			}
		}

		return expression;
	}

	// The "}" closing an interpolation that starts at "from", skipping nested braces and strings.
	private static findClosingBrace(text: string, from: number): number {
		let depth = 0;
		let i = from;

		while(i < text.length) {
			let char = text[i];

			if(char === '"' || char === `'` || char === '`') {
				let end = text.indexOf(char, i + 1);
				i = end === -1 ? text.length : end + 1;
				continue;
			}

			if(char === '{') {
				depth++;
			} else if(char === '}') {
				if(depth === 0) {
					return i;
				}

				depth--;
			}

			i++;
		}

		return text.length;
	}

	private static decodeEscape(text: string, i: number): {value: string; end: number} {
		let char = text[i + 1];

		if(char === 'u' && /^[0-9A-Fa-f]{4}$/.test(text.substring(i + 2, i + 6))) {
			return {value: String.fromCharCode(parseInt(text.substring(i + 2, i + 6), 16)), end: i + 6};
		}

		let simple: Record<string, string> = {n: '\n', t: '\t', r: '\r', b: '', f: '', v: '', 0: ''};
		return {value: simple[char] ?? char, end: i + 2};
	}
}

export namespace HostCodeLexer {
	export type TokenType = 'whitespace' | 'lineComment' | 'blockComment' | 'string' | 'template' | 'word' | 'number' | 'punctuation';

	export interface Segment {
		readonly kind: 'literal' | 'expression';
		readonly text: string;
	}

	export interface Token {
		readonly type: TokenType;
		// The token's source text, exactly as written.
		readonly text: string;
		readonly start: number;
		readonly end: number;
		// A string's decoded value: escapes applied, delimiters removed. A template's is its literal
		// text with every interpolation left out.
		readonly value?: string;
		// A template's literal text and interpolated expressions, in order.
		readonly segments?: Segment[];
	}

	export interface LexedString {
		readonly type: 'string' | 'template';
		readonly value: string;
		readonly segments?: Segment[];
		readonly end: number;
	}
}
