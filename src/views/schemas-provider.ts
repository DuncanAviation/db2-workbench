import * as vscode from 'vscode';
import { Extension } from '../extension.js';
import { Event } from '../events/event.js';
import { SchemaTreeChangedEvent } from '../events/schema-tree-changed-event.js';
import { GlobalStates } from '../global-states.js';
import { SchemaTrees } from '../schema-trees.js';
import { ConnectionConfig } from '../models/connection-config.js';
import { SystemColumn } from '../models/system-column.js';
import { SystemIndexAdvice } from '../models/system-index-advice.js';
import { SystemTrigger } from '../models/system-trigger.js';
import { SqlDocumentFormatter } from '../formatting/sql-document-formatter.js';
import { CatalogLookupError } from '../database/queries/catalog-lookup.js';
import { describeSourceLocation, findEntrySource, parseExternalName, ProgramSourceLocation } from '../database/queries/program-source.js';
import { DbConnections } from '../database/db-connections.js';
import { assembleTableSchema } from '../schema-conversion/table-schema-assembler.js';
import { SCHEMA_FORMATS } from '../schema-conversion/schema-formats.js';
import { findImportsToDelete, findImportsToUnlink } from '../schema-conversion/import-groups.js';
import { resolveColumns, resolveForeignKeys, resolveIndexes, resolveTable, resolveTableKeys } from '../schema-conversion/table-resolver.js';
import { addTables } from '../diagram/diagram-add-tables.js';
import { toDiagramTable } from '../diagram/diagram-resolved-table.js';
import { diagramModelToXml } from '../diagram/diagram-xml.js';
import { AlertUtils } from '../utils/alert-utils.js';
import { ColumnNameUtils } from '../utils/column-name-utils.js';
import { ExportDestination } from '../utils/export-utils.js';
import { ExportWriteUtils } from '../utils/export-write-utils.js';
import { DbErrorUtils } from '../utils/db-error-utils.js';
import { SchemaImportErrorUtils } from '../utils/schema-import-error-utils.js';
import { SchemasUtils } from '../utils/schemas-utils.js';
import { StringUtils } from '../utils/string-utils.js';
import { TryUtils } from '../utils/try-utils.js';
import { WebviewHtmlUtils } from '../utils/webview-html-utils.js';
import { DiagramExportFormat, DiagramModel } from '../webview-messages/diagram-messages.js';
import {
	ColumnsErrorMessage,
	RoutineDetailErrorMessage,
	RoutineDetailLoadedMessage,
	RoutineDdlErrorMessage,
	RoutineDdlLoadedMessage,
	RoutineSourceErrorMessage,
	RoutineSourceLoadedMessage,
	LoadRoutineDdlMessage,
	RoutineParamsErrorMessage,
	RoutineParamsLoadedMessage,
	SchemasObjectKind,
	ColumnsLoadedMessage,
	ForeignKeysErrorMessage,
	ForeignKeysLoadedMessage,
	ImportSchemaErrorMessage,
	ImportSchemaSummaryMessage,
	ImportsLoadedMessage,
	ApplyImportsMessage,
	IndexAdviceErrorMessage,
	IndexAdviceLoadedMessage,
	IndexesErrorMessage,
	IndexesLoadedMessage,
	LoadTriggerSourceMessage,
	RunDataEditStatementProgressMessage,
	RunDataEditStatementsResultMessage,
	DataEditSettingsChangedMessage,
	SchemaListUpdatedMessage,
	SchemasIndexAdvice,
	SchemasInitialState,
	SchemasOutboundMessage,
	SchemasProgramSource,
	SchemasSchemaListEntry,
	SchemasTrigger,
	SchemasTriggerHandler,
	SelectTableMessage,
	SetFilterMessage,
	OpenSqlImportEditorMessage,
	SqlImportConnectionsLoadedMessage,
	SqlImportLoadedMessage,
	SqlImportSavedMessage,
	SqlImportResultMessage,
	SqlImportRunResultMessage,
	TableDataErrorMessage,
	TableDataLoadedMessage,
	TableKeysErrorMessage,
	TableKeysLoadedMessage,
	TriggerSourceErrorMessage,
	TriggerSourceLoadedMessage,
	TriggersErrorMessage,
	TriggersLoadedMessage,
	ViewDefinitionErrorMessage,
	ViewDefinitionLoadedMessage
} from '../webview-messages/schemas-messages.js';

// One panel per connection (not a single shared panel, unlike ConnectionEditorProvider/
// FormattingEditorProvider) - a user may want to browse two connections' schemas side by side.
export class SchemasProvider {
	private _panelsByConnectionId?: Map<string, vscode.WebviewPanel>;
	constructor(private extension: Extension) {}

	private get panelsByConnectionId(): Map<string, vscode.WebviewPanel> {
		return this._panelsByConnectionId ??= new Map();
	}

	// "target" drives "View Table Details" from a SQL editor (Commands.onViewTableDetails) - a plain
	// db2-workbench.openSchemas invocation passes none, same as before this existed. "sqlImportEditorId"
	// drives the Edit SQL Import command, whose dialog lives in this webview: an open panel is told to open
	// it, a new one carries it in initial state (see SchemasInitialState.initialSqlImportEditorId).
	async show(config: ConnectionConfig, target?: SchemasProvider.TableTarget, sqlImportEditorId?: string): Promise<void> {
		let existingPanel = this.panelsByConnectionId.get(config.id);
		let key = SchemasUtils.buildKey(config.id);

		// Opening the browser is the user asking for this session. Everything the panel does afterwards
		// (tree, tabs, imports) connects lazily under this key, so it has to be allowed here, once.
		this.extension.connections.allowConnect(key);

		if(existingPanel != null) {
			existingPanel.reveal();

			if(StringUtils.isNotBlank(sqlImportEditorId)) {
				existingPanel.webview.postMessage(<OpenSqlImportEditorMessage>{command: 'openSqlImportEditor', importId: sqlImportEditorId});
			}

			if(SchemasProvider.isSelectable(target)) {
				await this.selectTable(existingPanel, key, config.id, target);
			} else if(target?.kind === 'filter') {
				existingPanel.webview.postMessage(<SetFilterMessage>{command: 'setFilter', filterText: target.filterText});
			}

			return;
		}

		let panel = vscode.window.createWebviewPanel(
			`${Extension.ID}.schemas`,
			SchemasUtils.label(config.name),
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [vscode.Uri.joinPath(this.extension.context.extensionUri, 'dist')],
				retainContextWhenHidden: true
			}
		);

		this.panelsByConnectionId.set(config.id, panel);

