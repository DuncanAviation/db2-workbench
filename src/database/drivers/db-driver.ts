import { Parameter } from '../../interfaces/parameter.js';
import { DbErrorUtils } from '../../utils/db-error-utils.js';
import { Nullable } from '../../utils/nullable.js';
import { SortSequenceUtils } from '../../utils/sort-sequence-utils.js';

/**
 * The boundary between the workbench and whatever actually talks to the database. Everything above
 * this interface (DbConnection, DbConnections, MemoryCache, the queries classes, the views and the
 * webviews) is written against these types only - no ODBC concept, type or error shape leaks past
 * this file. The ODBC implementation lives in drivers/odbc/ and is the one place in the repo that
 * imports the `odbc` package; drivers/fake/ serves canned fixtures so the extension can be tested
 * with no database at all.
 *
 * A driver owns three normalizations on behalf of its callers, since only it knows its own wire
 * types:
 * - rows must be JSON-safe (postMessage/JSON.stringify reach them unchanged) - e.g. the ODBC driver
 *   converts BIGINT values from bigint to string;
 * - thrown errors must carry DbErrorUtils.DbErrorDetail[] on `driverErrors`, so every error surface
 *   (History tab, Test Connection) renders the driver's full reported chain rather than a collapsed
 *   `.message`;
 * - a result must expose the DbResult shape below, whatever its native result object looks like.
 */
export interface DbDriver {
	/** Stable identifier used by ConnectionConfig.driver and the DB2_WORKBENCH_DRIVER override. */
	readonly id: string;

	/** How this driver is named in the UI (connection editor, error messages). */
	readonly displayName: string;

	/** Used when a ConnectionConfig doesn't supply its own connectionString. */
	readonly defaultConnectionString: string;

	connect(options: DbDriver.ConnectOptions): Promise<DbDriverConnection>;

	/**
	 * Optional, driver-specific "is this machine set up to use me?" check - the ODBC driver reports
	 * whether the connection string's driver is registered, and presents its own setup guidance. A
	 * driver that needs no local setup (the fake driver, a pure-network driver) simply doesn't
	 * implement this, and callers must treat an absent implementation as "nothing to check" rather
	 * than assuming ODBC.
	 */
	checkSetup?(connectionString: string): Promise<DbDriver.SetupCheck>;

	/**
	 * Optional. True when a caught error means this driver isn't set up on the machine (rather than
	 * the statement or the database being at fault), so the caller can offer setup guidance instead
	 * of showing a raw driver message. A driver without local setup doesn't implement this.
	 */
	isSetupError?(error: unknown): boolean;

	/**
	 * Optional. True when a failed connect means the host refused the sign-on (wrong password, unknown
	 * or disabled user, expired password), as opposed to a host that couldn't be reached. Only then is
	 * the stored password deleted: a password the user saved on purpose shouldn't be lost to a network
	 * outage. A driver that doesn't implement this has every connect failure treated as a sign-on
	 * failure, which re-prompts rather than retrying a bad password against the host.
	 */
	isAuthenticationError?(error: unknown): boolean;

	/**
	 * Optional. Returns the ConnectOptions for a connection pinned to `target`'s sort sequence, used
	 * when DB2 for i would otherwise bake the wrong sort sequence into a created object (see
	 * IndexQueries.executeCreateIndex). A driver that can't pin a sort sequence returns undefined,
	 * and the caller reports that rather than silently running under the wrong sequence.
	 */
	withSortSequence?(options: DbDriver.ConnectOptions, target: SortSequenceUtils.Identity, currentLanguageId: string): Nullable<DbDriver.ConnectOptions>;
}

/**
 * One open connection. The workbench opens two per session - a main connection that owns the result
 * cursor, and a worker connection for internal metadata queries that must not disturb it - but that
 * pairing is a workbench decision made above this interface, not something a driver implements.
 */
export interface DbDriverConnection {
	query(options: DbDriver.QueryOptions): Promise<Nullable<DbResult>>;

	callProcedure(options: DbDriver.CallProcedureOptions): Promise<Nullable<DbResult>>;

	/** Opens a server-side cursor. Closing the returned cursor is the caller's job. */
	openCursor(options: DbDriver.CursorOptions): Promise<DbCursor>;

