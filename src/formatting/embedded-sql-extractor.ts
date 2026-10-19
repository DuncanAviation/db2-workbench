// Detects SQL pasted in from host-language source (Java/C# "..." + var + "..." concatenation, or
// a JS template literal with ${...} interpolation) and extracts the clean SQL text, replacing each
// interpolated variable/expression with a DB2 named parameter (":variableName") derived from it.
// Runs on raw text, before tokenization -- SqlDocumentFormatter calls this on both the whole-
// document and the selection/range formatting path, since a scratch ".sql" file used only to
// reformat a pasted host-code snippet is a real workflow and Format Document must match Format
// Selection on the same text. hasSqlKeyword/hasConcatenationGlue keep this from tripping on
// ordinary DB2 SQL -- see hasConcatenationGlue's "+"-only glue requirement.
export class EmbeddedSqlExtractor {
	// Real SQL keywords must appear *inside* one of the quoted/template segments specifically --
	// this is what rejects ordinary string concatenation like "Hello " + name + "!" (no keyword in
	// either string) while still accepting "SELECT * FROM t WHERE id = " + id. GROUP BY/ORDER BY/
	// HAVING/JOIN/UNION close the one real gap SELECT/INSERT/UPDATE/DELETE/FROM/WHERE leave: code
	// that concatenates only a trailing clause onto an already-built base query variable (e.g.
	// baseQuery + " ORDER BY " + col), where none of those six ever appear in the same call. Kept as
	// full phrases ("GROUP\s+BY", not bare "GROUP") so they don't match ordinary English prose that
	// happens to get concatenated -- "LIMIT" was deliberately left out for exactly that reason (too
	// common a word on its own, unlike these).
	private static readonly SQL_KEYWORD_PATTERN = /\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|JOIN|UNION)\b/i;

	static extract(text: string): EmbeddedSqlExtractor.Result {
		let pieces = EmbeddedSqlExtractor.splitIntoPieces(text);
		let stringPieces = pieces.filter(piece => piece.kind !== 'code');

		if(stringPieces.length === 0
			|| !EmbeddedSqlExtractor.hasSqlKeyword(stringPieces)
			|| !EmbeddedSqlExtractor.hasConcatenationGlue(pieces)) {
			return {sql: text, replaced: false, parameters: []};
		}

		let firstIndex = pieces.findIndex(piece => piece.kind !== 'code');
		let lastIndex = -1;
		pieces.forEach((piece, index) => {
			if(piece.kind !== 'code') {
				lastIndex = index;
			}
		});

		// Leading/trailing "code" outside the first/last string or template literal is the host
		// language's own declaration syntax (e.g. "String sql = " ... ";"), not concatenation glue --
		// deliberately dropped rather than turned into a nonsense parameter, except a value the trailing
		// code still appends (see renderTrailingAppend).
		let relevant = pieces.slice(firstIndex, lastIndex + 1);
		let parameters: EmbeddedSqlExtractor.Parameter[] = [];
		let usedNames = new Set<string>();

		let paramFor = (expression: string): string => {
			let trimmed = expression.trim();

			if(trimmed.length === 0) {
				return '';
			}

			let existing = parameters.find(parameter => parameter.expression === trimmed);

			if(existing) {
				return `:${existing.name}`;
			}

			let name = EmbeddedSqlExtractor.deriveParamName(trimmed, usedNames);
			usedNames.add(name);
			parameters.push({expression: trimmed, name});
			return `:${name}`;
		};

		let sqlParts = relevant.map(piece => {
			if(piece.kind === 'string') {
				return piece.content ?? '';
			}

			if(piece.kind === 'template') {
				return (piece.segments ?? [])
					.map(segment => segment.kind === 'literal' ? segment.text : paramFor(segment.text))
					.join('');
			}

			return EmbeddedSqlExtractor.renderCodeGlue(piece.content ?? '', paramFor);
		});

		let trailing = pieces[lastIndex + 1];

		if(trailing?.kind === 'code') {
			sqlParts.push(EmbeddedSqlExtractor.renderTrailingAppend(trailing.content ?? '', paramFor));
		}

		// The trailing "\s+" collapse below normalizes the original source's incidental
		// indentation/line breaks into single spaces -- fine for ordinary tokens, but a "--" line
		// comment (renderCodeGlue's conversion of a host "//" comment) relies on an actual "\n" to
		// stop consuming input; collapse that newline away and the comment silently swallows every
		// clause after it. LINE_COMMENT_NEWLINE is a sentinel (not "\s") standing in for that
		// required newline so it survives the collapse, restored to a real "\n" immediately after.
		let sql = sqlParts.join('')
			.replace(/\s+/g, ' ')
			.replace(new RegExp(EmbeddedSqlExtractor.LINE_COMMENT_NEWLINE, 'g'), '\n')
			.trim();

		return {sql, replaced: true, parameters};
	}

	// True when the host code ahead of this text's first string piece appends to a query built by an
	// earlier statement ("sql += `...`", "sql = sql + ...", "sb.append(...)"), after any comments.
	// SqlDocumentFormatter splits a document on ";" before extracting, so it uses this to put back
	// together a query built over several host statements, which no single statement shows as glue.
	static continuesConcatenation(text: string): boolean {
		let pieces = EmbeddedSqlExtractor.splitIntoPieces(text);
		let firstIndex = pieces.findIndex(piece => piece.kind !== 'code');

		if(firstIndex === -1) {
			return false;
		}

		let leading = pieces.slice(0, firstIndex).map(piece => piece.content ?? '').join('')
			.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
		return EmbeddedSqlExtractor.normalizeGlue(leading).trim().startsWith('+');
	}

	private static readonly LINE_COMMENT_NEWLINE = String.fromCharCode(1);

	// Renders a concatenation-glue "code" piece (e.g. " + //note\ncustId + "), separating a
	// trailing host-language comment from the actual parameter expressions around it -- without
	// this, a "//note" would fall straight into splitTopLevelPlus/paramFor and come out as a
	// nonsense ":param" placeholder instead of being recognized as a comment at all. A "//" line
	// comment becomes a DB2 "--" comment (see LINE_COMMENT_NEWLINE above for why its terminating
	// newline is protected); a "/* ... */" block comment is already valid SQL and passed through
	// verbatim -- its own "*/" terminator means it needs no such protection.
	private static renderCodeGlue(code: string, paramFor: (expression: string) => string): string {
		let fragments: string[] = [];
		let i = 0;
		let exprStart = 0;

		let flushExpr = (end: number) => {
			if(end <= exprStart) {
				return;
			}

			let rendered = EmbeddedSqlExtractor.splitTopLevelPlus(EmbeddedSqlExtractor.normalizeGlue(code.substring(exprStart, end)))
				.map(paramFor)
				.filter(part => part.length > 0)
				.join(' ');

			if(rendered.length > 0) {
				fragments.push(rendered);
			}
		};

		while(i < code.length) {
			if(code[i] === '/' && code[i + 1] === '/') {
				flushExpr(i);
				let start = i + 2;
				let end = code.indexOf('\n', start);
				let commentText = (end === -1 ? code.substring(start) : code.substring(start, end)).trim();
				fragments.push(`--${commentText}${EmbeddedSqlExtractor.LINE_COMMENT_NEWLINE}`);
				i = end === -1 ? code.length : end;
				exprStart = i;
				continue;
			}

			if(code[i] === '/' && code[i + 1] === '*') {
				flushExpr(i);
				let end = code.indexOf('*/', i + 2);
				let commentEnd = end === -1 ? code.length : end + 2;
				fragments.push(code.substring(i, commentEnd));
				i = commentEnd;
				exprStart = i;
				continue;
			}

			i++;
		}

		flushExpr(code.length);
		return fragments.join(' ');
	}

	// Character-by-character scan splitting "text" into ordered string/template/code pieces.
	// Handles a lone "\"-escaped character inside a string/template just enough to not mistake it
	// for the closing delimiter -- full per-language unescaping is out of scope for v1, the escaped
	// text is carried through into the piece's content as-is.
	private static splitIntoPieces(text: string): EmbeddedSqlExtractor.Piece[] {
		let pieces: EmbeddedSqlExtractor.Piece[] = [];
		let i = 0;
		let codeStart = 0;

		let flushCode = (end: number) => {
			if(end > codeStart) {
				pieces.push({kind: 'code', content: text.substring(codeStart, end)});
			}
		};

		while(i < text.length) {
			let char = text[i];

			if(char === `'` || char === '"') {
				flushCode(i);
				let quote = char;
				let content = '';
				i++;

				while(i < text.length && text[i] !== quote) {
					if(text[i] === '\\' && i + 1 < text.length) {
						content += text.substring(i, i + 2);
						i += 2;
						continue;
					}

					content += text[i];
					i++;
				}

				i++;
				pieces.push({kind: 'string', content});
				codeStart = i;
				continue;
			}

			if(char === '`') {
				flushCode(i);
				i++;
				let segments: EmbeddedSqlExtractor.TemplateSegment[] = [];
				let literal = '';

				while(i < text.length && text[i] !== '`') {
					if(text[i] === '\\' && i + 1 < text.length) {
						literal += text.substring(i, i + 2);
						i += 2;
						continue;
					}

					if(text[i] === '$' && text[i + 1] === '{') {
						if(literal.length > 0) {
							segments.push({kind: 'literal', text: literal});
							literal = '';
						}

						i += 2;
						let depth = 1;
						let exprStart = i;

						while(i < text.length && depth > 0) {
							if(text[i] === '{') {
								depth++;
							} else if(text[i] === '}') {
								depth--;
							}

							if(depth > 0) {
								i++;
							}
						}

						segments.push({kind: 'expr', text: text.substring(exprStart, i)});
						i++;
						continue;
					}

					literal += text[i];
					i++;
				}

				if(literal.length > 0) {
					segments.push({kind: 'literal', text: literal});
				}

				i++;
				pieces.push({kind: 'template', segments});
				codeStart = i;
				continue;
			}

			i++;
		}

		flushCode(text.length);
		return pieces;
	}

	private static hasSqlKeyword(stringPieces: EmbeddedSqlExtractor.Piece[]): boolean {
		return stringPieces.some(piece => {
			if(piece.kind === 'string') {
				return EmbeddedSqlExtractor.SQL_KEYWORD_PATTERN.test(piece.content ?? '');
			}

			return (piece.segments ?? []).some(segment => segment.kind === 'literal' && EmbeddedSqlExtractor.SQL_KEYWORD_PATTERN.test(segment.text));
		});
	}

	// True when at least one "code" piece sits strictly between two string/template pieces (plain
	// concatenation, e.g. "..." + var + "...") or a template literal has at least one "${...}"
	// interpolation -- either counts as "SQL assembled via host-language concatenation" rather than
	// a single bare string literal that merely happens to contain SQL-shaped text. The plain-code
	// case additionally requires a literal "+" in that glue (Java/C#/JS's concatenation operator) --
	// DB2 itself concatenates with "||", never "+", so a real dynamic-SQL statement built with
	// "'...' || col || '...'" (a normal DB2-for-i pattern for EXECUTE IMMEDIATE) has SQL keywords
	// sitting inside its string pieces same as host-code would, but its glue never contains "+" and
	// so is correctly left alone -- this is what makes it safe for whole-document formatting to run
	// this check unconditionally rather than only on an explicit selection.
	private static hasConcatenationGlue(pieces: EmbeddedSqlExtractor.Piece[]): boolean {
		let hasInterpolation = pieces.some(piece => piece.kind === 'template' && (piece.segments ?? []).some(segment => segment.kind === 'expr'));

		if(hasInterpolation) {
			return true;
		}

		let firstIndex = pieces.findIndex(piece => piece.kind !== 'code');
		let lastIndex = -1;
		pieces.forEach((piece, index) => {
			if(piece.kind !== 'code') {
				lastIndex = index;
			}
		});

		if(firstIndex === -1 || lastIndex <= firstIndex) {
			return false;
		}

		return pieces.slice(firstIndex + 1, lastIndex).some(piece => piece.kind === 'code' && EmbeddedSqlExtractor.normalizeGlue(piece.content ?? '').includes('+'));
	}

	// An lvalue: "sql", "this.sql", "query.text".
	private static readonly LVALUE = String.raw`[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*`;
	// "sql +=" (JS/TS/Java/C#), and "sql = sql +" - both just append to the query being built.
	private static readonly COMPOUND_APPEND = new RegExp(String.raw`${EmbeddedSqlExtractor.LVALUE}\s*\+=`, 'g');
	private static readonly SELF_APPEND = new RegExp(String.raw`(${EmbeddedSqlExtractor.LVALUE})\s*(?<![=!<>])=(?!=)\s*\1\s*\+`, 'g');
	// A StringBuilder call, chained ").append(" or a new statement's "sb.append(" (C#'s "Append" too).
	private static readonly APPEND_CALL = new RegExp(String.raw`(?:${EmbeddedSqlExtractor.LVALUE}\s*)?\.\s*append\s*\(`, 'gi');

	// Rewrites the ways a host language appends to a query across statements into plain "+"
	// concatenation, so the glue between two string pieces of
	//   sql += `SELECT ... `;
	//   // a comment
	//   sql += `FROM ...`;
	// is only "+" and not ";", "sql" and "=" parameters. The glue is split into host statements on
	// ";"; a statement that appends nothing (no "+" once rewritten, e.g. "int x = 5") is dropped. An
	// append call's own parentheses are left unbalanced by the rewrite and trimmed in splitTopLevelPlus.
	private static normalizeGlue(code: string): string {
		return code.split(';')
			.map(statement => statement
				.replace(EmbeddedSqlExtractor.SELF_APPEND, ' + ')
				.replace(EmbeddedSqlExtractor.COMPOUND_APPEND, ' + ')
				.replace(EmbeddedSqlExtractor.APPEND_CALL, ' + '))
			.filter(statement => statement.includes('+'))
			.join(' + ');
	}

	// The code after the last string piece is mostly the statement's end (";", ");"), but it can
	// still append one last value - "... WHERE id = " + id; or .append(id); - which belongs in the
	// SQL. Only that statement's own text is read (up to its ";", or its line without one), and only
	// when it starts by appending, so whatever code follows the query is still dropped. It never
	// counts toward hasConcatenationGlue: one SQL string followed by "+ x" is also plain DB2 ('1' + 2).
	private static renderTrailingAppend(code: string, paramFor: (expression: string) => string): string {
		let parts = EmbeddedSqlExtractor.trailingAppendParts(code);
		return parts.length > 0 ? ' ' + parts.map(paramFor).join(' ') : '';
	}

	private static trailingAppendParts(code: string): string[] {
		let end = code.indexOf(';');
		let statement = code.substring(0, end === -1 ? code.search(/\n|$/) : end);
		let normalized = EmbeddedSqlExtractor.normalizeGlue(statement).replace(/^[\s)]*/, '');
		return normalized.startsWith('+') ? EmbeddedSqlExtractor.splitTopLevelPlus(normalized) : [];
	}

	// Drops the parentheses an append call leaves behind once normalizeGlue has rewritten it -
	// "sb.append(id)" becomes " + id)" - without touching a balanced "(a ? b : c)".
	private static trimUnbalancedParens(part: string): string {
		let trimmed = part.trim();
		let depth = (text: string) => [...text].reduce((total, char) => total + (char === '(' ? 1 : char === ')' ? -1 : 0), 0);

		while(trimmed.endsWith(')') && depth(trimmed) < 0) {
			trimmed = trimmed.slice(0, -1).trim();
		}

		while(trimmed.startsWith('(') && depth(trimmed) > 0) {
			trimmed = trimmed.slice(1).trim();
		}

		return trimmed;
	}

	// Splits a concatenation-glue "code" piece (e.g. " + a + b + ") on top-level "+" -- so
	// "... + a + b + ..." between two string literals produces two parameters, not one nonsense
	// blob -- respecting parens/brackets/braces so a method call's own "+" ("foo(a + b)") isn't
	// mistaken for a top-level concatenation operator.
	private static splitTopLevelPlus(code: string): string[] {
		let parts: string[] = [];
		let current = '';
		let depth = 0;

		for(let char of code) {
			if(char === '(' || char === '[' || char === '{') {
				depth++;
			} else if(char === ')' || char === ']' || char === '}') {
				depth = Math.max(0, depth - 1);
			}

			if(char === '+' && depth === 0) {
				parts.push(current);
				current = '';
				continue;
			}

			current += char;
		}

		parts.push(current);
		return parts.map(EmbeddedSqlExtractor.trimUnbalancedParens).filter(part => part.length > 0);
	}

	private static deriveParamName(expression: string, usedNames: Set<string>): string {
		let base = EmbeddedSqlExtractor.baseParamName(expression);

		if(!usedNames.has(base)) {
			return base;
		}

		let suffix = 2;

		while(usedNames.has(`${base}${suffix}`)) {
			suffix++;
		}

		return `${base}${suffix}`;
	}

	// Bare identifier -> itself; "a.b"/"getFoo()"/"isFoo()" -> the meaningful last segment (an
	// accessor prefix is stripped and the next letter lower-cased, e.g. "getCustomerId()" ->
	// "customerId"); anything else (a ternary, an array index, a compound expression) -> a generic
	// "param", disambiguated by deriveParamName's numeric suffixing if more than one occurs.
	private static baseParamName(expression: string): string {
		if(/^[A-Za-z_$][\w$]*$/.test(expression)) {
			return expression;
		}

		let methodCall = expression.match(/(?:^|\.)([A-Za-z_$][\w$]*)\(\s*\)$/);

		if(methodCall) {
			let accessor = methodCall[1].match(/^(?:get|is)([A-Z]\w*)$/);
			return accessor ? accessor[1].charAt(0).toLowerCase() + accessor[1].slice(1) : methodCall[1];
		}

		let propertyAccess = expression.match(/\.([A-Za-z_$][\w$]*)$/);

		if(propertyAccess) {
			return propertyAccess[1];
		}

		return 'param';
	}
}

export namespace EmbeddedSqlExtractor {
	export interface Parameter {
		readonly expression: string;
		readonly name: string;
	}

	export interface Result {
		readonly sql: string;
		readonly replaced: boolean;
		readonly parameters: Parameter[];
	}

	export interface TemplateSegment {
		readonly kind: 'literal' | 'expr';
		readonly text: string;
	}

	export interface Piece {
		readonly kind: 'string' | 'template' | 'code';
		readonly content?: string;
		readonly segments?: TemplateSegment[];
	}
}
