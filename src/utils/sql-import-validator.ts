import { Nullable } from './nullable.js';

// Read-only guard for SQL schema import statements. Saved import SQL lives in VS Code settings and
// auto-runs on connect with the user's own credentials, so every statement is checked before it ever
// reaches a connection - at save time (so the dialog can explain the problem) and again at run time
// (defence against a hand-edited settings.json).
//
// This is a guard, not a guarantee: a user-defined function called from the select list can still
// write, and no textual check can detect that. Accepted limitation - the point is to stop a statement
// that plainly modifies data, not to sandbox DB2.
//
// Regex-based, same spirit as SqlParser/DangerousStatementChecker, but it masks string literals,
// delimited identifiers and comments first rather than using StatementParser.stripComments: that
// helper strips comments only, so a `--` or `;` inside a literal would confuse it, and a column named
// "DELETE" in double quotes would trip the keyword check. Masking preserves offsets, so a caller can
// still index back into the original text (see SqlImportStatement, which finds a trailing ORDER BY
// this way).
export class SqlImportValidator {
	// Everything that modifies data or objects. SET is included because DB2 for i accepts standalone
	// SET statements; word boundaries keep OFFSET/SETTING from matching.
	private static readonly FORBIDDEN_KEYWORDS = /\b(INSERT|UPDATE|DELETE|MERGE|CALL|DROP|ALTER|CREATE|GRANT|REVOKE|COMMENT|LABEL|SET)\b/i;

	// DB2 for i lets a data change statement hide inside a SELECT this way, so the statement would pass
	// the "starts with SELECT" check while still writing.
	private static readonly DATA_CHANGE_TABLE = /\bFROM\s+(FINAL|NEW|OLD)\s+TABLE\b/i;

	static check(sql: string): Nullable<SqlImportValidator.Violation> {
		let masked = SqlImportValidator.mask(sql);

		if(masked.trim().length === 0) {
			return {reason: 'The statement is empty.'};
		}

		if(!/^\s*(SELECT|WITH)\b/i.test(masked)) {
			return {reason: 'An import statement must start with SELECT or WITH.'};
		}

		// A trailing semicolon is fine; one anywhere else means a second statement is hiding behind the
		// SELECT.
		if(masked.replace(/;\s*$/, '').includes(';')) {
			return {reason: 'An import statement must be a single statement - remove the extra ";".'};
		}

		// Checked before the keyword scan: the inner statement would trip that too, but naming the real
		// problem (the data change table) explains it better than naming its UPDATE.
		if(SqlImportValidator.DATA_CHANGE_TABLE.test(masked)) {
			return {reason: 'An import statement cannot select FROM FINAL/NEW/OLD TABLE - that runs a data change statement.'};
		}

		let forbidden = masked.match(SqlImportValidator.FORBIDDEN_KEYWORDS);

		if(forbidden) {
			return {reason: `An import statement must be read-only - it cannot contain ${forbidden[1].toUpperCase()}.`};
		}

		return undefined;
	}

	// Replaces the contents of string literals, delimited identifiers and comments with spaces, keeping
	// the text the same length so offsets still line up with the original.
	static mask(sql: string): string {
		let masked = '';
		let index = 0;

		while(index < sql.length) {
			let character = sql[index];
			let next = sql[index + 1];

			if(character === '-' && next === '-') {
				let end = sql.indexOf('\n', index);
				end = end === -1 ? sql.length : end;
				masked += ' '.repeat(end - index);
				index = end;
			} else if(character === '/' && next === '*') {
				let end = sql.indexOf('*/', index + 2);
				end = end === -1 ? sql.length : end + 2;
				masked += ' '.repeat(end - index);
				index = end;
			} else if(character === '\'' || character === '"') {
				let end = SqlImportValidator.findQuoteEnd(sql, index, character);
				// The quotes themselves stay - a caller scanning for a keyword can then see that the
				// masked run was quoted rather than a run of real whitespace.
				masked += character + ' '.repeat(Math.max(end - index - 1, 0));
				index = end + 1;

				if(end < sql.length) {
					masked += character;
				}
			} else {
				masked += character;
				index++;
			}
		}

		return masked;
	}

	// SQL escapes a quote by doubling it ('O''Brien'), so a doubled quote continues the literal.
	private static findQuoteEnd(sql: string, start: number, quote: string): number {
		let index = start + 1;

		while(index < sql.length) {
			if(sql[index] === quote) {
				if(sql[index + 1] === quote) {
					index += 2;
					continue;
				}

				return index;
			}

			index++;
		}

		return sql.length;
	}
}

export namespace SqlImportValidator {
	export interface Violation {
		reason: string;
	}
}
