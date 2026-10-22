import { concatMap, Subject } from 'rxjs';
import * as vscode from 'vscode';
import { DbColumnDefinition, DbDriver } from '../database/drivers/db-driver.js';
import { CatalogLookupError } from '../database/queries/catalog-lookup.js';
import { ConnectionConfigEvent } from '../events/connection-config-event.js';
import { DbConnectionEvent } from '../events/db-connection-event.js';
import { Event } from '../events/event.js';
import { Extension } from '../extension.js';
import { ConnectionInfo } from '../interfaces/connection-info.js';
import { HistoryParameter } from '../interfaces/history-parameter.js';
import { ProcedureOutParameter } from '../interfaces/procedure-out-parameter.js';
import { Row } from '../interfaces/row.js';
import { ConnectionConfig } from '../models/connection-config.js';
import { SystemColumn } from '../models/system-column.js';
import { AlertUtils } from '../utils/alert-utils.js';
import { ColumnDetails, ColumnDetailsUtils } from '../utils/column-details.js';
import { ColumnNameUtils } from '../utils/column-name-utils.js';
import { EditorUtils } from '../utils/editor-utils.js';
import { ExportUtils } from '../utils/export-utils.js';
import { ExportWriteUtils } from '../utils/export-write-utils.js';
import { DbErrorUtils } from '../utils/db-error-utils.js';
import { Nullable } from '../utils/nullable.js';
import { ParameterParser } from '../utils/parameter-parser.js';
import { DiagramUtils } from '../utils/diagram-utils.js';
import { SchemasUtils } from '../utils/schemas-utils.js';
import { StatementParser } from '../utils/statement-parser.js';
import { StringUtils } from '../utils/string-utils.js';
import { TryUtils } from '../utils/try-utils.js';
import { WebviewHtmlUtils } from '../utils/webview-html-utils.js';
import { ExportDataMessage, ResultsAppState, ResultsInboundMessage, ResultsInitialState, ResultsOutboundMessage, ResultsParameterFocusRequest, ResultsSessionDetail, ResultsSessionSummary, ResultsSqlHistory, SessionsStateMessage } from '../webview-messages/results-messages.js';

export class WorkbenchViewProvider implements vscode.WebviewViewProvider {
	private static readonly TITLE = 'DB2 Workbench';
	private static readonly FETCH_ALL_FLUSH_INTERVAL_MS = 500;
	private static readonly FETCH_ALL_FLUSH_ROW_THRESHOLD = 2000;

	private view?: vscode.WebviewView;
	private _additionalPanels?: Set<vscode.WebviewPanel>;
	private eventListener?: vscode.Disposable;
	private _sqlSessions?: Map<string, WorkbenchViewProvider.SqlSession>;
	private activeUri?: string;
	private _renderSubject?: Subject<() => Promise<void>>;