	/**
	 * Optional. Asks the database to stop whatever is running on this connection, and the running call
	 * then rejects with the driver's own cancellation error, on `driverErrors` like any other. Resolves
	 * once the request is made, not once the statement has stopped: a database may only notice at its
	 * next checkpoint, or finish the statement anyway. A no-op when nothing is running. A driver that
	 * can't cancel doesn't implement this, and callers then offer no Cancel at all.
	 */
	cancel?(): Promise<void>;

	close(): Promise<void>;
}

/** A paged result set. `fetch()` returns the next batch; `noData` reports that the last one landed. */
export interface DbCursor {
	readonly noData: boolean;
	fetch(): Promise<Nullable<DbResult>>;
	close(): Promise<void>;
}

/**
 * A result set: the rows themselves, plus the metadata a driver reports alongside them. Deliberately
 * shaped like odbc.Result so the ODBC driver can hand its own object back with no copying, but every
 * field here is one the workbench actually reads (row count and column names in the results view and
 * schema imports, `parameters` for a CALL's OUT/INOUT values) rather than a passthrough of one
 * driver's API.
 */
export interface DbResult<T = unknown> extends Array<T> {
	/** Rows affected/returned as the driver reports it - not always the same as `length`, which is
	 * the size of the batch actually delivered. */
	count: number;
	columns: DbColumnDefinition[];
	statement?: string;
	/** For a CALL, the final post-execution value at every parameter position. */
	parameters?: Array<Parameter>;
	return?: number;
}

/**
 * One output column's metadata, as the driver describes it. `name` is the only field consumed today
 * (result headings, duplicate-column detection, schema import mapping); the rest are kept because a
 * driver can already report them and a future consumer (column typing, export) would otherwise have
 * to re-query the catalog for what the driver already knew.
 */
export interface DbColumnDefinition {
	name: string;
	dataType: number;
	dataTypeName: string;
	columnSize: number;
	decimalDigits: number;
	nullable: boolean;
}

export namespace DbDriver {
	/**
	 * How callProcedure() refuses a CALL whose argument count differs from the procedure's parameter
	 * count - node-odbc's own wording, "and and" included, which FakeDriver reproduces. node-odbc counts
	 * every procedure of the name, so an overloaded one is always refused (see DbConnections.runCall).
	 */
	export const OVERLOAD_MISMATCH_MESSAGE = 'The number of parameters the procedure expects and and the number of passed parameters is not equal';

	/**
	 * What a driver needs to open a connection, as separate values rather than a pre-built string, so
	 * a non-ODBC driver (JDBC, a native IBM i driver) can build its own URL/handshake from the same
	 * ConnectionConfig instead of parsing ODBC syntax.
	 */
	export interface ConnectOptions {
		host: string;
		userName: string;
		password: string;
		/** Extra driver-specific settings exactly as the user configured them (an ODBC connection
		 * string today). Absent means the driver's own defaultConnectionString. */
		connectionString?: string;
	}

	export interface ExecuteOptions {
		/** Runs on the session's worker connection instead of its main one, so an internal metadata
		 * query can't disturb an open result cursor. */
		useWorkerConnection?: boolean;
	}

	export interface QueryOptions extends ExecuteOptions {
		sql: string;
		parameters?: Array<Parameter>;
	}

	export interface CursorOptions extends QueryOptions {
		/** Rows per fetch() batch - the db2-workbench.cursorFetchSize setting. */
		fetchSize?: number;
		timeout?: number;
		initialBufferSize?: number;
	}

	export interface CallProcedureOptions extends ExecuteOptions {
		catalog?: string;
		schema?: string;
		name?: string;
		parameters?: Array<Parameter>;
	}

	/** Result of DbDriver.checkSetup(). */
	export interface SetupCheck {
		/** False when this platform/driver can't tell one way or the other - callers must not treat
		 * `installed: false` as meaningful unless this is true. */
		detectionSupported: boolean;
		installed: boolean;
		/** The driver name the check looked for, when it could be determined. */
		driverName?: string;
	}

	/** The error shape every driver is required to throw - see the contract on DbDriver. */
	export interface Error extends globalThis.Error {
		driverErrors?: DbErrorUtils.DbErrorDetail[];
	}
}
