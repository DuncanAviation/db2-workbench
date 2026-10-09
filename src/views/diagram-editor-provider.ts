import { concatMap, Subject } from 'rxjs';
import * as vscode from 'vscode';
import { Configurations } from '../configurations.js';
import { diagramTableId, filterSyncResolve, ResolvedForeignKey, ResolvedTable } from '../diagram/diagram-add-tables.js';
import { DiagramDocument } from '../diagram/diagram-document.js';
import { filterDiagramModel, restrictDiagramModelToTables } from '../diagram/diagram-filter.js';
import { toDiagramTable } from '../diagram/diagram-resolved-table.js';
import { diagramModelToResolvedTables } from '../diagram/diagram-schema-export.js';
import { diagramModelToXml } from '../diagram/diagram-xml.js';
import { DiagramTableSelectedEvent } from '../events/diagram-table-selected-event.js';
import { Event } from '../events/event.js';
import { SchemaTreeChangedEvent } from '../events/schema-tree-changed-event.js';
import { Extension } from '../extension.js';
import { ConnectionConfig } from '../models/connection-config.js';
import { SystemTable } from '../models/system-table.js';
import { TableSchema } from '../models/table-schema.js';
import { SCHEMA_FORMATS } from '../schema-conversion/schema-formats.js';
import { resolveTable } from '../schema-conversion/table-resolver.js';
import { sqlImportTableKey } from '../schema-conversion/sql-import-converter.js';
import { SchemaTrees } from '../schema-trees.js';
import { StringUtils } from '../utils/string-utils.js';
import { TryUtils } from '../utils/try-utils.js';
import { SchemasProvider } from './schemas-provider.js';
import { DiagramUtils } from '../utils/diagram-utils.js';
import { ExportDestination } from '../utils/export-utils.js';
import { ExportWriteUtils } from '../utils/export-write-utils.js';
import { SchemaImportErrorUtils } from '../utils/schema-import-error-utils.js';
import { findImportsToDelete, findImportsToUnlink } from '../schema-conversion/import-groups.js';
import { WebviewHtmlUtils } from '../utils/webview-html-utils.js';
import { ApplyDiagramImportsMessage, DiagramColumnLabelsMessage, DiagramConnectAbortedMessage, DiagramConnectionChangedMessage, DiagramExportFormat, DiagramImportRemovalOrphanMessage, DiagramImportsMessage, DiagramImportSchemaErrorMessage, DiagramImportSchemaSummaryMessage, DiagramInitialState, DiagramMissingTargetsMessage, DiagramModel, DiagramModelUpdatedMessage, DiagramOutboundMessage, DiagramSchemaTablesMessage, DiagramSqlImportConnectionsMessage, DiagramSqlImportLoadedMessage, DiagramSqlImportResultMessage, DiagramSqlImportSavedMessage, SaveDiagramSqlImportMessage, DiagramSqlImportRunResultMessage, DiagramSyncOrphansMessage, DiagramSyncSummaryMessage, DiagramTable, DiagramTreeTable, ImportDiagramSqlSchemaMessage } from '../webview-messages/diagram-messages.js';
import { SchemaImportEntry, SqlImportStatementInput, TreeTableEntry } from '../webview-messages/schemas-messages.js';

import { findMissingTargets } from '../diagram/diagram-missing-targets.js';
import { AlertUtils } from '../utils/alert-utils.js';

// vscode.CustomEditorProvider<DiagramDocument> registered for *.db2diagram (see package.json's
// contributes.customEditors). Deliberately thin - DiagramDocument owns the model/file-I/O logic, this
// class is just the VS Code-facing glue: creating/resolving documents, wiring a webview panel per open
// editor, and forwarding save/revert/backup calls straight through to the document.
export class DiagramEditorProvider implements vscode.CustomEditorProvider<DiagramDocument> {
	// A literal, not `${Extension.ID}.diagramEditor` - this file sits in an import cycle back to
	// extension.ts (via the `Extension` type import below), and a static field initializer runs at
	// module-load time, before extension.ts's own `Extension` class declaration has finished executing -
	// which throws (TDZ: "Cannot access 'Extension' before initialization") and crashes the whole
	// extension's activation. See SchemasUtils.prefix() for the same gotcha, hit first there. Must stay
	// in sync with package.json's contributes.customEditors[0].viewType, which is hardcoded the same way.
	static readonly VIEW_TYPE = 'db2-workbench.diagramEditor';

	// The connection each open diagram is currently pointed at, keyed by document uri - deliberately not
	// persisted anywhere, since a diagram is not bound to a connection and always reopens disconnected.
	// Held per document rather than per panel so both editors on the same document (this provider sets
	// supportsMultipleEditorsPerDocument) agree on which connection is in play.
	private connectionsByDocumentUri = new Map<string, ConnectionConfig>();

	// The document uris currently attached to each connection config's shared session, keyed by configId -
	// this is what lets several diagrams pointed at the same connection share one DbConnections wrapper and
	// one "Diagrams: {name}" session (see DiagramUtils.buildKey) instead of one each. A config's entry is
	// removed entirely once its last attached document detaches, which is also the signal to actually close
	// the shared connection - see detachAndMaybeClose.
	private documentUrisByConfigId = new Map<string, Set<string>>();

	// Adds documentUri to configId's shared session. Idempotent - re-attaching a document already in the
	// set (e.g. a second panel on the same document) is harmless.
	private attachToConnection(documentUri: string, configId: string): void {
		let documentUris = this.documentUrisByConfigId.get(configId) ?? new Set<string>();
		documentUris.add(documentUri);
		this.documentUrisByConfigId.set(configId, documentUris);
	}

	// Removes documentUri from configId's shared session. Returns whether another diagram is still
	// attached (and so whether the underlying connection must stay open) - callers that are actually
	// leaving a connection (as opposed to switching to the same one) use this to decide whether to close
	// it, via detachAndMaybeClose.
	private detachFromConnection(documentUri: string, configId: string): boolean {
		let documentUris = this.documentUrisByConfigId.get(configId);
		documentUris?.delete(documentUri);

		if(!documentUris || documentUris.size === 0) {
			this.documentUrisByConfigId.delete(configId);
			return false;
		}

		return true;
	}

	// The other half of detachFromConnection: only tears down the shared session/connection once nothing
	// else is attached to it. Mirrors the unconditional close the per-document model used to do directly.
	private detachAndMaybeClose(documentUri: string, config: ConnectionConfig): void {
		if(this.detachFromConnection(documentUri, config.id)) {
			return;
		}

		let key = DiagramUtils.buildKey(config.id);
		this.extension.resultsViewProvider.closeSession(key);
		this.extension.connections.forgetClose({ key: key });
	}

	// What the last missing-FK-target push for each panel was computed from - the connection plus the
	// set of tables on the diagram. Recomputing needs a (cached) foreign-key lookup per table, and the
	// content-changed event that triggers it also fires on every single drag, so this skips the work
	// whenever neither input actually moved. A WeakMap so a disposed panel's entry goes with it.
	private missingTargetInputsByPanel = new WeakMap<vscode.WebviewPanel, string>();

	// "Sync with Database" holds its resolve here between finding orphans (tables that resolve against
	// NEITHER the database NOR any current import) and the user's Keep/Remove confirmation reply - see
	// handleSyncDiagram/handleConfirmSync/handleCancelSync. A WeakMap so a disposed panel's pending sync
	// goes with it rather than leaking; the syncDiagram/confirmSync round trip is the only place this is
	// read, so it never needs cleaning up on its own.
	private pendingSyncByPanel = new WeakMap<vscode.WebviewPanel, { updates: ResolvedTable[]; orphanTableIds: string[] }>();
	// The import change waiting on the Keep/Remove prompt - what to switch off (and on), and which tables on
	// this diagram it affects (see startImportChange). Nothing has been applied while an entry sits here -
	// unlike pendingSyncByPanel, which holds an already-finished resolve, this holds an action that has not
	// started. Same WeakMap-keyed-by-panel bookkeeping, so a closed panel takes its pending prompt with it.
	private pendingImportChangeByPanel = new WeakMap<vscode.WebviewPanel, { change: DiagramEditorProvider.ImportChange; targets: DiagramEditorProvider.RemovalTarget[] }>();

	// A connection chosen before the diagram existed, keyed by document uri - set by "New Diagram" on a
	// connection's context menu (see Commands.createBlankDiagram) and consumed the moment that
	// document's webview reports ready. Removed on use, so reopening the file later opens it
	// disconnected like any other diagram: the connection is a property of this one action, not of the
	// file (which deliberately stores nothing about one).
	private pendingConnectionsByDocumentUri = new Map<string, string>();

	// Serializes connect/reconnect attempts per document rather than an ad hoc busy flag (the rxjs
	// Subject + concatMap pattern used elsewhere, e.g. WorkbenchViewProvider.renderSubject). This
	// matters because applyConnection() posts connectionChanged - which clears the webview's spinner
	// and re-enables its menu - BEFORE awaiting postSchemaTables()/postMissingTargets(), so those keep
	// running worker-connection queries for a few seconds after "Reconnect" looks clickable again. A
	// second connectToDatabase firing in that window used to close the very connection those queries
	// were still using mid-flight; the ODBC driver has no safe way to cancel an in-flight query (see the
	// odbc-cancel memory/notes on db-connections.ts), so queuing attempts - never letting one start
	// until the previous one's full tail has settled - is the fix rather than trying to cancel anything.
	private connectSubjectsByDocumentUri = new Map<string, Subject<() => Promise<void>>>();

	/** Connect this document to `configId` as soon as its editor opens, skipping the usual quick-pick. */
	connectOnOpen(documentUri: string, configId: string): void {
		this.pendingConnectionsByDocumentUri.set(documentUri, configId);
	}