	constructor(private extension: Extension) {
		this.eventListener = extension.eventManager.onEvent(event => this.onEvent(event));

		extension.subscriptionManager.add(WorkbenchViewProvider.name, this.renderSubject
			.pipe(
				concatMap(async promise => await promise())
			)
			.subscribe()
		);

		// Sync the view when the user switches to another editor that already has a session.
		// A .sql file with no session yet (no query run) shouldn't blank out whatever session is
		// currently displayed - onConnecting/onExecuting will switch to it once it actually runs one.
		vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor && editor.document.languageId === 'sql') {
				let uri = editor.document.uri.toString();

				if (this.activeUri !== uri && this.sqlSessions.has(uri)) {
					this.setActiveUri(uri);
				}
			}
		});

		vscode.window.tabGroups.onDidChangeTabs(event => {
			event.closed.forEach(tab => {
				if(tab.input instanceof vscode.TabInputText) {
					this.closeSession(tab.input.uri.toString());
				}
			});
		});
	}

	private get additionalPanels(): Set<vscode.WebviewPanel> {
		return this._additionalPanels ??= new Set();
	}

	private get sqlSessions(): Map<string, WorkbenchViewProvider.SqlSession> {
		return this._sqlSessions ??= new Map();
	}

	private getSessions(configId: string): WorkbenchViewProvider.SqlSession[] {
		return Array.from(this.sqlSessions.values())
			.filter(sqlSession => sqlSession.configuration.id === configId);
	}

	private get renderSubject(): Subject<() => Promise<void>> {
		return this._renderSubject ??= new Subject();
	}

	private get appState(): ResultsAppState {
		if(this.extension.configurations.connections.length === 0) {
			return 'noConnections';
		}

		if(this.activeSession == null) {
			return 'noResults';
		}

		return 'results';
	}

	private establishCurrentSession(dbConnectionEvent: DbConnectionEvent): WorkbenchViewProvider.SqlSession {
		let uri = <string>dbConnectionEvent.key;
		let currentSession = this.sqlSessions.get(uri);

		if(currentSession == null) {
			let isSchemas = SchemasUtils.isSchemasKey(uri);
			// A diagram session is metadata-only in exactly the same way a schemas session is - every query
			// it runs is an internal system-table lookup, never a user-typed statement - and, like a schemas
			// session, it's scoped and labelled per connection (DiagramUtils.buildKey), shared by every open
			// diagram pointed at that connection rather than one session per document.
			let isDiagram = DiagramUtils.isDiagramKey(uri);
			let sessionName: string;

			if(isSchemas) {
				sessionName = SchemasUtils.label(dbConnectionEvent.configuration.name);
			} else if(isDiagram) {
				sessionName = DiagramUtils.label(dbConnectionEvent.configuration.name);
			} else {
				let openTabs = EditorUtils.getOpenEditorTabs('.sql');
				let tab = openTabs.find(findTab => findTab.input.uri.toString() === uri);
				sessionName = tab?.label ?? dbConnectionEvent.configuration.name;
			}

			currentSession = <WorkbenchViewProvider.SqlSession>{
				uri: uri,
				name: sessionName,
				sessionKind: isSchemas ? 'schemas' : (isDiagram ? 'diagram' : 'editor'),
				configuration: dbConnectionEvent.configuration,
				state: WorkbenchViewProvider.SqlSessionState.READY,
				rows: [],
				originalSql: dbConnectionEvent.parseResults?.originalSql,
				duration: dbConnectionEvent.duration,
				isCursorOpen: dbConnectionEvent.isCursorOpen,
				histories: []
			};

			this.sqlSessions.set(uri, currentSession);
		}

		return currentSession;
	}

	private onEvent(event: Event) {
		if(event.type === Event.Type.CONNECTION_CONFIG) {
			this.onConnectionConfigEvent(<ConnectionConfigEvent>event);
		} else if(event.type === Event.Type.DB_CONNECTION) {
			this.onDbConnectionEvent(<DbConnectionEvent>event);
		}
	}

	private onConnectionConfigEvent(event: ConnectionConfigEvent) {
		if(this.appState === 'noConnections') {
			this.render();
			return;
		}

		if(event.eventType === ConnectionConfigEvent.EventType.DELETED) {
			this.getSessions(event.connectionConfig.id).forEach(sqlSession => this.closeSession(sqlSession.uri));
			return;
		}

		if(event.comparator == null) {
			return;
		}

		if(event.comparator.hasDifference('resultBorderColor')) {
			this.getSessions(event.connectionConfig.id).forEach(sqlSession => sqlSession.configuration.resultBorderColor = event.connectionConfig.resultBorderColor);
			this.render();
		}
	}

	private onDbConnectionEvent(event: DbConnectionEvent) {
		if(!event.key) {
			return;
		}

		if(event.eventType === DbConnectionEvent.EventType.CONNECTING) {
			this.onConnecting(event);
		} else if(event.eventType === DbConnectionEvent.EventType.CONNECTED) {
			this.onConnected(event);
		} else if(event.eventType === DbConnectionEvent.EventType.EXECUTING) {
			this.onExecuting(event);
		} else if(event.eventType === DbConnectionEvent.EventType.ERROR) {
			this.onError(event);
		} else if(event.eventType === DbConnectionEvent.EventType.FETCHED) {
			this.onFetched(event);
		} else if(event.eventType === DbConnectionEvent.EventType.RESULT) {
			this.onResult(event);
		} else if(event.eventType === DbConnectionEvent.EventType.LIBRARY_LIST_CHANGED) {
			this.onLibraryListChanged(event);
		}
	}

	// Only the connection tab changes. Open results keep their column labels: they describe what the
	// statement resolved against when it ran.
	private onLibraryListChanged(dbConnectionEvent: DbConnectionEvent) {
		let currentSession = this.sqlSessions.get(dbConnectionEvent.key);

		if(currentSession == null) {
			return;
		}

		currentSession.connectionInfo = dbConnectionEvent.connectionInfo;
		this.render();
	}

	private onConnecting(dbConnectionEvent: DbConnectionEvent) {
		let currentSession = this.establishCurrentSession(dbConnectionEvent);
		currentSession.state = WorkbenchViewProvider.SqlSessionState.CONNECTING;
		currentSession.rows = [];
		currentSession.isCursorOpen = false;
		currentSession.duplicateColumns = undefined;
		currentSession.columnDefinitions = undefined;
		this.setActiveUri(currentSession.uri);
	}

	private onConnected(dbConnectionEvent: DbConnectionEvent) {
		let currentSession = this.establishCurrentSession(dbConnectionEvent);
		currentSession.state = WorkbenchViewProvider.SqlSessionState.READY;
		currentSession.rows = [];
		currentSession.isCursorOpen = false;
		currentSession.connectionInfo = dbConnectionEvent.connectionInfo;
		this.setActiveUri(currentSession.uri);

		this.addHistory(currentSession, {
			date: new Date(),
			type: WorkbenchViewProvider.SqlHistoryType.CONNECTION,
			duration: dbConnectionEvent.duration,
			error: dbConnectionEvent.error
		});

		// The connection is now actually open, unlike at CONNECTING time (when establishCurrentSession
		// first creates the session) - column/procedure-param metadata lookups for the Parameters tab
		// can only succeed from here on, so (re)resolve now rather than waiting for the next keystroke.
		this.forgetRefreshParameters(currentSession.uri);
	}

	private onExecuting(dbConnectionEvent: DbConnectionEvent) {
		let currentSession = this.establishCurrentSession(dbConnectionEvent);
		currentSession.state = WorkbenchViewProvider.SqlSessionState.EXECUTING;
		currentSession.rows = [];
		currentSession.isCursorOpen = false;
		currentSession.duplicateColumns = undefined;
		currentSession.columnDefinitions = undefined;
		currentSession.procedureOutParameters = undefined;
		this.setActiveUri(currentSession.uri);
	}

	private onResult(dbConnectionEvent: DbConnectionEvent) {
		let currentSession = this.establishCurrentSession(dbConnectionEvent);

		let rowCount: Nullable<number>;

		if((dbConnectionEvent.result?.count ?? 0) > 0) {
			rowCount = dbConnectionEvent.result?.count;
		} else if((dbConnectionEvent.result?.length ?? 0) > 0) {
			rowCount = dbConnectionEvent.result?.length;
		}

		this.addHistory(currentSession, {
			date: new Date(),
			type: WorkbenchViewProvider.SqlHistoryType.RESULT,
			sql: dbConnectionEvent.parseResults?.originalSql,
			duration: dbConnectionEvent.duration,
			rowCount: rowCount,
			parameters: dbConnectionEvent.historyParameters,
			isInternal: dbConnectionEvent.isInternal
		});

		// An internal (worker-connection) query's result is only ever relevant to the history log -
		// it must not overwrite the rows/cursor of whatever the user's own query left on the main
		// connection, and it shouldn't force the results view to switch to this session. It still
		// needs a render() though, or the new history entry sits in memory unseen until some other
		// event happens to re-render this session (e.g. a schemas session's own eager tables lookup,
		// which otherwise never shows up in its History tab).
		if(dbConnectionEvent.isInternal) {
			this.render();
			return;
		}

		currentSession.state = WorkbenchViewProvider.SqlSessionState.READY;
		currentSession.rows = <Row[]>dbConnectionEvent.result;
		currentSession.isCursorOpen = dbConnectionEvent.isCursorOpen;
		currentSession.duplicateColumns = dbConnectionEvent.duplicateColumns;
		// The driver's own description of the result set - its type names right-align the numeric columns
		// in the Data tab, and describe a computed column (one with no catalog entry) in its header tooltip.
		currentSession.columnDefinitions = dbConnectionEvent.result?.columns;
		currentSession.procedureOutParameters = dbConnectionEvent.procedureOutParameters;

		// Always re-resolve (not just when session.parameters is still empty) - a prior attempt may
		// have already populated entries with an unresolved dataType (e.g. attempted too early, or
		// before referenced metadata was cached), and an emptiness check alone would never retry it.
		this.forgetRefreshParameters(currentSession.uri);

		this.setActiveUri(currentSession.uri);
	}

	private onFetched(dbConnectionEvent: DbConnectionEvent) {
		let currentSession = this.sqlSessions.get(dbConnectionEvent.key);

		if(currentSession == null) {
			return;
		}

		let newRows = <Row[]>dbConnectionEvent.result;
		currentSession.state = WorkbenchViewProvider.SqlSessionState.READY;
		currentSession.rows ??= [];
		currentSession.rows.push(...newRows);
		currentSession.isCursorOpen = dbConnectionEvent.isCursorOpen;

		// Only broadcast to webviews if the current view is for this URI
		if (this.activeUri !== dbConnectionEvent.key) {
			return;
		}

		if (currentSession.isFetchingAll) {
			// fetchAll() calls this in a tight loop - sending one addRows message per batch would make
			// the webview's reducer re-copy its whole (growing) rows array on every single batch. Buffer
			// batches and flush on an interval/size threshold instead, to keep that cost bounded.
			currentSession.pendingRowsBuffer ??= [];
			currentSession.pendingRowsBuffer.push(...newRows);

			if (currentSession.pendingRowsBuffer.length >= WorkbenchViewProvider.FETCH_ALL_FLUSH_ROW_THRESHOLD) {
				this.flushPendingRows(currentSession);
			} else {
				this.schedulePendingFlush(currentSession);
			}

			return;
		}

		this.broadcastMessage({
			command: 'addRows',
			rows: newRows,
			isCursorOpen: !!dbConnectionEvent.isCursorOpen
		});
	}

	private schedulePendingFlush(session: WorkbenchViewProvider.SqlSession): void {
		if (session.pendingFlushTimer) {
			return;
		}

		session.pendingFlushTimer = setTimeout(() => {
			session.pendingFlushTimer = undefined;
			this.flushPendingRows(session);
		}, WorkbenchViewProvider.FETCH_ALL_FLUSH_INTERVAL_MS);
	}

	private flushPendingRows(session: WorkbenchViewProvider.SqlSession): void {
		if (session.pendingFlushTimer) {
			clearTimeout(session.pendingFlushTimer);
			session.pendingFlushTimer = undefined;
		}

		let rows = session.pendingRowsBuffer;
		session.pendingRowsBuffer = undefined;

		// The active session may have changed since these rows were buffered - if so, drop the
		// flush. Nothing is lost: session.rows already has them, and switching back to this session
		// triggers a full render() that includes everything fetched so far.
		if (!rows || rows.length === 0 || this.activeUri !== session.uri) {
			return;
		}

		this.broadcastMessage({
			command: 'addRows',
			rows,
			isCursorOpen: !!session.isCursorOpen
		});
	}

	private onError(dbConnectionEvent: DbConnectionEvent) {
		let currentSession = this.establishCurrentSession(dbConnectionEvent);
		currentSession.state = WorkbenchViewProvider.SqlSessionState.READY;

		this.addHistory(currentSession, {
			date: new Date(),
			type: WorkbenchViewProvider.SqlHistoryType.ERROR,
			sql: dbConnectionEvent.parseResults?.originalSql,
			duration: dbConnectionEvent.duration,
			error: dbConnectionEvent.error,
			parameters: dbConnectionEvent.historyParameters,
			isInternal: dbConnectionEvent.isInternal
		});

		this.adviseOnDriverSetupIfNeeded(currentSession, dbConnectionEvent.error);

		// Same reasoning as onResult()'s isInternal branch - an internal query failing shouldn't
		// force the results view to switch to this session, but the error still needs to reach
		// whichever session's History tab is currently visible.
		if(dbConnectionEvent.isInternal) {
			this.render();
			return;
		}

		this.setActiveUri(currentSession.uri);
	}

	// Recognizes a failure that means the session's driver isn't set up on this machine (an
	// unregistered ODBC driver, today) and surfaces that driver's own setup guidance via a native
	// notification, once per session, rather than leaving the user to decode the raw driver message
	// in the History tab on their own. A driver with no local setup reports neither, and nothing is
	// shown.
	private adviseOnDriverSetupIfNeeded(session: WorkbenchViewProvider.SqlSession, error: any): void {
		let driver = this.extension.drivers.get(session.configuration);

		if(session.hasShownDriverSetupGuidance || !driver.isSetupError?.(error)) {
			return;
		}

		session.hasShownDriverSetupGuidance = true;

		TryUtils.forgetPromise({
			context: `WorkbenchViewProvider adviseOnDriverSetupIfNeeded(${session.uri})`,
			promise: () => <Promise<unknown>>driver.checkSetup?.(StringUtils.default(session.configuration.connectionString, () => driver.defaultConnectionString))
		});
	}

	private addHistory(session: WorkbenchViewProvider.SqlSession, history: WorkbenchViewProvider.SqlHistory) {
		session.histories.push(history);

		if(session.histories.length > this.extension.configurations.historyCount) {
			session.histories.shift();
		}
	}

	private setActiveUri(uri: string) {
		this.activeUri = uri;
		this.render();
	}

	private get activeSession(): Nullable<WorkbenchViewProvider.SqlSession> {
		if(!this.activeUri) {
			return;
		}

		return this.sqlSessions.get(this.activeUri);
	}

	getSession(uri: string): Nullable<WorkbenchViewProvider.SqlSession> {
		return this.sqlSessions.get(uri);
	}

	// Which session the results view is currently showing. Every other consumer of this today is a
	// webview, which reads it off the rendered session state instead - but "the active session
	// follows the active editor" is a rule of this class, not of the webview, so it needs to be
	// readable without one.
	get activeSessionUri(): Nullable<string> {
		return this.activeUri;
	}

	// this.view is only set once the webview view has actually been resolved, which VS Code defers
	// until the view is first made visible - if another panel tab (Terminal/Output) is showing on
	// launch, this.view is still undefined. The `<viewId>.focus` command VS Code auto-generates for
	// every contributed view forces that resolution, but its `preserveFocus` argument isn't part of
	// the documented API and doesn't reliably control focus for a panel-located webview view - so
	// it's only used here to force resolution; the actual focus decision always goes through the
	// officially documented WebviewView.show(preserveFocus), once this.view is guaranteed set.
	private async ensureViewResolved(): Promise<void> {
		if(this.view == null) {
			await vscode.commands.executeCommand('db2-workbench.sqlResultsView.focus', {preserveFocus: true});
		}
	}

	reveal(): void {
		TryUtils.forgetPromise({
			context: 'WorkbenchViewProvider reveal()',
			promise: async () => {
				await this.ensureViewResolved();
				this.view?.show(true);
			}
		});
	}

	// The focus request travels as part of the session state (parameterFocusRequest, included in
	// every buildSessionDetail()/render()) rather than as a separate message - the Parameters tab
	// re-checks it whenever session state updates and applies it once `parameters` actually
	// includes the target key, so this doesn't need to be sequenced relative to whatever
	// (re)populates session.parameters (e.g. the caller's own refreshParameters() call).
	focusParametersTab(uri: string, parameterKey?: string): void {
		let session = this.sqlSessions.get(uri);

		if(session != null) {
			session.parameterFocusRequest = {nonce: (session.parameterFocusRequest?.nonce ?? 0) + 1, parameterKey};
		}

		this.setActiveUri(uri);

		// Takes real focus (preserveFocus: false) - a blocked execute means the user needs to type
		// into a parameter field right away.
		TryUtils.forgetPromise({
			context: 'WorkbenchViewProvider focusParametersTab()',
			promise: async () => {
				await this.ensureViewResolved();
				this.view?.show(false);
			}
		});
	}

	// Fire-and-forget wrapper for refreshParameters - used right after the connection is confirmed
	// open (onConnected/onResult), where a thrown metadata-lookup error shouldn't interrupt the
	// caller's own event handling.
	private forgetRefreshParameters(uri: string): void {
		TryUtils.forgetPromise({
			context: `WorkbenchViewProvider refreshParameters(${uri})`,
			promise: () => this.refreshParameters(uri)
		});
	}

	// No-ops if no session exists yet for this uri (the Parameters tab is session-scoped, same as
	// Connection/History/Data). Column/procedure-param metadata lookups need an open connection, so
	// this is only reliably useful once called from onConnected/onResult (right after the connection
	// is confirmed open) or from a document edit on an already-established session - calling it at
	// session-creation time (CONNECTING) would be too early and silently resolve nothing.
	async refreshParameters(uri: string): Promise<void> {
		let session = this.sqlSessions.get(uri);

		if(session == null) {
			return;
		}

		let document = vscode.workspace.textDocuments.find(findDocument => findDocument.uri.toString() === uri);

		if(document == null) {
			return;
		}

		session.parameters = await ParameterParser.resolveDocumentParameters(this.extension, uri, document);
		session.parameterValues ??= ({});
		this.render();
	}

	resolveWebviewView(webviewView: vscode.WebviewView) {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extension.context.extensionUri, 'dist')]
		};

		webviewView.webview.onDidReceiveMessage(
			message => this.onMessage(message),
			null,
			this.extension.context.subscriptions
		);

		webviewView.onDidDispose(() => this.dispose());

		this.getPanelHtml(webviewView.webview).then(html => {
			webviewView.webview.html = html;
		}, error => AlertUtils.onError(error));
	}

	private async onMessage(message: ResultsOutboundMessage): Promise<void> {
		if (message.command === 'setLibraryList') {
			await this.setLibraryList(message.uri, message.userLibraries);
		} else if (message.command === 'checkLibrary') {
			await this.checkLibrary(message.uri, message.requestId, message.library);
		} else if (message.command === 'loadMore') {
			await this.extension.connections.fetch({key: <string>this.activeUri});
		} else if (message.command === 'selectSession') {
			this.setActiveUri(message.uri);
		} else if (message.command === 'addConnection') {
			await vscode.commands.executeCommand('db2-workbench.addConnection');
		} else if (message.command === 'fetchAll') {
			await this.startFetchAll(<string>this.activeUri);
		} else if (message.command === 'cancelFetchAll') {
			this.extension.connections.cancelFetchAll({key: <string>this.activeUri});
		} else if (message.command === 'exportData') {
			await this.handleExportData(<string>this.activeUri, message);
		} else if (message.command === 'reconnect') {
			let session = this.sqlSessions.get(message.uri);

			// A shared diagram session can't just take DbConnections.reconnect()'s generic
			// close-then-reopen-whatever-getConfiguration()-resolves path (see
			// DiagramEditorProvider.reconnectSharedSession's own comment for why) - it needs to always
			// prompt, and only actually reconnect when the same connection is re-chosen.
			if(session?.sessionKind === 'diagram') {
				await this.extension.diagramEditorProvider.reconnectSharedSession(message.uri, session.name);
			} else {
				this.extension.connections.forgetReconnect(message.uri);
			}
		} else if (message.command === 'executeSql') {
			// Not the plain executeSql command - that resolves "which statement" from the active
			// editor's live cursor position, which there isn't one of once focus is in this webview.
			this.extension.commands.executeFromParametersTab(<string>this.activeUri);
		} else if (message.command === 'setParameterValue') {
			let session = this.activeSession;

			if (session == null) {
				return;
			}

			session.parameterValues ??= ({});
			session.parameterValues[message.key] = message.value;
			this.render();
		} else if (message.command === 'checkDriverSetup') {
			let session = this.activeSession;

			if (session == null) {
				return;
			}

			let driver = this.extension.drivers.get(session.configuration);
			await driver.checkSetup?.(StringUtils.default(session.configuration.connectionString, () => driver.defaultConnectionString));
		}
	}

	// The new list itself reaches the webview through the LIBRARY_LIST_CHANGED render, like any other session
	// change; the answer only closes the dialog, or keeps it open on the error. A refusal (CPF2110 for a
	// missing library, a limited-capability user) goes back to the dialog rather than to a toast, so its
	// driver chain can be read and copied there.
	private async setLibraryList(uri: string, userLibraries: string[]): Promise<void> {
		let session = this.sqlSessions.get(uri);
		let error: Nullable<DbErrorUtils.SerializedError>;

		try {
			await this.extension.connections.setLibraryList({key: uri, configId: session?.configuration.id}, userLibraries);
		} catch(caught) {
			error = DbErrorUtils.serialize(caught);
		}

		this.broadcastMessage({command: 'libraryListResult', uri: uri, error: error});
	}

	// On the worker connection (every catalog lookup is), so it answers whatever the main job is doing.
	private async checkLibrary(uri: string, requestId: number, library: string): Promise<void> {
		let session = this.sqlSessions.get(uri);
		let exists = false;
		let error: Nullable<DbErrorUtils.SerializedError>;

		try {
			let found = await this.extension.catalogQueries.listExistingLibraries({key: uri, configId: session?.configuration.id, progressMessage: 'Checking the library...'}, [library.toUpperCase()]);
			exists = found.length > 0;
		} catch(caught) {
			error = DbErrorUtils.serialize(caught instanceof CatalogLookupError ? caught.driverError ?? caught : caught);
		}

		this.broadcastMessage({command: 'libraryCheckResult', uri: uri, requestId: requestId, exists: exists, error: error});
	}

	private async startFetchAll(uri: string): Promise<void> {
		let session = this.sqlSessions.get(uri);

		if (session == null || session.isFetchingAll) {
			return;
		}

		session.isFetchingAll = true;
		this.render();

		try {
			await this.extension.connections.fetchAll({key: uri});
		} finally {
			session.isFetchingAll = false;
			this.flushPendingRows(session);
			this.render();
		}
	}

	private async handleExportData(uri: string, message: ExportDataMessage): Promise<void> {
		let session = this.sqlSessions.get(uri);

		if (session == null) {
			return;
		}

		if (message.what === 'all' && session.isCursorOpen) {
			await this.startFetchAll(uri);
		}

		let rows = message.what === 'filtered' ? message.filteredRows ?? [] : message.what === 'selected' ? message.selectedRows ?? [] : session.rows;
		let {columns, columnLabels} = await this.resolveColumnsAndLabels(session);

		let content = message.format === 'csv'
			? ExportUtils.toCsv({rows, columns, headings: ExportUtils.buildHeadings(columns, columnLabels)})
			: ExportUtils.toJson({rows, columns});

		await ExportWriteUtils.write({
			content: content,
			fileExtension: message.format,
			filterLabel: message.format === 'csv' ? 'CSV' : 'JSON',
			defaultFileName: ExportUtils.buildDefaultFileName(session.configuration.host, message.format),
			destination: message.destination,
			clipboardMessage: `${rows.length} row${StringUtils.getPlural(rows.length)} copied to the clipboard.`,
			fileMessage: path => `${rows.length} row${StringUtils.getPlural(rows.length)} exported to ${path}.`
		});
	}

	private render() {
		this.renderSubject.next(() => this.onRender());
	}

	private async onRender(): Promise<void> {
		try {
			let message = await this.buildSessionsStateMessage();
			this.broadcastMessage(message);
		} catch(error) {
			AlertUtils.onError(error);
		}
	}

	private broadcastMessage(message: ResultsInboundMessage): void {
		this.view?.webview.postMessage(message);

		this.additionalPanels.forEach(panel => {
			panel.webview.postMessage(message);
		});
	}

	private async buildInitialState(): Promise<ResultsInitialState> {
		let message = await this.buildSessionsStateMessage();

		return {
			appState: message.appState,
			extensionName: Extension.NAME,
			sessions: message.sessions,
			activeUri: message.activeUri,
			activeSession: message.activeSession,
			autoFocusResults: message.autoFocusResults
		};
	}

	private async buildSessionsStateMessage(): Promise<SessionsStateMessage> {
		let sessions: ResultsSessionSummary[] = Array.from(this.sqlSessions.values())
			.map(session => ({uri: session.uri, name: session.name}));

		let activeSession = this.activeSession
			? await this.buildSessionDetail(this.activeSession)
			: undefined;

		return {
			command: 'sessionsState',
			appState: this.appState,
			sessions,
			activeUri: this.activeUri,
			activeSession,
			autoFocusResults: this.extension.configurations.autoFocusResults
		};
	}

	private async resolveColumnsAndLabels(session: WorkbenchViewProvider.SqlSession): Promise<{columns: string[]; columnLabels: Record<string, string[]>; columnDetails: Record<string, ColumnDetails>}> {
		let latestHistory: Nullable<WorkbenchViewProvider.SqlHistory>;

		if(session.histories.length > 0) {
			let resultHistories = session.histories.filter(history => !history.isInternal && [WorkbenchViewProvider.SqlHistoryType.RESULT, WorkbenchViewProvider.SqlHistoryType.ERROR].includes(history.type));
			latestHistory = resultHistories[resultHistories.length - 1];
		}

		let columns = session.rows.length > 0 ? Object.keys(session.rows[0]) : [];
		let sql = latestHistory?.sql ?? '';
		// The duplicate-column warning names its columns through these labels too, and a result can have
		// duplicates without having rows - so label those keys even when rows[0] has none to offer.
		let labelKeys = Array.from(new Set([...columns, ...(session.duplicateColumns ?? [])]));
		let lookup = await this.getColumnLookupFromCache(sql);
		let columnLabels = ColumnNameUtils.buildLabelMap(lookup, labelKeys, this.extension.configurations.resultHeadingLabels);
		let columnDetails = ColumnDetailsUtils.buildDetailsMap(lookup, columns, session.columnDefinitions);

		return {columns, columnLabels, columnDetails};
	}

	private async buildSessionDetail(session: WorkbenchViewProvider.SqlSession): Promise<ResultsSessionDetail> {
		let {columns, columnLabels, columnDetails} = await this.resolveColumnsAndLabels(session);

		return {
			uri: session.uri,
			name: session.name,
			sessionKind: session.sessionKind,
			host: session.configuration.host,
			connectionName: session.configuration.name,
			userName: session.configuration.userName,
			state: session.state as unknown as ResultsSessionDetail['state'],
			connectionInfo: session.connectionInfo ? {
				jobDetails: {
					jobName: session.connectionInfo.jobDetails.jobName,
					ip: session.connectionInfo.jobDetails.ip,
					createdDate: session.connectionInfo.jobDetails.createdDate.toISOString(),
					sortSequence: session.connectionInfo.jobDetails.sortSequence
				},
				workerJobDetails: {
					jobName: session.connectionInfo.workerJobDetails.jobName,
					ip: session.connectionInfo.workerJobDetails.ip,
					createdDate: session.connectionInfo.workerJobDetails.createdDate.toISOString(),
					sortSequence: session.connectionInfo.workerJobDetails.sortSequence
				},
				schemas: session.connectionInfo.schemas.map(schema => ({name: schema.name, type: schema.type}))
			} : undefined,
			resultBorderColor: session.configuration.resultBorderColor,
			histories: session.histories.map(history => this.mapHistory(history, this.extension.drivers.get(session.configuration))),
			rows: session.rows,
			columns,
			columnLabels,
			columnDetails,
			duplicateColumns: session.duplicateColumns,
			// Keyed by the driver-reported column name, which is also the row key. The driver's type name
			// (e.g. ODBC's "SQL_DECIMAL") still contains the bare DB2 type name FieldUtils.isNumericType looks for.
			columnDataTypes: Object.fromEntries((session.columnDefinitions ?? []).map(column => [column.name, column.dataTypeName])),
			procedureOutParameters: session.procedureOutParameters ?? [],
			isCursorOpen: !!session.isCursorOpen,
			isFetchingAll: !!session.isFetchingAll,
			parameters: session.parameters ?? [],
			parameterValues: session.parameterValues ?? ({}),
			parameterFocusRequest: session.parameterFocusRequest
		};
	}

	private mapHistory(history: WorkbenchViewProvider.SqlHistory, driver: DbDriver): ResultsSqlHistory {
		return {
			date: history.date.toISOString(),
			type: history.type as unknown as ResultsSqlHistory['type'],
			rowCount: history.rowCount,
			sql: history.sql,
			duration: history.duration,
			error: history.error ? DbErrorUtils.serialize(history.error, driver.isSetupError?.(history.error)) : undefined,
			parameters: history.parameters,
			isInternal: history.isInternal
		};
	}

	private async getPanelHtml(webview: vscode.Webview): Promise<string> {
		return WebviewHtmlUtils.getReactWebviewHtml({
			webview,
			extensionUri: this.extension.context.extensionUri,
			bundleName: 'results',
			initialState: await this.buildInitialState()
		});
	}

	/**
	 * Opens the current SQL results in a new editor panel.
	 */
	async openInEditor(): Promise<void> {
		let panel = vscode.window.createWebviewPanel(
			`${Extension.ID}.sqlResultsEditor`,
			WorkbenchViewProvider.TITLE,
			vscode.ViewColumn.Beside,
			{
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(this.extension.context.extensionUri, 'dist')],
				retainContextWhenHidden: true
			}
		);

		this.addPanel(panel);
	}

	/**
	 * Opens the current SQL results in a new window.
	 */
	async openInNewWindow(): Promise<void> {
		let panel = vscode.window.createWebviewPanel(
			`${Extension.ID}.sqlResultsNewWindow`,
			WorkbenchViewProvider.TITLE,
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(this.extension.context.extensionUri, 'dist')],
				retainContextWhenHidden: true
			}
		);

		this.addPanel(panel);

		// Execute the command to move the active editor (which is our newly created panel) to a new window
		await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
	}

	private addPanel(panel: vscode.WebviewPanel): void {
		this.additionalPanels.add(panel);

		panel.webview.onDidReceiveMessage(
			message => this.onMessage(message),
			null,
			this.extension.context.subscriptions
		);

		panel.onDidDispose(() => {
			this.additionalPanels.delete(panel);
		});

		this.getPanelHtml(panel.webview).then(html => {
			panel.webview.html = html;
		}, error => AlertUtils.onError(error));
	}

	// The statement's tables' catalog columns, keyed by uppercased long name (the row key of an ordinary
	// unaliased DB2 query) - what the result headers' labels and tooltips are built from.
	private async getColumnLookupFromCache(sql: string): Promise<Map<string, SystemColumn>> {
		let parseResults = StatementParser.parse(sql);
		const lookup = new Map<string, SystemColumn>();

		if(parseResults == null) {
			return lookup;
		}

		if(parseResults.statementType === StatementParser.StatementType.SQL
		&& parseResults.tables?.length) {
			// Every table in the statement in one request (and so, for the ones not already cached, one
			// query) rather than one per table. Still applied table by table in the statement's own order,
			// since a column name found in two tables has to resolve the same way it always has: the last
			// table mentioned wins.
			let columns = await this.extension.memoryCache.getColumns({
				key: <string>this.activeUri,
				tables: parseResults.tables.map(table => ({schema: table.schema, table: table.table}))
			});

			for(const table of parseResults.tables) {
				for(const column of columns.filter(candidate => StringUtils.equalsIgnoreCase(candidate.tableName, table.table))) {
					lookup.set(column.sqlName.toUpperCase(), column);
				}
			}
		}

		return lookup;
	}

	// No-ops if `key` has no session yet - a webview panel that's still connecting (or failed to
	// connect) shouldn't be treated as an error here, same tolerance setActiveUri's callers already
	// get via establishCurrentSession creating the session first.
	activateSession(key: string): void {
		if(this.sqlSessions.has(key)) {
			this.setActiveUri(key);
		}
	}

	closeSession(key: string) {
		let session = this.sqlSessions.get(key);

		if (session?.pendingFlushTimer) {
			clearTimeout(session.pendingFlushTimer);
		}

		this.extension.connections.forgetClose({key: key});
		this.sqlSessions.delete(key);
		this.render();
	}

	private dispose() {
		if(this.eventListener) {
			this.eventListener.dispose();
		}

		this.extension.subscriptionManager.unsubscribe(WorkbenchViewProvider.name);
	}
}

