import { lastValueFrom } from 'rxjs';
import { JobDetails } from '../interfaces/job-details.js';
import { ConnectionConfig } from '../models/connection-config.js';
import { ConnectionSchema } from '../models/connection-schema.js';
import { Nullable } from '../utils/nullable.js';
import { SortSequenceUtils } from '../utils/sort-sequence-utils.js';
import { Sync } from '../utils/sync.js';
import { DbCursor, DbDriver, DbDriverConnection, DbResult } from './drivers/db-driver.js';
import { DbDrivers } from './drivers/db-drivers.js';

/**
 * One session's pair of database connections plus the state the UI reports on. Everything below this
 * class is driver work (see DbDriver); everything this class adds is workbench policy - the
 * main/worker connection split, the single open cursor, the CONNECTING/EXECUTING/OPEN state the
 * event layer reports, and the two DB2 for i lookups every session needs on connect.
 */
export class DbConnection {
	private _key: string;
	private _state: Nullable<DbConnection.State>;
	private _connection: DbDriverConnection | undefined;
	private _workerConnection: DbDriverConnection | undefined;
	private cursor: DbCursor | undefined;

	constructor(private options: DbConnection.Options) {
		if(options?.configuration == null || options.password == null || options.driver == null) {
			throw new Error('A connection needs a configuration, a password and a driver');
		}

		this._key = options.key;
	}

	get key(): string {
		return this._key;
	}

	get state(): DbConnection.State {
		return this._state ??= DbConnection.State.CLOSED;
	}

	private setState(state: DbConnection.State, executeOptions?: DbConnection.ExecuteOptions) {
		if(executeOptions?.useWorkerConnection) {
			return;
		}

		this._state = state;
	}

	get configuration(): ConnectionConfig {
		return this.options.configuration;
	}

	get driver(): DbDriver {
		return this.options.driver;
	}

	/**
	 * Opens both connections this session needs - a main one that owns the result cursor, and a
	 * separate worker one for internal metadata queries (autocomplete, catalog lookups) so they can't
	 * interfere with an open cursor on the main connection.
	 */
	async connect(): Promise<void> {
		this.setState(DbConnection.State.CONNECTING);

		let connectOptions = this.buildConnectOptions();

		this._connection = await this.driver.connect(connectOptions);
		this._workerConnection = await this.driver.connect(connectOptions);
		this.setState(DbConnection.State.OPEN);
	}

	/**
	 * The driver-level options for this connection, pinned to a specific sort sequence when one was
	 * requested (see DbConnections.runOnSortSequenceConnection). A driver that can't pin a sort
	 * sequence fails loudly here rather than quietly connecting under the wrong one, which would bake
	 * the wrong sequence into anything the caller then creates.
	 */
	private buildConnectOptions(): DbDriver.ConnectOptions {
		let connectOptions = DbDrivers.toConnectOptions(this.options.configuration, this.options.password, this.driver);

		if(this.options.sortSequence == null) {
			return connectOptions;
		}

		let pinned = this.driver.withSortSequence?.(connectOptions, this.options.sortSequence, this.options.sortSequence.currentLanguageId);

		if(pinned == null) {
			throw new Error(`The ${this.driver.displayName} driver can't open a connection using the ${this.options.sortSequence.sortSequence} sort sequence`);
		}

		return <DbDriver.ConnectOptions>pinned;
	}

	async close(): Promise<void> {
		return lastValueFrom(Sync.get(`db-connection-delete-${this.configuration.id}`, async () => {
			return this.closeHelper();
		}));
	}

	private async closeHelper() {
		this.setState(DbConnection.State.CLOSED);
		await this.closeCursor();

		if(this._connection != null) {
			await this._connection.close();
			this._connection = undefined;
		}

		if(this._workerConnection != null) {
			await this._workerConnection.close();
			this._workerConnection = undefined;
		}
	}

	private get connection(): DbDriverConnection {
		if(!this._connection) {
			throw new Error(`You must connect to a database before running a query`);
		}

		return this._connection;
	}

	private get workerConnection(): DbDriverConnection {
		if(!this._workerConnection) {
			throw new Error(`You must connect to a database before running a query`);
		}

		return this._workerConnection;
	}

	async query(options: DbConnection.QueryOptions): Promise<Nullable<DbResult>> {
		this.setState(DbConnection.State.EXECUTING, options);

		try {
			let connection = options.useWorkerConnection ? this.workerConnection : this.connection;
			return await connection.query(options);
		} finally {
			this.setState(DbConnection.State.OPEN, options);
		}
	}