	// The sidebar's generic "Reconnect" for a "Diagrams: {name}" session (WorkbenchViewProvider routes it
	// here instead of DbConnections.forgetReconnect - see its own comment on the 'reconnect' message
	// handler). Unlike every other session kind, a diagram session's key IS the connection identity
	// (DiagramUtils.buildKey/configIdForKey) and is shared by every attached diagram's own bookkeeping
	// (connectionsByDocumentUri, documentUrisByConfigId) - blindly closing-and-reopening under this key with
	// WHATEVER connection the generic path resolves to (as DbConnections.reconnect() does for editor/schema
	// sessions) could silently swap in a different database while every attached diagram still thinks it's
	// on the old one. So this always prompts, like a diagram's own Connect/Reconnect menu, but only
	// actually reconnects when the SAME configuration is chosen again (a real recover-a-dropped-connection);
	// picking a different one is declined with guidance, since migrating every attached diagram off a
	// shared session is what a diagram's own menu is for.
	async reconnectSharedSession(key: string, sessionName: string): Promise<void> {
		let configId = DiagramUtils.configIdForKey(key);
		let chosen = await this.extension.connections.pickConnectionConfig();

		if(chosen == null) {
			return;
		}

		if(chosen.id !== configId) {
			AlertUtils.onWarning(`Reconnecting "${sessionName}" re-establishes the same connection - to point a diagram at a different one, use that diagram's own Connect menu instead.`);
			return;
		}

		await this.extension.connections.close({ key: key });
		await this.extension.connections.connect({ key: key, configId: configId });
	}

	private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<DiagramDocument>>();
	readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

	constructor(private extension: Extension) { }

