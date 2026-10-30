import * as vscode from 'vscode';
import { Db2WorkbenchApi, ExtensionApi } from './api/db2-workbench-api.js';
import { Commands } from './commands.js';
import { Configurations } from './configurations.js';
import { StatementCompletionProvider } from './content-assist/statement-completion-provider.js';
import { DbConnections } from './database/db-connections.js';
import { DbDrivers } from './database/drivers/db-drivers.js';
import { CatalogQueries } from './database/queries/catalog-queries.js';
import { DataQueries } from './database/queries/data-queries.js';
import { IndexQueries } from './database/queries/index-queries.js';
import { RoutineQueries } from './database/queries/routine-queries.js';
import { ProgramQueries } from './database/queries/program-queries.js';
import { TriggerDispatchQueries } from './database/queries/trigger-dispatch-queries.js';
import { TableQueries } from './database/queries/table-queries.js';
import { EventManager } from './events/event-manager.js';
import { SqlFormattingProvider } from './formatting/sql-formatting-provider.js';
import { GlobalStates } from './global-states.js';
import { InfoManager } from './info-manager.js';
import { MemoryCache } from './memory-cache.js';
import { SchemaTrees } from './schema-trees.js';
import { SqlSchemaImports } from './sql-schema-imports.js';
import { Secrets } from './secrets.js';
import { DisposableManager } from './utils/disposable-manager.js';
import { EditorUtils } from './utils/editor-utils.js';
import { SubscriptionManager } from './utils/subscription-manager.js';
import { ConnectionEditorProvider } from './views/connection-editor-provider.js';
import { ConnectionsViewProvider } from './views/connections-view-provider.js';
import { DiagramEditorProvider } from './views/diagram-editor-provider.js';
import { FormattingEditorProvider } from './views/formatting-editor-provider.js';
import { SchemasProvider } from './views/schemas-provider.js';
import { WorkbenchViewProvider } from './views/workbench-view-provider.js';

/**
 * TODO
 * - Handle config updates in the connections class. Determine if the config can be handled dynamically or requires a reconnect. Publish an event that the config changed.
 * 		- Update connection wrapper config
 * 		- Listen for event in sql results view provider to redraw border
 */
export class Extension {
	static readonly ID = 'db2-workbench';
	static readonly NAME = 'DB2 Workbench';

	/**
	 * Set to '1' by the integration test runner (see .vscode-test.mjs). It only ever relaxes things a
	 * headless run can't answer - today, the password prompt - and is deliberately read from the
	 * environment rather than a setting, so nothing a user can click turns it on.
	 */
	static readonly TEST_MODE_ENVIRONMENT_VARIABLE = 'DB2_WORKBENCH_TEST_MODE';

	private _subscriptionManager?: SubscriptionManager;
	private _disposableManager?: DisposableManager;
	private _configurations?: Configurations;
	private _context?: vscode.ExtensionContext;
	private _memoryCache?: MemoryCache;
	private _schemaTrees?: SchemaTrees;
	private _sqlSchemaImports?: SqlSchemaImports;
	private _globalStates?: GlobalStates;
	private _connections?: DbConnections;
	private _drivers?: DbDrivers;
	private _catalogQueries?: CatalogQueries;
	private _tableQueries?: TableQueries;
	private _indexQueries?: IndexQueries;
	private _routineQueries?: RoutineQueries;
	private _programQueries?: ProgramQueries;
	private _triggerDispatchQueries?: TriggerDispatchQueries;
	private _dataQueries?: DataQueries;
	private _connectionsViewProvider?: ConnectionsViewProvider;
	private _resultsViewProvider?: WorkbenchViewProvider;
	private _completionProvider?: StatementCompletionProvider;
	private _eventManager?: EventManager;
	private _infoManager?: InfoManager;
	private _secrets?: Secrets;
	private _connectionEditorProvider?: ConnectionEditorProvider;
	private _diagramEditorProvider?: DiagramEditorProvider;
	private _formattingEditorProvider?: FormattingEditorProvider;
	private _schemasProvider?: SchemasProvider;
	private _commands?: Commands;
	private _formattingProvider?: SqlFormattingProvider;
	private _api?: ExtensionApi;

	constructor(context: vscode.ExtensionContext) {
		this._context = context;
	}

	/** See TEST_MODE_ENVIRONMENT_VARIABLE. */
	get isTestMode(): boolean {
		return process.env[Extension.TEST_MODE_ENVIRONMENT_VARIABLE] === '1';
	}

	get subscriptionManager(): SubscriptionManager {
		return this._subscriptionManager ??= new SubscriptionManager();
	}

	get disposableManager(): DisposableManager {
		return this._disposableManager ??= new DisposableManager();
	}

	get configurations(): Configurations {
		return this._configurations ??= new Configurations();
	}

	get context(): vscode.ExtensionContext {
		if(!this._context) {
			throw new Error(`This extension has not be activated yet`);
		}

		return this._context;
	}

	get memoryCache(): MemoryCache {
		return this._memoryCache ??= new MemoryCache(this);
	}

	get schemaTrees(): SchemaTrees {
		return this._schemaTrees ??= new SchemaTrees(this);
	}