	async openCursor(options: DbConnection.OpenCursorOptions): Promise<void> {
		try {
			this.setState(DbConnection.State.EXECUTING, options);
			await this.closeCursor();
			this.cursor = await this.connection.openCursor(options);
		} finally {
			this.setState(DbConnection.State.OPEN, options);
		}
	}

	private async closeCursor(): Promise<void> {
		if(!this.cursor) {
			return;
		}

		try {
			await this.cursor.close();
		} catch { }

		this.cursor = undefined;
	}

	async fetch(): Promise<Nullable<DbResult>> {
		if(!this.cursor) {
			throw new Error(`You must first open a cursor`);
		}

		this.setState(DbConnection.State.EXECUTING);

		try {
			let results = await this.cursor.fetch();

			if(this.cursor.noData) {
				await this.closeCursor();
			}

			return results;
		} finally {
			this.setState(DbConnection.State.OPEN);
		}
	}

	get isCursorOpen(): boolean {
		return this.cursor !== undefined;
	}

	/** Whether this session's driver can stop a running statement - see DbDriverConnection.cancel. */
	get canCancel(): boolean {
		return this._connection?.cancel != null;
	}

	/**
	 * Asks the main connection to stop the statement it is running. The worker connection is left alone:
	 * it only runs internal lookups, which nothing offers to cancel.
	 */
	async cancel(): Promise<void> {
		await this._connection?.cancel?.();
	}

	async callProcedure(options: DbConnection.CallProcedureOptions): Promise<Nullable<DbResult>> {
		if(options.name == null) {
			return;
		}

		this.setState(DbConnection.State.EXECUTING, options);

		try {
			let connection = options.useWorkerConnection ? this.workerConnection : this.connection;
			// The driver looks the procedure up in the catalog by exact name, where DB2 stores ordinary
			// identifiers uppercase - "call appl.proc" (or a lowercase catalog) would otherwise find nothing
			return await connection.callProcedure({
				...options,
				catalog: options.catalog?.toUpperCase(),
				schema: options.schema?.toUpperCase(),
				name: (<string>options.name).toUpperCase()
			});
		} finally {
			this.setState(DbConnection.State.OPEN, options);
		}
	}

	async getJobDetails(useWorkerConnection?: boolean): Promise<JobDetails> {
		let results = <Record<string, unknown>[]>await this.query({
			sql: `select qsys2.job_name, a.v_client_ip_address, b.job_entered_system_time, b.sort_sequence_name, b.sort_sequence_library, b.language_id ` +
				`from table (qsys2.get_job_info('*')) a ` +
				`join table(qsys2.job_info(job_user_filter => '*ALL', job_status_filter => '*ALL')) b on b.job_name = qsys2.job_name`,
			useWorkerConnection: useWorkerConnection
		});

		if(results.length === 0) {
			throw new Error(`Unable to get job details for this connection`);
		}

		let firstRow = results[0];

		return <JobDetails>{
			jobName: firstRow['JOB_NAME'],
			ip: firstRow['V_CLIENT_IP_ADDRESS'],
			createdDate: new Date(<string>firstRow['JOB_ENTERED_SYSTEM_TIME']),
			sortSequence: firstRow['SORT_SEQUENCE_NAME'],
			sortSequenceLibrary: firstRow['SORT_SEQUENCE_LIBRARY'],
			languageId: firstRow['LANGUAGE_ID']
		};
	}

	async getSchemaList(): Promise<ConnectionSchema[]> {
		let results = <Record<string, unknown>[]>await this.query({
			sql: `select ordinal_position, system_schema_name, type, text_description from qsys2.library_list_info order by ordinal_position`
		});

		return results.map(row => {
			return <ConnectionSchema>{
				position: row['ORDINAL_POSITION'],
				name: row['SYSTEM_SCHEMA_NAME'],
				type: row['TYPE'],
				description: row['TEXT_DESCRIPTION']
			};
		});
	}
}

export namespace DbConnection {
	export enum State {
		CLOSED = 'closed',
		CONNECTING = 'connecting',
		OPEN = 'open',
		EXECUTING = 'executing'
	}

	export interface Options {
		key: string;
		configuration: ConnectionConfig;
		password: string;
		driver: DbDriver;
		/** Opens this connection pinned to a specific sort sequence rather than the job's default -
		 * only used by the throwaway connection DDL with a sort-sequence requirement runs on. */
		sortSequence?: SortSequenceUtils.Identity & { currentLanguageId: string };
	}

	export type ExecuteOptions = DbDriver.ExecuteOptions;
	export type QueryOptions = DbDriver.QueryOptions;
	export type OpenCursorOptions = DbDriver.CursorOptions;
	export type CallProcedureOptions = DbDriver.CallProcedureOptions;
}
