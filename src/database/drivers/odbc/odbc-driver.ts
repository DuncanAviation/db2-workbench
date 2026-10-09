import type odbc from 'odbc';
import { DbErrorUtils } from '../../../utils/db-error-utils.js';
import { Nullable } from '../../../utils/nullable.js';
import { StringUtils } from '../../../utils/string-utils.js';
import { ConnectionStringUtils } from './connection-string-utils.js';
import { SortSequenceUtils } from '../../../utils/sort-sequence-utils.js';
import { DbCursor, DbDriver, DbDriverConnection, DbResult } from '../db-driver.js';
import { OdbcSetupAdvisor } from './odbc-setup-advisor.js';

/**
 * The ODBC implementation of DbDriver, and the only place in this repo that loads the `odbc`
 * package - everything ODBC-shaped (connection string syntax, SQLSTATE handling, the driver-manager
 * setup check, the bigint quirk) is confined to this folder so the rest of the workbench can be run
 * against a different driver, or against the fake driver in tests, without knowing ODBC exists.
 *
 * The package is imported lazily (see loadOdbc()) rather than at module load: `odbc` is a native
 * module, and a run that never opens an ODBC connection - a fake-driver test run, in particular -
 * should never pay for loading it, or require it to have built at all.
 */
export class OdbcDriver implements DbDriver {
	static readonly ID = 'odbc';
	static readonly DRIVER_NOT_FOUND_STATE = 'IM002';
	static readonly DRIVER_NOT_FOUND_MESSAGE_FRAGMENT = 'data source name not found and no default driver specified';

	static readonly DEFAULT_CONNECTION_STRING =
		`Driver={IBM i Access ODBC Driver}; ` +
		`Naming=1; ` +
		`DFTPKGLIB=SQLPKG; ` +
		`PKG=SQLPKG,2,1,0,512; ` +
		`CCSID=1208; ` + // Character encoding for UTF-8
		`BLOCKSIZE=512; ` +
		`CMT=0; ` + // Commitment set to immediate
		`KEEPALIVE=1; `;

	private odbcModule: Nullable<typeof odbc>;

	get id(): string {
		return OdbcDriver.ID;
	}

	get displayName(): string {
		return 'ODBC';
	}

	get defaultConnectionString(): string {
		return OdbcDriver.DEFAULT_CONNECTION_STRING;
	}

	async connect(options: DbDriver.ConnectOptions): Promise<DbDriverConnection> {
		let module = await this.loadOdbc();
		let connectionString = OdbcDriver.buildConnectionString(options);

		try {
			return new OdbcDriverConnection(await module.connect(connectionString));
		} catch(error) {
			throw OdbcDriver.normalizeError(error);
		}
	}

	async checkSetup(connectionString: string): Promise<DbDriver.SetupCheck> {
		let checkResult = await OdbcSetupAdvisor.checkAndAdvise(connectionString);

		return {
			detectionSupported: checkResult.detectionSupported,
			installed: checkResult.installed,
			driverName: StringUtils.isNotBlank(checkResult.driverName) ? <string>checkResult.driverName : undefined
		};
	}

	/**
	 * The ODBC Driver Manager reports SQLSTATE IM002 when the driver named in the connection string
	 * isn't registered on this machine - the root cause behind "[Microsoft][ODBC Driver Manager] Data
	 * source name not found and no default driver specified". The message check covers a driver
	 * manager that reported the text without the SQLSTATE.
	 */
	isSetupError(error: unknown): boolean {
		let errorLike = <{ message?: string }>error;
		let details = DbErrorUtils.extractDriverErrors(error);

		if(details?.some(detail => detail.state === OdbcDriver.DRIVER_NOT_FOUND_STATE)) {
			return true;
		}

		return !!errorLike?.message?.toLowerCase().includes(OdbcDriver.DRIVER_NOT_FOUND_MESSAGE_FRAGMENT);
	}

	withSortSequence(options: DbDriver.ConnectOptions, target: SortSequenceUtils.Identity, currentLanguageId: string): DbDriver.ConnectOptions {
		return {
			...options,
			connectionString: OdbcDriver.buildSortSequenceConnectionString(
				StringUtils.default(options.connectionString, () => OdbcDriver.DEFAULT_CONNECTION_STRING),
				target,
				currentLanguageId
			)
		};
	}

	/**
	 * Assembles the full ODBC connection string: the configured (or default) string with any
	 * System/Uid/Pwd the user happened to include stripped out, then this connection's own values
	 * appended so they can't collide.
	 */
	private static buildConnectionString(options: DbDriver.ConnectOptions): string {
		let connectionString = StringUtils.default(options.connectionString, () => OdbcDriver.DEFAULT_CONNECTION_STRING);
		let connectionProperties = ConnectionStringUtils.parseProperties(connectionString);
		connectionProperties = ConnectionStringUtils.removeProperties(connectionProperties, ['system', 'uid', 'pwd']);

		return connectionProperties.join(';') +
			`;` +
			`System=${options.host}; ` +
			`Uid=${options.userName}; ` +
			`Pwd=${options.password}; `;
	}

