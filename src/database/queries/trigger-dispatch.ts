// Finding the program a dispatching trigger program hands its work to - kept free of vscode and the
// connection so each step can be unit tested on its own (see trigger-dispatch.spec.ts).
// TriggerDispatchQueries runs the statements and strings these steps together.
//
// Some sites attach one generic program to every trigger (Trigger Mediator is a common one) and keep a
// table that says which program really handles each file. The system has no record of that link: the
// handler is activated dynamically, so nothing binds the two. What the system does record is the static
// SQL the dispatcher was compiled with, which names the tables it reads. One of those tables holds a row
// naming the trigger's table alongside a real program, and often one of that program's exports too. No
// product, table or column name is assumed anywhere here - every step works from what the catalog says.

import { StringUtils } from '../../utils/string-utils.js';
import { SqlParser } from '../../utils/sql-parser.js';
import { isSystemName } from './program-source.js';

/** How many tables the dispatcher reads are looked into - a dispatcher reads very few. */
export const MAX_CANDIDATE_TABLES = 10;

/** How many rows naming the trigger's table are read from one candidate - a routing table has one or two. */
export const MAX_ROUTING_ROWS = 20;

/** A table a statement names, as written - `schema` absent when unqualified. */
export interface StatementTable {
	schema?: string;
	table: string;
}

/** A *PGM or *SRVPGM a routing row's values were found to name. */
export interface FoundProgram {
	library: string;
	object: string;
	objectType: '*PGM' | '*SRVPGM';
}

/** A program a dispatcher is judged to call for this table, and what it was judged on. */
export interface DispatchHandler extends FoundProgram {
	/** The service program export the routing row names - its entry point. */
	entry?: string;
	/** Higher is more certain: an export the row names counts most, the trigger's schema in the row next. */
	score: number;
	/** Set when the routing row fails a condition the dispatcher puts on the rows it reads - an "active"
	 * flag set off, typically - so the dispatcher passes this handler over. */
	unselected?: UnselectedCondition;
}

/** A `column = 'literal'` condition a dispatcher's statement puts on the routing table's rows. */
export interface RowCondition {
	column: string;
	value: string;
}

/** A condition a routing row fails, and the value the row holds instead. */
export interface UnselectedCondition extends RowCondition {
	actual: string;
}

// Libraries whose tables are the system's own - a dispatcher's catalog lookups, never its routing table.
const SYSTEM_SCHEMAS = new Set(['QSYS', 'QSYS2', 'SYSIBM', 'SYSIBMADM', 'SYSPROC', 'SYSTOOLS', 'QTEMP']);

// Only statements that read. A table the dispatcher writes to (an INSERT into a log, an UPDATE of a
// counter) is not where it looks a handler up, and a log row naming the table and the program that
// changed it would otherwise look exactly like a routing row.
const READ_STATEMENT = /^\s*(?:select|with|declare|values)\b/i;

/**
 * The tables a program's static SQL reads, from SYSPROGRAMSTMTSTAT's statement text, distinct and upper
 * cased, the system's own catalogs left out. The text comes back normalized ("FROM ACME . APPSTS", host
 * variables as ": H"), which the same regex table extraction the editor uses already reads.
 */
export function extractReadTables(statements: string[]): StatementTable[] {
	let tables: StatementTable[] = [];
	let seen = new Set<string>();

	for(let statement of statements) {
		if(!READ_STATEMENT.test(statement)) {
			continue;
		}

		for(let reference of SqlParser.parse(statement).tables ?? []) {
			let schema = reference.schema?.toUpperCase();
			let table = reference.table.toUpperCase();
			let key = `${schema ?? ''}.${table}`;

			if(!isSystemName(table) || (schema != null && (!isSystemName(schema) || SYSTEM_SCHEMAS.has(schema))) || seen.has(key)) {
				continue;
			}

			seen.add(key);
			tables.push({schema: schema, table: table});
		}
	}

	return tables.slice(0, MAX_CANDIDATE_TABLES);
}

