// Single source of truth for SQL keyword/phrase knowledge, shared by every consumer that needs to
// recognize DB2/ANSI SQL vocabulary: SqlParser's regex-based table/alias scanning, Db2SyntaxShim's
// DB2-only trailing-clause stripping (see dt-sql-parser-shim.ts), and the formatting engine's
// token-level clause recognition (see src/formatting/). Previously each of those kept its own
// keyword list -- this consolidates them so DB2-specific vocabulary (isolation clauses, trailing
// clauses) can't silently drift out of sync between features.
export class KeywordTable {
	static readonly TABLE_KEYWORDS = [
		'FROM', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN', 'CROSS JOIN', 'UPDATE', 'INTO'
	];

	static readonly COLUMN_KEYWORDS = [
		'SELECT', 'SET', 'WHERE', 'AND', 'OR', 'ON', 'GROUP BY', 'ORDER BY', 'HAVING'
	];

	static readonly CLAUSE_KEYWORDS = [
		...this.COLUMN_KEYWORDS, ...this.TABLE_KEYWORDS,
		'INSERT', 'DELETE', 'LIMIT', 'OFFSET', 'AS', 'IN', 'IS NULL', 'IS NOT NULL', 'VALUES'
	];

	// Single-word tokens pulled from CLAUSE_KEYWORDS (compound entries like "LEFT JOIN" split into
	// "LEFT"/"JOIN") so an alias candidate that's actually the next clause's keyword is rejected
	// instead of being swallowed as an alias.
	static readonly RESERVED_WORDS = Array.from(new Set(this.CLAUSE_KEYWORDS.flatMap(keyword => keyword.split(/\s+/))));

	// DB2-for-i isolation-level clause words -- "WITH <word>" at the end of a statement (e.g.
	// "SELECT ... WITH UR") is this isolation clause, not a CTE named <word>, provided it isn't
	// itself immediately followed by "AS" (which would make it a real CTE definition).
	static readonly DB2_ISOLATION_WORDS = new Set(['UR', 'RR', 'CS', 'RS', 'RESET']);

	// Additional multi-word phrases the formatter needs to recognize as a single clause-boundary
	// unit that SqlParser's own TABLE_KEYWORDS/COLUMN_KEYWORDS never needed (they only cared about
	// what precedes a table/column reference, not every DB2 trailing clause).
	static readonly DB2_TRAILING_PHRASES = [
		'OPTIMIZE FOR', 'FETCH FIRST', 'FOR UPDATE',
		...Array.from(this.DB2_ISOLATION_WORDS).map(word => `WITH ${word}`)
	];

	// Reserved words that carry logical/comparison meaning rather than naming a clause -- kept
	// separate from CLAUSE_KEYWORDS because a formatter's keyword-case normalization needs this
	// broader set (AND/OR/CASE/etc. are never clause starters but should still be recased),
	// whereas SqlParser's alias-rejection only needed clause-starting words.
	static readonly LOGICAL_KEYWORDS = [
		'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN', 'EXISTS', 'DISTINCT', 'ALL',
		'AS', 'ON', 'ASC', 'DESC', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
		'UNION', 'INTERSECT', 'EXCEPT', 'RECURSIVE', 'WITH', 'USING'
	];

	// Every phrase (clause + DB2 trailing + logical) that keyword-case normalization should treat
	// as "a keyword" -- broader than CLAUSE_STARTER_PHRASES below, since e.g. AND/OR/CASE/END are
	// never a new top-level clause but should still be recased.
	static readonly ALL_PHRASES = Array.from(new Set([
		...this.CLAUSE_KEYWORDS, ...this.DB2_TRAILING_PHRASES, ...this.LOGICAL_KEYWORDS
	]));

	// The phrases that begin a new top-level clause segment when formatting a statement (SELECT,
	// FROM, every JOIN variant, WHERE, GROUP BY, ORDER BY, HAVING, INSERT/INSERT INTO, DELETE/
	// DELETE FROM, UPDATE, SET, VALUES, INTO, UNION family). Deliberately excludes "WITH" -- CTE
	// start vs. a DB2 isolation clause ("... WITH UR") needs KeywordTable.isWithCte's lookahead,
	// which a flat phrase list can't express, so callers special-case WITH themselves.
	static readonly CLAUSE_STARTER_PHRASES = [
		'SELECT', ...this.TABLE_KEYWORDS, 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING',
		'INSERT INTO', 'INSERT', 'DELETE FROM', 'DELETE', 'SET', 'VALUES',
		'UNION ALL', 'UNION', 'INTERSECT', 'EXCEPT',
		'OPTIMIZE FOR', 'FETCH FIRST', 'FOR UPDATE', 'LIMIT', 'OFFSET'
	];

	// Longest-match-first phrase lookup over any token-like array (anything with a `.text` field --
	// works for the formatter's SqlToken[] without a formatting-specific wrapper). Returns the
	// number of tokens the longest matching phrase consumed starting at index i, or 0 if none of
	// "phrases" match there at all. Defaults to ALL_PHRASES (keyword-case normalization's use case);
	// pass CLAUSE_STARTER_PHRASES explicitly for clause-segmentation.
	static matchKeywordPhrase<T extends {text: string}>(tokens: T[], i: number, phrases: string[] = KeywordTable.ALL_PHRASES): number {
		let sorted = [...phrases].sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length);

		for(let phrase of sorted) {
			let words = phrase.split(/\s+/);

			if(i + words.length > tokens.length) {
				continue;
			}

			let matches = words.every((word, offset) => tokens[i + offset].text.toUpperCase() === word);

			if(matches) {
				return words.length;
			}
		}

		return 0;
	}

	// True when the "WITH" token at index i starts a real CTE definition rather than a DB2
	// isolation clause ("... WITH UR") -- the same negative-lookahead rule as
	// Db2SyntaxShim.ISOLATION_CLAUSE, applied at token level: a bare "WITH <isolation word>" not
	// followed by "AS" is the isolation clause; anything else (including "WITH <isolation word> AS",
	// a CTE that happens to be named e.g. "ur") is a CTE start.
	static isWithCte<T extends {text: string}>(tokens: T[], i: number): boolean {
		let next = tokens[i + 1];

		if(!next || !KeywordTable.DB2_ISOLATION_WORDS.has(next.text.toUpperCase())) {
			return true;
		}

		let afterNext = tokens[i + 2];
		return !!afterNext && afterNext.text.toUpperCase() === 'AS';
	}
}
