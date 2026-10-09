import { Parameter } from '../../interfaces/parameter.js';

import { ArrayUtils } from '../../utils/array-utils.js';
import { StringUtils } from '../../utils/string-utils.js';

// The one place that turns "which tables am I asking about?" into a WHERE clause, shared by every
// catalog query that used to take a single schema/table pair and by MemoryCache's per-table cache
// keys. Pulled out of the query classes so the predicate and chunking rules can be unit tested
// without an extension host - the queries themselves need vscode and a driver, this decision doesn't.
//
// Every list query takes `tables: TableTarget[] | TableTarget`, so one table is just a one-element
// batch rather than a separate code path. ArrayUtils.toArray does the widening; toTableTargets also
// drops blanks and de-duplicates, which is what lets the callers skip their own validation.
export interface TableTarget {
	schema?: string;
	table: string;
}

/**
 * Normalizes a query's `tables` option into the uppercase, de-duplicated list every predicate and
 * cache key is built from. Targets naming no table at all are dropped rather than rejected: a caller
 * asking about nothing gets no rows, the same answer the old `if(!options.table) throw` produced for
 * the single-table case, without every caller needing a guard of its own.
 */
export function toTableTargets(tables: TableTarget[] | TableTarget | undefined): TableTarget[] {
	let seen = new Set<string>();
	let targets: TableTarget[] = [];

	for(let target of ArrayUtils.toArray(tables)) {
		if(target == null || StringUtils.isBlank(target.table)) {
			continue;
		}

		let normalized: TableTarget = {
			schema: StringUtils.isNotBlank(target.schema) ? (<string>target.schema).trim().toUpperCase() : undefined,
			table: target.table.trim().toUpperCase()
		};

		let key = tableTargetKey(normalized.schema, normalized.table);

		if(seen.has(key)) {
			continue;
		}

		seen.add(key);
		targets.push(normalized);
	}

	return targets;
}

/**
 * The identity a target is cached and grouped under - also how a returned row is matched back to the
 * target that asked for it, since a batched query can no longer attribute rows by the parameters it
 * was called with.
 */
export function tableTargetKey(schema: string | undefined, table: string): string {
	return `${StringUtils.default(schema, () => '')}.${StringUtils.default(table, () => '')}`.toLowerCase();
}

/**
 * ORs one clause per schema, with that schema's tables in an IN list - `(dbname = ? and tbname in (?, ?))`
 * - so a batch of many tables in a few schemas doesn't repeat the schema test once per table. A schema
 * with a single table keeps the plain `tbname = ?` form. Targets with no schema match on table name
 * alone, which is how the autocomplete callers ask about a table they haven't resolved a schema for yet.
 * Clauses follow the order each schema first appears in, and tables keep their order within it.
 *
 * `columns` names the catalog's own columns, since they differ per table: SYSCOLUMNS2 calls them
 * dbname/tbname, SYSCST system_table_schema/system_table_name, SYSPARTITIONINDEXSTAT
 * table_schema/table_name.
 */
export function buildTablePredicate(targets: TableTarget[], columns: TablePredicateColumns): TablePredicate {
	let clauses: string[] = [];
	let parameters: Parameter[] = [];

	for(let [schema, tables] of ArrayUtils.toMapOfArrays(targets, target => target.schema ?? '', target => target.table)) {
		let tableTest = tables.length === 1 ? `${columns.table} = ?` : `${columns.table} in (${tables.map(() => '?').join(', ')})`;

		if(StringUtils.isNotBlank(schema)) {
			clauses.push(`(${columns.schema} = ? and ${tableTest})`);
			parameters.push(schema);
		} else {
			clauses.push(tableTest);
		}

		parameters.push(...tables);
	}

	return {clause: clauses.join(' or '), parameters: parameters};
}

/**
 * Splits a batch so no single statement carries an unbounded OR chain or parameter marker list. A
 * diagram with sixty tables becomes three queries per catalog rather than sixty, which is the point
 * of batching, while staying well inside what DB2 for i will accept in one prepared statement. A
 * caller whose statement is cheap per target can pass a larger size (see RoutineQueries).
 */
export function chunkTableTargets(targets: TableTarget[], size = MAX_TARGETS_PER_QUERY): TableTarget[][] {
	if(targets.length === 0) {
		return [];
	}

	let chunks: TableTarget[][] = [];
	let step = Math.max(1, size);

	for(let index = 0; index < targets.length; index += step) {
		chunks.push(targets.slice(index, index + step));
	}

	return chunks;
}

export const MAX_TARGETS_PER_QUERY = 25;

/**
 * The shape every catalog list query now has: normalize the targets, run one statement per chunk, map
 * the rows. The statement itself is built and run by the caller (that part needs the extension's
 * connection), so this stays free of vscode and driver code, and testable on its own.
 *
 * Rows come back attributed by their own schema/table columns rather than by the parameters the query
 * was called with - a batched statement can no longer assume every row belongs to the one table asked
 * for, which is why each query selects its owning schema/table alongside the rest.
 */
export async function queryByTableTargets<R>(options: QueryByTableTargetsOptions<R>): Promise<R[]> {
	let targets = toTableTargets(options.tables);

	if(targets.length === 0) {
		return [];
	}

	let results: R[] = [];

	for(let chunk of chunkTableTargets(targets, options.chunkSize)) {
		let rows = await options.run(buildTablePredicate(chunk, options.columns)) ?? [];
		results.push(...rows.map(options.map));
	}

	return results;
}

export interface QueryByTableTargetsOptions<R> {
	tables: TableTarget[] | TableTarget | undefined;
	columns: TablePredicateColumns;
	chunkSize?: number;
	run: (predicate: TablePredicate) => Promise<Record<string, unknown>[]>;
	map: (row: Record<string, unknown>) => R;
}

export interface TablePredicateColumns {
	schema: string;
	table: string;
}

export interface TablePredicate {
	clause: string;
	parameters: Parameter[];
}
