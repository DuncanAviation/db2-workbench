import { Nullable } from './nullable.js';
import { SqlImportValidator } from './sql-import-validator.js';

// Builds the statement actually sent to DB2 for a SQL schema import. The user's own statement is never
// edited in place - it becomes a derived table and everything the extension needs (the per-table
// filter for the lazily-loaded Columns/Relationships sections, the row cap) is added on the outside,
// so the user's SQL keeps meaning exactly what it did when they wrote it:
//
//   select * from (<user sql>) SRC
//   where (SRC."SCHEMA1" = 'ACME' and SRC."NAME1" = 'APPUSER')
//      or (SRC."SCHEMA1" = 'ACME' and SRC."NAME1" = 'APPUSJB')
//
// OR chains rather than a row-value IN list, for maximum portability across systems. Multiple tables
// needed at once are batched into one statement by the caller passing them all here.
//
// Regex/scan-based like the rest of this extension's SQL handling (see SqlParser) - it only has to
// find a trailing ORDER BY and a trailing semicolon, not understand the statement.

export const SQL_IMPORT_DERIVED_TABLE_ALIAS = 'SRC';

export interface SqlImportTableRef {
	schema: string;
	table: string;
}

export interface SqlImportStatementFilter {
	/** Result column names, as the result set reports them - quoted as delimited identifiers, so the
	 * user's own casing is preserved. */
	schemaColumn: string;
	tableColumn: string;
	tables: SqlImportTableRef[];
}

export interface SqlImportStatementOptions {
	filter?: SqlImportStatementFilter;
	/** Applied to this statement (this batch), not to the import as a whole. The caller asks for one
	 * more row than it will keep, so a truncated result is detectable rather than silently short. */
	rowLimit?: number;
}

export function buildSqlImportStatement(sql: string, options: SqlImportStatementOptions = {}): string {
	let filter = options.filter && options.filter.tables.length > 0 ? options.filter : undefined;

	if(!filter && options.rowLimit === undefined) {
		return stripTrailingSemicolon(sql);
	}

	// A common table expression can't be the body of a derived table - `select * from (with x as (...)
	// select ...) SRC` is a syntax error - so a leading WITH clause moves in front of the wrapper, where
	// the derived table can still reference its expressions. See splitLeadingWithClause.
	let {withClause, body: fullselect} = splitLeadingWithClause(stripTrailingSemicolon(sql));

	// A statement that starts with WITH and can't be split (an unrecognized CTE shape) can't be wrapped
	// at all. Adding the row cap on its own is still valid SQL and still caps the result; a filter has
	// nowhere to go, so that statement runs unfiltered and the caller filters the rows it gets back.
	if(withClause === undefined && startsWithCommonTableExpression(sql)) {
		let capped = stripTrailingSemicolon(sql);
		return options.rowLimit !== undefined && !hasFetchFirst(capped) ? `${capped}\nfetch first ${options.rowLimit} rows only` : capped;
	}

	// ORDER BY inside a derived table is restricted in DB2, so a trailing one is lifted onto the
	// wrapper instead. Safe because the wrapper selects *, so both ordinals and names still resolve.
	let {body, orderBy} = splitTrailingOrderBy(fullselect);
	let statement = `${withClause ? `${withClause}\n` : ''}select * from (${body}) ${SQL_IMPORT_DERIVED_TABLE_ALIAS}`;

	if(filter) {
		statement += `\nwhere ${buildFilter(filter)}`;
	}

	if(orderBy) {
		statement += `\n${orderBy}`;
	}

	if(options.rowLimit !== undefined) {
		statement += `\nfetch first ${options.rowLimit} rows only`;
	}

	return statement;
}

// A derived table rejects duplicate result column names outright, so every statement is checked for
// them at save time rather than failing at run time with a DB2 error nobody can act on. Names are
// compared case-insensitively: an unquoted result column comes back upper-cased anyway, so "id" and
// "ID" would collide.
export function findDuplicateResultColumn(columns: string[]): Nullable<string> {
	let seen = new Set<string>();

	for(let column of columns) {
		let key = column.toUpperCase();

		if(seen.has(key)) {
			return column;
		}

		seen.add(key);
	}

	return undefined;
}

function buildFilter(filter: SqlImportStatementFilter): string {
	let schemaColumn = qualifiedColumn(filter.schemaColumn);
	let tableColumn = qualifiedColumn(filter.tableColumn);

	return filter.tables
		.map(table => `(${schemaColumn} = ${literal(table.schema)} and ${tableColumn} = ${literal(table.table)})`)
		.join('\n   or ');
}

function qualifiedColumn(name: string): string {
	return `${SQL_IMPORT_DERIVED_TABLE_ALIAS}.${identifier(name)}`;
}

