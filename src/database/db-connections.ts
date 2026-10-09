import { lastValueFrom } from 'rxjs';
import * as vscode from 'vscode';
import { ConnectionConfigEvent } from '../events/connection-config-event.js';
import { DbConnectionEvent } from '../events/db-connection-event.js';
import { Event } from '../events/event.js';
import { Extension } from '../extension.js';
import { ConnectionInfo } from '../interfaces/connection-info.js';
import { HistoryParameter } from '../interfaces/history-parameter.js';
import { Parameter } from '../interfaces/parameter.js';
import { ProcedureOutParameter } from '../interfaces/procedure-out-parameter.js';
import { ProgressReport } from '../interfaces/progress-report.js';
import { ConnectionConfig } from '../models/connection-config.js';
import { ConnectionSchema } from '../models/connection-schema.js';
import { SystemProcedureParam } from '../models/system-procedure-param.js';
import { AlertUtils } from '../utils/alert-utils.js';
import { DuplicateColumnChecker } from '../utils/duplicate-column-checker.js';
import { Nullable } from '../utils/nullable.js';
import { ObjectComparator } from '../utils/object-comparator.js';
import { SpParser } from '../utils/sp-parser.js';
import { StatementParser } from '../utils/statement-parser.js';
import { StringUtils } from '../utils/string-utils.js';
import { Sync } from '../utils/sync.js';
import { TryUtils } from '../utils/try-utils.js';
import { DbConnection } from './db-connection.js';
import { DbResult } from './drivers/db-driver.js';

export class DbConnections implements vscode.Disposable {
	private static readonly CONNECT_ACTION = 'Connect';
	/** See getPassword() - only read when Extension.isTestMode. */
	static readonly TEST_PASSWORD_ENVIRONMENT_VARIABLE = 'DB2_WORKBENCH_TEST_PASSWORD';
	/** How many times getConnectionWrapperHelper() retries a failed connect before giving up. */
	private static readonly MAX_CONNECT_ATTEMPTS = 3;

	private _connectionsWrappers: Nullable<Map<string, ConnectionWrapper>>;
	private _fetchAllCancellationSources: Nullable<Map<string, vscode.CancellationTokenSource>>;

	// Sessions (document uris) that have already been shown promptToConnect()'s notification -- so
	// a session with no connection open yet gets it once, not once per keystroke.
	private _contentAssistPrompted: Nullable<Set<string>>;

	// Sessions that were closed on purpose, and not reopened by the user since. A key stays here until
	// allowConnect() (or connect()) removes it, and while it is here getConnectionWrapper() will not open a
	// connection for it. That is what stops work that was already running when its session closed - a
	// results render labelling its headings, the connection-time warm-up, a saved SQL import - from quietly
	// reopening a connection nothing will ever close again. Keys are reused (a reopened file has the same
	// uri, a schema browser or diagram session is keyed by its config), so the only thing that tells a
	// reopen from leftover work is whether a user action asked for it. A key that has never been closed is
	// not here at all, so first access still opens lazily, as it always has.
	private _closedKeys: Nullable<Set<string>>;

	constructor(private extension: Extension) {
		extension.disposableManager.add(this, vscode.workspace.onDidChangeConfiguration(event => {
			if(event.affectsConfiguration(`${Extension.ID}.connections`)) {
				this.onConfigChange();
			}
		}));
	}

	private get connectionWrappers(): Map<string, ConnectionWrapper> {
		return this._connectionsWrappers ??= new Map();
	}

	private get contentAssistPrompted(): Set<string> {
		return this._contentAssistPrompted ??= new Set();
	}

	private get closedKeys(): Set<string> {
		return this._closedKeys ??= new Set();
	}

	/**
	 * Lets a session closed earlier open again. Call it from the places a user starts something on a
	 * session - running SQL, opening a schema browser or diagram, choosing Connect - and nowhere else:
	 * background work that calls it defeats the whole point (see closedKeys). A key that was never closed
	 * needs no call.
	 */
	allowConnect(key: string): void {
		this.closedKeys.delete(key);
	}

	/** allowConnect() plus establishing the connection - for a user action whose whole job is to connect. */
	async connect(options: DbConnections.CommonListOptions): Promise<Nullable<ConnectionConfig>> {
		this.allowConnect(options.key);
		return this.getConnectionConfig(options);
	}

	private get fetchAllCancellationSources(): Map<string, vscode.CancellationTokenSource> {
		return this._fetchAllCancellationSources ??= new Map();
	}

