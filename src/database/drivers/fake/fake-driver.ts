import { Parameter } from '../../../interfaces/parameter.js';
import { ArrayUtils } from '../../../utils/array-utils.js';
import { DbErrorUtils } from '../../../utils/db-error-utils.js';
import { Nullable } from '../../../utils/nullable.js';
import { StringUtils } from '../../../utils/string-utils.js';
import { DbColumnDefinition, DbCursor, DbDriver, DbDriverConnection, DbResult } from '../db-driver.js';
import { CatalogResponder } from './catalog-responder.js';
import { FakeDatabase, findTable } from './fake-database.js';
import { FakeDml } from './fake-dml.js';

/**
 * A DbDriver that serves canned data, so the extension can be exercised end to end - commands, the
 * event pipeline, sessions, the caches, the webviews - with no database, no ODBC driver manager and
 * no credentials. Selected with DB2_WORKBENCH_DRIVER=fake or ConnectionConfig.driver.
 *
 * Deliberately free of `vscode` and `odbc` imports, so it can be unit tested in the mocha tier as
 * well as driven from an extension-host integration test.
 *
 * A statement is resolved in four steps:
 * 1. the response list, for a test that wants to pin exact rows (or inject an error, or a delay);
 * 2. CatalogResponder, which answers the QSYS2 catalog queries out of the declared FakeDatabase;
 * 3. an INSERT/UPDATE/DELETE, applied to the declared rows by FakeDml;
 * 4. a plain SELECT against a table the fixture declares, which returns that table's rows.
 *
 * Anything else **throws**. A fake that quietly returned no rows for a statement nobody taught it
 * would let a test pass while proving nothing, which is the one failure mode worth designing hard
 * against here.
 */
export class FakeDriver implements DbDriver {
	static readonly ID = 'fake';
	static readonly DEFAULT_FETCH_SIZE = 100;

	private responder: Nullable<CatalogResponder>;
	private dml: Nullable<FakeDml>;

	// The declared database is copied, so a statement that writes to it (see FakeDml) changes only
	// this driver's rows. Tests share one exported fixture object and swap drivers freely, so a write
	// straight into that object would leak into every test that followed.
	private declared: Nullable<FakeDatabase>;

	constructor(private options: FakeDriver.Options = {}) {
		this.declared = options.database ? structuredClone(options.database) : undefined;
		this.responder = this.declared ? new CatalogResponder(this.declared) : undefined;
		this.dml = this.declared ? new FakeDml(this.declared) : undefined;
	}

	get id(): string {
		return FakeDriver.ID;
	}

	get displayName(): string {
		return 'Fake';
	}

	get defaultConnectionString(): string {
		return '';
	}

	/** Every connection attempt succeeds - a fake driver has no credentials to be wrong about. */
	async connect(): Promise<DbDriverConnection> {
		return new FakeDriverConnection(this);
	}

	/** This driver's own copy of the declared database - including whatever a write has changed. */
	get database(): Nullable<FakeDatabase> {
		return this.declared;
	}

	get fetchSize(): number {
		return this.options.fetchSize ?? FakeDriver.DEFAULT_FETCH_SIZE;
	}

	/**
	 * Resolves a statement to its rows, applying any declared delay and throwing any declared error
	 * first. Both of those exist so a test can exercise the paths that only a slow or failing
	 * statement reaches - the progress/serialization behavior, and the History tab's error rendering.
	 */
	async resolve(sql: string, parameters?: Array<Parameter>): Promise<Record<string, unknown>[]> {
		this.options.onStatement?.(sql, parameters);

		let response = this.findResponse(sql, parameters);

		if(response) {
			if(response.delayMs != null) {
				await new Promise(resolve => setTimeout(resolve, response.delayMs));
			}

			if(response.error != null) {
				throw FakeDriver.toError(response.error);
			}

			return <Record<string, unknown>[]>ArrayUtils.toArray(response.rows);
		}

		// Tested against undefined, not emptiness: "this catalog knows the table and it has no rows"
		// is a real answer (a table with no advised indexes), and must not fall through to a miss.
		let catalogRows = this.responder?.respond(sql, parameters);

		if(catalogRows !== undefined) {
			return catalogRows;
		}

		// A write reports no rows, the way a real driver's INSERT/UPDATE/DELETE does - what it changed
		// is read back by selecting from the table again.
		if(this.dml && FakeDml.isDml(CatalogResponder.normalize(sql))) {
			this.dml.apply(sql);
			return [];
		}

		let tableRows = this.findTableRows(sql);

		if(tableRows !== undefined) {
			return tableRows;
		}

		throw FakeDriver.toError({
			message: `FakeDriver: no fixture response for SQL: ${CatalogResponder.normalize(sql)}`,
			driverErrors: [{ code: -1, state: 'HY000', message: 'The fake driver was asked to run a statement no fixture covers.' }]
		});
	}