export namespace WorkbenchViewProvider {
	export enum SqlSessionState {
		CONNECTING = 'connecting',
		EXECUTING = 'executing',
		READY = 'ready'
	}

	export interface SqlSession {
		uri: string;
		name: string;
		sessionKind: 'editor' | 'schemas' | 'diagram';
		state: SqlSessionState;
		configuration: ConnectionConfig;
		connectionInfo?: ConnectionInfo;
		rows: Row[];
		isCursorOpen?: boolean;
		duplicateColumns?: string[];
		columnDefinitions?: DbColumnDefinition[];
		procedureOutParameters?: ProcedureOutParameter[];
		columnLabels?: Record<string, string>;
		histories: SqlHistory[];
		isFetchingAll?: boolean;
		pendingRowsBuffer?: Row[];
		pendingFlushTimer?: ReturnType<typeof setTimeout>;
		parameters?: ParameterParser.SqlParameter[];
		parameterValues?: Record<string, string | string[]>;
		parameterFocusRequest?: ResultsParameterFocusRequest;
		hasShownDriverSetupGuidance?: boolean;
	}

	export enum SqlHistoryType {
		CONNECTION = 'connection',
		ERROR = 'error',
		RESULT = 'result'
	}

	export interface SqlHistory {
		date: Date;
		type: SqlHistoryType;
		rowCount?: number;
		sql?: string;
		duration?: number;
		error?: any;
		parameters?: HistoryParameter[];
		isInternal?: boolean;
	}
}
