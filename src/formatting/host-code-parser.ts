import { HostCodeLexer } from './host-code-lexer.js';

type Token = HostCodeLexer.Token;

// Groups HostCodeLexer's tokens into a tree of host-language statements: a simple statement, a
// comment between statements, a { } block, a control statement (if/else, loops, switch, try) with
// its body, or a plain DB2 SQL statement sitting among the host code. It is just enough structure
// for EmbeddedSqlExtractor to tell which statements build a query, and under what condition - it is
// not a parser for any one language, and it never fails: a token it can't place goes into a simple
// statement.
//
// A simple statement ends at a top-level ";", before a "}" that closes its block, or at a line break
// when the statement looks complete there (JavaScript's semicolon-free style): the line doesn't end
// in an operator and the next one doesn't start with one.
export class HostCodeParser {
	private static readonly CONTROL_KEYWORDS = new Set(['if', 'while', 'for', 'foreach', 'switch', 'using', 'lock', 'catch', 'with', 'synchronized', 'fixed']);
	private static readonly BLOCK_KEYWORDS = new Set(['try', 'finally', 'do', 'else', 'unsafe', 'checked', 'unchecked']);
	// Words a plain SQL statement starts with. One counts only when the word after it is a name, "*"
	// or a number, so a host call or assignment ("update(row)", "values = [...]") isn't mistaken for it.
	private static readonly SQL_STATEMENT_KEYWORDS = new Set(['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CALL', 'VALUES',
		'CREATE', 'ALTER', 'DROP', 'DECLARE', 'GRANT', 'REVOKE', 'COMMENT', 'LABEL', 'COMMIT', 'ROLLBACK', 'TRUNCATE', 'RENAME', 'REFRESH', 'SET']);
	// A token a line can end with and still continue on the next line ("sql = " / "... +").
	private static readonly CONTINUES_AFTER = new Set(['+', '-', '*', '/', '%', '=', '+=', '-=', '==', '===', '!=', '!==', '<', '>', '<=', '>=',
		'&&', '||', '??', '?', ':', ',', '.', '?.', '(', '[', '=>', '&', '|', '^', '!']);
	// A token a line can start with that continues the line before it (".append(...)" / "+ `...`").
	private static readonly CONTINUES_BEFORE = new Set(['+', '-', '*', '/', '%', '==', '===', '!=', '!==', '<', '>', '<=', '>=', '&&', '||',
		'??', '?', ':', ',', '.', '?.', ')', ']', '=>', '&', '|', '^', '=', '+=']);

	private pos = 0;

	private constructor(private readonly tokens: Token[]) {}

	static parse(tokens: Token[]): HostCodeParser.Statement[] {
		return new HostCodeParser(tokens).parseList(false);
	}

	// Statements until the end of the text, or (inBlock) until the "}" closing the block, which is left
	// for the caller to consume.
	private parseList(inBlock: boolean): HostCodeParser.Statement[] {
		let statements: HostCodeParser.Statement[] = [];

		while(this.pos < this.tokens.length) {
			this.skipWhitespace();
			let token = this.tokens[this.pos];

			if(!token || (inBlock && this.isPunctuation(token, '}'))) {
				break;
			}

			let statement = this.parseOne();

			if(statement) {
				statements.push(statement);
			}
		}

		return statements;
	}

	private parseOne(): HostCodeParser.Statement | undefined {
		this.skipWhitespace();
		let token = this.tokens[this.pos];

		if(!token) {
			return undefined;
		}

		if(HostCodeLexer.isComment(token)) {
			this.pos++;
			return {kind: 'comment', token, start: token.start, end: token.end};
		}

		if(this.isPunctuation(token, ';')) {
			this.pos++;
			return undefined;
		}

		if(this.isPunctuation(token, '}')) {
			// A stray "}" with no block open (a paste that starts mid-function).
			this.pos++;
			return undefined;
		}

		if(this.isPunctuation(token, '{')) {
			return this.parseBlock();
		}

		if(token.type === 'word') {
			let word = token.text;

			if(HostCodeParser.CONTROL_KEYWORDS.has(word) && this.nextSignificant(this.pos + 1)?.text === '(') {
				return this.parseControl();
			}

			if(HostCodeParser.BLOCK_KEYWORDS.has(word)) {
				return this.parseKeywordBlock();
			}

			if(this.startsSqlStatement()) {
				return this.parseSql();
			}
		}

		return this.parseSimple();
	}

