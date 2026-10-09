import { KeywordTable } from './keyword-table.js';
import { SqlParser } from './sql-parser.js';

// Preprocessing pass required before handing SQL to a non-DB2 AST parser (currently
// dt-sql-parser's PostgreSQL grammar, used by CteAssist for CTE/subquery scope resolution --
// see tmp/dt-sql-parser-spike). These DB2-for-i-only trailing clauses have no equivalent there,
// and "WITH UR" is actively dangerous rather than merely unrecognized: "WITH" is that grammar's
// CTE keyword, so it misparses "WITH UR" as the start of a CTE named UR and corrupts the whole
// statement rather than just failing on its own tail.
export class Db2SyntaxShim {
	// The negative lookahead keeps this from also matching a CTE that happens to be *named* one of
	// these words (e.g. "WITH ur AS (...)") -- a real isolation clause is never followed by "AS",
	// only a CTE definition is. The word list itself comes from KeywordTable.DB2_ISOLATION_WORDS,
	// shared with the SQL formatter's token-level equivalent (KeywordTable.isWithCte), so the two
	// features' notion of "which words are DB2 isolation clauses" can't drift apart.
	private static readonly ISOLATION_CLAUSE = new RegExp(`\\bWITH\\s+(?:${Array.from(KeywordTable.DB2_ISOLATION_WORDS).join('|')})\\b(?!\\s+AS\\b)`, 'gi');
	private static readonly OPTIMIZE_FOR_CLAUSE = /\bOPTIMIZE\s+FOR\s+\d+\s+ROWS?\b/gi;

	static strip(sql: string): string {
		if(!sql) {
			return sql ?? '';
		}

		return sql
			.replace(Db2SyntaxShim.ISOLATION_CLAUSE, '')
			.replace(Db2SyntaxShim.OPTIMIZE_FOR_CLAUSE, '');
	}
}

// Patches a dangling JOIN clause -- one with no ON/USING yet because the user simply hasn't typed
// it yet, not malformed SQL -- with a trivial "ON 1=1" so dt-sql-parser (which requires ON/USING on
// a non-CROSS/NATURAL join, same as real SQL) can still parse the rest of the statement. Without
// this, an incomplete JOIN anywhere in the statement fails the WHOLE parse, including CTEs declared
// earlier that have nothing to do with the dangling join -- exactly the situation content-assist
// runs into constantly, since the user is typically still editing SOME clause while wanting
// suggestions for a DIFFERENT one (e.g. filling in the SELECT list above a JOIN they haven't
// finished yet).
export class DanglingJoinRepair {
	// The optional alias captured below must reject a reserved word (same list/reasoning as
	// SqlParser.parseTables' own tableRefPattern) -- otherwise "JOIN appvlog on" (the user has typed
	// the ON keyword but nothing else yet) reads as "JOIN appvlog AS on" with a still-dangling ON
	// clause, and this repair appends a second, conflicting "ON 1=1" right after the real "on",
	// producing invalid SQL that breaks dt-sql-parser's error recovery far worse than the original
	// incomplete statement did.
	private static readonly RESERVED_WORD_PATTERN = SqlParser.RESERVED_WORDS.join('|');

	// Deliberately excludes CROSS JOIN and NATURAL JOIN via the lookbehind -- neither ever takes an
	// ON/USING clause, so appending one would trade a "missing ON" error for a "unexpected ON"
	// error. The lookahead confirms what follows is either the end of the (truncated) text, a
	// closing paren (end of a subquery/CTE body), another join, or a clause keyword that would
	// legitimately end the FROM/JOIN list -- i.e. nothing that could still be an ON/USING clause
	// arriving later in the same match attempt.
	private static readonly DANGLING_JOIN = new RegExp(
		`(?<!\\b(?:CROSS|NATURAL)\\s+)\\b((?:(?:LEFT|RIGHT|FULL)\\s+(?:OUTER\\s+)?|INNER\\s+)?JOIN\\s+(?:\\w+\\s*\\.\\s*)?\\w+(?:\\s+(?:AS\\s+)?(?!(?:${DanglingJoinRepair.RESERVED_WORD_PATTERN})\\b)\\w+)?)(?!\\s*(?:ON|USING)\\b)(?=\\s*(?:$|\\)|,|\\b(?:(?:LEFT|RIGHT|INNER|FULL|CROSS|NATURAL)\\s+)?(?:OUTER\\s+)?JOIN\\b|\\bWHERE\\b|\\bGROUP\\s+BY\\b|\\bORDER\\s+BY\\b|\\bHAVING\\b|\\bUNION\\b|\\bINTERSECT\\b|\\bEXCEPT\\b))`,
		'gi'
	);

	// Same idea as DANGLING_JOIN, but for a JOIN whose "ON" the user already typed, with no
	// condition after it yet -- e.g. content-assist firing right after "JOIN appvlog ON |". Without
	// this, dt-sql-parser doesn't just fail to parse the ON clause itself, it derails the whole
	// statement's error recovery (observed empirically: it starts treating the FROM clause as its
	// own complete statement and "JOIN" as extraneous input on a new one), which corrupts every
	// table entity's belongStmt and makes earlier tables (e.g. the FROM table) look inaccessible at
	// the cursor. The lookahead is the same "what legitimately ends this clause" set used above.
	private static readonly DANGLING_ON =
		/\bON\b(?=\s*(?:$|\)|,|\b(?:(?:LEFT|RIGHT|INNER|FULL|CROSS|NATURAL)\s+)?(?:OUTER\s+)?JOIN\b|\bWHERE\b|\bGROUP\s+BY\b|\bORDER\s+BY\b|\bHAVING\b|\bUNION\b|\bINTERSECT\b|\bEXCEPT\b))/gi;

	// Inserts text, so a caret position computed against the pre-repair string technically no
	// longer lines up character-for-character against the repaired one whenever a dangling join
	// sits before the caret. Verified empirically (including multiple compounding repairs, and the
	// caret landing immediately after a dangling join) that this doesn't affect accessibility
	// resolution in practice -- scope containment is structural (which statement/clause the caret
	// falls within), not sensitive to a handful of shifted characters within the same clause. If
	// that ever stops holding, offset-tracking would need to move to CteAssist's caller instead.
	static repair(sql: string): string {
		if(!sql) {
			return sql ?? '';
		}

		return sql
			.replace(DanglingJoinRepair.DANGLING_JOIN, '$1 ON 1=1')
			.replace(DanglingJoinRepair.DANGLING_ON, '$& 1=1');
	}
}