function identifier(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function literal(value: string): string {
	return `'${value.replace(/'/g, '\'\'')}'`;
}

function stripTrailingSemicolon(sql: string): string {
	return sql.replace(/\s*;\s*$/, '').trim();
}

function startsWithCommonTableExpression(sql: string): boolean {
	return /^\s*WITH\b/i.test(SqlImportValidator.mask(sql));
}

// A statement that already caps itself doesn't get a second cap bolted on (two FETCH FIRST clauses are
// a syntax error). Only checked on the unwrapped path - anywhere else the user's own clause ends up
// inside the derived table, where it's perfectly legal alongside the wrapper's.
function hasFetchFirst(sql: string): boolean {
	return /\b(FETCH\s+FIRST|OFFSET)\b/i.test(SqlImportValidator.mask(sql));
}

// Splits `with a as (...), b as (...) select ...` into its WITH clause and the fullselect that follows,
// so the clause can be hoisted in front of the wrapper. Walks the CTE list rather than regex-matching
// the whole thing: a CTE body contains its own parens, commas and (often) the word SELECT, so nothing
// short of matching brackets finds where the list actually ends.
//
// `withClause` is undefined both for a statement that doesn't start with WITH (an ordinary fullselect,
// wrapped as-is) and for one whose CTE list doesn't parse - the caller tells those apart and handles the
// second case separately rather than emitting SQL built on a bad guess.
function splitLeadingWithClause(sql: string): {withClause?: string; body: string} {
	let masked = SqlImportValidator.mask(sql);
	let start = masked.match(/^\s*WITH\s+/i);

	if(!start) {
		return {body: sql};
	}

	let index = start[0].length;

	// DB2 for i doesn't use the RECURSIVE keyword (recursion is implicit), but other dialects do and a
	// statement written elsewhere may still carry it.
	let recursive = masked.substring(index).match(/^RECURSIVE\s+/i);
	index += recursive ? recursive[0].length : 0;

	while(index < masked.length) {
		index = skipWhitespace(masked, index);
		index = skipIdentifier(masked, index);
		index = skipWhitespace(masked, index);

		// The optional column-name list: `with x (a, b) as (...)`.
		if(masked[index] === '(') {
			index = skipParenthesized(masked, index);
			index = skipWhitespace(masked, index);
		}

		let as = masked.substring(index).match(/^AS\s*/i);

		if(!as) {
			return {body: sql};
		}

		index = skipWhitespace(masked, index + as[0].length);

		if(masked[index] !== '(') {
			return {body: sql};
		}

		index = skipWhitespace(masked, skipParenthesized(masked, index));

		if(masked[index] !== ',') {
			return {withClause: sql.substring(0, index).trim(), body: sql.substring(index).trim()};
		}

		index++;
	}

	return {body: sql};
}

function skipWhitespace(text: string, index: number): number {
	while(index < text.length && /\s/.test(text[index])) {
		index++;
	}

	return index;
}

// A CTE name is either a delimited identifier (masked to `"   "`, so its content can't be mistaken for
// syntax) or a plain one.
function skipIdentifier(text: string, index: number): number {
	if(text[index] === '"') {
		let end = text.indexOf('"', index + 1);
		return end === -1 ? text.length : end + 1;
	}

	while(index < text.length && /[A-Za-z0-9_$@#]/.test(text[index])) {
		index++;
	}

	return index;
}

/** Returns the index just past the `)` that closes the `(` at `index`, or the end of the text. */
function skipParenthesized(text: string, index: number): number {
	let depth = 0;

	for(let position = index; position < text.length; position++) {
		if(text[position] === '(') {
			depth++;
		} else if(text[position] === ')') {
			depth--;

			if(depth === 0) {
				return position + 1;
			}
		}
	}

	return text.length;
}

// Finds the statement's own trailing ORDER BY - the last one at paren depth zero. A window function's
// or a subquery's ORDER BY is always inside parens, so depth alone tells them apart. Everything from
// that keyword to the end of the statement moves (an ORDER BY is only ever followed by FETCH
// FIRST/OFFSET, which belong on the wrapper too).
function splitTrailingOrderBy(sql: string): {body: string; orderBy?: string} {
	let masked = SqlImportValidator.mask(sql);
	let depth = 0;
	let start: number | undefined;

	for(let index = 0; index < masked.length; index++) {
		let character = masked[index];

		if(character === '(') {
			depth++;
		} else if(character === ')') {
			depth = Math.max(depth - 1, 0);
		} else if(depth === 0 && /order/i.test(masked.substring(index, index + 5)) && isWordStart(masked, index)) {
			let match = masked.substring(index).match(/^order\s+by\b/i);

			if(match) {
				start = index;
				index += match[0].length - 1;
			}
		}
	}

	if(start === undefined) {
		return {body: sql};
	}

	return {body: sql.substring(0, start).trim(), orderBy: sql.substring(start).trim()};
}

function isWordStart(text: string, index: number): boolean {
	return index === 0 || !/[A-Za-z0-9_]/.test(text[index - 1]);
}