	private parseBlock(): HostCodeParser.Statement {
		let open = this.tokens[this.pos];
		this.pos++;
		let body = this.parseList(true);
		let close = this.tokens[this.pos];

		if(close) {
			this.pos++;
		}

		return {kind: 'block', body, start: open.start, end: close?.end ?? this.endOfLast()};
	}

	// "if (...) body [else body]", "while (...) body", "for (...) body", "switch (...) { ... }" and the like.
	private parseControl(): HostCodeParser.Statement {
		let keyword = this.tokens[this.pos];
		this.pos++;
		this.skipWhitespace();
		let headerStart = this.pos;
		this.skipBalanced();
		let header = this.tokens.slice(headerStart, this.pos).map(token => token.text).join('');
		let body = this.parseBody();
		let elseBody: HostCodeParser.Statement[] | undefined;

		if(keyword.text === 'if') {
			let elseIndex = this.nextSignificantIndex(this.pos);

			if(elseIndex !== -1 && this.tokens[elseIndex].text === 'else') {
				this.pos = elseIndex + 1;
				elseBody = this.parseBody();
			}
		}

		return {kind: 'control', keyword: keyword.text, header, body, elseBody, start: keyword.start, end: this.endOfLast()};
	}

	// "try { }", "finally { }", "do { } while (...)", and an "else" whose "if" was cut off by the paste.
	private parseKeywordBlock(): HostCodeParser.Statement {
		let keyword = this.tokens[this.pos];
		this.pos++;
		let body = this.parseBody();
		let header = '';

		if(keyword.text === 'do') {
			let whileIndex = this.nextSignificantIndex(this.pos);

			if(whileIndex !== -1 && this.tokens[whileIndex].text === 'while') {
				this.pos = whileIndex + 1;
				this.skipWhitespace();
				let headerStart = this.pos;
				this.skipBalanced();
				header = this.tokens.slice(headerStart, this.pos).map(token => token.text).join('');
			}
		}

		return {kind: 'control', keyword: keyword.text, header, body, start: keyword.start, end: this.endOfLast()};
	}

	// A control statement's body: a block's statements, or the one statement that follows it.
	private parseBody(): HostCodeParser.Statement[] {
		this.skipWhitespace();
		let token = this.tokens[this.pos];

		if(token && this.isPunctuation(token, '{')) {
			let block = this.parseBlock();
			return block.kind === 'block' ? block.body : [];
		}

		let statement = this.parseOne();
		return statement ? [statement] : [];
	}

	private parseSql(): HostCodeParser.Statement {
		let start = this.tokens[this.pos].start;
		let depth = 0;

		while(this.pos < this.tokens.length) {
			let token = this.tokens[this.pos];
			this.pos++;

			if(token.type === 'punctuation') {
				if(token.text === '(') {
					depth++;
				} else if(token.text === ')') {
					depth = Math.max(0, depth - 1);
				} else if(token.text === ';' && depth === 0) {
					break;
				}
			}
		}

		return {kind: 'sql', start, end: this.endOfLast()};
	}

	private parseSimple(): HostCodeParser.Statement {
		let first = this.pos;
		let depth = 0;

		while(this.pos < this.tokens.length) {
			let token = this.tokens[this.pos];

			if(token.type === 'punctuation') {
				if(token.text === '(' || token.text === '[' || token.text === '{') {
					depth++;
				} else if(token.text === ')' || token.text === ']' || token.text === '}') {
					if(depth === 0 && token.text === '}') {
						break;
					}

					depth = Math.max(0, depth - 1);
				} else if(token.text === ';' && depth === 0) {
					this.pos++;
					break;
				}
			} else if(token.type === 'whitespace' && depth === 0 && token.text.includes('\n') && this.endsAtLineBreak(first)) {
				break;
			}

			this.pos++;
		}

		if(this.pos === first) {
			this.pos++;
		}

		let tokens = this.tokens.slice(first, this.pos).filter(token => !this.isPunctuation(token, ';'));
		return {kind: 'simple', tokens, start: this.tokens[first].start, end: this.endOfLast()};
	}