	private async getConnectionWrapper(key: string, configId?: string): Promise<Nullable<ConnectionWrapper>> {
		if(!key) {
			return;
		}

		let wrapper = this.connectionWrappers.get(key);

		// A closed session reports "no connection" exactly as a connection that couldn't be opened does:
		// internalQuery returns nothing, and MemoryCache treats that as a failed lookup and caches nothing.
		if(wrapper != null || this.closedKeys.has(key)) {
			return wrapper;
		}

		return lastValueFrom(Sync.get(`db-connections-${key}`, async () => {
			return this.getConnectionWrapperHelper(key, configId);
		}));
	}

	private async getConnectionWrapperHelper(key: string, configId?: string): Promise<Nullable<ConnectionWrapper>> {
		let configuration = StringUtils.isNotBlank(configId)
			? this.extension.configurations.connections.find(config => config.id === configId)
			: await this.getConfiguration();

		if(configuration == null) {
			return;
		}

		let wrapper: Nullable<ConnectionWrapper>;
		let attempts = 0;

		// The loop exists to re-prompt after a wrong password (establishConnection wipes the cached one
		// on failure), so it assumed a failed connect always means "ask again". A failure the user
		// can't fix by retyping - an unreachable host, a driver that can't answer the connection-time
		// lookups - would otherwise spin here forever, since getPassword keeps handing back the same
		// answer. Bounded so a connection that simply can't be opened reports its error instead.
		while(wrapper?.connection?.state !== DbConnection.State.OPEN && attempts < DbConnections.MAX_CONNECT_ATTEMPTS) {
			attempts++;
			let password = await this.getPassword(configuration);

			if(StringUtils.isBlank(password)) {
				return;
			}

			this.extension.eventManager.fire({ type: Event.Type.DB_CONNECTION, eventType: DbConnectionEvent.EventType.CONNECTING, key: key, configuration: configuration });

			wrapper = await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: configuration.name,
				cancellable: false
			}, async (progress) => {
				progress.report({ message: 'Connecting...' });
				return this.establishConnection(key, configuration, <string>password, progress);
			});
		}

		// Out of attempts with nothing open - the ERROR event establishConnection already fired is the
		// report, so this just declines to cache a failure as if it were a session.
		if(wrapper == null) {
			return;
		}

		this.connectionWrappers.set(key, <ConnectionWrapper>wrapper);

		// Closed while it was still connecting - a tab shut during the password prompt or the connect
		// itself. close() found nothing to close then, so this connection has no owner: close it now
		// rather than hand it back.
		if(this.closedKeys.has(key)) {
			await this.close({ key: key });
			return;
		}

		TryUtils.forgetPromise({
			context: `db-connections getConnectionWrapper()`,
			promise: async () => {
				await this.extension.memoryCache.getTables({ key: key, configId: configuration.id });

				// Saved SQL schema imports run as soon as the connection is up, right behind the table scan
				// they depend on, so the tree already carries their tables the first time a panel opens. Runs
				// on the worker connection and is deduped per host, so a second session on the same system
				// costs nothing - see SqlSchemaImports.ensureLoaded.
				await this.extension.sqlSchemaImports.ensureLoaded({ key: key, configId: configuration.id });
			},
			onError: error => AlertUtils.onError(error)
		});

		return wrapper;
	}

	private async establishConnection(key: string, configuration: ConnectionConfig, password: string, progress: vscode.Progress<ProgressReport>): Promise<Nullable<ConnectionWrapper>> {
		let startTime = Date.now();
		let connection = new DbConnection({ key: key, configuration: configuration, password: password, driver: this.extension.drivers.get(configuration) });
		let wrapper: Nullable<ConnectionWrapper>;

		try {
			await connection.connect();

			progress.report({ message: 'Getting job details...' });
			let jobDetails = await connection.getJobDetails();
			let workerJobDetails = await connection.getJobDetails(true);

			progress.report({ message: 'Getting schema list...' });
			let schemaList = await connection.getSchemaList();

			wrapper = {
				connection: connection,
				configuration: configuration,
				info: {
					jobDetails: jobDetails,
					workerJobDetails: workerJobDetails,
					schemas: schemaList
				}
			};

			this.extension.eventManager.fire({ type: Event.Type.DB_CONNECTION, eventType: DbConnectionEvent.EventType.CONNECTED, key: key, configuration: configuration, connectionInfo: wrapper.info, duration: Date.now() - startTime });
		} catch(error: any) {
			this.extension.eventManager.fire({ type: Event.Type.DB_CONNECTION, eventType: DbConnectionEvent.EventType.ERROR, key: key, configuration: configuration, duration: Date.now() - startTime, error: error });
			await this.extension.secrets.delete(configuration);
		}

		return wrapper;
	}

	private async getConfiguration(): Promise<Nullable<ConnectionConfig>> {
		let connections = this.extension.configurations.connections;

		if(connections.length === 0) {
			AlertUtils.onError('You need to configure a database connection first');
			return;
		}

		if(connections.length === 1) {
			return connections[0];
		}

		let items = connections.map(config => ({
			label: config.name,
			description: config.host,
			detail: config.userName,
			config
		}));

		let cancelItem = { label: 'Cancel', alwaysShow: true };

		let selected = await vscode.window.showQuickPick([...items, cancelItem], {
			placeHolder: 'Select a database to connect to'
		});

		if(!selected || selected === cancelItem) {
			return undefined;
		}

		return (<{ config: ConnectionConfig }>selected).config;
	}

	async getPassword(config: ConnectionConfig): Promise<Nullable<string>> {
		// A headless integration run has nobody to answer showInputBox() below, and the loop in
		// getConnectionWrapperHelper() would hang rather than fail. In test mode the password is taken
		// from the environment instead - the fake driver accepts anything, and a test pointed at a real
		// connection can supply a working one.
		if(this.extension.isTestMode) {
			return StringUtils.default(process.env[DbConnections.TEST_PASSWORD_ENVIRONMENT_VARIABLE], () => 'test');
		}

		let password = await this.extension.secrets.get(config);

		if(StringUtils.isNotBlank(password)) {
			return password;
		}

		password = await vscode.window.showInputBox({
			prompt: `Enter password for ${config?.userName}@${config.host}`,
			password: true,
			ignoreFocusOut: true
		});

		if(password != null) {
			await this.extension.secrets.store({ ...config, password: password });
		}

		return password;
	}

	async execute(options: DbConnections.ExecuteOptions): Promise<void> {
		if(options == null || options?.key == null || options?.sql == null) {
			return;
		}

		// Running a statement is always something the user asked for, whichever caller passes it on.
		this.allowConnect(options.key);

		let wrapper = await this.getConnectionWrapper(options.key, options.configId);

		if(wrapper == null) {
			return;
		}

		if(wrapper.connection.state !== DbConnection.State.OPEN) {
			AlertUtils.onError('Your connection is not ready to execute a statement');
			return;
		}

		// A new query supersedes any fetchAll() loop still running for this key - stop it before
		// openCursor() replaces the cursor out from under it.
		this.cancelFetchAll(options);

		let parseResults = StatementParser.parse(options.sql);

		if(parseResults == null || !parseResults.isValid) {
			return;
		}

		let startTime = Date.now();
		let procedureSchema: Nullable<string>;

		try {
			this.extension.eventManager.fire({ type: Event.Type.DB_CONNECTION, eventType: DbConnectionEvent.EventType.EXECUTING, key: options.key, configuration: wrapper.configuration, connectionInfo: wrapper.info, parseResults: parseResults });

			let result = await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: wrapper.configuration.name,
				cancellable: false
			}, async (progress) => {
				if(parseResults.statementType === StatementParser.StatementType.SP) {
					procedureSchema = await this.resolveCallSchema(options, parseResults);
					progress.report({ message: 'Executing call...' });
					return wrapper.connection.callProcedure({ ...parseResults, schema: procedureSchema, parameters: options.parameters ?? parseResults.parameters });
				}

				progress.report({ message: 'Executing query...' });
				await wrapper.connection.openCursor({ sql: parseResults.originalSql, fetchSize: this.extension.configurations.cursorFetchSize, parameters: options.parameters });
				return <DbResult<Record<string, unknown>>>await wrapper.connection.fetch();
			});

			let duplicateColumns = DuplicateColumnChecker.check(result?.columns)?.duplicateNames;

			let procedureOutParameters = parseResults.statementType === StatementParser.StatementType.SP
				? await this.resolveProcedureOutParameters({ key: options.key, configId: options.configId }, { ...parseResults, schema: procedureSchema }, result)
				: undefined;

			this.extension.eventManager.fire({ type: Event.Type.DB_CONNECTION, eventType: DbConnectionEvent.EventType.RESULT, key: options.key, configuration: wrapper.configuration, connectionInfo: wrapper.info, parseResults: parseResults, duration: Date.now() - startTime, result: result, isCursorOpen: wrapper.connection.isCursorOpen, historyParameters: options.historyParameters, duplicateColumns: duplicateColumns, procedureOutParameters: procedureOutParameters, isInternal: options.isInternal });
		} catch(error: any) {
			this.extension.eventManager.fire({ type: Event.Type.DB_CONNECTION, eventType: DbConnectionEvent.EventType.ERROR, key: options.key, configuration: wrapper.configuration, connectionInfo: wrapper.info, parseResults: parseResults, duration: Date.now() - startTime, error: error, historyParameters: options.historyParameters, isInternal: options.isInternal });

			// If the connection was lost, clear the cached connection so the user can re-authenticate
			if(error.message && (error.message.includes('connection') || error.message.includes('comm'))) {
				await this.close({ key: options.key });
			}
		} finally {
			this.extension.eventManager.fire({ type: Event.Type.DB_CONNECTION, eventType: DbConnectionEvent.EventType.READY, key: options.key, configuration: wrapper.configuration, connectionInfo: wrapper.info, parseResults: parseResults });
		}
	}

	/**
	 * The schema to hand the driver for a CALL. An unqualified name is resolved against the library list
	 * here because the driver would otherwise look the procedure up with no schema at all, count the
	 * parameters of every same-named procedure on the system, and refuse the call when the name exists in
	 * more than one schema. A qualified name, or one the library list can't resolve, goes through as
	 * typed - the latter so the driver still reports the call's own error.
	 */
	private async resolveCallSchema(options: DbConnections.CommonListOptions, parseResults: SpParser.SpParseResults): Promise<Nullable<string>> {
		if(parseResults.schema || parseResults.catalog || !parseResults.name) {
			return parseResults.schema;
		}

		return this.extension.memoryCache.resolveProcedureSchema({ key: options.key, configId: options.configId, procedure: parseResults.name });
	}

	/**
	 * Pairs a completed CALL's DbResult.parameters (the final, post-execution values for every
	 * position the call passed) with that procedure's catalog metadata (name/mode/data type per
	 * position), keeping only OUT/INOUT positions - IN values are already visible in the CALL
	 * statement text itself. Position-matched by array index: both the values array and the
	 * (position-ordered) metadata array line up with the CALL's own parameter list as typed, so this
	 * only works out correctly if the statement supplied every leading parameter up to the last
	 * OUT/INOUT one it cares about. Returns undefined (rather than []) whenever there's nothing to
	 * show, so callers can pass it straight through without an extra emptiness check.
	 */
	private async resolveProcedureOutParameters(options: DbConnections.CommonListOptions, parseResults: SpParser.SpParseResults, result: Nullable<DbResult>): Promise<ProcedureOutParameter[] | undefined> {
		if(!result || !result.parameters?.length || !parseResults.name) {
			return undefined;
		}

		let procedureParams: SystemProcedureParam[];

		try {
			procedureParams = await this.extension.memoryCache.getProcedureParams({ key: options.key, configId: options.configId, schema: parseResults.schema, procedure: <string>parseResults.name });
		} catch {
			// Procedure/schema couldn't be resolved against the catalog (e.g. a name typo, or a
			// procedure the connected user can't see) - nothing to show rather than surfacing a
			// second error on top of whatever the CALL itself already reported.
			return undefined;
		}

		// DbResult.parameters is typed as Array<number|string>, but a BIGINT OUT/INOUT parameter
		// comes back as a real bigint at runtime (same driver quirk DbConnection.sanitizeRows works
		// around for row values) - widen the element type here so the bigint check below type-checks.
		let rawParameters = <Array<number | string | bigint | null>>(<unknown>result.parameters);

		let outParameters = rawParameters
			.map((value, index) => ({ value, meta: procedureParams[index] }))
			.filter((entry): entry is { value: number | string | bigint | null; meta: SystemProcedureParam } =>
				entry.meta != null && !StringUtils.equalsIgnoreCase(entry.meta.parameterMode, 'IN'))
			.map(entry => (<ProcedureOutParameter>{
				name: entry.meta.name,
				mode: entry.meta.parameterMode,
				dataType: entry.meta.dataType,
				length: entry.meta.length,
				scale: entry.meta.scale,
				value: typeof entry.value === 'bigint' ? entry.value.toString() : entry.value
			}));

		return outParameters.length > 0 ? outParameters : undefined;
	}

	/**
	 * Runs `options.sql` on a temporary, throwaway connection configured to match a specific sort
	 * sequence, rather than the session's normal connection - needed by IndexQueries.executeCreateIndex
	 * (and any future DDL with the same constraint) when generated DDL must be created under a sort
	 * sequence different from the one the session's connection is currently running under, since DB2
	 * for i bakes the connection's sort sequence into certain objects at creation time. The temporary
	 * connection deliberately bypasses connectionWrappers/EventManager - it never appears as a session
	 * in its own right in the sidebar/bottom panel, and is always closed before this method returns.
	 * The statement itself is still reported through the target session's own events (options.key), so
	 * it shows up in that session's History tab like any other executed statement, isInternal: true for
	 * the same reason internalQuery()'s results are.
	 */
	async runOnSortSequenceConnection(options: DbConnections.SortSequenceQueryOptions): Promise<void> {
		let wrapper = await this.getConnectionWrapper(options.key, options.configId);

		if(wrapper == null) {
			return;
		}

		let password = await this.getPassword(wrapper.configuration);

		if(StringUtils.isBlank(password)) {
			return;
		}

		let temporaryConfiguration: ConnectionConfig = { ...wrapper.configuration, id: `${wrapper.configuration.id}-temp-sort-sequence` };

		// The driver decides what pinning a sort sequence means for its own connection settings (see
		// DbDriver.withSortSequence) - a driver that can't do it throws on connect() below rather than
		// silently creating the object under the wrong sequence.
		let temporaryConnection = new DbConnection({
			key: `${options.key}-temp-sort-sequence`,
			configuration: temporaryConfiguration,
			password: <string>password,
			driver: this.extension.drivers.get(wrapper.configuration),
			sortSequence: {
				sortSequence: options.sortSequence,
				sortSequenceLibrary: options.sortSequenceLibrary,
				currentLanguageId: wrapper.info.jobDetails.languageId
			}
		});
		let parseResults = StatementParser.classify(options.sql);

		try {
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: wrapper.configuration.name,
				cancellable: false
			}, async (progress) => {
				progress.report({ message: `Connecting with sort sequence ${options.sortSequence}...` });
				await temporaryConnection.connect();

				progress.report({ message: options.progressMessage ?? 'Executing statement...' });
				let startTime = Date.now();

				try {
					let result = await temporaryConnection.query({ sql: options.sql });
					this.extension.eventManager.fire({ type: Event.Type.DB_CONNECTION, eventType: DbConnectionEvent.EventType.RESULT, key: options.key, configuration: wrapper.configuration, connectionInfo: wrapper.info, parseResults: parseResults, duration: Date.now() - startTime, result: result, isCursorOpen: wrapper.connection.isCursorOpen, isInternal: true });
				} catch(error: any) {
					this.extension.eventManager.fire({ type: Event.Type.DB_CONNECTION, eventType: DbConnectionEvent.EventType.ERROR, key: options.key, configuration: wrapper.configuration, connectionInfo: wrapper.info, parseResults: parseResults, duration: Date.now() - startTime, error: error, isInternal: true });
				}
			});
		} catch(error) {
			// Only a connect() failure reaches here - a query failure is caught and reported above as
			// a normal ERROR history entry instead, and doesn't rethrow.
			AlertUtils.onError(error);
		} finally {
			await temporaryConnection.close();
		}
	}

	async fetch(options: DbConnections.FetchOptions): Promise<void> {
		if(options == null || options?.key == null) {
			return;
		}

		let wrapper = await this.getConnectionWrapper(options.key, options.configId);

		if(wrapper == null || !wrapper.connection.isCursorOpen) {
			return;
		}

		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: wrapper.configuration.name,
			cancellable: false
		}, async (progress) => {
			progress.report({ message: 'Fetching...' });
			await this.fetchBatch(options.key, wrapper);
		});
	}

	/**
	 * Fetches the rest of an open cursor's rows in a loop under a single cancellable progress
	 * notification, rather than one progress popup per batch. Rows already fetched before a
	 * cancellation (via the notification's own button or cancelFetchAll()) are left in place -
	 * this only stops fetching further, it never discards what's already been delivered.
	 */
	async fetchAll(options: DbConnections.FetchOptions): Promise<void> {
		if(options == null || options?.key == null) {
			return;
		}

		let wrapper = await this.getConnectionWrapper(options.key, options.configId);

		if(wrapper == null || !wrapper.connection.isCursorOpen) {
			return;
		}

		let cancellationSource = new vscode.CancellationTokenSource();
		this.fetchAllCancellationSources.set(options.key, cancellationSource);

		try {
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: wrapper.configuration.name,
				cancellable: true
			}, async (progress, token) => {
				token.onCancellationRequested(() => cancellationSource.cancel());

				let fetchedCount = 0;
				progress.report({ message: 'Fetching all remaining rows...' });

				while(wrapper.connection.isCursorOpen && !cancellationSource.token.isCancellationRequested) {
					let batchCount = await this.fetchBatch(options.key, wrapper);

					if(batchCount === undefined) {
						break;
					}

					fetchedCount += batchCount;
					progress.report({ message: `Fetched ${fetchedCount} rows so far...` });
				}
			});
		} finally {
			this.fetchAllCancellationSources.delete(options.key);
			cancellationSource.dispose();
		}
	}

	/**
	 * Signals an in-progress fetchAll() to stop after its current batch. A no-op if nothing is
	 * running for this key (e.g. it already finished).
	 */
	cancelFetchAll(options: DbConnections.FetchOptions): void {
		this.fetchAllCancellationSources.get(options.key)?.cancel();
	}

	private async fetchBatch(key: string, wrapper: ConnectionWrapper): Promise<number | undefined> {
		let startTime = Date.now();
		let result: Nullable<DbResult>;
		this.extension.eventManager.fire({ type: Event.Type.DB_CONNECTION, eventType: DbConnectionEvent.EventType.FETCHING, key: key, configuration: wrapper.configuration, connectionInfo: wrapper.info });

		try {
			result = await wrapper.connection.fetch();

			if(result == null) {
				throw new Error(`No results from fetch`);
			}

			this.extension.eventManager.fire({ type: Event.Type.DB_CONNECTION, eventType: DbConnectionEvent.EventType.FETCHED, key: key, configuration: wrapper.configuration, connectionInfo: wrapper.info, duration: Date.now() - startTime, result: result, isCursorOpen: wrapper.connection.isCursorOpen });
			return result.length;
		} catch(error: any) {
			this.extension.eventManager.fire({ type: Event.Type.DB_CONNECTION, eventType: DbConnectionEvent.EventType.ERROR, key: key, configuration: wrapper.configuration, connectionInfo: wrapper.info, duration: Date.now() - startTime, error: error });
			return undefined;
		} finally {
			this.extension.eventManager.fire({ type: Event.Type.DB_CONNECTION, eventType: DbConnectionEvent.EventType.READY, key: key, configuration: wrapper.configuration, connectionInfo: wrapper.info });
		}
	}

	// Public so the per-domain query classes under src/database/queries/ (TableQueries, IndexQueries,
	// etc.) can run their own hardcoded catalog SQL, and simple worker-connection mutations (e.g.
	// IndexQueries.deleteIndex), over the worker connection without needing access to
	// ConnectionWrapper/getConnectionWrapper - both stay private to this class.
	async internalQuery(options: DbConnections.QueryOptions): Promise<Nullable<DbResult>> {
		let wrapper = await this.getConnectionWrapper(options.key, options.configId);

		if(wrapper == null) {
			return;
		}

		let startTime = Date.now();
		let parseResults = StatementParser.classify(options.sql);

		// Internal queries only ever bind plain positional "?" values (schema/table names, etc.) -
		// there's no ":name" marker or resolved dataType to carry, so the History tab's markers/values
		// toggle just needs each value quoted as a literal (buildValuesSql() ignores `name` for the
		// "?" case, and an undefined dataType already formats as a quoted string literal).
		let historyParameters: HistoryParameter[] | undefined = options.parameters?.length
			? options.parameters.map(value => ({ name: '', value: String(value) }))
			: undefined;

		try {
			let result = await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: wrapper.configuration.name,
				cancellable: false
			}, async (progress) => {
				progress.report({ message: options.progressMessage ?? 'Executing worker query...' });
				return wrapper.connection.query({ ...options, useWorkerConnection: true });
			});

			this.extension.eventManager.fire({ type: Event.Type.DB_CONNECTION, eventType: DbConnectionEvent.EventType.RESULT, key: options.key, configuration: wrapper.configuration, connectionInfo: wrapper.info, parseResults: parseResults, duration: Date.now() - startTime, result: result, isCursorOpen: wrapper.connection.isCursorOpen, historyParameters: historyParameters, isInternal: true });
			return result;
		} catch(error: any) {
			this.extension.eventManager.fire({ type: Event.Type.DB_CONNECTION, eventType: DbConnectionEvent.EventType.ERROR, key: options.key, configuration: wrapper.configuration, connectionInfo: wrapper.info, parseResults: parseResults, duration: Date.now() - startTime, error: error, historyParameters: historyParameters, isInternal: true });
			options.onError?.(error);
		}
	}

	forgetClose(options: DbConnections.CloseOptions) {
		TryUtils.forgetPromise({
			context: 'db-connections forgetClose()',
			promise: () => this.close(options)
		});
	}

	async close(options: DbConnections.CloseOptions): Promise<void> {
		if(options == null || options?.key == null) {
			return;
		}

		this.contentAssistPrompted.delete(options.key);

		// Before the wrapper check, not after: a session closed while it is still connecting has no wrapper
		// yet, and the tombstone is what tells getConnectionWrapperHelper to discard it when it lands.
		this.closedKeys.add(options.key);

		let wrapper = this.connectionWrappers.get(options.key);

		if(wrapper == null) {
			return;
		}

		// Stop any in-flight fetchAll() loop before tearing down the connection it's reading from.
		this.cancelFetchAll(options);

		await wrapper.connection.close();
		this.connectionWrappers.delete(options.key);

		// Memory cache is shared by connection config, not by session (see MemoryCache), so it should
		// only be dropped once no other open session (e.g. another SQL tab on the same connection) is
		// still relying on it.
		let stillInUse = Array.from(this.connectionWrappers.values()).some(other => other.configuration.id === wrapper.configuration.id);

		if(!stillInUse) {
			await this.extension.memoryCache.deleteConnectionCache({ ...options, configId: wrapper.configuration.id });
		}

		// A SQL schema import's rows are cached per HOST, not per config (see SqlSchemaImports), so they
		// only go once no session anywhere is still on that host - another config pointed at the same
		// system, or the same one under a different user name, is still entitled to them.
		let hostStillInUse = Array.from(this.connectionWrappers.values()).some(other => StringUtils.equalsIgnoreCase(other.configuration.host, wrapper.configuration.host));

		if(!hostStillInUse) {
			this.extension.sqlSchemaImports.deleteHostCache(wrapper.configuration.host);
		}

		this.extension.eventManager.fire({ type: Event.Type.DB_CONNECTION, eventType: DbConnectionEvent.EventType.CLOSED, key: options.key, configuration: wrapper.configuration, connectionInfo: wrapper.info });
	}

	async listConnectionSchemas(options: DbConnections.ListConnectionSchemasOptions): Promise<ConnectionSchema[]> {
		let wrapper = await this.getConnectionWrapper(options.key, options.configId);

		if(wrapper == null) {
			return [];
		}

		return wrapper?.info.schemas;
	}

	// Synchronous and non-establishing, unlike getConnectionConfig/getConnectionWrapper -- just
	// peeks at whether this session already has an open connection, without prompting for one. Lets
	// a caller that reacts to keystrokes (content assist, EditorUtils.updateCacheForStatement's
	// cache warm-up) check this first and call promptToConnect() below instead of resolving a
	// connection outright, which would otherwise interrupt typing with a connection/password prompt
	// on a not-yet-connected session's very first keystroke.
	hasActiveConnection(key: string): boolean {
		return this.connectionWrappers.get(key) != null;
	}

	// Shows a one-time, non-blocking notice for this session (document uri) that content assist
	// needs a connection, with a "Connect" action that starts the normal connect flow (QuickPick +
	// password prompt) for it -- so establishing the connection stays a deliberate user action
	// rather than a side effect of typing. Repeat calls for the same key before it closes (see
	// close() below) are no-ops; once shown, it isn't shown again for that session.
	promptToConnect(key: string): void {
		if(this.contentAssistPrompted.has(key)) {
			return;
		}

		this.contentAssistPrompted.add(key);

		TryUtils.forgetPromise({
			context: `db-connections promptToConnect(${key})`,
			promise: async () => {
				let selection = await vscode.window.showInformationMessage('Connect to enable SQL content assist.', DbConnections.CONNECT_ACTION);

				if(selection === DbConnections.CONNECT_ACTION) {
					await this.connect({ key: key });
				}
			},
			onError: error => AlertUtils.onError(error)
		});
	}

	async getConnectionConfig(options: DbConnections.CommonListOptions): Promise<Nullable<ConnectionConfig>> {
		let wrapper = await this.getConnectionWrapper(options.key, options.configId);
		return wrapper?.configuration;
	}

	async pickConnectionConfig(): Promise<Nullable<ConnectionConfig>> {
		return this.getConfiguration();
	}

	async getConnectionInfo(options: DbConnections.CommonListOptions): Promise<Nullable<ConnectionInfo>> {
		let wrapper = await this.getConnectionWrapper(options.key, options.configId);
		return wrapper?.info;
	}

	private onConfigChange() {
		let connectionConfigs = this.extension.configurations.connections;
		let connectionWrappers = Array.from(this.connectionWrappers.values());
		let deletedConnections: ConnectionConfig[] = [];
		let updatedConnections: ObjectComparator<ConnectionConfig>[] = [];

		connectionWrappers.forEach(connectionWrapper => {
			let foundConfig = connectionConfigs.find(connectionConfig => connectionConfig.id === connectionWrapper.configuration.id);

			if(foundConfig) {
				let comparator = new ObjectComparator(foundConfig, { ...connectionWrapper.configuration });

				if(comparator.hasDifferences) {
					// Before the clone below overwrites it: a SQL import's rows are cached under the host, and
					// which imports this connection links can have changed too. Handed the previous config
					// explicitly, since a moment later there is no record of what it used to be.
					this.extension.sqlSchemaImports.applyConnectionChange(
						{ key: connectionWrapper.connection.key, configId: foundConfig.id },
						comparator.object2,
						foundConfig
					);

					// In place rather than replacing the object: everything holding this wrapper's
					// configuration sees the new settings, and a setting the edit removed is gone.
					let configuration = <Record<string, unknown>><unknown>connectionWrapper.configuration;
					Object.keys(configuration).forEach(key => delete configuration[key]);
					Object.assign(configuration, structuredClone(foundConfig));

					if(this.reconnectRequired(comparator)) {
						this.forgetReconnect(connectionWrapper.connection.key);
					}

					if(updatedConnections.every(updatedComparator => updatedComparator.object1.id !== comparator.object1.id)) {
						updatedConnections.push(comparator);
					}
				}
			} else {
				TryUtils.forgetPromise({
					context: 'db-connections onConfigChange()',
					promise: () => connectionWrapper.connection.close()
				});

				if(deletedConnections.every(deletedConfig => deletedConfig.id !== connectionWrapper.configuration.id)) {
					deletedConnections.push(connectionWrapper.configuration);
				}
			}
		});

		deletedConnections.forEach(connectionConfig => this.extension.eventManager.fire({ type: Event.Type.CONNECTION_CONFIG, eventType: ConnectionConfigEvent.EventType.DELETED, connectionConfig: connectionConfig }));
		updatedConnections.forEach(comparator => this.extension.eventManager.fire({ type: Event.Type.CONNECTION_CONFIG, eventType: ConnectionConfigEvent.EventType.UPDATED, connectionConfig: comparator.object1, comparator: comparator }));
	}

	private reconnectRequired(comparator: ObjectComparator<ConnectionConfig>): boolean {
		return comparator.hasDifference('host', 'userName', 'connectionString');
	}

	forgetReconnect(key: string) {
		TryUtils.forgetPromise({
			context: 'db-connections forgetReconnect()',
			promise: () => this.reconnect(key)
		});
	}

	private async reconnect(key: string): Promise<void> {
		await this.close({ key: key });
		this.allowConnect(key);
		await this.getConnectionWrapper(key);
	}

	async dispose(): Promise<void> {
		this.extension.disposableManager.dispose(this);
		let keys = Array.from(this.connectionWrappers.keys());

		if(keys.length === 0) {
			return;
		}

		await Promise.all(keys.map(key => this.close({ key: key })));
	}
}