		panel.onDidDispose(() => {
			this.panelsByConnectionId.delete(config.id);
			this.extension.resultsViewProvider.closeSession(key);
			this.extension.connections.forgetClose({key: key});
		}, null, this.extension.context.subscriptions);

		panel.onDidChangeViewState(event => {
			if(event.webviewPanel.active) {
				this.extension.resultsViewProvider.activateSession(key);
			}
		}, null, this.extension.context.subscriptions);

		this.subscribeToTreeChanges(panel, key, config);

		// The Data tab's Add Row reads db2-workbench.dataEdit.* in the webview, so a change made anywhere -
		// this panel's Settings dialog, another panel's, Ctrl+, or settings.json - has to reach it.
		let configurationSubscription = vscode.workspace.onDidChangeConfiguration(event => {
			if(event.affectsConfiguration(`${Extension.ID}.dataEdit`)) {
				panel.webview.postMessage(<DataEditSettingsChangedMessage>{command: 'dataEditSettingsChanged', settings: this.extension.configurations.dataEditSettings});
			}
		});

		panel.onDidDispose(() => configurationSubscription.dispose());

		panel.webview.onDidReceiveMessage(async (message: SchemasOutboundMessage) => {
			if(message.command === 'loadViewDefinition') {
				await this.postViewDefinition(panel, key, config.id, message.schema, message.table, message.forceRefresh);
			} else if(message.command === 'loadRoutineParams') {
				await this.postRoutineParams(panel, key, config.id, message.schema, message.table, message.forceRefresh);
			} else if(message.command === 'loadRoutineDetail') {
				await this.postRoutineDetail(panel, key, config.id, message.schema, message.table, message.forceRefresh);
			} else if(message.command === 'loadRoutineDdl') {
				await this.postRoutineDdl(panel, key, config.id, message);
			} else if(message.command === 'loadRoutineSource') {
				await this.postRoutineSource(panel, key, config.id, message.schema, message.table);
			} else if(message.command === 'loadColumns') {
				await this.postColumns(panel, key, config.id, message.schema, message.table, message.forceRefresh);
			} else if(message.command === 'loadTableKeys') {
				await this.postTableKeys(panel, key, config.id, message.schema, message.table, message.forceRefresh);
			} else if(message.command === 'loadForeignKeys') {
				await this.postForeignKeys(panel, key, config.id, message.schema, message.table, message.forceRefresh);
			} else if(message.command === 'loadIndexes') {
				await this.postIndexes(panel, key, config.id, message.schema, message.table, message.forceRefresh);
			} else if(message.command === 'loadIndexAdvice') {
				await this.postIndexAdvice(panel, key, config.id, message.schema, message.table, message.forceRefresh);
			} else if(message.command === 'loadTriggers') {
				await this.postTriggers(panel, key, config.id, message.schema, message.table, message.forceRefresh);
			} else if(message.command === 'loadTriggerSource') {
				await this.postTriggerSource(panel, key, config.id, message);
			} else if(message.command === 'loadTableData') {
				await this.postTableData(panel, key, config.id, message.schema, message.table, message.offset, message.limit, message.orderBy, message.where);
			} else if(message.command === 'runGeneratedSql') {
				if(StringUtils.isNotBlank(message.sortSequence)) {
					await this.extension.indexQueries.executeCreateIndex({key: key, configId: config.id, sql: message.sql, sortSequence: message.sortSequence, sortSequenceLibrary: message.sortSequenceLibrary ?? ''});
				} else {
					await this.extension.connections.execute({key: key, configId: config.id, sql: message.sql, isInternal: true});
				}

				if(StringUtils.isNotBlank(message.deleteAdviceSql)) {
					await this.extension.indexQueries.deleteIndexAdvice({key: key, configId: config.id, sql: message.deleteAdviceSql});
				}

				// The Advised Indexes tab's own cached lookup for this table is now stale (e.g. the just-run
				// CREATE INDEX should remove the corresponding advice row) - force a live recheck rather
				// than waiting for the tab to be remounted.
				await this.postIndexAdvice(panel, key, config.id, message.schema, message.table, true);

				// The Indexes tab's cache is now stale too - just cleared (not pushed) so it lazy-reloads
				// next time it's mounted, same as any other lazy tab's first load.
				await this.extension.memoryCache.deleteIndexesCache({key: key, configId: config.id, tables: {schema: message.schema, table: message.table}});
			} else if(message.command === 'deleteIndex' || message.command === 'renameIndex') {
				if(message.command === 'deleteIndex') {
					await this.extension.indexQueries.deleteIndex({key: key, configId: config.id, sql: message.sql});
				} else {
					await this.extension.indexQueries.renameIndex({key: key, configId: config.id, sql: message.sql});
				}

				// Unlike runGeneratedSql's lazy-clear above, the Indexes tab is already mounted and
				// showing the row that was just deleted/renamed - push a fresh load rather than leaving
				// the stale row in place until the tab is remounted.
				await this.postIndexes(panel, key, config.id, message.schema, message.table, true);

				// A dropped index may now be advised again (and a renamed one no longer matches any
				// cached advice row), so recheck the same way runGeneratedSql does after Create Index.
				await this.postIndexAdvice(panel, key, config.id, message.schema, message.table, true);
			} else if(message.command === 'deleteIndexAdvice') {
				await this.extension.indexQueries.deleteIndexAdvice({key: key, configId: config.id, sql: message.sql});

				// The Advised Indexes tab is already mounted and showing the row that was just deleted -
				// push a fresh load rather than leaving the stale row in place until the tab is remounted.
				await this.postIndexAdvice(panel, key, config.id, message.schema, message.table, true);
			} else if(message.command === 'updateSchemaList') {
				// No push here (nor after either import below, nor after removeImportedTableData): all four
				// mutate shared state, so the repaint comes back through SchemaTreeChangedEvent - which also
				// reaches any diagram open on this connection.
				try {
					await this.extension.schemaTrees.updateSchemaList({key: key, configId: config.id}, message);
				} catch(error) {
					AlertUtils.onError(error);
				}
			} else if(message.command === 'runDataEditStatements') {
				let result = await this.extension.dataQueries.executeStatements({
					key: key,
					configId: config.id,
					statements: message.statements,
					onProgress: (index, status) => panel.webview.postMessage(<RunDataEditStatementProgressMessage>{command: 'runDataEditStatementProgress', index: index, status: status})
				});
				panel.webview.postMessage(<RunDataEditStatementsResultMessage>{command: 'runDataEditStatementsResult', executedCount: result.executedCount, failed: result.failed, error: result.error});
			} else if(message.command === 'exportSchema') {
				await this.handleExportSchema(key, config, message.schema, message.table, message.format, message.destination);
			} else if(message.command === 'importSchema') {
				await this.applyImport(panel, await this.extension.schemaTrees.importFromFile({key: key, configId: config.id}));
			} else if(message.command === 'importSchemaFromText') {
				await this.applyImport(panel, await this.extension.schemaTrees.importFromText({key: key, configId: config.id}, message.format, message.content));
			} else if(message.command === 'runSqlImport') {
				let result = await this.extension.sqlSchemaImports.run({key: key, configId: config.id, statements: message.statements});
				panel.webview.postMessage(<SqlImportRunResultMessage>{command: 'sqlImportRunResult', result: result});
			} else if(message.command === 'importSqlSchema') {
				// No tree push here either - the import fires SCHEMA_TREE_CHANGED like every other one. This
				// reply only carries what the summary dialog needs (or why the import didn't happen).
				let result = await this.extension.sqlSchemaImports.import({runId: message.runId, name: message.name, mappings: message.mappings, save: message.save, connectionIds: message.connectionIds});
				panel.webview.postMessage(<SqlImportResultMessage>{command: 'sqlImportResult', result: result});
			} else if(message.command === 'loadSqlImport') {
				panel.webview.postMessage(<SqlImportLoadedMessage>{command: 'sqlImportLoaded', config: this.extension.sqlSchemaImports.getSavedImport(message.importId)});
			} else if(message.command === 'saveSqlImport') {
				let outcome = await this.extension.sqlSchemaImports.saveSavedImport({key: key, configId: config.id}, {...message});
				panel.webview.postMessage(<SqlImportSavedMessage>{command: 'sqlImportSaved', saved: outcome.saved, message: outcome.saved ? undefined : outcome.message});

				if(outcome.saved) {
					this.postImports(panel, config.id);
				}
			} else if(message.command === 'refreshSqlImport') {
				await this.extension.sqlSchemaImports.refreshImport({key: key, configId: config.id}, message.importId);
				this.postImports(panel, config.id);
			} else if(message.command === 'loadSqlImportConnections') {
				panel.webview.postMessage(<SqlImportConnectionsLoadedMessage>{command: 'sqlImportConnectionsLoaded', connections: this.extension.sqlSchemaImports.getConnectionTargets(config.id)});
			} else if(message.command === 'discardSqlImportRun') {
				this.extension.sqlSchemaImports.discardRun(message.runId);
			} else if(message.command === 'disableImportedTableData') {
				this.extension.schemaTrees.disableImportedTableData(config.id, message.schema, message.table);
			} else if(message.command === 'enableImportedTableData') {
				this.extension.schemaTrees.enableImportedTableData(config.id, message.schema, message.table);
			} else if(message.command === 'savePanelWidth') {
				this.extension.globalStates.setSchemaBrowserPanelWidth(message.panel, message.width);
			} else if(message.command === 'saveDataEditSettings') {
				// No reply - the configuration listener above posts the saved settings back.
				await this.extension.configurations.setDataEditSettings(message.settings);
			} else if(message.command === 'loadImports') {
				this.postImports(panel, config.id);
			} else if(message.command === 'applyImports') {
				// The tree repaint still rides SchemaTreeChangedEvent (see updateSchemaList above); this
				// pushes the refreshed import list on top of it, since the dialog stays open afterwards.
				await this.applyImports(config.id, message);
				this.postImports(panel, config.id);
			}
		}, null, this.extension.context.subscriptions);