	get sqlSchemaImports(): SqlSchemaImports {
		return this._sqlSchemaImports ??= new SqlSchemaImports(this);
	}

	get globalStates(): GlobalStates {
		return this._globalStates ??= new GlobalStates(this);
	}

	get connections(): DbConnections {
		if(!this._connections) {
			let connections = new DbConnections(this);
			this.context.subscriptions.push(connections);
			this._connections = connections;
		}

		return this._connections;
	}

	get drivers(): DbDrivers {
		return this._drivers ??= new DbDrivers(this);
	}

	get catalogQueries(): CatalogQueries {
		return this._catalogQueries ??= new CatalogQueries(this);
	}

	get tableQueries(): TableQueries {
		return this._tableQueries ??= new TableQueries(this);
	}

	get indexQueries(): IndexQueries {
		return this._indexQueries ??= new IndexQueries(this);
	}

	get routineQueries(): RoutineQueries {
		return this._routineQueries ??= new RoutineQueries(this);
	}

	get programQueries(): ProgramQueries {
		return this._programQueries ??= new ProgramQueries(this);
	}

	get triggerDispatchQueries(): TriggerDispatchQueries {
		return this._triggerDispatchQueries ??= new TriggerDispatchQueries(this);
	}

	get dataQueries(): DataQueries {
		return this._dataQueries ??= new DataQueries(this);
	}

	get connectionsViewProvider(): ConnectionsViewProvider {
		return this._connectionsViewProvider ??= new ConnectionsViewProvider(this);
	}

	get resultsViewProvider(): WorkbenchViewProvider {
		return this._resultsViewProvider ??= new WorkbenchViewProvider(this);
	}

	get completionProvider(): StatementCompletionProvider {
		if(!this._completionProvider) {
			let provider = new StatementCompletionProvider(this);
			this.context.subscriptions.push(vscode.languages.registerCompletionItemProvider('sql', provider, '.'));
			this._completionProvider = provider;
		}

		return this._completionProvider;
	}

	get eventManager(): EventManager {
		if(!this._eventManager) {
			let eventManager = new EventManager();
			this.context.subscriptions.push(eventManager);
			this._eventManager = eventManager;
		}

		return this._eventManager;
	}

	get infoManager(): InfoManager {
		return this._infoManager ??= new InfoManager(this);
	}

	get secrets(): Secrets {
		return this._secrets ??= new Secrets(this);
	}

	get connectionEditorProvider(): ConnectionEditorProvider {
		return this._connectionEditorProvider ??= new ConnectionEditorProvider(this);
	}

	// Reachable as a service (not just registered and forgotten) because Commands has to hand it a
	// connection to use before a diagram's webview exists - see connectOnOpen.
	get diagramEditorProvider(): DiagramEditorProvider {
		return this._diagramEditorProvider ??= new DiagramEditorProvider(this);
	}

	get formattingEditorProvider(): FormattingEditorProvider {
		return this._formattingEditorProvider ??= new FormattingEditorProvider(this);
	}

	get schemasProvider(): SchemasProvider {
		return this._schemasProvider ??= new SchemasProvider(this);
	}

	get commands(): Commands {
		return this._commands ??= new Commands(this);
	}

	get formattingProvider(): SqlFormattingProvider {
		if(!this._formattingProvider) {
			let provider = new SqlFormattingProvider(this);
			this.context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider('sql', provider));
			this.context.subscriptions.push(vscode.languages.registerDocumentRangeFormattingEditProvider('sql', provider));
			this._formattingProvider = provider;
		}

		return this._formattingProvider;
	}

	get api(): ExtensionApi {
		return this._api ??= new ExtensionApi(this);
	}

	activate() {
		this.context.subscriptions.push(vscode.window.registerWebviewViewProvider(`${Extension.ID}.sqlResultsView`, this.resultsViewProvider, {webviewOptions: {retainContextWhenHidden: true}}));
		this.context.subscriptions.push(vscode.window.createTreeView(`${Extension.ID}.connectionsView`, {treeDataProvider: this.connectionsViewProvider}));

		this.completionProvider;
		this.infoManager;
		this.commands;
		this.formattingProvider;
		this.context.subscriptions.push(DiagramEditorProvider.register(this));

		this.context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => this.onChangeTextDocument(event)));
		this.context.subscriptions.push(this.eventManager);
	}

	private async onChangeTextDocument(event: vscode.TextDocumentChangeEvent): Promise<void> {
		if(event.document.languageId !== 'sql' || event.contentChanges.length === 0) {
			return;
		}

		let change = event.contentChanges[0].text;

		//TODO This looks for a white space charater or a semicolon. When that happens, look for tables and load cache. Can we do this as soon as we detect a table name?
		if(change.length === 1 && /[\s;]/.test(change)) {
			let editor = vscode.window.activeTextEditor;

			if(editor && editor.document === event.document) {
				await EditorUtils.updateCacheForStatement(this, event.document, editor.selection.active);
			}
		}

		await this.resultsViewProvider.refreshParameters(event.document.uri.toString());
	}
}

export let extension: Extension;

export function activate(context: vscode.ExtensionContext): Db2WorkbenchApi {
	extension = new Extension(context);
	extension.activate();
	return extension.api;
}
