import { Extension } from '../../extension.js';
import { Row } from '../../interfaces/row.js';
import { SystemColumn } from '../../models/system-column.js';
import { FieldUtils } from '../../utils/field-utils.js';
import { DbErrorUtils } from '../../utils/db-error-utils.js';
import { StringUtils } from '../../utils/string-utils.js';
import { DbConnections } from '../db-connections.js';

// Row-level content of an already-identified table - a stateless page of rows today (backing the
// schema browser's Data tab); future home for insert/update/delete on that same tab.
export class DataQueries {
	constructor(private extension: Extension) {}

	// A stateless page of a table's rows, read over the worker connection (internalQuery) like
	// TableQueries.listColumns rather than through the main connection's cursor (execute/fetch), so
	// it can't be disturbed by (or disturb) an open result cursor or an unrelated action (e.g.
	// Create Index) on the same table's other tabs.
	async listTableData(options: DataQueries.ListTableDataOptions): Promise<DataQueries.ListTableDataResult> {
		if(!options || !options.schema || !options.table || options.columns.length === 0) {
			return {rows: [], hasMore: false, keyColumns: []};
		}

		let quotedSchema = `"${options.schema.replace(/"/g, '""')}"`;
		let quotedTable = `"${options.table.replace(/"/g, '""')}"`;
		let hasPrimaryKey = options.primaryKeyColumns.length > 0;

		// Every identifier is delimited (double-quoted), unlike this class's other generated SQL
		// (e.g. Create Index) which uses bare identifiers. Selected by short system name (not the
		// long SQL name) - shorter/cleaner generated SQL, and addressing a column directly without an
		// alias already returns that same identifier as the raw driver column label, so the row key
		// ends up being systemName throughout. ColumnNameUtils.buildLabelMap/SchemasProvider.postTableData
		// key their lookup by systemName to match. LENGTH(...) is the one exception needing an
		// explicit alias - a function call has no name of its own - aliased back to its own
		// systemName too, so every column (LOB or not) is keyed the same way.
		let selectColumns = options.columns.map(column => {
			let quotedSystemName = `"${column.systemName.replace(/"/g, '""')}"`;

			if(FieldUtils.isLobType(column.dataType)) {
				return `length(${quotedSystemName}) as ${quotedSystemName}`;
			}

			return quotedSystemName;
		});

		// A table with neither an identity column nor a PRIMARY KEY/UNIQUE constraint (see
		// SchemasProvider.postTableData's primaryKeyColumns resolution) has no column(s) that can key a
		// row for update/delete - RRN (relative record number), unqualified since it's evaluated against
		// this same FROM target, is DB2 for i's stable per-row fallback (same function
		// AdvisedIndexesTab's buildDeleteAdviceSql already uses to target one SYSIXADV row). "$RRN" is a
		// synthetic alias chosen to be practically impossible to collide with a real column name.
		//
		// A read-only source (a view) gets no fallback at all: nothing will key a row of it, and RRN() of a
		// view that joins more than one table is an error rather than a number.
		let useRrn = !hasPrimaryKey && !options.readOnly;
		let rrnColumn = `RRN(${quotedTable}) as "$RRN"`;
		let selectList = useRrn ? [...selectColumns, rrnColumn].join(', ') : selectColumns.join(', ');

		let keyColumns: DataQueries.KeyColumn[] = hasPrimaryKey
			? options.primaryKeyColumns.map(systemName => ({systemName: systemName, isRrn: false}))
			: useRrn ? [{systemName: '$RRN', isRrn: true}] : [];

		// Ordered by position in the SELECT list (e.g. "order by 1, 3") rather than by name - avoids
		// any identifier-quoting edge case for the ORDER BY clause, since the position is already
		// known from options.columns. An explicit user sort (options.orderBy) replaces the default
		// primary-key order entirely rather than being appended to it - single-column sort, so at
		// most one of these ever contributes a position. A table with no primary key and no explicit
		// sort falls back to ordering by the synthetic $RRN column (always the last select-list
		// position in that case) instead of leaving the result set unordered, which would otherwise
		// make offset-based paging unstable (duplicate/skipped rows across pages).
		let orderByClause: string;

		if(options.orderBy?.length || hasPrimaryKey) {
			let sortColumns = options.orderBy?.length
				? options.orderBy.map(sort => ({systemName: sort.systemName, direction: sort.direction}))
				: options.primaryKeyColumns.map(primaryKeyColumn => ({systemName: primaryKeyColumn, direction: <'asc' | 'desc'>'asc'}));

			let orderByPositions = sortColumns
				.map(sort => ({position: options.columns.findIndex(column => StringUtils.equalsIgnoreCase(column.systemName, sort.systemName)) + 1, direction: sort.direction}))
				.filter(sort => sort.position > 0);

			orderByClause = orderByPositions.length > 0 ? ` order by ${orderByPositions.map(sort => `${sort.position} ${sort.direction}`).join(', ')}` : '';
		} else if(useRrn) {
			orderByClause = ` order by ${options.columns.length + 1} asc`;
		} else {
			// No key and no RRN to page by - the first column is the closest thing to a stable order a
			// read-only source offers.
			orderByClause = ` order by 1 asc`;
		}

		// options.where is the clause body only (no "where" keyword) - built webview-side by
		// SearchCriteriaUtils.buildWhereClause() or typed directly into the Edit Search dialog's
		// Custom tab, same "webview builds the SQL, host just runs it" convention as e.g.
		// IndexAdviceUtils.buildCreateIndexSql / RunGeneratedSqlMessage.
		let whereClause = StringUtils.isNotBlank(options.where) ? ` where ${options.where}` : '';

		// offset/limit are host-computed (page * 100) integers, never user text, and are inlined
		// rather than bound as "?" parameter markers - DB2 for i drivers are inconsistent about
		// accepting parameter markers in OFFSET/FETCH FIRST.
		let offset = Math.max(0, Math.trunc(options.offset));
		let limit = Math.max(1, Math.trunc(options.limit));
		let sql = `select ${selectList} from ${quotedSchema}.${quotedTable}${whereClause}${orderByClause} offset ${offset} rows fetch first ${limit} rows only`;

		// onError is required here, not just for the caller's benefit - internalQuery swallows a failing
		// query's exception itself (firing an ERROR event, returning undefined) rather than throwing, so
		// without this a bad WHERE clause (e.g. an invalid Edit Search Custom clause) would silently come
		// back as "0 rows" instead of surfacing the actual failure to the Data tab.
		let capturedError: any;
		let result = await this.extension.connections.internalQuery({
			key: options.key,
			configId: options.configId,
			sql: sql,
			progressMessage: 'Loading table data...',
			onError: error => {
				capturedError = error;
			}
		});

		if(!result) {
			return {rows: [], hasMore: false, keyColumns: keyColumns, error: DbErrorUtils.serialize(capturedError)};
		}

		let rows = <Row[]>result;
		return {rows: rows, hasMore: rows.length === limit, keyColumns: keyColumns};
	}