	findResponse(sql: string, parameters?: Array<Parameter>): Nullable<FakeDriver.Response> {
		let normalized = CatalogResponder.normalize(sql);
		let responses = <FakeDriver.Response[]>ArrayUtils.toArray(this.options.responses);

		return responses.find(response => {
			if(StringUtils.isNotBlank(response.sql)) {
				return CatalogResponder.normalize(<string>response.sql) === normalized;
			}

			if(response.match instanceof RegExp) {
				return response.match.test(sql);
			}

			if(typeof response.match === 'function') {
				return response.match(sql, parameters);
			}

			return false;
		});
	}

	/**
	 * A plain `select ... from SCHEMA.TABLE` against a table the fixture declares returns that
	 * table's rows, delimited identifiers included - the schema browser's Data tab quotes every one.
	 *
	 * Two parts of the statement are honoured, because they decide which rows come back rather than
	 * what a row contains: OFFSET/FETCH FIRST, so a pager gets a page rather than the whole table, and
	 * the synthetic "$RRN" select-list alias, so a table with no primary key has something to key its
	 * rows by. WHERE and ORDER BY are **ignored** - evaluating arbitrary user-written SQL is the line
	 * between a fixture and a database engine. A test that needs a specific subset declares it as a
	 * response instead, and a test that cares about either clause asserts on the statement text.
	 */
	private findTableRows(sql: string): Nullable<Record<string, unknown>[]> {
		if(!this.declared) {
			return undefined;
		}

		let normalized = CatalogResponder.normalize(sql);

		if(!normalized.startsWith('select') && !normalized.startsWith('with')) {
			return undefined;
		}

		let match = /\bfrom\s+(?:"?([a-z0-9_$#@]+)"?\.)?"?([a-z0-9_$#@]+)"?/.exec(normalized);

		if(!match) {
			return undefined;
		}

		let found = findTable(this.declared, match[1], match[2]);

		if(!found) {
			return undefined;
		}

		// RRN() of a view is an error on a real system whenever the view joins more than one table - the
		// fake refuses it for every view, so a query that would break on a join view breaks here too.
		if(found.isView && normalized.includes('as "$rrn"')) {
			throw FakeDriver.toError({
				message: `FakeDriver: RRN() is not valid for view ${found.schema.name}.${found.table.name}`,
				driverErrors: [{ code: -5001, state: '42703', message: 'RRN() of a view is not allowed.' }]
			});
		}

		let rows = normalized.includes('as "$rrn"')
			? found.table.rows.map(row => ({ ...row, $RRN: this.dml?.rowNumber(found.table, row) }))
			: found.table.rows;

		return FakeDriver.page(rows, normalized);
	}

	/** Applies `offset N rows` / `fetch first N rows only`, which is what makes paging observable. */
	private static page(rows: Record<string, unknown>[], normalized: string): Record<string, unknown>[] {
		let offset = /\boffset\s+(\d+)\s+rows?\b/.exec(normalized);
		let limit = /\bfetch\s+first\s+(\d+)\s+rows?\s+only\b/.exec(normalized);

		if(!offset && !limit) {
			return rows;
		}

		let start = offset ? Number(offset[1]) : 0;

		return rows.slice(start, limit ? start + Number(limit[1]) : undefined);
	}

	/** Builds the DbResult shape every driver returns, from plain row objects. */
	static toResult(rows: Record<string, unknown>[], columns?: DbColumnDefinition[]): DbResult {
		let result = <DbResult>Object.assign([...rows], {
			count: rows.length,
			columns: columns ?? FakeDriver.describeColumns(rows),
			statement: '',
			parameters: <Array<Parameter>>[],
			return: 0
		});

		return result;
	}

	/**
	 * Column metadata inferred from the rows themselves, since a fixture declares data rather than a
	 * result-set description. The first row decides the column list - which matches how a real result
	 * set works, and means a fixture with rows of differing shapes is reporting a bug in the fixture,
	 * not something to paper over.
	 */
	private static describeColumns(rows: Record<string, unknown>[]): DbColumnDefinition[] {
		return Object.keys(rows[0] ?? ({})).map(name => ({
			name: name,
			dataType: 12,
			dataTypeName: 'VARCHAR',
			columnSize: 256,
			decimalDigits: 0,
			nullable: true
		}));
	}

