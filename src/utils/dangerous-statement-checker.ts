import { Nullable } from './nullable.js';
import { SqlParser } from './sql-parser.js';

// Regex-based, same spirit as SqlParser/SpParser -- just enough to catch the common "oops"
// statements (a DELETE/UPDATE with no WHERE, a DROP, a TRUNCATE) before they run, not a real
// static-analysis pass. Only ever called with plain SQL text (CALL statements never match any of
// these patterns, so callers don't need to special-case SpParser.isSp themselves).
export class DangerousStatementChecker {
	static check(sql: string): Nullable<DangerousStatementChecker.Result> {
		let trimmed = sql.trim();

		if(/^DELETE\b/i.test(trimmed) && !DangerousStatementChecker.hasTopLevelWhere(trimmed)) {
			return {reason: 'This DELETE has no WHERE clause and will remove every row from the table.'};
		}

		if(/^UPDATE\b/i.test(trimmed) && !DangerousStatementChecker.hasTopLevelWhere(trimmed)) {
			return {reason: 'This UPDATE has no WHERE clause and will modify every row in the table.'};
		}

		if(/^TRUNCATE\s+TABLE\b/i.test(trimmed)) {
			return {reason: 'TRUNCATE TABLE permanently removes every row from the table and cannot be undone.'};
		}

		let dropMatch = trimmed.match(/^DROP\s+(TABLE|VIEW|INDEX|PROCEDURE|FUNCTION|SCHEMA|ALIAS)\b/i);

		if(dropMatch) {
			return {reason: `This will permanently drop the ${dropMatch[1].toLowerCase()} and cannot be undone.`};
		}

		if(/^ALTER\s+TABLE\b/i.test(trimmed) && /\bDROP\s+COLUMN\b/i.test(trimmed)) {
			return {reason: 'This will permanently drop a column, and the data in it, from the table.'};
		}

		return undefined;
	}

	private static hasTopLevelWhere(sql: string): boolean {
		return SqlParser.findTopLevelKeywordRanges(sql, 'WHERE').length > 0;
	}
}

export namespace DangerousStatementChecker {
	export interface Result {
		reason: string;
	}
}