	// Runs the Run SQL panel's pending statements in order, over the worker connection (same
	// reasoning as listTableData - shouldn't disturb an open cursor on the main connection), stopping
	// at the first failure. internalQuery() already swallows a failing statement's exception and fires
	// a DB_CONNECTION ERROR event of its own (visible in this session's History tab) rather than
	// throwing, returning a nullish result instead - that's the signal used here to detect a failure
	// and stop, since none of these statements (INSERT/UPDATE/DELETE today) legitimately returns a
	// nullish DbResult on success.
	async executeStatements(options: DataQueries.ExecuteStatementsOptions): Promise<DataQueries.ExecuteStatementsResult> {
		for(let i = 0; i < options.statements.length; i++) {
			options.onProgress?.(i, 'running');
			let capturedError: any;
			let result = await this.extension.connections.internalQuery({
				key: options.key,
				configId: options.configId,
				sql: options.statements[i],
				progressMessage: `Running statement ${i + 1} of ${options.statements.length}...`,
				onError: error => {
					capturedError = error;
				}
			});

			if(!result) {
				options.onProgress?.(i, 'error');
				return {executedCount: i, failed: true, error: DbErrorUtils.serialize(capturedError)};
			}

			options.onProgress?.(i, 'success');
		}

		return {executedCount: options.statements.length, failed: false};
	}
}

export namespace DataQueries {
	// Identifies whichever column(s) actually key a row for update/delete - either the real
	// primary-key/identity column(s) resolved by SchemasProvider.postTableData, or the single synthetic
	// "$RRN" fallback column when the table has neither (see listTableData). isRrn is the only bit a
	// consumer needs beyond systemName: it decides whether a key value is rendered as a bare RRN(...)
	// predicate or a normal quoted-literal column comparison (see RowEditUtils).
	export interface KeyColumn {
		systemName: string;
		isRrn: boolean;
	}

	export interface ListTableDataOptions extends DbConnections.CommonListOptions {
		schema: string;
		table: string;
		/** Caller already has these via TableQueries.listColumns - determines the SELECT list (in
		 * order) and which columns get a LENGTH(...) placeholder instead of their raw value. */
		columns: SystemColumn[];
		/** systemName values, in ordinalPosition order; empty when the table has no primary key. Used
		 * only when `orderBy` isn't set. */
		primaryKeyColumns: string[];
		/** An explicit user sort (single column) - replaces the primaryKeyColumns default entirely. */
		orderBy?: Array<{systemName: string; direction: 'asc' | 'desc'}>;
		/** The Edit Search dialog's WHERE clause body (no "where" keyword) - see SearchCriteriaUtils.buildWhereClause. */
		where?: string;
		offset: number;
		limit: number;
		/** Rows of this source are never edited (a view) - no "$RRN" fallback key is selected, and
		 * keyColumns comes back empty when there is no primary key. */
		readOnly?: boolean;
	}

	export interface ListTableDataResult {
		rows: Row[];
		hasMore: boolean;
		keyColumns: KeyColumn[];
		/** Only set when the query itself failed (e.g. an invalid Edit Search WHERE clause) - rows/
		 * hasMore are the empty-result defaults in that case, not a genuine "no matching rows" page. */
		error?: DbErrorUtils.SerializedError;
	}

	export interface ExecuteStatementsOptions extends DbConnections.CommonListOptions {
		/** Raw SQL text, run in order - see RunDataEditStatementsMessage. */
		statements: string[];
		/** Called 'running' right before each statement executes, then 'success'/'error' right after -
		 * lets the caller relay live per-statement progress to the webview. */
		onProgress?: (index: number, status: 'running' | 'success' | 'error') => void;
	}

	export interface ExecuteStatementsResult {
		executedCount: number;
		failed: boolean;
		/** Only set when failed - the statement at index executedCount is the one that failed. */
		error?: DbErrorUtils.SerializedError;
	}
}
