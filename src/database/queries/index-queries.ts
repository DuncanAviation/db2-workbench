import { Extension } from '../../extension.js';
import { Parameter } from '../../interfaces/parameter.js';
import { SystemIndexAdvice } from '../../models/system-index-advice.js';
import { SystemIndex } from '../../models/system-index.js';
import { SortSequenceUtils } from '../../utils/sort-sequence-utils.js';
import { StringUtils } from '../../utils/string-utils.js';
import { DbConnections } from '../db-connections.js';
import { runCatalogLookup } from './catalog-lookup.js';
import { queryByTableTargets, TableTarget } from './table-predicates.js';

// Everything about indexes on an already-identified table - read (listIndexes/listIndexAdvice) and
// structural mutation (executeCreateIndex/deleteIndex/renameIndex) together, one class per concept
// rather than split by operation type. deleteIndexAdvice lives here too even though it's a plain
// DELETE against a catalog housekeeping row (QSYS2.SYSIXADV), not structural DDL on a real object -
// it's still "index advice" bookkeeping, so it belongs with the rest of this concept.
export class IndexQueries {
	constructor(private extension: Extension) {}

	async listIndexes(options: IndexQueries.ListIndexesOptions): Promise<SystemIndex[]> {
		// SYSPARTITIONINDEXSTAT (one row per index per table partition/member) covers every kind of
		// index over a table - SQL indexes, DDS logical files, keyed physical files, and
		// constraint-backed indexes - and already carries a pre-built, ordered COLUMN_NAMES string, so
		// unlike listTableKeys/listForeignKeys no SYSKEYS-style join/grouping is needed. SYSINDEXES is
		// only left-joined in for owner/comment, which SYSPARTITIONINDEXSTAT doesn't carry and which
		// only ever exist for actual SQL indexes (null for logical files/constraints).
		return queryByTableTargets<SystemIndex>({
			tables: options?.tables,
			columns: {schema: 'p.table_schema', table: 'p.table_name'},
			run: predicate => this.runQuery(options, `select p.table_schema, p.table_name, p.table_partition, p.index_schema, p.index_name, p.index_type, ` +
					`p."UNIQUE" as unique_code, p.column_names, p.index_size, p.create_timestamp, p.last_build_timestamp, ` +
					`p.last_query_use, p.query_use_count, p.query_statistics_count, p.last_used_timestamp, ` +
					`i.index_owner, i.index_text ` +
					`from qsys2.syspartitionindexstat p ` +
					`left join qsys2.sysindexes i ` +
					`on p.index_schema = i.index_schema ` +
					`and p.index_name = i.index_name ` +
					`where ${predicate.clause} ` +
					`order by p.table_schema, p.table_name, p.index_name, p.table_partition`, predicate.parameters),
			map: row => {
				return <SystemIndex>{
					schema: IndexQueries.readName(row, 'TABLE_SCHEMA'),
					tableName: IndexQueries.readName(row, 'TABLE_NAME'),
					partition: StringUtils.trim(<string>row['TABLE_PARTITION'], {removeDuplicateWhiteSpace: true}),
					indexSchema: StringUtils.trim(<string>row['INDEX_SCHEMA'], {removeDuplicateWhiteSpace: true}),
					indexName: StringUtils.trim(<string>row['INDEX_NAME'], {removeDuplicateWhiteSpace: true}),
					indexType: StringUtils.trim(<string>row['INDEX_TYPE'], {removeDuplicateWhiteSpace: true}),
					uniqueness: IndexQueries.describeIndexUniqueness(<number>row['UNIQUE_CODE']),
					keyColumns: StringUtils.trim(<string>row['COLUMN_NAMES'], {removeDuplicateWhiteSpace: true}),
					size: <number>row['INDEX_SIZE'],
					created: new Date(<string>row['CREATE_TIMESTAMP']),
					lastBuild: new Date(<string>row['LAST_BUILD_TIMESTAMP']),
					lastQueryUsed: row['LAST_QUERY_USE'] != null ? new Date(<string>row['LAST_QUERY_USE']) : null,
					queryUseCount: <number>row['QUERY_USE_COUNT'],
					queryStatisticsUseCount: <number>row['QUERY_STATISTICS_COUNT'],
					lastUsed: row['LAST_USED_TIMESTAMP'] != null ? new Date(<string>row['LAST_USED_TIMESTAMP']) : null,
					indexOwner: row['INDEX_OWNER'] != null ? StringUtils.trim(<string>row['INDEX_OWNER'], {removeDuplicateWhiteSpace: true}) : null,
					comment: row['INDEX_TEXT'] != null ? StringUtils.trim(<string>row['INDEX_TEXT'], {removeDuplicateWhiteSpace: true}) : null
				};
			}
		});
	}