	// Registers the single instance held by Extension rather than constructing its own - Commands needs
	// to reach the same object (connectOnOpen), and a second provider would have its own empty maps.
	static register(extension: Extension): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(DiagramEditorProvider.VIEW_TYPE, extension.diagramEditorProvider, {
			webviewOptions: { retainContextWhenHidden: true },
			supportsMultipleEditorsPerDocument: true
		});
	}

	async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<DiagramDocument> {
		let document = await DiagramDocument.create(uri, openContext, () => this.extension.configurations.resultHeadingLabels);

		let editSubscription = document.onDidChangeDocument(event => this._onDidChangeCustomDocument.fire(event));

		// Session teardown hangs off the DOCUMENT closing, not a panel closing - with two editors open on
		// one document, the first panel to close must not take the shared connection down with it. Mirrors
		// what SchemasProvider does on its own panel dispose (closeSession so the results view drops the
		// session, forgetClose so the database connection is released without a confirmation prompt) - except
		// the connection/session here may still be in use by ANOTHER diagram document on the same
		// connection, so detachAndMaybeClose only actually tears it down once this is the last one.
		document.onDidDispose(() => {
			editSubscription.dispose();

			let documentUri = uri.toString();
			let config = this.connectionsByDocumentUri.get(documentUri);
			this.connectionsByDocumentUri.delete(documentUri);

			if(config) {
				this.detachAndMaybeClose(documentUri, config);
			}

			this.connectSubjectsByDocumentUri.get(documentUri)?.complete();
			this.connectSubjectsByDocumentUri.delete(documentUri);
		});

		return document;
	}

	resolveCustomEditor(document: DiagramDocument, panel: vscode.WebviewPanel): void {
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extension.context.extensionUri, 'dist')]
		};

		let contentSubscription = document.onDidChangeContent(() => {
			panel.webview.postMessage(<DiagramModelUpdatedMessage>{ command: 'modelUpdated', model: document.model });
			// Which foreign keys are unresolved is a function of what's on the diagram, so it has to be
			// rechecked after any edit that added or removed a table - including an undo/redo, which
			// arrives here the same as a fresh edit. Guarded inside postMissingTargets, so the drags that
			// also land here cost nothing. Not awaited: this handler is a plain event listener, and the
			// model update above must reach the webview immediately rather than behind a catalog lookup.
			TryUtils.forgetPromise({
				context: `diagram-editor-provider postMissingTargets()`,
				promise: () => this.postMissingTargets(panel, document),
				onError: error => AlertUtils.onError(error)
			});
		});

		panel.onDidDispose(() => contentSubscription.dispose());

		this.subscribeToTreeChanges(panel, document);

		// Column rows are labelled per db2-workbench.resultHeadingLabels (see diagram-column-labels.ts), so
		// a change to it has to reach an open canvas - the alternative is a diagram that disagrees with the
		// results grid and the schema browser until it's reopened. Only the labelling moves; identities,
		// relationships and geometry are all independent of the setting.
		let configurationSubscription = vscode.workspace.onDidChangeConfiguration(event => {
			if(event.affectsConfiguration(`${Extension.ID}.${Configurations.Keys.RESULT_HEADING_LABELS}`)) {
				panel.webview.postMessage(<DiagramColumnLabelsMessage>{ command: 'columnLabelsChanged', columnLabels: this.extension.configurations.resultHeadingLabels });
			}
		});

		panel.onDidDispose(() => configurationSubscription.dispose());

		// Brings this diagram's own session to the front of the results/History view whenever its editor is
		// focused, exactly as SchemasProvider does - without it, the History tab would keep showing whatever
		// session happened to be active last. Guarded on a connection existing so merely clicking through a
		// never-connected diagram does not try to activate a session that was never created.
		panel.onDidChangeViewState(event => {
			let config = this.connectionsByDocumentUri.get(document.uri.toString());

			if(event.webviewPanel.active && config) {
				this.extension.resultsViewProvider.activateSession(DiagramUtils.buildKey(config.id));
			}
		}, null, this.extension.context.subscriptions);

		panel.webview.onDidReceiveMessage(async (message: DiagramOutboundMessage) => {
			if(message.command === 'moveTable') {
				document.moveTable(message.tableId, message.position);
			} else if(message.command === 'moveTables') {
				document.moveTables(message.tables);
			} else if(message.command === 'tableClicked') {
				this.handleTableClicked(document, message.tableId);
			} else if(message.command === 'resizeSchema') {
				document.resizeSchema(message.schemaId, message.bounds);
			} else if(message.command === 'moveSchema') {
				document.moveSchema(message.schemaId, message.position);
			} else if(message.command === 'removeTable') {
				document.removeTable(message.tableId);
			} else if(message.command === 'removeTables') {
				document.removeTables(message.tableIds);
			} else if(message.command === 'removeSchema') {
				document.removeSchema(message.schemaId);
			} else if(message.command === 'openSchemaForTable') {
				await this.handleOpenSchemaForTable(document, panel, message.tableId);
			} else if(message.command === 'connectToDatabase') {
				this.enqueueConnect(document, () => this.handleConnectToDatabase(document, panel));
			} else if(message.command === 'addTables') {
				await this.handleAddTables(document, message.tables);
			} else if(message.command === 'ready') {
				this.enqueueConnect(document, () => this.handlePendingConnection(document, panel));
			} else if(message.command === 'updateSchemaList') {
				await this.handleUpdateSchemaList(document, panel, message);
			} else if(message.command === 'importSchema') {
				await this.handleImport(document, panel, options => this.extension.schemaTrees.importFromFile(options));
			} else if(message.command === 'importSchemaFromText') {
				await this.handleImport(document, panel, options => this.extension.schemaTrees.importFromText(options, message.format, message.content));
			} else if(message.command === 'runSqlImport') {
				await this.handleRunSqlImport(document, panel, message.statements);
			} else if(message.command === 'importSqlSchema') {
				await this.handleImportSqlSchema(panel, message);
			} else if(message.command === 'loadSqlImport') {
				panel.webview.postMessage(<DiagramSqlImportLoadedMessage>{ command: 'sqlImportLoaded', config: this.extension.sqlSchemaImports.getSavedImport(message.importId) });
			} else if(message.command === 'saveSqlImport') {
				await this.handleSaveSqlImport(document, panel, message);
			} else if(message.command === 'refreshSqlImport') {
				await this.handleRefreshSqlImport(document, panel, message.importId);
			} else if(message.command === 'loadSqlImportConnections') {
				let current = this.connectionsByDocumentUri.get(document.uri.toString());
				panel.webview.postMessage(<DiagramSqlImportConnectionsMessage>{ command: 'sqlImportConnectionsLoaded', connections: this.extension.sqlSchemaImports.getConnectionTargets(current?.id) });
			} else if(message.command === 'discardSqlImportRun') {
				this.extension.sqlSchemaImports.discardRun(message.runId);
			} else if(message.command === 'exportDiagram') {
				await this.handleExportDiagram(document, message.format, message.scope, message.filterText, message.destination);
			} else if(message.command === 'exportTables') {
				await this.handleExportTables(document, message.tableIds, message.format, message.destination);
			} else if(message.command === 'syncDiagram') {
				await this.handleSyncDiagram(document, panel);
			} else if(message.command === 'confirmSync') {
				await this.handleConfirmSync(document, panel, message.tableIds);
			} else if(message.command === 'cancelSync') {
				this.pendingSyncByPanel.delete(panel);
			} else if(message.command === 'disableImportedTableData') {
				await this.handleImportedTableDataToggle(document, panel, message.tableId, 'disable');
			} else if(message.command === 'enableImportedTableData') {
				await this.handleImportedTableDataToggle(document, panel, message.tableId, 'enable');
			} else if(message.command === 'confirmImportRemoval') {
				await this.handleConfirmImportRemoval(document, panel, message.removeTableIds);
			} else if(message.command === 'loadImports') {
				this.postImports(document, panel);
			} else if(message.command === 'applyImports') {
				await this.handleApplyImports(document, panel, message);
			} else if(message.command === 'cancelImportRemoval') {
				this.pendingImportChangeByPanel.delete(panel);
			} else if(message.command === 'rearrangeTables') {
				await document.rearrangeTables();
			}
		});

		let initialState: DiagramInitialState = {
			model: document.model,
			fileName: DiagramEditorProvider.fileNameFor(document.uri),
			connectionName: this.connectionsByDocumentUri.get(document.uri.toString())?.name,
			// A pending connection is one this panel is about to start on its own `ready` message, so the
			// webview would otherwise mount looking idle - and offering a menu whose only entry starts a
			// competing connect - for as long as the password prompt and connection handshake take.
			connecting: this.pendingConnectionsByDocumentUri.has(document.uri.toString()),
			columnLabels: this.extension.configurations.resultHeadingLabels
		};

		panel.webview.html = WebviewHtmlUtils.getReactWebviewHtml({
			webview: panel.webview,
			extensionUri: this.extension.context.extensionUri,
			bundleName: 'diagram',
			stylesheet: true,
			initialState: initialState
		});
	}

	async saveCustomDocument(document: DiagramDocument): Promise<void> {
		await document.save(document.uri);
	}

	// A Save As doesn't just write elsewhere - VS Code closes this editor and reopens the destination as a
	// new document, which disposes this one and takes its session and database connection with it (see
	// openCustomDocument). That is the path the very FIRST save of an untitled "New Diagram" takes, so
	// without this the connection the user picked would silently vanish the moment they saved. Reusing
	// connectOnOpen means the destination reconnects itself as soon as its webview reports ready, with the
	// password already cached in Secrets from the original connect.
	async saveCustomDocumentAs(document: DiagramDocument, destination: vscode.Uri): Promise<void> {
		await document.save(destination);

		let config = this.connectionsByDocumentUri.get(document.uri.toString());

		if(config && destination.toString() !== document.uri.toString()) {
			this.connectOnOpen(destination.toString(), config.id);
		}
	}

	async revertCustomDocument(document: DiagramDocument): Promise<void> {
		await document.revert();
	}

	async backupCustomDocument(document: DiagramDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
		return document.backup(context.destination);
	}

	// The connection "New Diagram" on a connection's context menu already chose. Unlike
	// handleConnectToDatabase this passes a configId, which is what stops DbConnections from showing its
	// quick-pick - the password prompt and progress notification still happen, which is correct: those
	// are about reaching the database, not about choosing it.
	//
	// Runs off the webview's `ready` message rather than at the end of resolveCustomEditor because a
	// webview postMessage sent before the page's own listener attaches is dropped rather than queued,
	// and connectionChanged is how the webview learns it's connected at all.
	//
	// Always reached through enqueueConnect (see handleConnectToDatabase's own comment) - a second panel's
	// `ready` firing while another panel's connect is still finishing its tail is the same race, so it's
	// wrapped in the same try/catch for the same reason.
	private async handlePendingConnection(document: DiagramDocument, panel: vscode.WebviewPanel): Promise<void> {
		try {
			let documentUri = document.uri.toString();
			let configId = this.pendingConnectionsByDocumentUri.get(documentUri);

			// Consumed whether or not the connect succeeds - a failed or cancelled attempt shouldn't silently
			// retry on the next panel opened for this document.
			this.pendingConnectionsByDocumentUri.delete(documentUri);

			let existing = this.connectionsByDocumentUri.get(documentUri);

			// Both no-op paths still have to answer, because the initial state told the webview a connect was
			// already under way (see DiagramInitialState.connecting) and only a connectionChanged ends that
			// spinner. The already-connected case - a SECOND panel on a document the first one already
			// connected - answers with the real connection and refills its picker, since this panel's webview
			// has nothing in it yet.
			if(existing) {
				await this.applyConnection(document, panel, DiagramUtils.buildKey(existing.id), existing);
				return;
			}

			if(!configId) {
				panel.webview.postMessage(<DiagramConnectionChangedMessage>{ command: 'connectionChanged' });
				return;
			}

			let key = DiagramUtils.buildKey(configId);
			let config = await this.extension.connections.connect({ key: key, configId: configId });

			if(config == null) {
				panel.webview.postMessage(<DiagramConnectionChangedMessage>{ command: 'connectionChanged' });
				return;
			}

			this.attachToConnection(documentUri, config.id);
			await this.applyConnection(document, panel, key, config);
		} catch(error) {
			AlertUtils.onError(error);
		}
	}

	// Runs `task` behind this document's connect queue (see connectSubjectsByDocumentUri) instead of
	// directly, so an overlapping connectToDatabase message waits for whatever's already in flight -
	// including applyConnection()'s awaited tail - rather than closing the connection out from under it.
	private enqueueConnect(document: DiagramDocument, task: () => Promise<void>): void {
		let documentUri = document.uri.toString();
		let subject = this.connectSubjectsByDocumentUri.get(documentUri);

		if(!subject) {
			subject = new Subject();
			// Errors are swallowed inside handleConnectToDatabase itself (see its own try/catch) rather than
			// here - an error escaping this pipeline would terminate the subscription, silently dropping every
			// later reconnect attempt for this document.
			subject.pipe(concatMap(async queuedTask => queuedTask())).subscribe();
			this.connectSubjectsByDocumentUri.set(documentUri, subject);
		}

		subject.next(task);
	}

	// The first-time-connect case delegates the entire choose-a-connection flow to
	// DbConnections.pickConnectionConfig() (auto-picks a lone connection, otherwise its own quick-pick) -
	// unlike a plain getConnectionConfig() call, this doesn't also open the connection, because a diagram's
	// key is scoped by connection config id (see DiagramUtils.buildKey) and so isn't known until a
	// configuration has actually been chosen.
	//
	// Reconnect always prompts instead, even when there's only one connection configured - the user is
	// explicitly choosing again, not just re-establishing whatever this diagram happened to be on. Unlike
	// the old per-document model, choosing again does NOT close the existing connection up front: it may
	// still be shared with other diagrams, and a cancelled prompt should leave this diagram exactly as
	// connected as it was. The old connection is only detached (and, if nothing else is attached to it,
	// actually closed) once a DIFFERENT configuration has been confirmed - reconnecting to the same one
	// just rejoins it.
	//
	// Establishing the connection under a config's key is also what makes it show up as a "Diagrams: {name}"
	// session in the results/History view - DbConnections fires the CONNECTING event with the key, and
	// WorkbenchViewProvider builds the session from it (see DiagramUtils.isDiagramKey there). There is no
	// separate "register with history" call.
	//
	// Always reached through enqueueConnect, never called directly - see connectSubjectsByDocumentUri for
	// why. Wrapped in its own try/catch (rather than leaving that to the caller) so a failure here reports
	// through the usual AlertUtils path without erroring out the queue's subscription for this document.
	private async handleConnectToDatabase(document: DiagramDocument, panel: vscode.WebviewPanel): Promise<void> {
		try {
			let documentUri = document.uri.toString();
			let oldConfig = this.connectionsByDocumentUri.get(documentUri);
			let chosen = await this.extension.connections.pickConnectionConfig();

			if(chosen == null) {
				// Cancelled - leave this diagram on whatever it already had (nothing to detach/close) and say
				// so with connectAborted rather than a connectionChanged naming the old connection: the latter
				// clears the webview's table picker, which would empty the tree for a connection that was never
				// disturbed. All that needs ending here is the "connecting" spinner.
				panel.webview.postMessage(<DiagramConnectAbortedMessage>{ command: 'connectAborted' });
				return;
			}

			let key = DiagramUtils.buildKey(chosen.id);

			// Reconnecting to the SAME connection this diagram is already on rejoins it as-is - no detach,
			// no risk of disrupting another diagram sharing it.
			if(oldConfig && oldConfig.id === chosen.id) {
				let rejoined = await this.extension.connections.connect({ key: key, configId: chosen.id });

				if(rejoined == null) {
					panel.webview.postMessage(<DiagramConnectionChangedMessage>{ command: 'connectionChanged' });
					await this.postMissingTargets(panel, document);
					return;
				}

				await this.applyConnection(document, panel, key, rejoined);
				return;
			}

			// A first-time connect, or switching to a different connection - detach from whatever this
			// diagram was on before (closing it only if this was the last diagram attached to it).
			if(oldConfig) {
				this.connectionsByDocumentUri.delete(documentUri);
				this.detachAndMaybeClose(documentUri, oldConfig);
			}

			let config = await this.extension.connections.connect({ key: key, configId: chosen.id });

			if(config == null) {
				// No connectionName - the webview drops back to "Not connected" rather than being left showing a
				// half-finished state after a failed connection. The missing-FK markers are cleared too (they'd
				// otherwise keep offering to add tables through a connection that no longer exists).
				panel.webview.postMessage(<DiagramConnectionChangedMessage>{ command: 'connectionChanged' });
				await this.postMissingTargets(panel, document);
				return;
			}

			this.attachToConnection(documentUri, config.id);
			await this.applyConnection(document, panel, key, config);
		} catch(error) {
			AlertUtils.onError(error);
		}
	}

	// Everything that follows a successful connect, however it was chosen: remember it for this
	// document, bring its session to the front of the results/History view, tell the webview, then fill
	// the picker and the missing-FK markers.
	private async applyConnection(document: DiagramDocument, panel: vscode.WebviewPanel, key: string, config: ConnectionConfig): Promise<void> {
		this.connectionsByDocumentUri.set(document.uri.toString(), config);
		this.extension.resultsViewProvider.activateSession(key);
		panel.webview.postMessage(<DiagramConnectionChangedMessage>{ command: 'connectionChanged', connectionName: config.name });

		await this.postSchemaTables(panel, document, config.id);
		await this.postMissingTargets(panel, document);
		await this.refreshImportedData(document);
	}

	// Refreshes every table already on the diagram against its current resolved definition, so a table's
	// Imported/Enhanced badge and its imported-sourced columns/relationships reflect whatever is CURRENTLY
	// imported for this connection - not just what was true the moment it was added. A table added after
	// this always gets fresh data through the normal add path (loadTables -> toDiagramTable in
	// handleAddTables), so this only ever needs to touch what's already on the canvas.
	//
	// Called once after every successful connect (an import from an earlier session on this connection,
	// or from another diagram/the schema browser, may already be waiting - see applyConnection) and again
	// after every SCHEMA_TREE_CHANGED event (a fresh import, most commonly - see subscribeToTreeChanges).
	//
	// Gated on this connection actually having an import loaded THIS session (SchemaTrees' own cache is
	// in-memory only - see its own comment). Without this guard, reconnecting after a restart, before
	// re-importing anything, resolves every table against an empty import list: a wholly-imported table is
	// caught by loadTables' own "neither connected nor imported" skip, but a real, "enhanced" table's
	// import-only extra columns/foreign keys have no such protection - they'd just be silently resolved
	// away and the resulting (shorter) column list written back over what the file already had. The saved
	// diagram is the durable copy of that data (see diagram-resolved-table.ts); this refresh exists to pick
	// up NEW or CHANGED imports, not to erase what an import already contributed just because this session
	// hasn't repeated it yet.
	private async refreshImportedData(document: DiagramDocument): Promise<void> {
		let documentUri = document.uri.toString();
		let config = this.connectionsByDocumentUri.get(documentUri);

		if(!config || document.model.tables.length === 0 || this.extension.schemaTrees.getImportedTables(config.id).length === 0) {
			return;
		}

		let key = DiagramUtils.buildKey(config.id);

		try {
			let resolved = await this.loadTables(documentUri, key, config.id, DiagramEditorProvider.toTargets(document.model.tables));
			document.updateTables([...resolved.values()]);
		} catch(error) {
			AlertUtils.onError(error);
		}
	}

	// Everything the diagram needs to know about a set of tables, resolved once and shared by the two
	// callers that ask different questions of the same data: postMissingTargets ("which of these foreign
	// keys point nowhere?") and handleAddTables ("which point at what I'm adding, and what are those
	// columns really called?").
	//
	// Each table goes through table-resolver, so live DB2 data and whatever this session's schema imports
	// contributed are already reconciled - an imported-only table resolves entirely from the import, and
	// an "enhanced" one carries its imported extras (notably foreign keys DB2 doesn't have) alongside its
	// real columns. See diagram-resolved-table.ts for the column-naming subtlety that makes those
	// imported keys actually draw.
	//
	// Columns, keys and foreign keys are each fetched for EVERY connected target up front, in one
	// MemoryCache call apiece, rather than three calls per table inside the loop - so a twenty-table
	// diagram costs three queries instead of sixty. MemoryCache still serves each table from its own
	// cache slot and only queries the ones missing from it, so a table the picker or an earlier add
	// already looked at costs nothing. The three run one after another rather than in a Promise.all:
	// every metadata query for a session goes down that connection's single worker connection (see
	// ConnectionWrapper), so firing them together would only contend for it.
	//
	// The whole batch resolves in one call rather than one call per table: buildTreeState below is the
	// same work for every target, and the caller still gets per-table progress and per-target misses
	// through the callbacks.
	// documentUri is only used to re-check liveness (see stillAttached below), never to derive key/configId -
	// callers keep passing those explicitly since a schema-browser-triggered caller could in principle share
	// this someday without a diagram document at all.
	private async loadTables(
		documentUri: string,
		key: string,
		configId: string,
		targets: { schema: string; table: string }[],
		callbacks: DiagramEditorProvider.LoadCallbacks = {}
	): Promise<Map<string, ResolvedTable>> {
		let byTableId = new Map<string, ResolvedTable>();

		if(targets.length === 0) {
			return byTableId;
		}

		// This runs across several awaited round trips (buildTreeState, then up to three batched
		// queries), and every caller (postMissingTargets, handleAddTables, and the tree-change refresh in
		// subscribeToTreeChanges) can still be mid-flight after documentUri detached from configId - closed,
		// or reconnected elsewhere - since none of that cancels an already-running call. Re-checked before
		// each round trip rather than once at entry, so a detach partway through stops the rest instead of
		// letting them silently reopen a connection nothing needs any more (which is what resurrected a
		// "Diagrams: {name}" session after its last diagram closed).
		let stillAttached = () => this.connectionsByDocumentUri.get(documentUri)?.id === configId;

		if(!stillAttached()) {
			return byTableId;
		}

		let state = await this.extension.schemaTrees.buildTreeState({ key: key, configId: configId });

		// Prefetched for every target in one call rather than per table inside the loop: a SQL import's
		// Columns and Relationships sections are queried per table, and batching them here is what keeps
		// adding twenty tables to a diagram to one query per section instead of twenty.
		let importedByTable = await this.extension.schemaTrees.loadImportedTablesFor(
			{ key: key, configId: configId },
			targets.map(target => ({ schema: target.schema, table: target.table }))
		);

		// Only the targets DB2 actually has a table for are worth querying: an imported-only one has no
		// catalog rows to find, and asking for it would just widen every predicate for nothing.
		let connectedTables = new Map<string, SystemTable>();

		for(let target of targets) {
			let listed = DiagramEditorProvider.findConnectedTable(state, target);

			if(listed) {
				connectedTables.set(sqlImportTableKey(target.schema, target.table), listed);
			}
		}

		let connectedTargets = targets.filter(target => connectedTables.has(sqlImportTableKey(target.schema, target.table)));
		let batch = { key: key, configId: configId, tables: connectedTargets.map(target => ({ schema: target.schema, table: target.table })) };

		// Not fetched: a diagram box shows columns, keys and relationships, never indexes. resolveTable
		// resolves them anyway (there is no cheaper entry point) and the result is dropped, which is also
		// why passing [] rather than the real list is harmless below.
		let columns = stillAttached() ? await this.extension.memoryCache.getColumns(batch) : [];
		let tableKeys = stillAttached() ? await this.extension.memoryCache.getTableKeys(batch) : [];
		let foreignKeys = stillAttached() ? await this.extension.memoryCache.getForeignKeys(batch) : [];

		for(let target of targets) {
			if(!stillAttached()) {
				break;
			}

			callbacks.onStart?.(target);

			let listed = connectedTables.get(sqlImportTableKey(target.schema, target.table));

			// undefined, not an empty array, when no connected table backs this at all - table-resolver
			// draws a hard distinction between "no such table in DB2" and "a real table that happens to
			// have none of this kind of row", and conflating them would let imported data leak into a real
			// table's authoritative-and-empty result. See table-resolver.ts's file comment.
			let connected: TableSchema | undefined = listed
				? {
					table: listed,
					columns: columns.filter(column => StringUtils.equalsIgnoreCase(column.tableName, target.table) && StringUtils.equalsIgnoreCase(column.schema, target.schema)),
					keys: tableKeys.filter(tableKey => StringUtils.equalsIgnoreCase(tableKey.tableName, target.table) && StringUtils.equalsIgnoreCase(tableKey.schema, target.schema)),
					foreignKeys: foreignKeys.filter(foreignKey => StringUtils.equalsIgnoreCase(foreignKey.tableName, target.table) && StringUtils.equalsIgnoreCase(foreignKey.schema, target.schema)),
					indexes: []
				}
				: undefined;

			let imported = importedByTable.get(sqlImportTableKey(target.schema, target.table)) ?? [];

			// Neither a live table nor an import - nothing to resolve. The caller decides what that means:
			// handleAddTables reports it, postMissingTargets just has one fewer table to check.
			if(!connected && imported.length === 0) {
				callbacks.onMissing?.(target);
				continue;
			}

			let table = toDiagramTable(resolveTable(connected, imported));
			byTableId.set(diagramTableId(table.schema, table.table), table);
		}

		return byTableId;
	}

	// The connection's own SystemTable row for a target, or undefined when no live table backs it (an
	// imported-only one, or a table dropped since the picker was filled). Read off the shared schema tree
	// rather than MemoryCache.getTables directly so a schema the user manually ADDED through "Edit Schema
	// List" counts too - those aren't on the connection's library list, and getTables' eager branch only
	// returns what is.
	//
	// SchemasSystemTable is a SystemTable with its two timestamps as ISO strings (they cross a postMessage
	// boundary in the schema browser). Only schema/name/description are ever read back out of the result,
	// but SystemTable declares both timestamps non-optional, so they're parsed back rather than dropped.
	private static findConnectedTable(state: SchemaTrees.TreeState, target: { schema: string; table: string }): SystemTable | undefined {
		let entry = DiagramEditorProvider.findTreeEntry(state, target);

		if(!entry?.connected) {
			return undefined;
		}

		return {
			...entry.connected,
			alteredTimestamp: new Date(entry.connected.alteredTimestamp ?? 0),
			refreshTimestamp: new Date(entry.connected.refreshTimestamp ?? 0)
		};
	}

	private static findTreeEntry(state: SchemaTrees.TreeState, target: { schema: string; table: string }): TreeTableEntry | undefined {
		let bucket = Object.entries(state.tablesBySchema).find(([schema]) => StringUtils.equalsIgnoreCase(schema, target.schema))?.[1] ?? [];

		return bucket.find(entry => {
			let name = entry.connected?.name ?? entry.imported?.[0]?.name;
			return StringUtils.isNotBlank(name) && StringUtils.equalsIgnoreCase(name, target.table);
		});
	}

	// The foreign keys of the tables on the diagram that point at tables which AREN'T - the set
	// addTables deliberately skips rather than drawing dangling edges for. Each becomes a marker in the
	// webview offering to bring that table in.
	private async postMissingTargets(panel: vscode.WebviewPanel, document: DiagramDocument): Promise<void> {
		let config = this.connectionsByDocumentUri.get(document.uri.toString());
		// Deliberately part of the guard key: connecting has to recompute even though the diagram's own
		// tables didn't change, and disconnecting has to push an empty list to clear the markers - there
		// is nothing to act on without a connection. So is the import count, since an import can introduce
		// foreign keys DB2 never had, and each of those gets a marker of its own.
		let importCount = config ? this.extension.schemaTrees.getImportedTables(config.id).length : 0;
		let inputs = `${config?.id ?? ''}|${importCount}|${document.model.tables.map(table => table.id).sort().join(',')}`;

		if(this.missingTargetInputsByPanel.get(panel) === inputs) {
			return;
		}

		this.missingTargetInputsByPanel.set(panel, inputs);

		if(!config) {
			panel.webview.postMessage(<DiagramMissingTargetsMessage>{ command: 'missingTargetsLoaded', targets: [] });
			return;
		}

		let key = DiagramUtils.buildKey(config.id);
		let tables: Map<string, ResolvedTable>;

		try {
			tables = await this.loadTables(document.uri.toString(), key, config.id, DiagramEditorProvider.toTargets(document.model.tables));
		} catch(error) {
			// A failed lookup shouldn't take the diagram down - the markers are an extra affordance, not
			// something the diagram needs in order to render. Clearing the guard so a later edit retries.
			this.missingTargetInputsByPanel.delete(panel);
			AlertUtils.onError(error);
			return;
		}

		panel.webview.postMessage(<DiagramMissingTargetsMessage>{
			command: 'missingTargetsLoaded',
			targets: findMissingTargets(document.model, DiagramEditorProvider.toForeignKeysByTableId(tables))
		});
	}

	// Resolves each picked table's full definition (columns, primary/unique keys, foreign keys - live DB2
	// data reconciled with any imported contributions) and hands the batch to the document as a single
	// edit. Everything is fetched through MemoryCache, so re-adding a table the schema browser has
	// already looked at costs no queries at all.
	//
	// Wrapped in a progress notification rather than left silent because a batch is three queries per
	// table against a remote DB2 - fast when cached, several seconds when not, and the diagram gives no
	// other sign that anything is happening until the tables appear.
	private async handleAddTables(document: DiagramDocument, requested: { schema: string; table: string }[]): Promise<void> {
		let documentUri = document.uri.toString();
		let config = this.connectionsByDocumentUri.get(documentUri);

		// The picker only exists while connected, so this is the disconnect-mid-right-click race rather
		// than a state the UI offers on purpose.
		if(!config || requested.length === 0) {
			return;
		}

		let key = DiagramUtils.buildKey(config.id);

		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `Adding ${requested.length} table${requested.length === 1 ? '' : 's'} to diagram...`
		}, async progress => {
			try {
				// Neither connected nor imported. Reachable in earnest from a missing-FK-target marker, which
				// names a table the CATALOG pointed at - a foreign key can outlive its referenced table, and
				// the picker can also go stale after a drop elsewhere.
				let notFound: string[] = [];

				let resolved = await this.loadTables(documentUri, key, config.id, requested, {
					onStart: target => progress.report({ message: `${target.schema}.${target.table}`, increment: 100 / requested.length }),
					onMissing: target => notFound.push(`${target.schema}.${target.table}`)
				});

				// No columns at all: either listed but not readable by this user (a drop would have taken it
				// off the tree), or an import that declared no fields. An empty box would look like a
				// rendering bug, so it's reported instead - and the rest of the batch still goes in.
				let unreadable: string[] = [];
				let adding: ResolvedTable[] = [];

				for(let [tableId, table] of resolved) {
					table.columns.length === 0 ? unreadable.push(tableId) : adding.push(table);
				}

				if(adding.length > 0) {
					// Read BEFORE the edit, so it's the set of tables that were already here - which is exactly
					// the side whose keys point AT what's being added (the missing-FK marker flow's whole
					// premise). Cached, and postMissingTargets has usually just warmed them.
					let existing = await this.loadTables(documentUri, key, config.id, DiagramEditorProvider.toTargets(document.model.tables));

					// Neither end's column names need reconciling here: every column carries all three of its
					// name forms, so addTables resolves each foreign key against the tables themselves.
					await document.addTables(adding, DiagramEditorProvider.toForeignKeysByTableId(existing));
				}

				// One notification rather than two, so a mixed batch doesn't stack popups.
				let problems = [
					...(notFound.length > 0 ? [`not found on this connection: ${notFound.join(', ')}`] : []),
					...(unreadable.length > 0 ? [`could not read column information for: ${unreadable.join(', ')}`] : [])
				];

				if(problems.length > 0) {
					AlertUtils.onWarning(`Not added to diagram - ${problems.join('; ')}.`);
				}
			} catch(error) {
				AlertUtils.onError(error);
			}
		});
	}

	// "Sync with Database" from the diagram's own menu - resolves every table already on the diagram
	// against current DB2+imports, reusing the same loadTables pipeline postMissingTargets/handleAddTables
	// already use, but WITHOUT refreshImportedData's getImportedTables().length > 0 guard: an explicit
	// Sync always runs, regardless of whether anything's been (re-)imported this session. Needs a
	// connection to resolve anything against - prompts for one first if disconnected, same convention
	// handleOpenSchemaForTable already follows, queued behind whatever connect attempt (if any) is already
	// in flight for this document. The already-connected path runs directly (not queued), the same as
	// handleAddTables - it's a read-only resolve, not a connect operation, so there's nothing here that a
	// concurrent connect attempt could disrupt.
	private async handleSyncDiagram(document: DiagramDocument, panel: vscode.WebviewPanel): Promise<void> {
		let config = this.connectionsByDocumentUri.get(document.uri.toString());

		if(config) {
			await this.runSync(document, panel, config);
			return;
		}

		this.enqueueConnect(document, async () => {
			try {
				let chosen = await this.extension.connections.pickConnectionConfig();

				if(chosen == null) {
					return;
				}

				let key = DiagramUtils.buildKey(chosen.id);
				let connected = await this.extension.connections.connect({ key: key, configId: chosen.id });

				if(connected == null) {
					return;
				}

				this.attachToConnection(document.uri.toString(), connected.id);
				await this.applyConnection(document, panel, key, connected);
				await this.runSync(document, panel, connected);
			} catch(error) {
				AlertUtils.onError(error);
			}
		});
	}

	// The actual resolve, once a connection is known. A table that resolves against NEITHER a connected
	// row NOR any current import becomes an orphan (see loadTables' onMissing): with at least one, the
	// resolve is held (pendingSyncByPanel) until the user answers the Keep/Remove confirmation dialog (see
	// handleConfirmSync); with none, the sync applies immediately - there's nothing to confirm.
	private async runSync(document: DiagramDocument, panel: vscode.WebviewPanel, config: ConnectionConfig): Promise<void> {
		let documentUri = document.uri.toString();
		let key = DiagramUtils.buildKey(config.id);

		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Syncing diagram with database...'
		}, async () => {
			try {
				let orphanTargets: { schema: string; table: string }[] = [];

				let resolved = await this.loadTables(documentUri, key, config.id, DiagramEditorProvider.toTargets(document.model.tables), {
					onMissing: target => orphanTargets.push(target)
				});

				// Protects every already-Imported/Enhanced table from being silently flattened (or offered
				// as an orphan) just because nobody re-opened its source file this session - see
				// filterSyncResolve's own comment.
				let hasAnyImportThisSession = this.extension.schemaTrees.getImportedTables(config.id).length > 0;
				let filtered = filterSyncResolve(document.model, [...resolved.values()], orphanTargets, hasAnyImportThisSession);
				let updates = filtered.updates;
				orphanTargets = filtered.orphanTargets;

				if(orphanTargets.length === 0) {
					this.applySync(document, panel, updates, [], []);
					return;
				}

				this.pendingSyncByPanel.set(panel, {
					updates: updates,
					orphanTableIds: orphanTargets.map(target => diagramTableId(target.schema, target.table))
				});

				panel.webview.postMessage(<DiagramSyncOrphansMessage>{
					command: 'syncOrphansFound',
					orphans: orphanTargets.map(target => ({ tableId: diagramTableId(target.schema, target.table), schema: target.schema, table: target.table }))
				});
			} catch(error) {
				AlertUtils.onError(error);
			}
		});
	}

	// Reply to the Keep/Remove confirmation dialog - applies the resolve runSync already did, plus
	// whichever orphans the user chose to remove (everything else defaulted to Keep). A stale reply (this
	// panel's pending sync already cleared - a second Sync click, or the panel closed) is silently
	// ignored rather than erroring.
	private async handleConfirmSync(document: DiagramDocument, panel: vscode.WebviewPanel, removeTableIds: string[]): Promise<void> {
		let pending = this.pendingSyncByPanel.get(panel);
		this.pendingSyncByPanel.delete(panel);

		if(!pending) {
			return;
		}

		this.applySync(document, panel, pending.updates, pending.orphanTableIds, removeTableIds);
	}

	// Applies a resolved sync as one edit and always reports a result - unlike addTables/updateTables,
	// which stay silent when there's nothing to do, Sync is a user-invoked action and should feel like it
	// did something (or confirm that it didn't) every time it runs. A genuine no-op stays a plain toast;
	// anything that actually changed opens the webview's scrollable summary dialog instead, since the
	// affected-table list can run long and a toast has nowhere to put it.
	private applySync(document: DiagramDocument, panel: vscode.WebviewPanel, updates: ResolvedTable[], orphanTableIds: string[], removeTableIds: string[]): void {
		let changedTables = document.syncTables(updates, orphanTableIds, removeTableIds);

		if(changedTables.length === 0) {
			AlertUtils.onInfo('Diagram is already in sync with the database.');
			return;
		}

		panel.webview.postMessage(<DiagramSyncSummaryMessage>{ command: 'syncSummary', tables: changedTables });
	}

	// schemaId is the schema NAME for every table a diagram can currently hold (see DiagramSchemaGroup's
	// own comment on why the two are nonetheless kept as separate fields).
	private static toTargets(tables: DiagramTable[]): { schema: string; table: string }[] {
		return tables.map(table => ({ schema: table.schemaId, table: table.name }));
	}

	private static toForeignKeysByTableId(tables: ReadonlyMap<string, ResolvedTable>): Map<string, ResolvedForeignKey[]> {
		return new Map(Array.from(tables).map(([tableId, table]) => [tableId, table.foreignKeys]));
	}

	// "Edit Schema List" from the tree's own menu - the same dialog, the same overrides and the same
	// rebuild the schema browser gets, since both go through SchemaTrees. Hiding a schema can take tables
	// off the picker that are already ON the diagram; that's deliberate, and doesn't touch the diagram
	// itself, which is a saved document rather than a view of the tree.
	private async handleUpdateSchemaList(document: DiagramDocument, panel: vscode.WebviewPanel, update: SchemaTrees.SchemaListUpdate): Promise<void> {
		let config = this.connectionsByDocumentUri.get(document.uri.toString());

		if(!config) {
			return;
		}

		try {
			let key = DiagramUtils.buildKey(config.id);
			// Deliberately no push: the rebuilt tree reaches this panel (and any schema browser on the same
			// connection) through SchemaTreeChangedEvent - see subscribeToTreeChanges.
			await this.extension.schemaTrees.updateSchemaList({ key: key, configId: config.id }, update);
		} catch(error) {
			AlertUtils.onError(error);
		}
	}

	// Both "Import" paths (a file, or pasted text). SchemaTrees does the parsing, merging and the count
	// toast, and a successful import repaints the tree through SchemaTreeChangedEvent - so the only thing
	// left here is the import-error dialog, with the text that failed to parse.
	private async handleImport(document: DiagramDocument, panel: vscode.WebviewPanel, runImport: (options: SchemaTrees.Options) => Promise<SchemaTrees.ImportResult>): Promise<void> {
		let config = this.connectionsByDocumentUri.get(document.uri.toString());

		if(!config) {
			return;
		}

		let result = await runImport({ key: DiagramUtils.buildKey(config.id), configId: config.id });

		if(result.kind === 'error') {
			panel.webview.postMessage(<DiagramImportSchemaErrorMessage>{ command: 'importSchemaError', error: SchemaImportErrorUtils.serialize(result.error), content: result.content });
		} else if(result.kind === 'imported') {
			panel.webview.postMessage(<DiagramImportSchemaSummaryMessage>{ command: 'importSchemaSummary', report: result.report });
		}
	}

	// The two steps of a SQL import. Same service, same replies as the schema browser's - the tables that
	// land reach this canvas through SCHEMA_TREE_CHANGED like any other import, so neither handler does
	// anything diagram-specific beyond needing this document's connection.
	private async handleRunSqlImport(document: DiagramDocument, panel: vscode.WebviewPanel, statements: SqlImportStatementInput[]): Promise<void> {
		let config = this.connectionsByDocumentUri.get(document.uri.toString());

		if(!config) {
			return;
		}

		let result = await this.extension.sqlSchemaImports.run({ key: DiagramUtils.buildKey(config.id), configId: config.id, statements: statements });
		panel.webview.postMessage(<DiagramSqlImportRunResultMessage>{ command: 'sqlImportRunResult', result: result });
	}

	private async handleImportSqlSchema(panel: vscode.WebviewPanel, message: ImportDiagramSqlSchemaMessage): Promise<void> {
		let result = await this.extension.sqlSchemaImports.import({ runId: message.runId, name: message.name, mappings: message.mappings, save: message.save, connectionIds: message.connectionIds });
		panel.webview.postMessage(<DiagramSqlImportResultMessage>{ command: 'sqlImportResult', result: result });
	}

	/** The per-node "Disable/Enable Imported Changes" as an ImportChange - either way it only ever switches
	 * entries, never unlinking or deleting an import. */
	private static toToggleChange(entries: SchemaImportEntry[], direction: 'disable' | 'enable'): DiagramEditorProvider.ImportChange {
		return {
			disable: direction === 'disable' ? entries : [],
			enable: direction === 'enable' ? entries : [],
			unlinkImportIds: [],
			deleteImportIds: [],
			savedImportIds: []
		};
	}

	// The saved-import half of the SQL import flow: edit, delete and refresh, all of which need this
	// document's connection for the same reason the two import steps do. The canvas repaints off
	// SCHEMA_TREE_CHANGED like any other import change; these only push the refreshed dialog state.
	private async handleSaveSqlImport(document: DiagramDocument, panel: vscode.WebviewPanel, message: SaveDiagramSqlImportMessage): Promise<void> {
		let config = this.connectionsByDocumentUri.get(document.uri.toString());

		if(!config) {
			return;
		}

		let outcome = await this.extension.sqlSchemaImports.saveSavedImport({ key: DiagramUtils.buildKey(config.id), configId: config.id }, { ...message });
		panel.webview.postMessage(<DiagramSqlImportSavedMessage>{ command: 'sqlImportSaved', saved: outcome.saved, message: outcome.saved ? undefined : outcome.message });

		if(outcome.saved) {
			this.postImports(document, panel);
		}
	}

	private async handleRefreshSqlImport(document: DiagramDocument, panel: vscode.WebviewPanel, importId: string): Promise<void> {
		let config = this.connectionsByDocumentUri.get(document.uri.toString());

		if(!config) {
			return;
		}

		await this.extension.sqlSchemaImports.refreshImport({ key: DiagramUtils.buildKey(config.id), configId: config.id }, importId);
		this.postImports(document, panel);
	}

	// Repaints this diagram's picker whenever the shared schema tree for the connection it's pointed at
	// changes, whoever changed it - this panel, another diagram, or the schema browser. An import can also
	// introduce foreign keys DB2 never had, so the missing-FK markers are rechecked at the same time.
	//
	// Subscribed per panel and disposed with it. Reads the connection at fire time rather than closing
	// over one, since a diagram can be pointed at a different connection (or none) while open.
	private subscribeToTreeChanges(panel: vscode.WebviewPanel, document: DiagramDocument): void {
		let subscription = this.extension.eventManager.onEvent(event => {
			let config = this.connectionsByDocumentUri.get(document.uri.toString());

			if(event.type !== Event.Type.SCHEMA_TREE_CHANGED || !config || (<SchemaTreeChangedEvent>event).configId !== config.id) {
				return;
			}

			// A forgotten promise, not awaited by anything - this subscription itself is disposed with the
			// panel, but that only stops FUTURE events from starting a new one of these; it can't cancel one
			// already under way. Since postSchemaTables re-checks (see its own comment) that this document is
			// still attached to configId before touching the database, a query that's still running after
			// the user closed this diagram (or reconnected it elsewhere) just bails instead of reopening a
			// connection nothing needs anymore.
			TryUtils.forgetPromise({
				context: 'diagram-editor-provider onSchemaTreeChanged',
				promise: async () => {
					await this.postSchemaTables(panel, document, config.id);
					await this.postMissingTargets(panel, document);
					await this.refreshImportedData(document);
				},
				onError: error => AlertUtils.onError(error)
			});
		});

		panel.onDidDispose(() => subscription.dispose());
	}

	// The tree behind the diagram's table picker: the same schema tree the schema browser shows, so the
	// "Edit Schema List" hide/add overrides and every schema imported this session apply here too. It was
	// deliberately the raw library list before those two menu items existed here - now that they do, a
	// schema the user has hidden must not keep appearing in the picker, and an imported table has to.
	//
	// An imported-only table appears exactly like a real one, and adds to the diagram from its imported
	// definition (see loadMappedTables). Nothing distinguishes the two visually yet - the Imported/
	// Enhanced badges the schema browser's own tree plan calls for are a separate piece of work.
	// Re-verifies the document is still attached to configId before touching the database (unlike the
	// unconditional key/configId this used to take) - a caller can be a forgotten async continuation
	// (subscribeToTreeChanges's event handler) that was kicked off before this document disconnected or
	// reconnected elsewhere, and finally gets here well after that happened. Without this check, a stale
	// continuation's query would silently reopen a connection nothing is using any more (getConnectionWrapper
	// auto-connects on demand), resurrecting a "Diagrams: {name}" session the user just closed.
	private async postSchemaTables(panel: vscode.WebviewPanel, document: DiagramDocument, configId: string): Promise<void> {
		let current = this.connectionsByDocumentUri.get(document.uri.toString());

		if(!current || current.id !== configId) {
			return;
		}

		this.postTreeState(panel, await this.extension.schemaTrees.buildTreeState({ key: DiagramUtils.buildKey(configId), configId: configId }), configId);
	}

	private postTreeState(panel: vscode.WebviewPanel, state: SchemaTrees.TreeState, configId: string): void {
		let tablesBySchema: Record<string, DiagramTreeTable[]> = {};

		for(let [schema, entries] of Object.entries(state.tablesBySchema)) {
			tablesBySchema[schema] = entries
				.map(entry => {
					let name = entry.connected?.name ?? entry.imported?.[0]?.name;
					let description = entry.connected?.description;

					return <DiagramTreeTable>{
						schema: schema,
						table: name ?? '',
						// Blank rather than absent is what the catalog returns for "no description"; the tree
						// renders "NAME (description)" whenever one is present, so an empty string would show
						// as "NAME ()".
						description: StringUtils.isNotBlank(description) ? description : undefined
					};
				})
				// An entry with neither a connected row nor an imported one can't happen, but the type allows
				// it - dropping it beats rendering a nameless row.
				.filter(entry => StringUtils.isNotBlank(entry.table));
		}

		panel.webview.postMessage(<DiagramSchemaTablesMessage>{
			command: 'schemaTablesLoaded',
			tablesBySchema: tablesBySchema,
			schemaList: state.schemaList,
			disabledImportTables: this.extension.schemaTrees.getDisabledImportedTables(configId)
		});
	}

	// Resolves the click to a real schema/table name (not just our internal composite id) and fires it
	// through the shared EventManager bus, the same way DbConnectionEvent already feeds
	// ExtensionApi.onStatementExecuted - see diagram-table-selected-event.ts for why this goes through
	// the bus rather than DiagramEditorProvider calling into the API directly.
	private handleTableClicked(document: DiagramDocument, tableId: string): void {
		let table = document.model.tables.find(candidate => candidate.id === tableId);

		if(!table) {
			return;
		}

		let schema = document.model.schemas.find(candidate => candidate.id === table.schemaId);

		this.extension.eventManager.fire<DiagramTableSelectedEvent>({
			type: Event.Type.DIAGRAM_TABLE_SELECTED,
			documentUri: document.uri.toString(),
			schema: schema?.name ?? table.schemaId,
			table: table.name
		});
	}

	// Right-click "Open Schema" on a table node - the same destination F12's "Go to Definition" opens from
	// a SQL editor (Commands.showTableDetails), reached here from the diagram side instead. SchemasProvider.
	// show() already does the "reveal the existing tab for this connection, or open a new one" and
	// "select this table" work (see its own comment), so once a connection is known this is a one-liner.
	private async handleOpenSchemaForTable(document: DiagramDocument, panel: vscode.WebviewPanel, tableId: string): Promise<void> {
		let table = document.model.tables.find(candidate => candidate.id === tableId);

		if(!table) {
			return;
		}

		let schema = document.model.schemas.find(candidate => candidate.id === table.schemaId);
		let target: SchemasProvider.TableTarget = { kind: 'table', schema: schema?.name ?? table.schemaId, table: table.name };

		let config = this.connectionsByDocumentUri.get(document.uri.toString());

		if(config) {
			await this.extension.schemasProvider.show(config, target);
			return;
		}

		// Not connected yet - the same "Connect to Database" quick-pick, queued behind whatever connect
		// attempt (if any) is already in flight for this document (see connectSubjectsByDocumentUri), so
		// the chosen connection becomes this diagram's own rather than racing a separate one-off lookup.
		// Cancelling the picker just leaves the diagram disconnected, same as cancelling "Connect to
		// Database" itself.
		this.enqueueConnect(document, async () => {
			try {
				let chosen = await this.extension.connections.pickConnectionConfig();

				if(chosen == null) {
					return;
				}

				let key = DiagramUtils.buildKey(chosen.id);
				let connected = await this.extension.connections.connect({ key: key, configId: chosen.id });

				if(connected == null) {
					return;
				}

				this.attachToConnection(document.uri.toString(), connected.id);
				await this.applyConnection(document, panel, key, connected);
				await this.extension.schemasProvider.show(connected, target);
			} catch(error) {
				AlertUtils.onError(error);
			}
		});
	}

	// Right-click "Disable Imported Changes" / "Enable Imported Changes" on a table node - the schema
	// browser's own actions (see SchemasProvider's two handlers), reached from the diagram instead. Both go
	// through the one shared SchemaTrees disabled-entry set, so an import switched off (or back on) here
	// changes every surface pointed at this connection, not just this diagram.
	//
	// One handler for both directions: everything but which way the entries go is identical, down to the
	// connection prompt. Enabling can't strand a table, so its change carries no disable list and
	// startImportChange raises no Keep/Remove prompt for it.
	//
	// A disconnected diagram prompts for a connection first, the same convention handleOpenSchemaForTable
	// and handleSyncDiagram already follow, queued behind whatever connect attempt (if any) is already in
	// flight for this document. Cancelling the picker just leaves the diagram disconnected, with nothing
	// changed. A connection is needed for two separate reasons: the imported data itself is held per
	// connection config (see SchemaTrees), and resolving what the table should look like with or without
	// its import is a database question. Note that the import store is in-memory per session, so a
	// connection whose import was made in an earlier session holds nothing to switch either way - the
	// resolve below still produces the right result, since it resolves against DB2 plus whatever (nothing)
	// is currently imported.
	private async handleImportedTableDataToggle(document: DiagramDocument, panel: vscode.WebviewPanel, tableId: string, direction: 'disable' | 'enable'): Promise<void> {
		let table = document.model.tables.find(candidate => candidate.id === tableId);

		if(!table) {
			return;
		}

		let schema = document.model.schemas.find(candidate => candidate.id === table.schemaId);
		let target = { schema: schema?.name ?? table.schemaId, table: table.name };
		let config = this.connectionsByDocumentUri.get(document.uri.toString());

		let change = (configId: string) => DiagramEditorProvider.toToggleChange(
			this.extension.schemaTrees.allEntriesForTable(configId, target.schema, target.table),
			direction
		);

		if(config) {
			await this.startImportChange(document, panel, config.id, change(config.id), [tableId]);
			return;
		}

		this.enqueueConnect(document, async () => {
			try {
				let chosen = await this.extension.connections.pickConnectionConfig();

				if(chosen == null) {
					return;
				}

				let key = DiagramUtils.buildKey(chosen.id);
				let connected = await this.extension.connections.connect({ key: key, configId: chosen.id });

				if(connected == null) {
					return;
				}

				this.attachToConnection(document.uri.toString(), connected.id);
				await this.applyConnection(document, panel, key, connected);
				await this.startImportChange(document, panel, connected.id, change(connected.id), [tableId]);
			} catch(error) {
				AlertUtils.onError(error);
			}
		});
	}

	// "View Imports" on the tree menu, and every change its dialog applies. The tree is only shown once this
	// diagram is connected, so unlike the per-node "Disable Imported Changes" there is no connection to
	// prompt for here - a detached diagram can't reach either message.
	private postImports(document: DiagramDocument, panel: vscode.WebviewPanel): void {
		let config = this.connectionsByDocumentUri.get(document.uri.toString());
		let imports = config ? this.extension.schemaTrees.getImports(config.id) : [];
		panel.webview.postMessage(<DiagramImportsMessage>{ command: 'importsLoaded', imports: imports });
	}

	// Same machinery the per-node action uses (orphan prompt included), then the refreshed list for the
	// dialog, which stays open. The tree itself repaints off SCHEMA_TREE_CHANGED like every other import
	// mutation, on this diagram and on any schema browser open for the same connection.
	private async handleApplyImports(document: DiagramDocument, panel: vscode.WebviewPanel, message: ApplyDiagramImportsMessage): Promise<void> {
		let config = this.connectionsByDocumentUri.get(document.uri.toString());

		if(!config) {
			return;
		}

		// Resolved here, while the store still reflects what this apply is being judged against -
		// findImportsToUnlink/findImportsToDelete ask whether the apply leaves each import fully disabled,
		// which nothing can answer once it has been applied. The unlinks and deletes themselves happen at the
		// far end, which on this surface can be several round trips away (see the Keep/Remove orphan prompt in
		// startImportChange).
		let summaries = this.extension.schemaTrees.getImports(config.id);

		let change: DiagramEditorProvider.ImportChange = {
			disable: message.disable,
			enable: message.enable,
			unlinkImportIds: findImportsToUnlink(summaries, message.disable, message.enable, message.unlinkImportIds ?? []).map(summary => summary.importId),
			deleteImportIds: findImportsToDelete(summaries, message.disable, message.enable, message.deleteImportIds ?? []).map(summary => summary.importId),
			savedImportIds: summaries.filter(summary => summary.saved).map(summary => summary.importId)
		};

		await this.startImportChange(document, panel, config.id, change);
		this.postImports(document, panel);
	}

	// Every import entry touching one table - what "Disable Imported Changes" on a node means, since that
	// action switches off a table's imported data whatever import supplied it (the schema browser's own copy
	// of it goes through the same shared store). A table with nothing imported yields no entries, which
	// startImportChange below still runs through the resolve path: the table is already showing whatever
	// DB2 says, so applying that is a no-op, and refusing outright would be a silent nothing instead.
	private entriesForTable(configId: string, target: { schema: string; table: string }): SchemaImportEntry[] {
		return this.extension.schemaTrees.getImportedTablesFor(configId, target.schema, target.table)
			.map(imported => ({ importId: imported.provenance.importId, schema: target.schema, table: target.table }));
	}

	// Decides which of the two shapes this change takes, once a connection is known. A table with a real
	// DB2 row behind it just reverts to that row. A table that exists in no connected schema would be left
	// with no source at all, which is the same Keep/Remove question Sync asks about a table that stopped
	// resolving (see handleSyncDiagram), so it is asked the same way and with the same dialog rather than
	// being decided here. The check is made BEFORE anything is applied, so Cancel is a true no-op.
	//
	// Shared by the per-node "Disable Imported Changes" (one table) and the View Imports dialog (a whole
	// import, or any selection inside one) - the same two shapes apply either way, just to several tables
	// at once, which is why the prompt takes a list.
	//
	// Only the DISABLING half can strand a table: re-enabling gives a table more to resolve against, never
	// less, so it is resolved alongside the rest but never asked about.
	//
	// alwaysTableIds is how the per-node action keeps working on a table with nothing currently imported (an
	// import made in an EARLIER session, say - the store is in-memory): there are no entries to switch off,
	// but the table is still worth resolving, which flattens whatever stale imported flags it was saved with.
	private async startImportChange(
		document: DiagramDocument,
		panel: vscode.WebviewPanel,
		configId: string,
		change: DiagramEditorProvider.ImportChange,
		alwaysTableIds: string[] = []
	): Promise<void> {
		try {
			// Only tables actually ON this diagram need reconciling - an import can easily cover tables that
			// were never added here, and those change in the shared store without touching the canvas.
			let disableTargets = this.diagramTargetsFor(document, change.disable, alwaysTableIds);
			let targets = this.diagramTargetsFor(document, [...change.disable, ...change.enable], alwaysTableIds);

			if(targets.length === 0) {
				await this.applyImportChange(document, configId, change, [], []);
				return;
			}

			// The same tree every resolve reads its connected rows off (see loadTables/findConnectedTable), so
			// this costs nothing beyond what applying the change is about to do anyway - it's cached per
			// connection config.
			let state = await this.extension.schemaTrees.buildTreeState({ key: DiagramUtils.buildKey(configId), configId: configId });
			let enabledTableIds = new Set(this.diagramTargetsFor(document, change.enable).map(target => target.tableId));

			// A table this same apply is re-enabling still has a source afterwards, whatever the disabling
			// half does to it, so it is never an orphan.
			let orphans = disableTargets.filter(target => !enabledTableIds.has(target.tableId) && !DiagramEditorProvider.findConnectedTable(state, target));

			if(orphans.length === 0) {
				await this.applyImportChange(document, configId, change, targets, []);
				return;
			}

			this.pendingImportChangeByPanel.set(panel, { change: change, targets: targets });

			panel.webview.postMessage(<DiagramImportRemovalOrphanMessage>{
				command: 'importRemovalOrphanFound',
				orphans: orphans.map(orphan => ({ tableId: orphan.tableId, schema: orphan.schema, table: orphan.table }))
			});
		} catch(error) {
			AlertUtils.onError(error);
		}
	}

	// Which tables on this diagram the listed import entries actually affect, deduplicated by table id (two
	// imports of the same table are two entries but one box). Matched on schema group name + table name,
	// case-insensitively, the same pairing every other diagram/tree lookup here uses.
	private diagramTargetsFor(document: DiagramDocument, entries: SchemaImportEntry[], alwaysTableIds: string[] = []): DiagramEditorProvider.RemovalTarget[] {
		let targets = new Map<string, DiagramEditorProvider.RemovalTarget>();

		for(let table of document.model.tables) {
			let schema = document.model.schemas.find(candidate => candidate.id === table.schemaId);
			let schemaName = schema?.name ?? table.schemaId;

			if(alwaysTableIds.includes(table.id) || entries.some(entry => StringUtils.equalsIgnoreCase(entry.schema, schemaName) && StringUtils.equalsIgnoreCase(entry.table, table.name))) {
				targets.set(table.id, { tableId: table.id, schema: schemaName, table: table.name });
			}
		}

		return [...targets.values()];
	}

	// Reply to the Keep/Remove prompt above. A stale reply (this panel's pending removal already cleared -
	// a Cancel, a second attempt, or the panel closed) is silently ignored, same as handleConfirmSync.
	private async handleConfirmImportRemoval(document: DiagramDocument, panel: vscode.WebviewPanel, removeTableIds: string[]): Promise<void> {
		let pending = this.pendingImportChangeByPanel.get(panel);
		this.pendingImportChangeByPanel.delete(panel);

		let config = this.connectionsByDocumentUri.get(document.uri.toString());

		if(!pending || !config) {
			return;
		}

		try {
			await this.applyImportChange(document, config.id, pending.change, pending.targets, removeTableIds);

			// The View Imports dialog may still be open behind the prompt (that is how a whole-import disable
			// gets here), and nothing was actually applied until just now - so it gets its refreshed list
			// here rather than at the point the change was merely requested.
			this.postImports(document, panel);
		} catch(error) {
			AlertUtils.onError(error);
		}
	}

	// Applies the import change, then brings the diagram back in line with what is left.
	//
	// The repaint is done here rather than left to the SCHEMA_TREE_CHANGED subscription, which covers
	// neither half of this on its own: refreshImportedData bails outright once this connection has no
	// imports left at all (removing the last one is exactly that case), and updateTables deliberately
	// ignores a table that now resolves against nothing. So this resolves the affected tables directly and
	// applies everything - reverts, orphans and removals - through one syncTables call, which is also what
	// makes the whole removal a single Ctrl+Z. A table backed by a real DB2 row reverts to its real
	// columns; one the user chose to keep is flagged 'orphaned' (the "New" badge), the same treatment Sync
	// gives a table that no longer resolves; one switched to Remove goes off the canvas.
	//
	// This is the one caller that asks syncTables to reconcile a table's relationships DOWN to what the
	// resolve says (its last argument): a foreign key an import introduced has to leave the diagram along
	// with the rest of that import, and it would otherwise stay drawn - the columns at both ends can still
	// exist, so nothing about the line looks stale. Sync deliberately never asks for this, since a sync is
	// meant to RETAIN imported data, not reconcile it away.
	private async applyImportChange(
		document: DiagramDocument,
		configId: string,
		change: DiagramEditorProvider.ImportChange,
		targets: DiagramEditorProvider.RemovalTarget[],
		removeTableIds: string[]
	): Promise<void> {
		// Enabling first, so a table named by both halves of one apply ends up disabled rather than enabled -
		// the dialog can't produce that, but the per-node action and the dialog can overlap on this surface.
		this.extension.schemaTrees.enableEntries(configId, change.enable);
		this.extension.schemaTrees.disableEntries(configId, change.disable);

		for(let importId of change.unlinkImportIds) {
			await this.extension.sqlSchemaImports.unlinkSavedImport(configId, importId);
		}

		for(let importId of change.deleteImportIds) {
			// A saved import loses its settings entry (and every other connection's link to it); an unsaved
			// one has nothing but the rows, so dropping those is the whole delete.
			if(change.savedImportIds.includes(importId)) {
				await this.extension.sqlSchemaImports.deleteSavedImport(importId);
			} else {
				this.extension.schemaTrees.removeImport(configId, importId);
			}
		}

		// An import can easily cover tables that were never added to this diagram - then there is nothing on
		// the canvas to reconcile, and resolving (and syncing) an empty list would only put a no-op edit on
		// the undo stack.
		if(targets.length === 0 && removeTableIds.length === 0) {
			return;
		}

		// A table being taken off the diagram needs no resolve - nothing is left to show for it.
		let removed = new Set(removeTableIds);
		let remaining = targets.filter(target => !removed.has(target.tableId));

		let orphanTableIds: string[] = [];
		let key = DiagramUtils.buildKey(configId);
		let resolved = await this.loadTables(document.uri.toString(), key, configId, remaining, {
			onMissing: target => {
				let orphan = remaining.find(candidate => StringUtils.equalsIgnoreCase(candidate.schema, target.schema) && StringUtils.equalsIgnoreCase(candidate.table, target.table));

				if(orphan) {
					orphanTableIds.push(orphan.tableId);
				}
			}
		});

		document.syncTables([...resolved.values()], orphanTableIds, removeTableIds, remaining.map(target => target.tableId));
	}

	private static fileNameFor(uri: vscode.Uri): string {
		let segments = uri.path.split('/');
		return segments[segments.length - 1] ?? uri.path;
	}

	// "Export..." from the diagram's own menu (see ExportTablesDialog) - filterDiagramModel narrows the
	// model first when scope is "filtered" (see its own comment for why a relationship needs BOTH
	// endpoints matching, not the canvas's more permissive "at least one" dimming rule); actually writing
	// it out is shared with handleExportTables below, via writeExport.
	private async handleExportDiagram(document: DiagramDocument, format: DiagramExportFormat, scope: 'all' | 'filtered', filterText: string, destination: ExportDestination): Promise<void> {
		let model = scope === 'filtered' ? filterDiagramModel(document.model, filterText) : document.model;
		await this.writeExport(document, model, format, destination, 'Diagram');
	}

	// Table's own "Export..." context menu item (ExportTablesMessage) - same serialize/write path as the
	// diagram's own Export, just pre-restricted to the right-clicked table(s) via
	// restrictDiagramModelToTables instead of filterDiagramModel's text match.
	private async handleExportTables(document: DiagramDocument, tableIds: string[], format: DiagramExportFormat, destination: ExportDestination): Promise<void> {
		let model = restrictDiagramModelToTables(document.model, tableIds);
		let label = tableIds.length === 1 ? '1 table' : `${tableIds.length} tables`;
		await this.writeExport(document, model, format, destination, label);
	}

	// Shared by handleExportDiagram and handleExportTables - mirrors SchemasProvider.handleExportSchema's
	// convention exactly (clipboard short-circuits before the save dialog, default filename/directory,
	// cancel returns silently, write via vscode.workspace.fs, confirm via AlertUtils.onInfo). Only what the
	// success/error message calls the thing being exported (`subject`, e.g. "Diagram" or "3 tables")
	// differs between the two callers.
	private async writeExport(document: DiagramDocument, model: DiagramModel, format: DiagramExportFormat, destination: ExportDestination, subject: string): Promise<void> {
		try {
			let serialized = DiagramEditorProvider.serializeForExport(model, format, this.extension.configurations.resultHeadingLabels);

			await ExportWriteUtils.write({
				content: serialized.content,
				fileExtension: serialized.fileExtension,
				filterLabel: serialized.filterLabel,
				defaultFileName: DiagramEditorProvider.exportFileNameFor(document.uri, serialized.fileExtension),
				destination: destination,
				clipboardMessage: `${subject} exported to the clipboard.`,
				fileMessage: path => `${subject} exported to ${path}.`
			});
		} catch(error) {
			AlertUtils.onError(error);
		}
	}

	// `.drawio` reuses the exact serializer DiagramDocument.save() uses, so an exported file and a saved
	// .db2diagram file can never disagree on the mapping. DBML/Frictionless go through
	// diagramModelToResolvedTables (see its own file comment for exactly what the diagram model does and
	// doesn't carry - this is necessarily best-effort, unlike the lossless `.drawio` path) and then the
	// SAME converters the schema browser's own Export already uses - one implementation per format, not a
	// second one that could drift from it.
	private static serializeForExport(model: DiagramModel, format: DiagramExportFormat, columnLabels: readonly string[]): { content: string; fileExtension: string; filterLabel: string } {
		if(format === 'drawio') {
			return { content: diagramModelToXml(model, columnLabels), fileExtension: 'drawio', filterLabel: 'draw.io Diagram' };
		}

		let converter = SCHEMA_FORMATS[format];
		return { content: converter.export(diagramModelToResolvedTables(model)), fileExtension: converter.fileExtension, filterLabel: converter.label };
	}

	// The document's own file name with its extension swapped for the export format's own, not appended -
	// "New Diagram" produces an untitled document whose fileNameFor() has no extension at all, so a plain
	// split-on-dot would either do nothing or clip a name that legitimately contains one.
	private static exportFileNameFor(uri: vscode.Uri, extension: string): string {
		let fileName = DiagramEditorProvider.fileNameFor(uri);
		let lastDotIndex = fileName.lastIndexOf('.');
		return `${lastDotIndex === -1 ? fileName : fileName.slice(0, lastDotIndex)}.${extension}`;
	}
}

export namespace DiagramEditorProvider {
	// Per-target hooks for loadMappedTables - a batch resolves in one pass, so progress reporting and
	// "nothing to resolve" reporting have to come out through callbacks rather than a per-table return.
	export interface LoadCallbacks {
		onStart?: (target: { schema: string; table: string }) => void;
		onMissing?: (target: { schema: string; table: string }) => void;
	}

	// A table on the diagram that an import change affects - the resolve target plus the canvas box it
	// belongs to, which is what syncTables (and the Keep/Remove prompt) work in terms of.
	export interface RemovalTarget {
		tableId: string;
		schema: string;
		table: string;
	}

	// One View Imports apply (or one per-node disable), already narrowed to what the host will actually do,
	// carried across however many round trips the Keep/Remove prompt takes. `savedImportIds` is captured
	// with the rest because whether an import is saved decides how deleting it is carried out, and its
	// settings entry can be gone by the time a prompt comes back.
	export interface ImportChange {
		disable: SchemaImportEntry[];
		enable: SchemaImportEntry[];
		unlinkImportIds: string[];
		deleteImportIds: string[];
		savedImportIds: string[];
	}
}