	// At a line break inside a simple statement (this.pos is the line break): whether the statement
	// ends here rather than going on to the next line.
	private endsAtLineBreak(first: number): boolean {
		let previous: Token | undefined;

		for(let i = this.pos - 1; i >= first; i--) {
			if(!HostCodeLexer.isTrivia(this.tokens[i])) {
				previous = this.tokens[i];
				break;
			}
		}

		let next = this.nextSignificant(this.pos);

		if(!previous || !next) {
			return !!previous;
		}

		if(previous.type === 'punctuation' && HostCodeParser.CONTINUES_AFTER.has(previous.text)) {
			return false;
		}

		return !(next.type === 'punctuation' && HostCodeParser.CONTINUES_BEFORE.has(next.text));
	}

	private startsSqlStatement(): boolean {
		let keyword = this.tokens[this.pos].text.toUpperCase();

		if(!HostCodeParser.SQL_STATEMENT_KEYWORDS.has(keyword)) {
			return false;
		}

		let secondIndex = this.nextSignificantIndex(this.pos + 1);
		let second = this.tokens[secondIndex];

		if(!second || !(second.type === 'word' || second.type === 'number' || second.text === '*')) {
			return false;
		}

		// "Update update = ..." is a host declaration, not "UPDATE update SET ...".
		let third = secondIndex === -1 ? undefined : this.nextSignificant(secondIndex + 1);
		return !(third?.type === 'punctuation' && ['=', '+='].includes(third.text) && keyword !== 'SET');
	}

	// Skips a balanced (...) group starting at this.pos, if there is one.
	private skipBalanced(): void {
		if(!this.isPunctuation(this.tokens[this.pos], '(')) {
			return;
		}

		let depth = 0;

		while(this.pos < this.tokens.length) {
			let token = this.tokens[this.pos];
			this.pos++;

			if(this.isPunctuation(token, '(')) {
				depth++;
			} else if(this.isPunctuation(token, ')')) {
				depth--;

				if(depth === 0) {
					return;
				}
			}
		}
	}

	private skipWhitespace(): void {
		while(this.tokens[this.pos]?.type === 'whitespace') {
			this.pos++;
		}
	}

	private nextSignificantIndex(from: number): number {
		for(let i = from; i < this.tokens.length; i++) {
			if(!HostCodeLexer.isTrivia(this.tokens[i])) {
				return i;
			}
		}

		return -1;
	}

	private nextSignificant(from: number): Token | undefined {
		let index = this.nextSignificantIndex(from);
		return index === -1 ? undefined : this.tokens[index];
	}

	private endOfLast(): number {
		for(let i = this.pos - 1; i >= 0; i--) {
			if(this.tokens[i].type !== 'whitespace') {
				return this.tokens[i].end;
			}
		}

		return 0;
	}

	private isPunctuation(token: Token | undefined, text: string): boolean {
		return token?.type === 'punctuation' && token.text === text;
	}
}

export namespace HostCodeParser {
	interface Located {
		// Source offsets of the statement's first character and one past its last.
		readonly start: number;
		readonly end: number;
	}

	export interface Simple extends Located {
		readonly kind: 'simple';
		// The statement's tokens, comments and whitespace included, without its ";".
		readonly tokens: HostCodeLexer.Token[];
	}

	export interface Comment extends Located {
		readonly kind: 'comment';
		readonly token: HostCodeLexer.Token;
	}

	export interface Block extends Located {
		readonly kind: 'block';
		readonly body: Statement[];
	}

	export interface Control extends Located {
		readonly kind: 'control';
		// "if", "for", "while", "switch", "do", "try", ...
		readonly keyword: string;
		// The parenthesized condition or loop header as written, "(...)" included; empty for "try"/"else".
		readonly header: string;
		readonly body: Statement[];
		// An "if"'s else branch: an "else if" is a one-statement branch holding the next Control.
		readonly elseBody?: Statement[];
	}

	// A plain DB2 SQL statement among the host code, "start"/"end" covering its text and its ";".
	export interface Sql extends Located {
		readonly kind: 'sql';
	}

	export type Statement = Simple | Comment | Block | Control | Sql;
}