		// Otherwise the panel sits blank (VS Code's default empty webview) for as long as
		// establishing the connection and running the initial getTables() query takes - which
		// includes a password prompt on first connect, so it can be a while.
		panel.webview.html = WebviewHtmlUtils.getLoadingHtml(`Connecting to ${config.name}...`);

		try {
			// SchemaTrees.buildTreeState()'s getTables() call is what establishes the connection (firing the
			// CONNECTING/CONNECTED events that create+activate this panel's bottom-panel session) - see
			// the "Data layer" section of the schemas-browser plan for why getTables() is relied on to
			// connect eagerly, and its connectionInfo is reused below for job details/sort sequence.
			let overrides = this.extension.globalStates.getSchemaListOverrides(config.id);
			let state = await this.extension.schemaTrees.buildTreeState({key: key, configId: config.id, overrides: overrides});

			// Opening straight to a specific table (e.g. via F12) must never land on a schema that's
			// hidden or not yet known - unhide/add it and rebuild before the tree is even shown, so
			// there's no flash of a missing table followed by a state push.
			if(SchemasProvider.isSelectable(target)) {
				let ensured = await this.ensureSchemaVisible(config.id, overrides, state.schemaList, target.schema);

				if(ensured.changed) {
					state = await this.extension.schemaTrees.buildTreeState({key: key, configId: config.id, overrides: ensured.overrides});
				}
			}

			let initialState: SchemasInitialState = {
				connectionName: config.name,
				tablesBySchema: state.tablesBySchema,
				viewsBySchema: state.viewsBySchema,
				functionsBySchema: state.functionsBySchema,
				proceduresBySchema: state.proceduresBySchema,
				schemaList: state.schemaList,
				currentSortSequence: state.connectionInfo?.jobDetails.sortSequence ?? '',
				currentSortSequenceLibrary: state.connectionInfo?.jobDetails.sortSequenceLibrary ?? '',
				initialSelectedTable: SchemasProvider.isSelectable(target) ? SchemasProvider.toSelectedTable(target) : undefined,
				initialFilterText: target?.kind === 'filter' ? target.filterText : undefined,
				initialSqlImportEditorId: sqlImportEditorId,
				panelWidths: this.extension.globalStates.schemaBrowserPanelWidths,
				dataEditSettings: this.extension.configurations.dataEditSettings
			};

			panel.webview.html = WebviewHtmlUtils.getReactWebviewHtml({
				webview: panel.webview,
				extensionUri: this.extension.context.extensionUri,
				bundleName: 'schemas',
				initialState: initialState
			});
		} catch(error) {
			// No retry affordance in v1 (the whole tree loads once, up front) - a blank, un-disposed
			// panel with no explanation would be worse than closing it and telling the user why.
			AlertUtils.onError(error);
			panel.dispose();
		}
	}

	// Makes sure `schema` shows up in the tree before a specific table in it is opened - unhiding it if
	// the user had hidden it, or marking it as manually added if it isn't known at all yet (e.g. via
	// "Go to Definition" on a schema outside the library list). Only persists (and reports changed:
	// true) when something actually needs to change, so opening an already-visible table costs nothing
	// extra.
	private async ensureSchemaVisible(configId: string, currentOverrides: GlobalStates.SchemaListOverrides, schemaList: SchemasSchemaListEntry[], schema: string): Promise<{overrides: GlobalStates.SchemaListOverrides; changed: boolean}> {
		let normalizedSchema = schema.toUpperCase();
		let existing = schemaList.find(entry => StringUtils.equalsIgnoreCase(entry.name, normalizedSchema));

		if(existing && !existing.hidden) {
			return {overrides: currentOverrides, changed: false};
		}

		let updated: GlobalStates.SchemaListOverrides = {
			added: existing ? currentOverrides.added : [...currentOverrides.added, normalizedSchema],
			hidden: currentOverrides.hidden.filter(hidden => !StringUtils.equalsIgnoreCase(hidden, normalizedSchema))
		};

		this.extension.globalStates.setSchemaListOverrides(configId, updated);
		return {overrides: updated, changed: true};
	}

	// Selects a table in an already-open panel - unlike show()'s fresh-open path, this has to push
	// whatever schema-visibility change ensureSchemaVisible made (if any) before the selectTable
	// message, since the webview's current tablesBySchema may not already include the target schema.
	private async selectTable(panel: vscode.WebviewPanel, key: string, configId: string, target: SchemasProvider.SelectableTarget): Promise<void> {
		let overrides = this.extension.globalStates.getSchemaListOverrides(configId);
		let state = await this.extension.schemaTrees.buildTreeState({key: key, configId: configId, overrides: overrides});
		let ensured = await this.ensureSchemaVisible(configId, overrides, state.schemaList, target.schema);

		if(ensured.changed) {
			state = await this.extension.schemaTrees.buildTreeState({key: key, configId: configId, overrides: ensured.overrides});
			panel.webview.postMessage(<SchemaListUpdatedMessage>{command: 'schemaListUpdated', tablesBySchema: state.tablesBySchema, viewsBySchema: state.viewsBySchema, functionsBySchema: state.functionsBySchema, proceduresBySchema: state.proceduresBySchema, schemaList: state.schemaList});
		}

		panel.webview.postMessage(<SelectTableMessage>{command: 'selectTable', ...SchemasProvider.toSelectedTable(target)});
	}

	// The webview's form of a target: `kind` only for a view or a function, the same optional-kind shape its
	// TableKey uses, so a table target reads exactly as it did before anything else could be targeted.
	private static toSelectedTable(target: SchemasProvider.SelectableTarget): {schema: string; table: string; kind?: SchemasObjectKind} {
		return target.kind === 'table'
			? {schema: target.schema, table: target.table}
			: {schema: target.schema, table: target.table, kind: target.kind};
	}

	private static isSelectable(target: SchemasProvider.TableTarget | undefined): target is SchemasProvider.SelectableTarget {
		return target != null && target.kind !== 'filter';
	}

	// A function's Parameters and Result Columns tabs. `specificName` arrives as the message's `table`.
	private async postRoutineParams(panel: vscode.WebviewPanel, key: string, configId: string, schema: string, specificName: string, forceRefresh?: boolean): Promise<void> {
		try {
			let params = await this.extension.memoryCache.getRoutineParams({key: key, configId: configId, tables: {schema: schema, table: specificName}, forceRefresh: forceRefresh});
			panel.webview.postMessage(<RoutineParamsLoadedMessage>{command: 'routineParamsLoaded', schema: schema, table: specificName, params: params});
		} catch(error) {
			panel.webview.postMessage(<RoutineParamsErrorMessage>{command: 'routineParamsError', schema: schema, table: specificName, error: DbErrorUtils.serialize(error)});
		}
	}

	// A function's Info and Definition tabs. The body is formatted here, the same as a view's definition -
	// a routine body (BEGIN ... END, RETURN ...) isn't a statement the formatter always handles, which is
	// what its fallback to the raw text is for.
	private async postRoutineDetail(panel: vscode.WebviewPanel, key: string, configId: string, schema: string, specificName: string, forceRefresh?: boolean): Promise<void> {
		try {
			let detail = await this.extension.memoryCache.getRoutineDetail({key: key, configId: configId, schema: schema, specificName: specificName, forceRefresh: forceRefresh});
			let definition = detail?.definition ?? '';
			let formatted = StringUtils.isBlank(definition) ? '' : this.formatDefinition(definition);
			panel.webview.postMessage(<RoutineDetailLoadedMessage>{command: 'routineDetailLoaded', schema: schema, table: specificName, detail: detail ?? undefined, formattedDefinition: formatted});
		} catch(error) {
			panel.webview.postMessage(<RoutineDetailErrorMessage>{command: 'routineDetailError', schema: schema, table: specificName, error: DbErrorUtils.serialize(error)});
		}
	}

	// Whether `schema.table` is an actual, live DB2 table (or view - the Columns tab is shared by both) - needed because MemoryCache.getColumns/etc.
	// return an empty array both when a real table just happens to have zero of that kind of row (e.g.
	// no real foreign keys) and when the table doesn't exist in DB2 at all (an imported-only table). The
	// resolver needs to tell those two apart (see table-resolver.ts's `T[] | undefined` convention), and
	// an empty array alone can't do that - this is the check that can. getTables() is already cached per
	// connection, so this doesn't add a new query beyond the first call for a given schema.
	private async connectedTableExists(key: string, configId: string, schema: string, table: string): Promise<boolean> {
		let tables = await this.extension.memoryCache.getTables({key: key, configId: configId, schema: schema});
		return tables.some(candidate => StringUtils.equalsIgnoreCase(candidate.name, table)) || await this.connectedViewExists(key, configId, schema, table);
	}

	// Views never get a SystemTable entry (getTables only lists T/P types), so they're looked up on their
	// own - also what tells postTableData to page a view without an RRN fallback key.
	private async connectedViewExists(key: string, configId: string, schema: string, view: string): Promise<boolean> {
		let views = await this.extension.memoryCache.getViewsForSchemas({key: key, configId: configId}, [schema]);
		return views.some(candidate => StringUtils.equalsIgnoreCase(candidate.name, view));
	}

	// The Definition tab: the raw SYSVIEWS text plus a formatted copy, formatted here rather than in the
	// webview since the formatter and the user's formatting settings both live on the host. A definition
	// the formatter can't handle is shown raw in both places rather than failing the tab.
	private async postViewDefinition(panel: vscode.WebviewPanel, key: string, configId: string, schema: string, view: string, forceRefresh?: boolean): Promise<void> {
		try {
			let definition = await this.extension.memoryCache.getViewDefinition({key: key, configId: configId, schema: schema, view: view, forceRefresh: forceRefresh});
			let formatted = this.formatDefinition(definition);
			panel.webview.postMessage(<ViewDefinitionLoadedMessage>{command: 'viewDefinitionLoaded', schema: schema, table: view, definition: definition, formatted: formatted});
		} catch(error) {
			panel.webview.postMessage(<ViewDefinitionErrorMessage>{command: 'viewDefinitionError', schema: schema, table: view, error: DbErrorUtils.serialize(error)});
		}
	}

	private formatDefinition(definition: string): string {
		try {
			return SqlDocumentFormatter.formatDocumentText(definition, this.extension.configurations.formattingOptions);
		} catch {
			return definition;
		}
	}

	// The connected table's columns, so the Table Keys/Foreign Keys resolvers can match an imported
	// constraint that names its columns in the other name form (see table-resolver.ts's
	// buildColumnNameResolver). Only fetched when there's an import to reconcile against - with none,
	// nothing is compared and the (cached, but not free on first use) column lookup isn't needed.
	private async connectedColumnsForMatching(key: string, configId: string, schema: string, table: string, exists: boolean, imported: readonly unknown[]): Promise<SystemColumn[] | undefined> {
		if(!exists || imported.length === 0) {
			return undefined;
		}

		return this.extension.memoryCache.getColumns({key: key, configId: configId, tables: {schema: schema, table: table}});
	}

	// Applies the View Imports dialog's Apply: switches the named tables off and on, then unlinks or
	// deletes whichever imports the confirmation asked to take off the list entirely. The confirmation only
	// offers those options for an import the apply leaves fully disabled, and findImportsToUnlink /
	// findImportsToDelete hold the host to that same rule - the ids arrive from a webview, and the store
	// can have moved since the confirmation was raised.
	//
	// Both lists are computed BEFORE anything is applied, since the apply is exactly what makes the
	// imports in question fully disabled. Order matters after that: the data goes first, so an import that
	// ends up deleted is already out of the tree by the time its settings entry follows it.
	private async applyImports(configId: string, message: ApplyImportsMessage): Promise<void> {
		let summaries = this.extension.schemaTrees.getImports(configId);
		let unlinkable = findImportsToUnlink(summaries, message.disable, message.enable, message.unlinkImportIds ?? []);
		let deletable = findImportsToDelete(summaries, message.disable, message.enable, message.deleteImportIds ?? []);

		this.extension.schemaTrees.enableEntries(configId, message.enable);
		this.extension.schemaTrees.disableEntries(configId, message.disable);

		for(let summary of unlinkable) {
			await this.extension.sqlSchemaImports.unlinkSavedImport(configId, summary.importId);
		}

		for(let summary of deletable) {
			// A saved import loses its settings entry (and every other connection's link to it); an unsaved
			// one has nothing but the rows, so dropping those is the whole delete.
			if(summary.saved) {
				await this.extension.sqlSchemaImports.deleteSavedImport(summary.importId);
			} else {
				this.extension.schemaTrees.removeImport(configId, summary.importId);
			}
		}
	}

	private async postColumns(panel: vscode.WebviewPanel, key: string, configId: string, schema: string, table: string, forceRefresh?: boolean): Promise<void> {
		try {
			if(forceRefresh) {
				await this.extension.memoryCache.deleteColumnsCache({key: key, configId: configId, tables: {schema: schema, table: table}});
			}

			let columns = await this.extension.memoryCache.getColumns({key: key, configId: configId, tables: {schema: schema, table: table}});
			let exists = await this.connectedTableExists(key, configId, schema, table);
			let imported = await this.extension.schemaTrees.loadImportedTablesForTable({key: key, configId: configId}, schema, table);
			let resolved = resolveColumns(exists ? columns : undefined, imported);
			panel.webview.postMessage(<ColumnsLoadedMessage>{command: 'columnsLoaded', schema: schema, table: table, columns: resolved});
		} catch(error) {
			panel.webview.postMessage(<ColumnsErrorMessage>{command: 'columnsError', schema: schema, table: table, error: DbErrorUtils.serialize(error)});
		}
	}

	private async postTableKeys(panel: vscode.WebviewPanel, key: string, configId: string, schema: string, table: string, forceRefresh?: boolean): Promise<void> {
		try {
			if(forceRefresh) {
				await this.extension.memoryCache.deleteTableKeysCache({key: key, configId: configId, tables: {schema: schema, table: table}});
			}

			let tableKeys = await this.extension.memoryCache.getTableKeys({key: key, configId: configId, tables: {schema: schema, table: table}});
			let exists = await this.connectedTableExists(key, configId, schema, table);
			let imported = await this.extension.schemaTrees.loadImportedTablesForTable({key: key, configId: configId}, schema, table);
			let resolved = resolveTableKeys(exists ? tableKeys : undefined, imported, await this.connectedColumnsForMatching(key, configId, schema, table, exists, imported));
			panel.webview.postMessage(<TableKeysLoadedMessage>{command: 'tableKeysLoaded', schema: schema, table: table, tableKeys: resolved});
		} catch(error) {
			panel.webview.postMessage(<TableKeysErrorMessage>{command: 'tableKeysError', schema: schema, table: table, error: DbErrorUtils.serialize(error)});
		}
	}

	private async postForeignKeys(panel: vscode.WebviewPanel, key: string, configId: string, schema: string, table: string, forceRefresh?: boolean): Promise<void> {
		try {
			if(forceRefresh) {
				await this.extension.memoryCache.deleteForeignKeysCache({key: key, configId: configId, tables: {schema: schema, table: table}});
			}

			let foreignKeys = await this.extension.memoryCache.getForeignKeys({key: key, configId: configId, tables: {schema: schema, table: table}});
			let exists = await this.connectedTableExists(key, configId, schema, table);
			let imported = await this.extension.schemaTrees.loadImportedTablesForTable({key: key, configId: configId}, schema, table);
			let resolved = resolveForeignKeys(exists ? foreignKeys : undefined, imported, await this.connectedColumnsForMatching(key, configId, schema, table, exists, imported));
			panel.webview.postMessage(<ForeignKeysLoadedMessage>{command: 'foreignKeysLoaded', schema: schema, table: table, foreignKeys: resolved});
		} catch(error) {
			panel.webview.postMessage(<ForeignKeysErrorMessage>{command: 'foreignKeysError', schema: schema, table: table, error: DbErrorUtils.serialize(error)});
		}
	}

	private async postIndexes(panel: vscode.WebviewPanel, key: string, configId: string, schema: string, table: string, forceRefresh?: boolean): Promise<void> {
		try {
			if(forceRefresh) {
				await this.extension.memoryCache.deleteIndexesCache({key: key, configId: configId, tables: {schema: schema, table: table}});
			}

			let indexes = await this.extension.memoryCache.getIndexes({key: key, configId: configId, tables: {schema: schema, table: table}});
			let exists = await this.connectedTableExists(key, configId, schema, table);
			// The synchronous lookup, unlike every other tab here: a SQL import has no section that could
			// supply an index, so the lazily loaded parts of one have nothing to contribute and asking for
			// them would only run the Columns/Relationships queries earlier than anything needs them.
			let resolved = resolveIndexes(exists ? indexes : undefined, this.extension.schemaTrees.getImportedTablesFor(configId, schema, table));
			panel.webview.postMessage(<IndexesLoadedMessage>{command: 'indexesLoaded', schema: schema, table: table, indexes: resolved});
		} catch(error) {
			panel.webview.postMessage(<IndexesErrorMessage>{command: 'indexesError', schema: schema, table: table, error: DbErrorUtils.serialize(error)});
		}
	}

	private async postIndexAdvice(panel: vscode.WebviewPanel, key: string, configId: string, schema: string, table: string, forceRefresh?: boolean): Promise<void> {
		try {
			let indexAdvice = await this.extension.memoryCache.getIndexAdvice({key: key, configId: configId, tables: [{schema: schema, table: table}], forceRefresh: forceRefresh});
			panel.webview.postMessage(<IndexAdviceLoadedMessage>{command: 'indexAdviceLoaded', schema: schema, table: table, indexAdvice: indexAdvice.map(SchemasProvider.toSchemasIndexAdvice)});
		} catch(error) {
			panel.webview.postMessage(<IndexAdviceErrorMessage>{command: 'indexAdviceError', schema: schema, table: table, error: DbErrorUtils.serialize(error)});
		}
	}

	private static toSchemasIndexAdvice(advice: SystemIndexAdvice): SchemasIndexAdvice {
		return {...advice, lastAdvised: advice.lastAdvised.toISOString()};
	}

	// Connected tables only, like Advised Indexes - an import has nothing to say about triggers, so there
	// is no resolver step here.
	private async postTriggers(panel: vscode.WebviewPanel, key: string, configId: string, schema: string, table: string, forceRefresh?: boolean): Promise<void> {
		try {
			if(forceRefresh) {
				await this.extension.memoryCache.deleteTriggersCache({key: key, configId: configId, tables: {schema: schema, table: table}});
			}

			let triggers = await this.extension.memoryCache.getTriggers({key: key, configId: configId, tables: {schema: schema, table: table}});
			panel.webview.postMessage(<TriggersLoadedMessage>{command: 'triggersLoaded', schema: schema, table: table, triggers: triggers.map(SchemasProvider.toSchemasTrigger)});
		} catch(error) {
			panel.webview.postMessage(<TriggersErrorMessage>{command: 'triggersError', schema: schema, table: table, error: DbErrorUtils.serialize(error)});
		}
	}

	// Every source is read even when one fails - see ProgramQueries.readSources. A program that no longer
	// exists shows as one with no recorded source, which is what the dialog has always said for it.
	private async postTriggerSource(panel: vscode.WebviewPanel, key: string, configId: string, message: LoadTriggerSourceMessage): Promise<void> {
		let reply = {schema: message.schema, table: message.table, triggerName: message.triggerName};

		try {
			let options = {key: key, configId: configId};
			let locations = await this.extension.programQueries.listSourceLocations({...options, library: message.programLibrary, program: message.programName});
			let sources = await this.readProgramSources(options, locations ?? [], message.programLibrary);
			let handlers = await this.readTriggerHandlers(options, message);

			panel.webview.postMessage(<TriggerSourceLoadedMessage>{command: 'triggerSourceLoaded', ...reply, sources: sources, handlers: handlers});
		} catch(error) {
			panel.webview.postMessage(<TriggerSourceErrorMessage>{command: 'triggerSourceError', ...reply, error: SchemasProvider.serializeLookupError(error)});
		}
	}

	// The programs a dispatching trigger program calls for this table, each with its source, read the way a
	// routine's Program Source tab reads a service program's. Best effort: a dispatcher that can't be seen
	// through still shows its own source, so a failure here leaves the handlers out rather than failing the
	// dialog (any failed lookup has already reached the History tab).
	private async readTriggerHandlers(options: DbConnections.CommonListOptions, message: LoadTriggerSourceMessage): Promise<SchemasTriggerHandler[] | undefined> {
		try {
			let handlers = await this.extension.triggerDispatchQueries.findHandlers({
				...options,
				schema: message.schema,
				table: message.table,
				programLibrary: message.programLibrary,
				programName: message.programName
			});
			let read: SchemasTriggerHandler[] = [];

			for(let handler of handlers) {
				let locations = await this.extension.programQueries.listSourceLocations({...options, library: handler.library, program: handler.object, objectType: handler.objectType});
				let sources = await this.readProgramSources(options, locations ?? [], handler.library);
				let entryIndex = handler.entry == null ? undefined : findEntrySource(sources, handler.entry, handler.object);

				read.push({
					program: `${handler.library}/${handler.object} (${handler.objectType})`,
					object: handler.object,
					entry: handler.entry,
					via: `${handler.via.schema}/${handler.via.table}`,
					unselected: handler.unselected,
					sources: entryIndex == null ? sources : [sources[entryIndex]]
				});
			}

			return read.length ? read : undefined;
		} catch(error) {
			if(error instanceof CatalogLookupError) {
				return undefined;
			}

			throw error;
		}
	}

	private async readProgramSources(options: DbConnections.CommonListOptions, locations: ProgramSourceLocation[], programLibrary: string): Promise<SchemasProgramSource[]> {
		return (await this.extension.programQueries.readSources(options, locations, {programLibrary: programLibrary})).map(read => ({
			module: read.location.module,
			location: describeSourceLocation(read.location),
			text: read.text,
			unavailable: read.unavailable,
			notice: read.notice,
			error: read.error == null ? undefined : SchemasProvider.serializeLookupError(read.error)
		}));
	}

	// The Definition tab's full DDL. A failure is posted as such rather than as an empty statement, so the
	// tab can say why and show the stored body instead.
	private async postRoutineDdl(panel: vscode.WebviewPanel, key: string, configId: string, message: LoadRoutineDdlMessage): Promise<void> {
		let reply = {schema: message.schema, table: message.table};

		try {
			let ddl = await this.extension.memoryCache.getRoutineDdl({key: key, configId: configId, schema: message.schema, specificName: message.table, routineType: message.routineType, forceRefresh: message.forceRefresh});
			panel.webview.postMessage(<RoutineDdlLoadedMessage>{command: 'routineDdlLoaded', ...reply, ddl: ddl});
		} catch(error) {
			panel.webview.postMessage(<RoutineDdlErrorMessage>{command: 'routineDdlError', ...reply, error: SchemasProvider.serializeLookupError(error)});
		}
	}

	// The Program Source tab: from the routine's external name to the object it runs (resolving *LIBL the
	// way the system does), to that object's module sources, read the same way a trigger program's are.
	// For a service program, the module that defines the routine's entry point is picked out. Every way
	// there can be nothing to show - a Java routine, a name that isn't an object, an object since deleted -
	// is a reason posted with the reply, not an error.
	private async postRoutineSource(panel: vscode.WebviewPanel, key: string, configId: string, schema: string, specificName: string): Promise<void> {
		let reply = {schema: schema, table: specificName};
		let unavailable = (program: string, reason: string) => panel.webview.postMessage(<RoutineSourceLoadedMessage>{command: 'routineSourceLoaded', ...reply, program: program, sources: [], unavailable: reason});

		try {
			let options = {key: key, configId: configId};
			let detail = await this.extension.memoryCache.getRoutineDetail({...options, schema: schema, specificName: specificName});
			let routine = (await this.extension.memoryCache.getRoutines({...options, schema: schema})).find(candidate => StringUtils.equalsIgnoreCase(candidate.specificName, specificName));
			let externalName = detail?.externalName ?? '';

			if(StringUtils.equalsIgnoreCase(routine?.language, 'JAVA')) {
				return void unavailable(externalName, `A Java routine runs ${externalName || 'a Java method'}, whose source is not kept on the system.`);
			}

			let program = parseExternalName(externalName);

			if(program == null) {
				return void unavailable(externalName, StringUtils.isBlank(externalName)
					? 'No external program is recorded for this routine.'
					: `${externalName} does not name a program or service program.`);
			}

			let library = program.library ?? await this.extension.programQueries.resolveLibrary({...options, objectType: program.objectType, program: program.object});
			let described = `${library ?? '*LIBL'}/${program.object} (${program.objectType})`;

			if(library == null) {
				// Where copies are is a hint, not something to fail over - the routine is unreachable either way.
				let copies = await this.extension.programQueries.listLibrariesHolding({...options, objectType: program.objectType, program: program.object}).catch(() => []);
				let notFound = `${program.objectType} ${program.object} was not found on the library list, so calling this ${routine?.routineType === 'FUNCTION' ? 'function' : 'procedure'} from this connection would fail.`;

				return void unavailable(described, copies.length ? `${notFound} Copies exist in ${copies.join(', ')}.` : notFound);
			}

			let locations = await this.extension.programQueries.listSourceLocations({...options, library: library, program: program.object, objectType: program.objectType});

			if(locations == null) {
				return void unavailable(described, `${program.objectType} ${library}/${program.object} was not found - it may have been deleted since the routine was created.`);
			}

			let sources = await this.readProgramSources(options, locations, library);
			let entryIndex = program.entry == null ? undefined : findEntrySource(sources, program.entry, program.object);

			// Only the entry's own module is shown. The others are bound in by copy (from the module list or a
			// binding directory) and say nothing about this routine. When the entry can't be told apart, every
			// module stays, so the source is still there to look through.
			if(entryIndex != null) {
				sources = [sources[entryIndex]];
			}

			panel.webview.postMessage(<RoutineSourceLoadedMessage>{
				command: 'routineSourceLoaded',
				...reply,
				program: described,
				entry: program.entry,
				sources: sources,
				entryModuleFound: program.entry == null ? undefined : entryIndex != null,
				resolvedFromLibraryList: program.library == null
			});
		} catch(error) {
			panel.webview.postMessage(<RoutineSourceErrorMessage>{command: 'routineSourceError', ...reply, error: SchemasProvider.serializeLookupError(error)});
		}
	}

	// A CatalogLookupError wraps the driver's own error, which is what carries the SQLSTATE detail.
	private static serializeLookupError(error: unknown): DbErrorUtils.SerializedError {
		return DbErrorUtils.serialize(error instanceof CatalogLookupError && error.driverError != null ? error.driverError : error);
	}

	private static toSchemasTrigger(trigger: SystemTrigger): SchemasTrigger {
		return {...trigger, created: trigger.created.toISOString(), lastAltered: trigger.lastAltered?.toISOString()};
	}

	private async postTableData(panel: vscode.WebviewPanel, key: string, configId: string, schema: string, table: string, offset: number, limit: number, orderBy?: {systemName: string; direction: 'asc' | 'desc'}, where?: string): Promise<void> {
		try {
			let columns = await this.extension.memoryCache.getColumns({key: key, configId: configId, tables: {schema: schema, table: table}});
			let tableKeys = await this.extension.memoryCache.getTableKeys({key: key, configId: configId, tables: {schema: schema, table: table}});

			// An identity column (DB2 for i allows at most one) is preferred over the declared PRIMARY
			// KEY when both exist - it's a generated, immutable surrogate key, whereas the PK constraint
			// can end up on a different (business) column that happens to also be unique. Only falls
			// back to the PK/UNIQUE constraint columns when the table has no identity column.
			let identityColumn = columns.find(column => column.identity === 'YES');

			let primaryKeyColumns = identityColumn
				? [identityColumn.systemName]
				: tableKeys
					.filter(tableKey => tableKey.constraintType === 'PRIMARY KEY')
					.sort((first, second) => first.ordinalPosition - second.ordinalPosition)
					.map(tableKey => tableKey.systemColumnName);

			let readOnly = await this.connectedViewExists(key, configId, schema, table);
			let {rows, hasMore, keyColumns, error} = await this.extension.dataQueries.listTableData({key: key, configId: configId, schema: schema, table: table, columns: columns, primaryKeyColumns: primaryKeyColumns, orderBy: orderBy ? [orderBy] : undefined, where: where, offset: offset, limit: limit, readOnly: readOnly});

			if(error) {
				panel.webview.postMessage(<TableDataErrorMessage>{command: 'tableDataError', schema: schema, table: table, error: error});
				return;
			}

			// Keyed by systemName, not sqlName - DataQueries.listTableData selects columns by their
			// short system name (no alias), so that's what the raw row keys/grid column ids are here.
			let lookup = new Map(columns.map(column => [column.systemName.toUpperCase(), column]));
			let columnLabels = ColumnNameUtils.buildLabelMap(lookup, columns.map(column => column.systemName), this.extension.configurations.resultHeadingLabels);

			panel.webview.postMessage(<TableDataLoadedMessage>{command: 'tableDataLoaded', schema: schema, table: table, offset: offset, rows: rows, columns: columns, columnLabels: columnLabels, hasMore: hasMore, keyColumns: keyColumns});
		} catch(error) {
			panel.webview.postMessage(<TableDataErrorMessage>{command: 'tableDataError', schema: schema, table: table, error: DbErrorUtils.serialize(error)});
		}
	}

	private static buildDefaultSchemaFileName(schema: string, table: string, extension: string): string {
		let sanitizedPrefix = `${schema}.${table}`.replace(/[^A-Za-z0-9_.-]/g, '_');
		let now = new Date();
		let pad = (value: number) => value.toString().padStart(2, '0');
		let timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

		return `${sanitizedPrefix}-${timestamp}.${extension}`;
	}

	// Answers both the View Imports dialog's initial load and each removal it makes, with the whole current
	// list either way - the dialog never reconciles a removal against what it was showing.
	private postImports(panel: vscode.WebviewPanel, configId: string): void {
		panel.webview.postMessage(<ImportsLoadedMessage>{command: 'importsLoaded', imports: this.extension.schemaTrees.getImports(configId)});
	}

	// Both file/paste ImportSchemaDialog paths land here. SchemaTrees did the parsing and merging, and a
	// successful import repaints this tree through SchemaTreeChangedEvent like any other change - so all
	// this panel adds is the outcome dialog: the summary of what landed, or the parse error with the text
	// that failed. Nothing to do for a cancelled file dialog.
	private applyImport(panel: vscode.WebviewPanel, result: SchemaTrees.ImportResult): void {
		if(result.kind === 'error') {
			panel.webview.postMessage(<ImportSchemaErrorMessage>{command: 'importSchemaError', error: SchemaImportErrorUtils.serialize(result.error), content: result.content});
		} else if(result.kind === 'imported') {
			panel.webview.postMessage(<ImportSchemaSummaryMessage>{command: 'importSchemaSummary', report: result.report});
		}
	}

	// Repaints this panel's tree whenever the shared schema tree for ITS connection changes, whoever
	// changed it - this panel, another schema browser, or a diagram's own copy of the same two menu
	// items. Subscribed per panel and disposed with it.
	private subscribeToTreeChanges(panel: vscode.WebviewPanel, key: string, config: ConnectionConfig): void {
		let subscription = this.extension.eventManager.onEvent(event => {
			if(event.type !== Event.Type.SCHEMA_TREE_CHANGED || (<SchemaTreeChangedEvent>event).configId !== config.id) {
				return;
			}

			TryUtils.forgetPromise({
				context: 'schemas-provider onSchemaTreeChanged',
				promise: async () => {
					let state = await this.extension.schemaTrees.buildTreeState({key: key, configId: config.id});
					panel.webview.postMessage(<SchemaListUpdatedMessage>{command: 'schemaListUpdated', tablesBySchema: state.tablesBySchema, viewsBySchema: state.viewsBySchema, functionsBySchema: state.functionsBySchema, proceduresBySchema: state.proceduresBySchema, schemaList: state.schemaList});
				},
				onError: error => AlertUtils.onError(error)
			});
		});

		panel.onDidDispose(() => subscription.dispose());
	}
	// Table tab header's "Export" menu - mirrors WorkbenchViewProvider.handleExportData's convention
	// exactly (clipboard short-circuits before the save dialog, default filename/directory, cancel
	// returns silently, write via vscode.workspace.fs, confirm via AlertUtils.onInfo). Works from
	// whatever's resolved regardless of whether a live table backs it - see table-resolver.ts - so an
	// imported-only table exports just as well as a connected one.
	//
	// `.drawio` is the one format that isn't a SchemaFormatConverter (dbml/frictionless only ever handle
	// one table's own fields; a diagram is a different shape of thing) - toDiagramTable converts the same
	// `resolved` value diagramModelToXml elsewhere in this file, run through addTables against a brand
	// new empty model, is exactly "start a new diagram and add this one table" (see addTables/
	// createSchemaGroup's own placement rules) - so a single-table `.drawio` export lands identically to
	// what New Diagram + Add would produce, not a separate ad hoc layout.
	private async handleExportSchema(key: string, config: ConnectionConfig, schema: string, table: string, format: DiagramExportFormat, destination: ExportDestination): Promise<void> {
		try {
			let connected = await assembleTableSchema(this.extension, {key: key, configId: config.id, schema: schema, table: table});
			let imported = await this.extension.schemaTrees.loadImportedTablesForTable({key: key, configId: config.id}, schema, table);
			let resolved = resolveTable(connected, imported);

			let content: string;
			let fileExtension: string;
			let filterLabel: string;

			if(format === 'drawio') {
				let model: DiagramModel = {schemas: [], tables: [], relationships: []};
				await addTables(model, [toDiagramTable(resolved)]);

				content = diagramModelToXml(model, this.extension.configurations.resultHeadingLabels);
				fileExtension = 'drawio';
				filterLabel = 'draw.io Diagram';
			} else {
				let converter = SCHEMA_FORMATS[format];

				content = converter.export([resolved]);
				fileExtension = converter.fileExtension;
				filterLabel = converter.label;
			}

			await ExportWriteUtils.write({
				content: content,
				fileExtension: fileExtension,
				filterLabel: filterLabel,
				defaultFileName: SchemasProvider.buildDefaultSchemaFileName(schema, table, fileExtension),
				destination: destination,
				clipboardMessage: 'Table schema copied to the clipboard.',
				fileMessage: path => `Table exported to ${path}.`
			});
		} catch(error) {
			AlertUtils.onError(error);
		}
	}
}

export namespace SchemasProvider {
	// 'table'/'view'/'function'/'procedure' - the name resolved from the SQL editor is one of those in the target
	// schema, open its tab. 'filter' - it didn't (see Commands.showTableDetails' resolution rules), so just
	// pre-fill the tree filter with the name instead of opening a tab for something that isn't there.
	export type TableTarget =
		| SelectableTarget
		| {kind: 'filter'; filterText: string};

	export interface SelectableTarget {
		kind: 'table' | SchemasObjectKind;
		schema: string;
		/** A routine's specific name - the one name that picks out a single overload. */
		table: string;
	}
}