interface ConnectionWrapper {
	connection: DbConnection;
	configuration: ConnectionConfig;
	info: ConnectionInfo;
}

export namespace DbConnections {
	export interface CommonExecuteOptions {
		key: string;
		/** Resolves which configured connection to establish for a brand-new key, bypassing
		 * getConfiguration()'s single-connection/QuickPick guess - needed when the caller already
		 * knows exactly which connection it wants (e.g. a right-click on a specific connection). Has
		 * no effect once a wrapper for this key already exists. */
		configId?: string;
	}

	export interface ExecuteOptions extends CommonExecuteOptions {
		sql: string;
		parameters?: Array<Parameter>;
		historyParameters?: HistoryParameter[];
		/** See DbConnectionEvent.isInternal - set this when running generated SQL against a schemas
		 * session (e.g. from the Advised Indexes tab), whose History tab only ever surfaces
		 * 'internalStatement' entries (see getAvailableHistoryCategories() in history-tab.tsx). */
		isInternal?: boolean;
	}

	/** Backs runOnSortSequenceConnection() - a temporary-connection variant of QueryOptions, since that
	 * method can't reuse internalQuery() (it runs on a throwaway connection outside the wrapper map,
	 * not the session's own worker connection). */
	export interface SortSequenceQueryOptions extends CommonExecuteOptions {
		sql: string;
		/** The target sort sequence - see SortSequenceUtils.Identity. */
		sortSequence: string;
		sortSequenceLibrary: string;
		progressMessage?: string;
	}

	export interface FetchOptions extends CommonExecuteOptions { }

	export interface QueryOptions extends CommonExecuteOptions, DbConnection.QueryOptions {
		/** Shown in the connecting/executing progress notification in place of the default "Executing
		 * worker query..." - lets callers (e.g. IndexQueries) describe what they're actually doing. */
		progressMessage?: string;
		/** Called with the raw thrown error when internalQuery's own query fails, right alongside the
		 * ERROR event it already fires - lets a caller that needs the actual error (not just a nullish
		 * result) get at it, e.g. DataQueries.executeStatements surfacing a driver error to the UI. */
		onError?: (error: any) => void;
	}

	export interface CloseOptions extends CommonExecuteOptions { }

	export interface CommonListOptions {
		/** Identifies this session for connection lifecycle purposes (opening/closing the underlying
		 * driver connection). Typically the uri from the file editor so that each open file has its own
		 * connection. MemoryCache lookups key off the resolved connection config instead, so two
		 * sessions pointed at the same connection share cached system-table data rather than each
		 * keying off this session key. */
		key: string;
		/** See CommonExecuteOptions.configId. */
		configId?: string;
	}

	export interface ListConnectionSchemasOptions extends CommonListOptions { }
}