// A column compared to a string literal, optionally qualified ("RTACT = 'Y'", "T . RTACT = 'Y'"). The
// statement text is normalized, so the spacing around the dot and the equals sign varies.
const LITERAL_CONDITION = /(?:\b[A-Z0-9_$#@]+\s*\.\s*)?(?<![A-Z0-9_$#@])([A-Z_$#@][A-Z0-9_$#@]*)\s*=\s*'((?:[^']|'')*)'/gi;

/**
 * The `column = 'literal'` conditions each of the dispatcher's statements that reads this table puts on
 * its rows - how a dispatcher skips a routing row switched off ("WHERE TRACTIVE = 'Y'"), read from its
 * own SQL rather than guessed from column names. One entry per statement, in the WHERE clause only.
 * A statement with an OR or a NOT is entered with no conditions: which rows it takes can't be told
 * without evaluating it, so it is taken to read every row and no row is judged passed over.
 */
export function extractRowConditions(statements: string[], table: StatementTable): RowCondition[][] {
	let perStatement: RowCondition[][] = [];

	for(let statement of statements) {
		if(!READ_STATEMENT.test(statement) || !readsTable(statement, table)) {
			continue;
		}

		let where = statement.match(/\bwhere\b([\s\S]*)$/i)?.[1];

		if(where == null || /\b(?:or|not)\b/i.test(where)) {
			perStatement.push([]);
			continue;
		}

		perStatement.push([...where.matchAll(LITERAL_CONDITION)].map(match => ({column: match[1].toUpperCase(), value: match[2].replace(/''/g, '\'')})));
	}

	return perStatement;
}

function readsTable(statement: string, table: StatementTable): boolean {
	return (SqlParser.parse(statement).tables ?? []).some(reference => StringUtils.equalsIgnoreCase(reference.table, table.table)
		&& (reference.schema == null || table.schema == null || StringUtils.equalsIgnoreCase(reference.schema, table.schema)));
}

/**
 * The condition that keeps the dispatcher from selecting this routing row, when every statement that
 * reads the table has one the row fails. Undefined when any statement would take the row, or when no
 * statement can be judged. CHAR values compare blank padded, as DB2 compares them; a condition on a
 * column the row doesn't hold (another table's, in a join) is not judged.
 */
export function findUnselectedCondition(row: Record<string, unknown>, conditions: RowCondition[][]): UnselectedCondition | undefined {
	let first: UnselectedCondition | undefined;

	for(let statement of conditions) {
		let failed = statement
			.map(condition => ({...condition, actual: readColumn(row, condition.column)}))
			.find(condition => condition.actual != null && condition.actual.trimEnd() !== condition.value.trimEnd());

		if(failed == null) {
			return undefined;
		}

		first ??= {column: failed.column, value: failed.value, actual: (<string>failed.actual).trimEnd()};
	}

	return first;
}

function readColumn(row: Record<string, unknown>, column: string): string | undefined {
	let key = Object.keys(row).find(candidate => StringUtils.equalsIgnoreCase(candidate, column));
	let value = key == null ? undefined : row[key];
	return typeof value === 'string' ? value : undefined;
}

/** The row without these columns - a condition's flag column holds a flag, never a program or library name. */
export function omitColumns(row: Record<string, unknown>, columns: string[]): Record<string, unknown> {
	return Object.fromEntries(Object.entries(row).filter(([key]) => !columns.some(column => StringUtils.equalsIgnoreCase(column, key))));
}

/**
 * The statement that reads a candidate table's rows naming the trigger's table in any character column.
 * The column names are spliced in (a predicate can't bind an identifier), so each one is checked against
 * the shape of a system name first, and one that isn't is left out. So is a column too short to hold the
 * name: it can't match, and the ODBC driver describes each marker by the column it is compared to, so
 * binding the name to a CHAR(1) flag fails the whole statement (CWB0111, "Input data is too big to fit
 * into field"). Such a column can still be selected - `alsoSelect` adds the ones the dispatcher's
 * conditions name - since only the WHERE binds a marker to it. Undefined when no column is left.
 */
export function buildRoutingRowQuery(table: {schema: string; table: string}, columns: {name: string; length?: number}[], tableName: string, alsoSelect: string[] = []): {sql: string; parameters: string[]} | undefined {
	let usable = columns
		.filter(column => isSystemName(column.name) && (column.length == null || column.length >= tableName.length))
		.map(column => column.name);

	if(!isSystemName(table.schema) || !isSystemName(table.table) || usable.length === 0) {
		return undefined;
	}

	let selected = [...usable, ...columns
		.map(column => column.name)
		.filter(name => isSystemName(name) && alsoSelect.some(extra => StringUtils.equalsIgnoreCase(extra, name)) && !usable.includes(name))];

	return {
		sql: `select ${selected.map(column => `"${column}"`).join(', ')} ` +
			`from "${table.schema}"."${table.table}" ` +
			`where ${usable.map(column => `"${column}" = ?`).join(' or ')} ` +
			`fetch first ${MAX_ROUTING_ROWS} rows only`,
		parameters: usable.map(() => tableName.toUpperCase())
	};
}

/** A row's distinct non-blank text values, trimmed - CHAR columns come back blank padded. */
export function rowValues(row: Record<string, unknown>): string[] {
	let values = Object.values(row)
		.filter((value): value is string => typeof value === 'string')
		.map(value => value.trim())
		.filter(value => value.length > 0);

	return [...new Set(values)];
}

/** The rows that really name the table - the statement asked for exactly these, but checking again keeps
 * a row from a driver that ignored the WHERE (or a padded comparison that matched loosely) out. */
export function findRoutingRows(rows: Record<string, unknown>[], tableName: string): Record<string, unknown>[] {
	return rows.filter(row => rowValues(row).some(value => StringUtils.equalsIgnoreCase(value, tableName)));
}

/** The values in a routing row that could name a library - a system name, or `*LIBL`. */
export function libraryCandidates(values: string[]): string[] {
	return values.map(value => value.toUpperCase()).filter(value => value === '*LIBL' || isSystemName(value));
}

/** The values in a routing row that could name the handler program - a system name that isn't one the
 * row is already known to hold for another reason (the trigger's table, the dispatcher itself). */
export function programNameCandidates(values: string[], exclude: string[]): string[] {
	let excluded = new Set(exclude.map(value => value.toUpperCase()));
	return values.map(value => value.toUpperCase()).filter(value => isSystemName(value) && !excluded.has(value));
}

/**
 * How sure a found program is the handler: an export of it that the row also names (the procedure the
 * dispatcher calls) is close to proof, and the trigger's schema in the row is supporting evidence. A
 * program with neither is a coincidence - some other value in the row that happens to name an object -
 * and is dropped. Undefined when dropped.
 */
export function scoreHandler(program: FoundProgram, values: string[], exports: string[] | undefined, triggerSchema: string): DispatchHandler | undefined {
	let entry = exports?.find(symbol => values.some(value => StringUtils.equalsIgnoreCase(value, symbol)));
	let schemaNamed = values.some(value => StringUtils.equalsIgnoreCase(value, triggerSchema));
	let score = (entry != null ? 2 : 0) + (schemaNamed ? 1 : 0);

	return score === 0 ? undefined : {...program, entry: entry, score: score};
}

/** One entry per program, its best score kept - on a tie, a row the dispatcher selects over one it passes
 * over - most certain first. */
export function rankHandlers<T extends DispatchHandler>(handlers: T[]): T[] {
	let best = new Map<string, T>();

	for(let handler of handlers) {
		let key = `${handler.library}/${handler.object}/${handler.objectType}`;
		let current = best.get(key);

		if(current == null || handler.score > current.score || (handler.score === current.score && current.unselected != null && handler.unselected == null)) {
			best.set(key, handler);
		}
	}

	return [...best.values()].sort((a, b) => b.score - a.score);
}