	private async runQuery(options: DbConnections.CommonListOptions, sql: string, parameters: Parameter[]): Promise<Record<string, unknown>[]> {
		return await runCatalogLookup(this.extension, {
			key: options.key,
			configId: options.configId,
			sql: sql,
			parameters: parameters
		});
	}

	// The schema/table a row belongs to, read off the row itself rather than off the request - a
	// batched statement can't attribute rows by the parameters it was called with. Uppercase and
	// trimmed to match what toTableTargets produces.
	private static readName(row: Record<string, unknown>, column: string): string {
		return (<string>StringUtils.trim(<string>row[column], {removeDuplicateWhiteSpace: true})).toUpperCase();
	}

	// QSYS2.SYSPARTITIONINDEXSTAT.UNIQUE is a numeric code rather than the descriptive text DB2 returns
	// for e.g. QSYS2.SYSCST.CONSTRAINT_TYPE - mapped here so SystemIndex.uniqueness is always
	// display-ready, per IBM's documented code values.
	private static describeIndexUniqueness(code: number): string {
		switch(code) {
			case 0: return 'Unique';
			case 1: return 'Unique Where Not Null';
			case 2: return 'Non-Unique (FIFO)';
			case 3: return 'Non-Unique (LIFO)';
			case 4: return 'Non-Unique (FCFO)';
			default: return String(code);
		}
	}

	async listIndexAdvice(options: IndexQueries.ListIndexAdviceOptions): Promise<SystemIndexAdvice[]> {
		return queryByTableTargets<SystemIndexAdvice>({
			tables: options?.tables,
			columns: {schema: 'table_schema', table: 'table_name'},
			run: predicate => this.runQuery(options, `select rrn(sysixadv) as id, table_schema, table_name, key_columns_advised, index_type, reason_advised, times_advised, last_advised, nlssname, nlssdbname ` +
					`from qsys2.sysixadv ` +
					`where ${predicate.clause} `, predicate.parameters),
			map: row => {
				return <SystemIndexAdvice>{
					id: <number>row['ID'],
					schema: StringUtils.trim(<string>row['TABLE_SCHEMA'], {removeDuplicateWhiteSpace: true}),
					table: StringUtils.trim(<string>row['TABLE_NAME'], {removeDuplicateWhiteSpace: true}),
					keyColumnsAdvised: StringUtils.trim(<string>row['KEY_COLUMNS_ADVISED'], {removeDuplicateWhiteSpace: true}),
					indexType: StringUtils.trim(<string>row['INDEX_TYPE'], {removeDuplicateWhiteSpace: true}),
					reasonAdvised: StringUtils.trim(<string>row['REASON_ADVISED'], {removeDuplicateWhiteSpace: true}),
					timesAdvised: <number>row['TIMES_ADVISED'],
					lastAdvised: new Date(<string>row['LAST_ADVISED']),
					sortSequence: StringUtils.trim(<string>row['NLSSNAME'], {removeDuplicateWhiteSpace: true}),
					sortSequenceLibrary: StringUtils.trim(<string>row['NLSSDBNAME'], {removeDuplicateWhiteSpace: true})
				};
			}
		});
	}