	/** Errors carry `driverErrors`, the same contract the ODBC driver meets - see DbDriver. */
	static toError(error: FakeDriver.ErrorSpec): Error {
		let thrown = <Error & { driverErrors?: DbErrorUtils.DbErrorDetail[] }>new Error(error.message);
		thrown.driverErrors = error.driverErrors;
		return thrown;
	}
}

class FakeDriverConnection implements DbDriverConnection {
	constructor(private driver: FakeDriver) { }

	async query(options: DbDriver.QueryOptions): Promise<Nullable<DbResult>> {
		return FakeDriver.toResult(await this.driver.resolve(options.sql, options.parameters));
	}

	/**
	 * A CALL returns the fixture's rows for it (usually none) and echoes its parameters back, which is
	 * what DbConnections.resolveProcedureOutParameters reads to report OUT/INOUT values. A response
	 * declaring its own `parameters` overrides the echo, so a test can return a different value than
	 * was passed in - which is the whole point of an OUT parameter.
	 */
	async callProcedure(options: DbDriver.CallProcedureOptions): Promise<Nullable<DbResult>> {
		let call = `call ${StringUtils.default(options.schema, () => '')}.${StringUtils.default(options.name, () => '')}`;
		let rows = await this.driver.resolve(call, options.parameters);
		let result = FakeDriver.toResult(rows);
		result.parameters = this.driver.findResponse(call, options.parameters)?.parameters ?? <Array<Parameter>>ArrayUtils.toArray(options.parameters);
		return result;
	}

	async openCursor(options: DbDriver.CursorOptions): Promise<DbCursor> {
		let rows = await this.driver.resolve(options.sql, options.parameters);
		return new FakeCursor(rows, options.fetchSize ?? this.driver.fetchSize);
	}

	async close(): Promise<void> { }
}

/**
 * Pages the resolved rows the way a real cursor does, so "Load More" and Fetch All are exercised for
 * real rather than stubbed: each fetch() returns at most fetchSize rows, and noData flips only once
 * a fetch has run off the end - matching node-odbc, where the final empty fetch is what reports the
 * cursor exhausted.
 */
class FakeCursor implements DbCursor {
	private position = 0;
	private _noData = false;
	private columns: DbColumnDefinition[];

	constructor(private rows: Record<string, unknown>[], private fetchSize: number) {
		this.columns = FakeDriver.toResult(rows).columns;
	}

	get noData(): boolean {
		return this._noData;
	}

	async fetch(): Promise<Nullable<DbResult>> {
		let batch = this.rows.slice(this.position, this.position + this.fetchSize);
		this.position += batch.length;
		this._noData = this.position >= this.rows.length;

		// Columns are described from the whole result, not just this batch, so a final empty batch
		// still reports the same columns the first one did.
		return FakeDriver.toResult(batch, this.columns);
	}

	async close(): Promise<void> {
		this._noData = true;
	}
}

export namespace FakeDriver {
	export interface Options {
		/** The declared database catalog queries and table selects are answered from. */
		database?: FakeDatabase;
		/** Statement-specific answers, checked before the database - see FakeDriver's resolution order. */
		responses?: Response[];
		/** Rows per cursor batch when a caller doesn't specify one. */
		fetchSize?: number;
		/**
		 * Called with every statement that reaches the driver, before it is resolved.
		 *
		 * Caching is the one behavior a fake can't demonstrate by its answers: a cache hit and a cache
		 * miss return the same rows, so "did this query the catalog again?" can only be answered by
		 * watching what reached the driver. Swapping in a driver rigged to fail can't answer it either
		 * once a session is already open, since that session's connection keeps the driver instance it
		 * was opened with.
		 */
		onStatement?: (sql: string, parameters?: Array<Parameter>) => void;
	}

	export interface Response {
		/** Matched against the statement with whitespace collapsed and case ignored. */
		sql?: string;
		/** Used when `sql` isn't set - a pattern or predicate against the raw statement. */
		match?: RegExp | ((sql: string, parameters?: Array<Parameter>) => boolean);
		rows?: Record<string, unknown>[];
		/** For a CALL: the parameter values to report back instead of echoing the ones passed in, which
		 * is how an OUT or INOUT parameter returns a value. */
		parameters?: Parameter[];
		/** Throws instead of returning rows, for testing the error paths. */
		error?: ErrorSpec;
		/** Delays the answer, for testing progress reporting and the render/execute serialization. */
		delayMs?: number;
	}

	export interface ErrorSpec {
		message: string;
		driverErrors?: DbErrorUtils.DbErrorDetail[];
	}
}
