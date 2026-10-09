import type { Token } from 'antlr4ng';
import { DtSqlParser } from '../dt-sql-parser.js';

// dt-sql-parser comes from the same pre-bundled CJS file CteAssist uses (see src/dt-sql-parser.ts).
// Unlike CteAssist (which walks dt-sql-parser's entity/AST graph), this is the first consumer of its
// raw lexer/token stream (getAllTokens) -- no bundle changes are needed since getAllTokens is a public
// method inherited from BasicSQL, already present on the exported PostgreSQL class.

// Tokenizes SQL text using dt-sql-parser's PostgreSQL *lexer* only -- never its grammar/.parse()
// layer. There is no real DB2-for-i grammar in dt-sql-parser (see dt-sql-parser-shim.ts), so a
// formatter built on the grammar/AST layer would inherit the same fragility CteAssist already
// works around with Db2SyntaxShim/DanglingJoinRepair. Lexing is far more forgiving: a lexer only
// balks at genuinely unrecognized characters, never at grammar-level violations, which is what
// makes fault-tolerant formatting of imperfect DB2-for-i SQL possible at all.
//
// getAllTokens() happens to invoke the parser internally (dt-sql-parser fills the token stream
// and then always calls parser.program(), even though the token stream itself is already
// complete before that call) but ANTLR's default error strategy recovers from syntax errors
// rather than throwing, so this does not defeat fault tolerance in practice -- confirmed against
// dt-sql-parser's own source (basicSQL.js). The try/catch below is defense-in-depth for the
// genuinely exceptional case (e.g. a lexer bug) rather than the expected path for malformed SQL.
export class SqlTokenizer {
	private static readonly parser = new DtSqlParser.PostgreSQL();

	static tokenize(sql: string): SqlTokenizer.SqlToken[] {
		let rawTokens: Token[];

		try {
			rawTokens = SqlTokenizer.parser.getAllTokens(sql);
		} catch {
			return sql.length === 0 ? [] : [SqlTokenizer.toToken(sql, 0, sql.length - 1)];
		}

		let tokens = rawTokens
			.filter(token => token.text !== null && token.start >= 0 && token.stop >= token.start)
			.map(token => SqlTokenizer.toToken(<string>token.text, token.start, token.stop))
			.sort((a, b) => a.start - b.start);

		return SqlTokenizer.fillGaps(tokens, sql);
	}

	// Guarantees the returned token list losslessly covers every character of the input, even if
	// the underlying ANTLR lexer silently drops a character it can't recognize (e.g. DB2 object
	// names using "#"/"$", which aren't part of Postgres's identifier grammar) -- a real but
	// accepted gap between dt-sql-parser's dialects and DB2-for-i, see dt-sql-parser-db2-fidelity-
	// gap notes. Any span not covered by a real token becomes a synthetic UNKNOWN token holding
	// that exact substring, so the pretty-printer's default fallthrough rule can still print it
	// verbatim instead of the formatter silently corrupting/losing part of the user's SQL.
	private static fillGaps(tokens: SqlTokenizer.SqlToken[], sql: string): SqlTokenizer.SqlToken[] {
		if(sql.length === 0) {
			return [];
		}

		let filled: SqlTokenizer.SqlToken[] = [];
		let cursor = 0;

		for(let token of tokens) {
			if(token.start > cursor) {
				filled.push(SqlTokenizer.toToken(sql.substring(cursor, token.start), cursor, token.start - 1));
			}

			filled.push(token);
			cursor = Math.max(cursor, token.stop + 1);
		}

		if(cursor < sql.length) {
			filled.push(SqlTokenizer.toToken(sql.substring(cursor), cursor, sql.length - 1));
		}

		return filled;
	}

	private static toToken(text: string, start: number, stop: number): SqlTokenizer.SqlToken {
		return {text, start, stop, type: SqlTokenizer.classify(text)};
	}

	private static classify(text: string): SqlTokenizer.TokenType {
		if(/^\s+$/.test(text)) {
			return SqlTokenizer.TokenType.WHITESPACE;
		}

		if(text.startsWith('--')) {
			return SqlTokenizer.TokenType.LINE_COMMENT;
		}

		if(text.startsWith('/*')) {
			return SqlTokenizer.TokenType.BLOCK_COMMENT;
		}

		if(text.startsWith(`'`)) {
			return SqlTokenizer.TokenType.STRING;
		}

		if(text.startsWith('"')) {
			return SqlTokenizer.TokenType.QUOTED_IDENTIFIER;
		}

		if(text === '(' || text === ')' || text === ',' || text === ';' || text === '.') {
			return SqlTokenizer.TokenType.PUNCTUATION;
		}

		// Postgres's own lexer (empirically, via dt-sql-parser) already tokenizes a DB2-style named
		// parameter ("id = :custId") as one whole ":custId" token rather than ":" and "custId"
		// separately -- there's no colon-less grammar rule it could otherwise match against, so the
		// unrecognized-character run is consumed greedily. Matched by prefix here rather than an
		// exact ":" check for that reason; a bare "?" positional marker is unaffected by this and
		// still lexes as its own single-character token.
		if(text === '?' || text.startsWith(':')) {
			return SqlTokenizer.TokenType.PARAM_MARKER;
		}

		if(/^[0-9]/.test(text)) {
			return SqlTokenizer.TokenType.NUMBER;
		}

		// DB2-for-i identifiers routinely include "#"/"$"/"@" (e.g. "APP#HIST") on top of the usual
		// letters/digits/underscore -- allowed here even though Postgres's own identifier grammar
		// wouldn't lex them as part of a single WORD token itself, since classification runs on the
		// token's already-lexed text, not on re-lexing raw characters.
		if(/^[A-Za-z_][A-Za-z0-9_$#@]*$/.test(text)) {
			return SqlTokenizer.TokenType.WORD;
		}

		if(/^[+\-*/=<>!|~^%&:.]+$/.test(text)) {
			return SqlTokenizer.TokenType.OPERATOR;
		}

		return SqlTokenizer.TokenType.UNKNOWN;
	}
}

export namespace SqlTokenizer {
	export enum TokenType {
		WORD = 'WORD',
		QUOTED_IDENTIFIER = 'QUOTED_IDENTIFIER',
		STRING = 'STRING',
		NUMBER = 'NUMBER',
		LINE_COMMENT = 'LINE_COMMENT',
		BLOCK_COMMENT = 'BLOCK_COMMENT',
		PUNCTUATION = 'PUNCTUATION',
		PARAM_MARKER = 'PARAM_MARKER',
		OPERATOR = 'OPERATOR',
		WHITESPACE = 'WHITESPACE',
		UNKNOWN = 'UNKNOWN'
	}

	export interface SqlToken {
		readonly text: string;
		readonly type: TokenType;
		readonly start: number;
		readonly stop: number;
	}
}
