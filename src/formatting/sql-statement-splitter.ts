import { SqlTokenizer } from './sql-tokenizer.js';

// Splits an already-tokenized document into per-statement spans on top-level ";" -- built on the
// tokenized stream (one pass, tracking paren depth) rather than a second regex scan over the raw
// text, so a ";" inside a string, a quoted identifier, a line comment, or a block comment can
// never be mistaken for a statement boundary: those are already single opaque tokens by this
// point. Unlike SqlStatementText's own splitter (used by the execute-SQL commands), it also tracks
// paren depth.
//
// Each span keeps its trailing ";" token (if the statement had one) so SqlPrettyPrinter can
// preserve whatever spacing originally sat between the last real token and it, rather than a
// missing/present semicolon (or the gap before it) being decided here.
export class SqlStatementSplitter {
	static split(tokens: SqlTokenizer.SqlToken[]): SqlTokenizer.SqlToken[][] {
		let spans: SqlTokenizer.SqlToken[][] = [];
		let current: SqlTokenizer.SqlToken[] = [];
		let depth = 0;

		for(let token of tokens) {
			if(token.type === SqlTokenizer.TokenType.PUNCTUATION) {
				if(token.text === '(') {
					depth++;
				} else if(token.text === ')') {
					depth = Math.max(0, depth - 1);
				}
			}

			current.push(token);

			if(depth === 0 && token.type === SqlTokenizer.TokenType.PUNCTUATION && token.text === ';') {
				spans.push(current);
				current = [];
			}
		}

		if(current.length > 0) {
			spans.push(current);
		}

		// Drops a span that has no real content at all -- just whitespace and/or the lone ";" that
		// closed it (e.g. the empty statement between the two ";" in "SELECT 1;;SELECT 2;") --
		// while still keeping a comment-only span, which is real content worth preserving.
		return spans.filter(span => span.some(token => token.type !== SqlTokenizer.TokenType.WHITESPACE
			&& !(token.type === SqlTokenizer.TokenType.PUNCTUATION && token.text === ';')));
	}
}