	/**
	 * Builds the connection string for a connection that must run under `target`'s sort sequence,
	 * starting from `baseConnectionString` with any existing sort/language keywords stripped so they
	 * can't collide with the ones added here.
	 *
	 * SYSIXADV never records which LanguageID a *LANGIDSHR/*LANGIDUNQ advisory was generated under, so
	 * `currentLanguageId` (the connection's own current LanguageID) is reused as a best-available
	 * stand-in - correct as long as the environment only ever runs one language.
	 */
	private static buildSortSequenceConnectionString(baseConnectionString: string, target: SortSequenceUtils.Identity, currentLanguageId: string): string {
		let properties = ConnectionStringUtils.parseProperties(baseConnectionString);
		properties = ConnectionStringUtils.removeProperties(properties, ['sortsequence', 'sortweight', 'languageid', 'sorttable']);
		properties.push(...OdbcDriver.buildSortKeywords(target, currentLanguageId));
		return properties.join('; ') + ';';
	}

	private static buildSortKeywords(target: SortSequenceUtils.Identity, currentLanguageId: string): string[] {
		switch(target.sortSequence) {
			case '*HEX':
				return ['SortSequence=0'];
			case '*LANGIDSHR':
				return ['SortSequence=2', `LanguageID=${currentLanguageId}`, 'SortWeight=0'];
			case '*LANGIDUNQ':
				return ['SortSequence=2', `LanguageID=${currentLanguageId}`, 'SortWeight=1'];
			default:
				// A custom sort sequence table rather than one of DB2 for i's symbolic SRTSEQ values.
				return ['SortSequence=3', `SortTable=${target.sortSequenceLibrary}/${target.sortSequence}`];
		}
	}

	private async loadOdbc(): Promise<typeof odbc> {
		if(!this.odbcModule) {
			this.odbcModule = (await import('odbc')).default;
		}

		return this.odbcModule;
	}

	/**
	 * Every driver owes its callers the DbDriver error contract: the driver-reported chain of parts
	 * on `driverErrors`. node-odbc reports that chain on `.odbcErrors`, so copy it across rather than
	 * replacing the error - the original object keeps its stack, and anything still reading
	 * `.odbcErrors` (an old cached history entry) keeps working.
	 */
	static normalizeError(error: any): any {
		if(error && Array.isArray(error.odbcErrors) && !error.driverErrors) {
			error.driverErrors = error.odbcErrors.map((detail: odbc.OdbcError) => ({ code: detail.code, state: detail.state, message: detail.message }));
		}

		return error;
	}

	/**
	 * Normalizes row values that don't survive JSON.stringify (used by webview postMessage() and
	 * JSON/CSV export) - e.g. BigInt for 64-bit integer columns. Mutates rows in place so the result
	 * array's extra properties (count, columns, etc.) are preserved. Add new conversions here as
	 * other unserializable ODBC types turn up.
	 */
	static sanitizeRows<T>(result: Nullable<odbc.Result<T>>): Nullable<DbResult<T>> {
		result?.forEach(row => {
			if(row == null || typeof row !== 'object') {
				return;
			}

			let record = <Record<string, unknown>>row;

			for(let column of Object.keys(record)) {
				let value = record[column];

				if(typeof value === 'bigint') {
					record[column] = value.toString();
				}
			}
		});

		return result;
	}
}

/** One open ODBC connection. Created by OdbcDriver.connect() - never constructed directly. */
class OdbcDriverConnection implements DbDriverConnection {
	constructor(private connection: odbc.Connection) { }

	async query(options: DbDriver.QueryOptions): Promise<Nullable<DbResult>> {
		try {
			let result = await this.connection.query(options.sql, <Array<number | string>>options.parameters);
			return OdbcDriver.sanitizeRows(result);
		} catch(error) {
			throw OdbcDriver.normalizeError(error);
		}
	}

	async callProcedure(options: DbDriver.CallProcedureOptions): Promise<Nullable<DbResult>> {
		try {
			let result = await this.connection.callProcedure(
				options.catalog ?? null,
				options.schema ?? null,
				<string>options.name,
				<Array<number | string>>options.parameters
			);

			return OdbcDriver.sanitizeRows(result);
		} catch(error) {
			throw OdbcDriver.normalizeError(error);
		}
	}

	async openCursor(options: DbDriver.CursorOptions): Promise<DbCursor> {
		try {
			let cursor = <odbc.Cursor>await this.connection.query(options.sql, <Array<number | string>>options.parameters, OdbcDriverConnection.toQueryOptions(options));
			return new OdbcDriverCursor(cursor);
		} catch(error) {
			throw OdbcDriver.normalizeError(error);
		}
	}

	async close(): Promise<void> {
		await this.connection.close();
	}

	/**
	 * node-odbc validates every key that is *present* on its query options, so an explicit
	 * `timeout: undefined` fails with "Connection.query options: .timeout must be a NUMBER value"
	 * rather than being treated as "not specified". Only the values the caller actually supplied are
	 * copied across.
	 */
	private static toQueryOptions(options: DbDriver.CursorOptions): odbc.CursorQueryOptions {
		let queryOptions: odbc.CursorQueryOptions = { cursor: true };

		if(options.fetchSize != null) {
			queryOptions.fetchSize = options.fetchSize;
		}

		if(options.timeout != null) {
			queryOptions.timeout = options.timeout;
		}

		if(options.initialBufferSize != null) {
			queryOptions.initialBufferSize = options.initialBufferSize;
		}

		return queryOptions;
	}
}

class OdbcDriverCursor implements DbCursor {
	constructor(private cursor: odbc.Cursor) { }

	get noData(): boolean {
		return this.cursor.noData;
	}

	async fetch(): Promise<Nullable<DbResult>> {
		try {
			let result = await this.cursor.fetch();
			return OdbcDriver.sanitizeRows(result);
		} catch(error) {
			throw OdbcDriver.normalizeError(error);
		}
	}

	async close(): Promise<void> {
		await this.cursor.close();
	}
}