	/**
	 * Runs a CREATE INDEX statement generated from an Advised Indexes recommendation, always over a
	 * worker-style connection rather than the session's main connection/cursor - the main connection
	 * may have an open result cursor mid-fetch, and this shouldn't disturb it. DB2 for i also bakes the
	 * connection's current sort sequence into an index at creation time, so an index advised under a
	 * different sort sequence than the one this key's connection is running under has to be created on
	 * a separate, throwaway connection configured to match - otherwise the created index wouldn't match
	 * what the optimizer actually asked for. See SortSequenceUtils for how that connection string is
	 * derived. Either way, the statement is reported back through the active session's own events so it
	 * shows up in that session's History tab like any other executed statement.
	 */
	async executeCreateIndex(options: IndexQueries.ExecuteCreateIndexOptions): Promise<void> {
		let connectionInfo = await this.extension.connections.getConnectionInfo(options);

		if(connectionInfo == null) {
			return;
		}

		let target: SortSequenceUtils.Identity = {sortSequence: options.sortSequence, sortSequenceLibrary: options.sortSequenceLibrary};
		let current: SortSequenceUtils.Identity = {sortSequence: connectionInfo.jobDetails.sortSequence, sortSequenceLibrary: connectionInfo.jobDetails.sortSequenceLibrary};

		if(SortSequenceUtils.matches(target, current)) {
			await this.extension.connections.internalQuery({key: options.key, configId: options.configId, sql: options.sql, progressMessage: 'Creating index...'});
			return;
		}

		await this.extension.connections.runOnSortSequenceConnection({key: options.key, configId: options.configId, sql: options.sql, sortSequence: options.sortSequence, sortSequenceLibrary: options.sortSequenceLibrary, progressMessage: 'Creating index...'});
	}

	/**
	 * Deletes an index from the Indexes tab's row context menu, always over the session's worker
	 * connection - same reasoning as executeCreateIndex(): the main connection may have an open result
	 * cursor mid-fetch, and DROP INDEX shouldn't disturb it. No sort-sequence handling is needed here
	 * (unlike executeCreateIndex()) since dropping an index doesn't bake in a sort sequence.
	 */
	async deleteIndex(options: IndexQueries.IndexStatementOptions): Promise<void> {
		await this.extension.connections.internalQuery({key: options.key, configId: options.configId, sql: options.sql, progressMessage: 'Deleting index...'});
	}

	/**
	 * Deletes a QSYS2.SYSIXADV row (by RRN, see SystemIndexAdvice.id) after the Create Index dialog's
	 * "Delete advised index" checkbox is used - same worker-connection reasoning as deleteIndex(), and
	 * likewise sort-sequence-agnostic since this only removes a catalog row rather than creating
	 * anything. Always run after the CREATE INDEX itself succeeds (see runGeneratedSql in
	 * schemas-provider.ts), but as its own statement/history entry rather than a multi-statement batch.
	 */
	async deleteIndexAdvice(options: IndexQueries.IndexStatementOptions): Promise<void> {
		await this.extension.connections.internalQuery({key: options.key, configId: options.configId, sql: options.sql, progressMessage: 'Deleting index advice...'});
	}

	/**
	 * Renames an index from the Indexes tab's row context menu - same worker-connection reasoning as
	 * deleteIndex(). The new name's length is validated webview-side (against
	 * IndexAdviceUtils.MAX_INDEX_NAME_LENGTH) before this is ever called.
	 */
	async renameIndex(options: IndexQueries.IndexStatementOptions): Promise<void> {
		await this.extension.connections.internalQuery({key: options.key, configId: options.configId, sql: options.sql, progressMessage: 'Renaming index...'});
	}
}

export namespace IndexQueries {
	export interface ListIndexesOptions extends DbConnections.CommonListOptions {
		tables: TableTarget[] | TableTarget;
	}

	export interface ListIndexAdviceOptions extends DbConnections.CommonListOptions {
		tables: TableTarget[] | TableTarget;
		/** Bypasses MemoryCache's per-table cache in getIndexAdvice() so a manual recheck (or a
		 * recheck right after running generated DDL like Create Index) reflects QSYS2.SYSIXADV's
		 * current state instead of whatever was cached the first time this table was requested. */
		forceRefresh?: boolean;
	}

	export interface ExecuteCreateIndexOptions extends DbConnections.CommonExecuteOptions {
		sql: string;
		/** The advised index's SYSIXADV.NLSSNAME/NLSSDBNAME - see SortSequenceUtils.Identity. */
		sortSequence: string;
		sortSequenceLibrary: string;
	}

	/** Shared by deleteIndex()/renameIndex()/deleteIndexAdvice() - the webview builds the DROP/RENAME/
	 * DELETE statement itself (same convention as the Advised Indexes tab building its own CREATE
	 * INDEX SQL), so these just need somewhere to run it. */
	export interface IndexStatementOptions extends DbConnections.CommonExecuteOptions {
		sql: string;
	}
}
