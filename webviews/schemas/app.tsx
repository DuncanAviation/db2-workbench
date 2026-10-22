import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Stack, Typography } from '@mui/material';
import { StringUtils } from '../../src/utils/string-utils.js';
import { SystemTable } from '../../src/models/system-table.js';
import type { SchemaBrowserPanel, SchemaImportReport, SchemaImportSummary, SchemasSchemaListEntry, SchemasSystemRoutine, SchemasSystemView, SchemasTreeInboundMessage, SaveSqlImportRequest, SqlImportConnectionTarget, SqlImportMappings, SqlImportRunResult, SqlImportStatementInput, TreeTableEntry } from '../../src/webview-messages/schemas-messages';
import type { DbErrorUtils } from '../../src/utils/db-error-utils';
import type { SchemaImportErrorUtils } from '../../src/utils/schema-import-error-utils';
import { getInitialState } from './initial-state';
import { DataEditSettingsContext } from './data-edit-settings-context';
import type { DataEditSettingsContextValue } from './data-edit-settings-context';
import type { DataEditSettings } from '../../src/utils/data-edit-defaults';
import type { PendingDataStatement } from './pending-statement';
import { buildTableKey, getEntryKey, tableKeysEqual, tableKeyToString, TableKey } from './table-key';
import type { SchemaFormatId } from '../../src/schema-conversion/schema-format-converter';
import type { DiagramExportFormat } from '../../src/webview-messages/diagram-messages';
import type { ExportDestination } from '../../src/utils/export-utils';
import { EditSchemaListDialog } from '../shared/components/edit-schema-list-dialog';
import { ExportTablesDialog } from '../shared/components/export-tables-dialog';
import { ImportErrorDialog } from '../shared/components/import-error-dialog';
import { ImportSchemaDialog } from '../shared/components/import-schema-dialog';
import { EditSqlImportDialog, linkedConnectionIdsFor } from '../shared/components/edit-sql-import-dialog';
import type { SqlImportConfig } from '../../src/models/sql-import-config';
import { ImportSummaryDialog } from '../shared/components/import-summary-dialog';
import { ViewImportsDialog } from '../shared/components/view-imports-dialog';
import { DEFAULT_RUN_SQL_PANEL_WIDTH, RunSqlPanel } from './components/run-sql-panel';
import type { StatementStatus } from './components/run-sql-panel';
import type { PanelResize } from '../shared/components/resizable-panel';
import { DEFAULT_TREE_WIDTH, SchemaTree } from '../shared/components/schema-tree';
import type { SchemaTreeEntry } from '../shared/components/schema-tree';
import { TableTabs } from './components/table-tabs';
import { TableDetail } from './components/table-detail';
import type { SubTabKey } from './components/table-detail';
import { ViewDetail } from './components/view-detail';
import { RoutineDetail } from './components/routine-detail';
import { schemasVsCodeApi } from './vscode-api';

// A routine row is keyed by its specific name (what tells overloads apart) but shows its name, or its
// signature when it is one of several overloads.
function toRoutineTreeEntries(routinesBySchema: Record<string, SchemasSystemRoutine[]>): Record<string, SchemaTreeEntry[]> {
	let mapped: Record<string, SchemaTreeEntry[]> = {};

	for(let [schema, routines] of Object.entries(routinesBySchema)) {
		mapped[schema] = routines.map(routine => ({ schema: routine.schema, table: routine.specificName, label: routine.signature ?? routine.name, description: routine.description }));
	}

	return mapped;
}

export function App() {
	const { tablesBySchema: initialTablesBySchema, viewsBySchema: initialViewsBySchema, functionsBySchema: initialFunctionsBySchema, proceduresBySchema: initialProceduresBySchema, schemaList: initialSchemaList, currentSortSequence, currentSortSequenceLibrary, initialSelectedTable, initialFilterText, initialSqlImportEditorId, connectionName, panelWidths: initialPanelWidths, dataEditSettings: initialDataEditSettings } = getInitialState();
	const [dataEditSettings, setDataEditSettings] = useState<DataEditSettings>(initialDataEditSettings);
	const dataEditSettingsContext = useMemo<DataEditSettingsContextValue>(() => ({
		settings: dataEditSettings,
		// Applied here at once rather than waiting for the host's dataEditSettingsChanged, which then
		// confirms it - or brings back what the host actually saved.
		save: settings => {
			setDataEditSettings(settings);
			schemasVsCodeApi.postMessage({ command: 'saveDataEditSettings', settings });
		}
	}), [dataEditSettings]);

	const [openKeys, setOpenKeys] = useState<TableKey[]>(initialSelectedTable ? [buildTableKey(initialSelectedTable.schema, initialSelectedTable.table, initialSelectedTable.kind)] : []);
	const [activeKey, setActiveKey] = useState<TableKey | null>(initialSelectedTable ? buildTableKey(initialSelectedTable.schema, initialSelectedTable.table, initialSelectedTable.kind) : null);
	const [filterText, setFilterText] = useState(initialFilterText ?? '');
	const [panelWidths, setPanelWidths] = useState(initialPanelWidths ?? {});
	// tablesBySchema/schemaList are state (not just the initial constants) since the "Edit Schema List"
	// dialog's OK button replaces both wholesale via a schemaListUpdated push - see the message listener below.
	const [tablesBySchema, setTablesBySchema] = useState<Record<string, TreeTableEntry[]>>(initialTablesBySchema);
	const [viewsBySchema, setViewsBySchema] = useState<Record<string, SchemasSystemView[]>>(initialViewsBySchema);
	const [functionsBySchema, setFunctionsBySchema] = useState<Record<string, SchemasSystemRoutine[]>>(initialFunctionsBySchema);
	const [proceduresBySchema, setProceduresBySchema] = useState<Record<string, SchemasSystemRoutine[]>>(initialProceduresBySchema);
	const [schemaList, setSchemaList] = useState<SchemasSchemaListEntry[]>(initialSchemaList);
	const [editSchemaListDialogOpen, setEditSchemaListDialogOpen] = useState(false);
	const [exportSchemaDialogOpen, setExportSchemaDialogOpen] = useState(false);
	const [importSchemaDialogOpen, setImportSchemaDialogOpen] = useState(false);
	// The View Imports dialog and the list it shows. `null` is "asked, still waiting" (the list is fetched
	// on open rather than carried in initial state - see LoadImportsMessage), as opposed to an empty array,
	// which is a real "nothing imported".
	const [viewImportsDialogOpen, setViewImportsDialogOpen] = useState(false);
	const [imports, setImports] = useState<SchemaImportSummary[] | null>(null);
	// Set from an importSchemaError push (see the message listener below) - null means no error dialog
	// is showing. Replaces what used to be a generic error toast with enough detail (per-problem message
	// + location + source line) for ImportErrorDialog's scrollable table.
	const [importError, setImportError] = useState<{ error: SchemaImportErrorUtils.SerializedImportError; content: string } | null>(null);
	// The SQL import's own state: the run whose result the dialog is mapping, the failure of an import
	// attempt, and whether a run/import is in flight. All three live here rather than in the dialog
	// because they arrive as messages - the dialog is told what happened, it doesn't ask.
	const [sqlRunResult, setSqlRunResult] = useState<SqlImportRunResult | undefined>(undefined);
	const [sqlImportConnections, setSqlImportConnections] = useState<SqlImportConnectionTarget[] | null>(null);
	// undefined = no editor open. null = open, entry still loading. A config = open on that entry.
	const [editingSqlImport, setEditingSqlImport] = useState<SqlImportConfig | null | undefined>(undefined);
	const [editSqlImportOpen, setEditSqlImportOpen] = useState(false);
	const [sqlImportSaveError, setSqlImportSaveError] = useState<string | undefined>(undefined);
	const [sqlImportError, setSqlImportError] = useState<DbErrorUtils.SerializedError | undefined>(undefined);
	const [sqlImportBusy, setSqlImportBusy] = useState(false);
	// Shown after any import lands, whatever it came from - see ImportSummaryDialog.
	const [importReport, setImportReport] = useState<SchemaImportReport | null>(null);
	// A snapshot of every open tab's table object, captured from tablesBySchema whenever it's visible
	// there and kept even after its schema is later hidden (at which point tablesBySchema no longer
	// carries it) - otherwise hiding a schema would blank out any of its tabs that were already open,
	// even though the underlying data (columns, keys, rows, ...) is still fully queryable regardless of
	// hidden state. Only pruned when a tab actually closes - see handleCloseTab/OtherTabs/AllTabs.
	const [openTables, setOpenTables] = useState<Record<string, TreeTableEntry>>({});
	// The same snapshot for every open view tab, keyed by its "view:"-prefixed tableKeyToString form - kept
	// apart from openTables since a view has no connected/imported sides, and everything that walks
	// openTables (imports, export) is about tables.
	const [openViews, setOpenViews] = useState<Record<string, SchemasSystemView>>({});
	// And for every open function tab, keyed by its "function:"-prefixed form (schema plus specific name).
	const [openRoutines, setOpenRoutines] = useState<Record<string, SchemasSystemRoutine>>({});
	// Which TableDetail sub-tab (Info/Columns/Table Keys/...) is selected - lives here rather than as
	// local state in TableDetail so it survives switching between open table tabs (TableDetail remounts
	// per table via its key={tableKeyToString(...)} below). Reset to the 'info' default once every table
	// tab is closed - see handleCloseTab/handleCloseAllTabs.
	const [subTab, setSubTab] = useState<SubTabKey>('info');

	// editMode/pendingStatements/rightPanelCollapsed back the Run SQL panel - see RunSqlPanel. Pending
	// statements can come from multiple open table tabs at once (hence living here, not inside
	// TableDataTab) - see the Data tab's Add/Edit/Delete Row actions and inline editing.
	const [editMode, setEditMode] = useState(false);
	// Never spliced/cleared by a run itself (only by the Clear button or Cancel below) - a statement
	// that's run successfully stays in this list, permanently flagged 'success' in statementStatuses,
	// so the Run SQL panel keeps showing it as done rather than making it vanish. See activeStatements
	// below for what this means for the Data tab specifically.
	const [pendingStatements, setPendingStatements] = useState<PendingDataStatement[]>([]);
	const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);
	// The distinct {schema, table} pairs among whichever pendingStatements just ran successfully in the
	// most recent run - a table's currently-loaded rows are stale the instant its statement succeeds,
	// so without this a row whose update just committed would appear to silently "revert" to its
	// pre-edit value once activeStatements below stops including it. A fresh array every call (not
	// accumulated), so TableDataTab's effect (matching its own schema/table against this list) fires on
	// every run even if the same table is affected twice in a row.
	const [runCompletionNotice, setRunCompletionNotice] = useState<Array<{schema: string; table: string}> | null>(null);
	// Backs requestExitEditMode below - the action to run once the user confirms discarding pending
	// statements; null when no confirmation is in progress. Shared by RunSqlPanel's Cancel button and
	// every tab-close action, so both trigger the exact same confirmation dialog/outcome.
	const [discardConfirm, setDiscardConfirm] = useState<(() => void) | null>(null);
	// True for the entire span between posting runDataEditStatements and receiving its final result -
	// see requestExitEditMode/handleDeleteStatement below, both of which refuse to remove a pending
	// statement while true. Removing one mid-run would desync statementIdsAtRunStartRef's index->id
	// mapping (used to route runDataEditStatementProgress messages) and handleRunResult's own lookup of
	// which statements just ran, both of which assume the sent list's order and membership hold steady
	// until the run's final result arrives.
	const [isRunning, setIsRunning] = useState(false);
	// Per-statement id. Unlike a typical "current run" status map, a 'success' entry here is
	// permanent - it's never reset back out (see handleRunStatements), which is what makes a statement
	// "done": excluded from activeStatements below, un-deletable, and skipped on the next Run. 'running'/
	// 'error' are transient, only ever set for whichever statements are part of the run currently (or
	// most recently) in flight.
	const [statementStatuses, setStatementStatuses] = useState<Record<string, StatementStatus>>({});
	// Per-statement id - only ever set for a statement whose most recent run attempt failed (see
	// handleRunResult), cleared the moment that statement is included in a new run (handleRunStatements)
	// so a retried statement doesn't keep showing its previous failure's detail while it's running again.
	const [statementErrors, setStatementErrors] = useState<Record<string, DbErrorUtils.SerializedError>>({});
	// Snapshot (taken the instant a run starts) of the ids in the exact order their sql was sent to the
	// host - runDataEditStatementProgress only carries a numeric array index, so this is what maps that
	// back to a statement id. A ref, not state: it's written once per run and only ever read from
	// inside the message-listener effect below, so it doesn't need to trigger a render itself.
	const statementIdsAtRunStartRef = useRef<string[]>([]);

	// What TableDataTab (via TableDetail) actually gets to see and act on - a statement that's already
	// done has actually run, so it shouldn't still look "pending" (with Edit Row/Cancel Update actions)
	// on whatever table it belongs to. RunSqlPanel, by contrast, is handed the raw pendingStatements
	// below so it can keep showing done statements (that's the whole point of #4/#1).
	const activeStatements = useMemo(
		() => pendingStatements.filter(statement => statementStatuses[statement.id] !== 'success'),
		[pendingStatements, statementStatuses]
	);

	// The shared tree takes a flat {schema, table, description} row rather than a TreeTableEntry, so
	// connected-vs-imported (and SchemasSystemTable's dozen DB2 columns) stay this bundle's concern -
	// see SchemaTreeEntry. getEntryKey is what resolves which side of an entry supplies the identity.
	// Materialized query tables are table entries like any other - they open the same TableDetail - and are
	// only split out here, so the tree can list them under a node of their own.
	const { treeTablesBySchema, treeMqtsBySchema } = useMemo(() => {
		let tables: Record<string, SchemaTreeEntry[]> = {};
		let mqts: Record<string, SchemaTreeEntry[]> = {};

		for(let [schema, entries] of Object.entries(tablesBySchema)) {
			tables[schema] = [];

			for(let entry of entries) {
				let key = getEntryKey(entry);
				let treeEntry = { schema: key.schema, table: key.table, description: entry.connected?.description };

				if(entry.connected && SystemTable.isMqt(entry.connected)) {
					(mqts[schema] ??= []).push(treeEntry);
				} else {
					tables[schema].push(treeEntry);
				}
			}
		}

		return { treeTablesBySchema: tables, treeMqtsBySchema: mqts };
	}, [tablesBySchema]);

	const treeViewsBySchema = useMemo(() => {
		let mapped: Record<string, SchemaTreeEntry[]> = {};

		for(let [schema, views] of Object.entries(viewsBySchema)) {
			mapped[schema] = views.map(view => ({ schema: view.schema, table: view.name, description: view.description }));
		}

		return mapped;
	}, [viewsBySchema]);

	const treeFunctionsBySchema = useMemo(() => toRoutineTreeEntries(functionsBySchema), [functionsBySchema]);
	const treeProceduresBySchema = useMemo(() => toRoutineTreeEntries(proceduresBySchema), [proceduresBySchema]);

	// The tree's own vertical-dots menu is caller-supplied now that the component is shared - these two
	// entries are schema-browser features the diagram has no equivalent of.
	const treeMenuItems = useMemo(() => [
		{ label: 'Edit Schema List', onClick: () => setEditSchemaListDialogOpen(true) },
		{ label: 'Import', onClick: () => setImportSchemaDialogOpen(true) },
		{ label: 'View Imports', onClick: handleOpenViewImports }
	], []);

	// Keeps openTables in sync whenever tablesBySchema changes (including a schemaListUpdated push
	// after hiding/showing a schema) or a tab opens - captures each open key's current table object
	// while it's actually present in tablesBySchema, and simply leaves the last-known one in place
	// once its schema is hidden and stops appearing there. Runs on every relevant change rather than
	// only from handleSelectTable, since a tab can also become "open" via the F12 message path (see
	// the message-listener effect below), whose closure over tablesBySchema would otherwise be stale.
	useEffect(() => {
		let allEntries = Object.values(tablesBySchema).flat();

		setOpenTables(current => {
			let next = { ...current };
			let changed = false;

			for (let key of openKeys.filter(openKey => openKey.kind == null)) {
				let match = allEntries.find(entry => tableKeysEqual(getEntryKey(entry), key));

				if (match) {
					let keyString = tableKeyToString(key);

					if (next[keyString] !== match) {
						next[keyString] = match;
						changed = true;
					}
				}
			}

			return changed ? next : current;
		});
	}, [tablesBySchema, openKeys]);

	// openViews' counterpart of the effect above.
	useEffect(() => {
		let allViews = Object.values(viewsBySchema).flat();

		setOpenViews(current => {
			let next = { ...current };
			let changed = false;

			for (let key of openKeys.filter(openKey => openKey.kind === 'view')) {
				let match = allViews.find(view => view.schema === key.schema && view.name === key.table);
				let keyString = tableKeyToString(key);

				if (match && next[keyString] !== match) {
					next[keyString] = match;
					changed = true;
				}
			}

			return changed ? next : current;
		});
	}, [viewsBySchema, openKeys]);

	// And openRoutines' - functions and procedures both, each looked up in its own kind's list.
	useEffect(() => {
		let allByKind = { function: Object.values(functionsBySchema).flat(), procedure: Object.values(proceduresBySchema).flat() };

		setOpenRoutines(current => {
			let next = { ...current };
			let changed = false;

			for (let key of openKeys) {
				if (key.kind !== 'function' && key.kind !== 'procedure') {
					continue;
				}

				let match = allByKind[key.kind].find(routine => routine.schema === key.schema && routine.specificName === key.table);
				let keyString = tableKeyToString(key);

				if (match && next[keyString] !== match) {
					next[keyString] = match;
					changed = true;
				}
			}

			return changed ? next : current;
		});
	}, [functionsBySchema, proceduresBySchema, openKeys]);

	// The message-listener effect below registers its handler once (empty deps, so the extension host
	// connection isn't torn down/re-established on every render) and so only ever closes over the
	// pendingStatements this component had at that first mount - reading pendingStatements directly
	// inside handleRunResult would silently see that permanently-stale (empty) array instead of
	// whatever's actually pending by the time a run really finishes. This ref is reassigned every
	// render, so handleRunResult can read pendingStatementsRef.current instead and always see the
	// latest value regardless of which render's closure ends up calling it.
	const pendingStatementsRef = useRef(pendingStatements);
	pendingStatementsRef.current = pendingStatements;

	function handleSelectTable(schema: string, name: string) {
		openTab(buildTableKey(schema, name));
	}

	function handleSelectView(schema: string, name: string) {
		openTab(buildTableKey(schema, name, 'view'));
	}

	function handleSelectFunction(schema: string, specificName: string) {
		openTab(buildTableKey(schema, specificName, 'function'));
	}

	function handleSelectProcedure(schema: string, specificName: string) {
		openTab(buildTableKey(schema, specificName, 'procedure'));
	}

	function openTab(key: TableKey) {
		setOpenKeys(keys => keys.some(openKey => tableKeysEqual(openKey, key)) ? keys : [...keys, key]);
		setActiveKey(key);
	}

	// No reply message - the host resolves entirely via a native Save dialog and an info/error toast.
	// Scope has no equivalent here (there's no filter/canvas to scope by) - ExportTablesDialog always
	// reports 'all' when its Scope section is hidden, so it's simply unused.
	function handleExportSchema(format: DiagramExportFormat, _scope: 'all' | 'filtered', destination: ExportDestination) {
		setExportSchemaDialogOpen(false);

		if (activeTable) {
			let { schema, table } = getEntryKey(activeTable);
			schemasVsCodeApi.postMessage({ command: 'exportSchema', schema, table, format, destination });
		}
	}

	// The file/paste paths close the dialog optimistically, same convention as the other
	// outbound-message-triggered actions in this webview - the host answers with either an error push or
	// the import summary, neither of which needs the dialog still open.
	function handleImportFile() {
		setImportSchemaDialogOpen(false);
		schemasVsCodeApi.postMessage({ command: 'importSchema' });
	}

	function handleImportText(format: SchemaFormatId, content: string) {
		setImportSchemaDialogOpen(false);
		schemasVsCodeApi.postMessage({ command: 'importSchemaFromText', format, content });
	}

	// The SQL path keeps the dialog open across both steps, so unlike the file/paste paths these only set
	// the in-flight flag and wait for the host's reply.
	function handleRunSqlImport(statements: SqlImportStatementInput[]) {
		setSqlImportBusy(true);
		setSqlImportError(undefined);
		schemasVsCodeApi.postMessage({ command: 'runSqlImport', statements });
	}

	function handleImportSql(request: { runId: string; name: string; mappings: SqlImportMappings; save: boolean; connectionIds: string[] }) {
		setSqlImportBusy(true);
		setSqlImportError(undefined);
		schemasVsCodeApi.postMessage({ command: 'importSqlSchema', ...request });
	}

	// The Edit SQL Import command opened this panel FOR this import - see
	// SchemasInitialState.initialSqlImportEditorId. Once, on mount; every later invocation reaches an
	// already-open panel as a message instead.
	useEffect(() => {
		if (initialSqlImportEditorId) {
			handleEditSqlImport(initialSqlImportEditorId);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Re-fetched every time the dialog opens rather than held - see the diagram's copy of this.
	function handleLoadSqlImportConnections() {
		setSqlImportConnections(null);
		schemasVsCodeApi.postMessage({ command: 'loadSqlImportConnections' });
	}

	// Editing a saved import replaces the View Imports dialog rather than stacking on top of it - the edit
	// dialog is the bigger, more specific thing, and the list behind it would be stale the moment a save
	// lands anyway. The connection list is fetched alongside the entry, since the editor can re-link it.
	function handleEditSqlImport(importId: string) {
		setViewImportsDialogOpen(false);
		setEditingSqlImport(null);
		setEditSqlImportOpen(true);
		setSqlImportSaveError(undefined);
		setSqlRunResult(undefined);
		handleLoadSqlImportConnections();
		schemasVsCodeApi.postMessage({ command: 'loadSqlImport', importId });
	}

	function handleRefreshSqlImport(importId: string) {
		schemasVsCodeApi.postMessage({ command: 'refreshSqlImport', importId });
	}

	function handleSaveSqlImport(request: SaveSqlImportRequest) {
		setSqlImportBusy(true);
		setSqlImportSaveError(undefined);
		schemasVsCodeApi.postMessage({ command: 'saveSqlImport', ...request });
	}

	function handleCloseEditSqlImport() {
		setEditSqlImportOpen(false);
		setEditingSqlImport(undefined);
		setSqlRunResult(undefined);
		setSqlImportSaveError(undefined);
	}

	function handleDiscardSqlRun(runId: string) {
		schemasVsCodeApi.postMessage({ command: 'discardSqlImportRun', runId });
	}

	function handleCloseImportDialog() {
		setImportSchemaDialogOpen(false);
		setSqlRunResult(undefined);
		setSqlImportError(undefined);
	}

	// Always re-fetches rather than reusing whatever the last open left behind - an import (or a removal)
	// could have happened from this panel, another panel, or a diagram on the same connection since then.
	function handleOpenViewImports() {
		setImports(null);
		setViewImportsDialogOpen(true);
		schemasVsCodeApi.postMessage({ command: 'loadImports' });
	}

	// Disabling imported data can leave a wholly-imported table with nothing to show, so its tab closes -
	// the same rule handleDisableImportedChange applies to a single table, applied to a batch. An Enhanced
	// table's tab stays open and reverts to its live DB2 data off the schemaListUpdated push. The dialog
	// itself stays open and repaints off the importsLoaded reply. Only the disabling half can strand a tab:
	// re-enabling gives a table more to show, never less.
	function handleApplyImports(change: ViewImportsDialog.Change) {
		schemasVsCodeApi.postMessage({ command: 'applyImports', disable: change.disable, enable: change.enable, unlinkImportIds: change.unlinkImportIds, deleteImportIds: change.deleteImportIds });

		let affected = new Set(change.disable.map(entry => tableKeyToString(buildTableKey(entry.schema, entry.table))));

		for (let key of openKeys) {
			let keyString = tableKeyToString(key);
			let entry = openTables[keyString];

			if (affected.has(keyString) && entry && !entry.connected) {
				handleCloseTab(key);
			}
		}
	}

	// The host processes this asynchronously (it may batch-fetch tables for newly added schemas, or wipe
	// cache for deleted ones) and pushes the result back as a schemaListUpdated message rather than
	// replying directly - see the message listener below. Closes optimistically rather than waiting for
	// that push, same convention as the other outbound-message-triggered actions in this webview (e.g.
	// runGeneratedSql).
	function handleUpdateSchemaList(result: { hiddenSchemas: string[]; newSchemas: string[]; deletedSchemas: string[] }) {
		function commit() {
			setEditSchemaListDialogOpen(false);

			if (result.deletedSchemas.length > 0) {
				let deletedSchemas = new Set(result.deletedSchemas.map(schema => schema.toUpperCase()));

				setOpenKeys(keys => {
					let next = keys.filter(key => !deletedSchemas.has(key.schema.toUpperCase()));

					if (activeKey && deletedSchemas.has(activeKey.schema.toUpperCase())) {
						setActiveKey(next.length > 0 ? next[next.length - 1] : null);
					}

					return next;
				});

				setOpenTables(current => Object.fromEntries(Object.entries(current).filter(([, entry]) => !deletedSchemas.has(getEntryKey(entry).schema.toUpperCase()))));
				setOpenViews(current => Object.fromEntries(Object.entries(current).filter(([, view]) => !deletedSchemas.has(view.schema.toUpperCase()))));
				setOpenRoutines(current => Object.fromEntries(Object.entries(current).filter(([, routine]) => !deletedSchemas.has(routine.schema.toUpperCase()))));
			}

			schemasVsCodeApi.postMessage({ command: 'updateSchemaList', hiddenSchemas: result.hiddenSchemas, newSchemas: result.newSchemas, deletedSchemas: result.deletedSchemas });
		}

		// Deleting a schema closes every open tab for a table in it - same "discard pending changes"
		// gate as closing a tab normally goes through (requestExitEditMode), so unrun SQL statements
		// aren't silently lost. Hiding/showing/adding schemas alone never closes a tab, so there's
		// nothing to gate when nothing's actually being deleted.
		if (result.deletedSchemas.length > 0) {
			requestExitEditMode(commit);
		} else {
			commit();
		}
	}

	// "View Table Details" from a SQL editor re-invoked against a schemas panel that's already open -
	// SchemasProvider posts one of these instead of the initialSelectedTable/initialFilterText state
	// above, which only takes effect on first mount. See SchemasProvider.TableTarget.
	useEffect(() => {
		function onMessage(event: MessageEvent<SchemasTreeInboundMessage>) {
			let message = event.data;

			if (message.command === 'selectTable') {
				if (message.kind === 'view') {
					handleSelectView(message.schema, message.table);
				} else if (message.kind === 'function') {
					handleSelectFunction(message.schema, message.table);
				} else if (message.kind === 'procedure') {
					handleSelectProcedure(message.schema, message.table);
				} else {
					handleSelectTable(message.schema, message.table);
				}
			} else if (message.command === 'setFilter') {
				setFilterText(message.filterText);
			} else if (message.command === 'runDataEditStatementsResult') {
				handleRunResult(message.executedCount, message.failed, message.error);
			} else if (message.command === 'runDataEditStatementProgress') {
				let id = statementIdsAtRunStartRef.current[message.index];

				if (id) {
					setStatementStatuses(current => ({ ...current, [id]: message.status }));
				}
			} else if (message.command === 'dataEditSettingsChanged') {
				setDataEditSettings(message.settings);
			} else if (message.command === 'schemaListUpdated') {
				setTablesBySchema(message.tablesBySchema);
				setViewsBySchema(message.viewsBySchema);
				setFunctionsBySchema(message.functionsBySchema);
				setProceduresBySchema(message.proceduresBySchema);
				setSchemaList(message.schemaList);
			} else if (message.command === 'openSqlImportEditor') {
				handleEditSqlImport(message.importId);
			} else if (message.command === 'sqlImportLoaded') {
				setEditingSqlImport(message.config);
			} else if (message.command === 'sqlImportSaved') {
				setSqlImportBusy(false);

				if (message.saved) {
					handleCloseEditSqlImport();
				} else {
					setSqlImportSaveError(message.message);
				}
			} else if (message.command === 'sqlImportConnectionsLoaded') {
				setSqlImportConnections(message.connections);
			} else if (message.command === 'importsLoaded') {
				setImports(message.imports);
			} else if (message.command === 'importSchemaError') {
				setImportError({ error: message.error, content: message.content });
			} else if (message.command === 'importSchemaSummary') {
				setImportReport(message.report);
			} else if (message.command === 'sqlImportRunResult') {
				setSqlImportBusy(false);
				setSqlRunResult(message.result);
			} else if (message.command === 'sqlImportResult') {
				setSqlImportBusy(false);

				if (message.result.kind === 'imported') {
					// The summary replaces the import dialog rather than stacking on top of it - the import
					// is done, and there is nothing left to go back to.
					setImportSchemaDialogOpen(false);
					setSqlRunResult(undefined);
					setImportReport(message.result.report);
				} else {
					setSqlImportError(message.result.error);
				}
			}
		}

		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
		// The handlers this listener calls are stable for the panel's lifetime in every way that matters -
		// re-subscribing on every render would tear down and rebuild the listener for nothing.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	function handleEnterEditMode() {
		setEditMode(true);
	}

	// Called once discarding is either confirmed or has nothing to discard - see requestExitEditMode.
	function handleCancelEdit() {
		setPendingStatements([]);
		setStatementStatuses({});
		setStatementErrors({});
		setEditMode(false);
	}

	// executedCount statements (from the front of the ones actually sent, in the order they were sent)
	// succeeded - each already got its own 'success' via the progress handler below, so this only needs
	// to record the failure detail (if any) and figure out which tables to refresh. Nothing is removed
	// from pendingStatements/editMode is never turned off here - the panel stays open with every
	// statement (done or not) visible, per the panel's spec; the user now exits via Cancel or clears via
	// the Clear button.
	function handleRunResult(executedCount: number, failed: boolean, error?: DbErrorUtils.SerializedError) {
		let executedIds = new Set(statementIdsAtRunStartRef.current.slice(0, executedCount));
		let executedStatements = pendingStatementsRef.current.filter(statement => executedIds.has(statement.id));
		let affectedTables = new Map(executedStatements.map(statement => [`${statement.schema}/${statement.table}`, { schema: statement.schema, table: statement.table }]));
		setRunCompletionNotice(Array.from(affectedTables.values()));
		setIsRunning(false);

		if (failed) {
			let failedId = statementIdsAtRunStartRef.current[executedCount];

			if (failedId) {
				setStatementErrors(current => ({ ...current, [failedId]: error ?? { message: 'Failed' } }));
			}
		}
	}

	// The Run SQL panel's Run button, once its confirmation dialog is accepted - only sends statements
	// that aren't already done (see statementStatuses above), and snapshots that exact sent order/ids so
	// runDataEditStatementProgress (index-keyed) and handleRunResult (count-keyed) both have something
	// stable to resolve against for the rest of this run.
	function handleRunStatements() {
		let toRun = pendingStatements.filter(statement => statementStatuses[statement.id] !== 'success');
		statementIdsAtRunStartRef.current = toRun.map(statement => statement.id);

		// Clears a stale 'error'/'running' entry (and its detail) for anything about to run again -
		// 'success' entries are never touched here, that's what makes them permanent.
		let toRunIds = new Set(statementIdsAtRunStartRef.current);
		setStatementStatuses(current => Object.fromEntries(Object.entries(current).filter(([id]) => !toRunIds.has(id))));
		setStatementErrors(current => Object.fromEntries(Object.entries(current).filter(([id]) => !toRunIds.has(id))));

		setIsRunning(true);
		schemasVsCodeApi.postMessage({ command: 'runDataEditStatements', statements: toRun.map(statement => statement.sql) });
	}

	// Refused while a run is in flight (see isRunning above) or once a statement is done - RunSqlPanel
	// already disables the button for both cases; this is defense in depth against any other path.
	function handleDeleteStatement(id: string) {
		if (isRunning || statementStatuses[id] === 'success') {
			return;
		}

		setPendingStatements(current => current.filter(statement => statement.id !== id));
		setStatementStatuses(current => {
			let { [id]: _removed, ...rest } = current;
			return rest;
		});
		setStatementErrors(current => {
			let { [id]: _removed, ...rest } = current;
			return rest;
		});
	}

	// Removes every done statement, leaving not-done ones (and editMode) untouched - one of the Run SQL
	// panel's Clear options.
	function handleClearDone() {
		setPendingStatements(current => current.filter(statement => statementStatuses[statement.id] !== 'success'));
		setStatementStatuses(current => Object.fromEntries(Object.entries(current).filter(([, status]) => status !== 'success')));
	}

	// Empties the list entirely - unlike Cancel, this doesn't turn editMode off, since Clear is meant as
	// a strictly smaller "start over with an empty list" action, not an exit.
	function handleClearAll() {
		setPendingStatements([]);
		setStatementStatuses({});
		setStatementErrors({});
	}

	// The one write path TableDataTab uses for every Add/Edit Row (dialog or inline) - always hands
	// over a complete PendingDataStatement, so this doesn't need to know whether it's a create or an
	// update: replaces by id when one already exists, appends otherwise.
	function handleUpsertStatement(statement: PendingDataStatement) {
		setPendingStatements(current => {
			let index = current.findIndex(existing => existing.id === statement.id);
			return index === -1 ? [...current, statement] : current.map(existing => existing.id === statement.id ? statement : existing);
		});
	}

	// The guard used by every exit-edit-mode path - RunSqlPanel's Cancel button and every tab-close
	// action below. Closing any tab while editMode is on always exits edit mode as part of that
	// (there's one global edit session, not one per table), so this is disruptive to the whole session
	// the same way Cancel is, not just to whichever table was closed.
	function requestExitEditMode(onConfirmed: () => void) {
		if (isRunning) {
			return;
		}

		if (!editMode) {
			onConfirmed();
			return;
		}

		// A done statement already ran - there's nothing left "at risk" in discarding it, so it doesn't
		// count toward whether a confirmation is needed at all.
		let notDoneCount = pendingStatements.filter(statement => statementStatuses[statement.id] !== 'success').length;

		if (notDoneCount === 0) {
			handleCancelEdit();
			onConfirmed();
			return;
		}

		setDiscardConfirm(() => () => {
			handleCancelEdit();
			onConfirmed();
		});
	}

	function handleConfirmDiscard() {
		let confirmed = discardConfirm;
		setDiscardConfirm(null);
		confirmed?.();
	}

	// Shared by RunSqlPanel's Cancel button and the Data tab's own Cancel Edit action - both are the same
	// "leave edit mode" gesture, so both go through the same confirmation logic.
	function handleCancelEditClick() {
		requestExitEditMode(() => {});
	}

	function handleCloseTab(key: TableKey) {
		requestExitEditMode(() => {
			setOpenKeys(keys => {
				let next = keys.filter(openKey => !tableKeysEqual(openKey, key));

				if (activeKey && tableKeysEqual(activeKey, key)) {
					setActiveKey(next.length > 0 ? next[next.length - 1] : null);
				}

				if (next.length === 0) {
					setSubTab('info');
				}

				return next;
			});

			setOpenTables(current => {
				let { [tableKeyToString(key)]: _removed, ...rest } = current;
				return rest;
			});

			setOpenViews(current => {
				let { [tableKeyToString(key)]: _removed, ...rest } = current;
				return rest;
			});

			setOpenRoutines(current => {
				let { [tableKeyToString(key)]: _removed, ...rest } = current;
				return rest;
			});
		});
	}

	function handleCloseOtherTabs(key: TableKey) {
		requestExitEditMode(() => {
			setOpenKeys([key]);
			setActiveKey(key);

			setOpenTables(current => {
				let keyString = tableKeyToString(key);
				return current[keyString] ? { [keyString]: current[keyString] } : {};
			});

			setOpenViews(current => {
				let keyString = tableKeyToString(key);
				return current[keyString] ? { [keyString]: current[keyString] } : {};
			});

			setOpenRoutines(current => {
				let keyString = tableKeyToString(key);
				return current[keyString] ? { [keyString]: current[keyString] } : {};
			});
		});
	}

	function handleCloseAllTabs() {
		requestExitEditMode(() => {
			setOpenKeys([]);
			setActiveKey(null);
			setOpenTables({});
			setOpenViews({});
			setOpenRoutines({});
			setSubTab('info');
		});
	}

	// At most one of these is set - each kind's key string carries its own prefix, so it can never match
	// another kind's entry.
	let activeTable = activeKey ? openTables[tableKeyToString(activeKey)] : undefined;
	let activeView = activeKey ? openViews[tableKeyToString(activeKey)] : undefined;
	let activeRoutine = activeKey ? openRoutines[tableKeyToString(activeKey)] : undefined;

	// A routine's key holds its specific name, which isn't what anyone calls it - its tab shows the name
	// (or an overload's signature) the tree shows.
	function getTabLabel(key: TableKey): string {
		let routine = key.kind === 'function' || key.kind === 'procedure' ? openRoutines[tableKeyToString(key)] : undefined;
		return routine ? routine.signature ?? routine.name : key.table;
	}

	// Table tab header's "Disable Imported Changes" action - switches off every imported contribution for
	// this one table. A wholly-imported table (no `connected`
	// at all) has nothing left to show once that happens, so its tab closes too; an Enhanced table just
	// reverts to its live DB2 data and stays open, refreshed by the schemaListUpdated push the host
	// sends back (see SchemasProvider's 'disableImportedTableData' handler). Reversible from View Imports.
	function handleDisableImportedChange() {
		if (!activeKey || !activeTable) {
			return;
		}

		schemasVsCodeApi.postMessage({ command: 'disableImportedTableData', schema: activeKey.schema, table: activeKey.table });

		if (!activeTable.connected) {
			handleCloseTab(activeKey);
		}
	}

	// The inverse - offered only while this table has something switched off (TreeTableEntry
	// .hasDisabledImports). Nothing to close here: enabling only ever gives the tab more to show, and the
	// refreshed rows arrive on the schemaListUpdated push like every other import change.
	function handleEnableImportedChange() {
		if (!activeKey) {
			return;
		}

		schemasVsCodeApi.postMessage({ command: 'enableImportedTableData', schema: activeKey.schema, table: activeKey.table });
	}

	// A panel's draggable divider: the width follows every move here, and the host saves it once a drag
	// settles, so the next schema browser opens with the same layout.
	function panelResize(panel: SchemaBrowserPanel, defaultWidth: number): PanelResize {
		return {
			width: panelWidths[panel] ?? defaultWidth,
			onResize: width => setPanelWidths(current => ({ ...current, [panel]: width })),
			onResizeEnd: width => schemasVsCodeApi.postMessage({ command: 'savePanelWidth', panel: panel, width: width })
		};
	}

	return (
		<DataEditSettingsContext.Provider value={dataEditSettingsContext}>
			<Stack direction="row" sx={{ height: '100vh', minHeight: 0, overflow: 'hidden' }}>
				<SchemaTree
					tablesBySchema={treeTablesBySchema}
					mqtsBySchema={treeMqtsBySchema}
					viewsBySchema={treeViewsBySchema}
					functionsBySchema={treeFunctionsBySchema}
					proceduresBySchema={treeProceduresBySchema}
					filterText={filterText}
					onFilterTextChange={setFilterText}
					selection={{ mode: 'single', selectedKey: activeKey, onSelectTable: handleSelectTable, onSelectView: handleSelectView, onSelectFunction: handleSelectFunction, onSelectProcedure: handleSelectProcedure }}
					menuItems={treeMenuItems}
					title={connectionName}
					resizable={panelResize('tree', DEFAULT_TREE_WIDTH)}
				/>
	
				<Stack sx={{ flexGrow: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
					{openKeys.length > 0 ? (
						<>
							<TableTabs
								openKeys={openKeys}
								activeKey={activeKey}
								onSelect={setActiveKey}
								onClose={handleCloseTab}
								onCloseOthers={handleCloseOtherTabs}
								onCloseAll={handleCloseAllTabs}
								getLabel={getTabLabel}
							/>
							{activeKey && activeTable && (
								<TableDetail
									key={tableKeyToString(activeKey)}
									entry={activeTable}
									currentSortSequence={currentSortSequence}
									currentSortSequenceLibrary={currentSortSequenceLibrary}
									editMode={editMode}
									onEnterEditMode={handleEnterEditMode}
									onCancelEditClick={handleCancelEditClick}
									isRunning={isRunning}
									pendingStatements={activeStatements}
									onUpsertStatement={handleUpsertStatement}
									onDeleteStatement={handleDeleteStatement}
									runCompletionNotice={runCompletionNotice}
									onOpenExport={() => setExportSchemaDialogOpen(true)}
									onDisableImportedChange={handleDisableImportedChange}
									onEnableImportedChange={handleEnableImportedChange}
									subTab={subTab}
									onSubTabChange={setSubTab}
								/>
							)}
							{activeKey && activeView && (
								<ViewDetail
									key={tableKeyToString(activeKey)}
									view={activeView}
									subTab={subTab}
									onSubTabChange={setSubTab}
								/>
							)}
							{activeKey && activeRoutine && (
								<RoutineDetail
									key={tableKeyToString(activeKey)}
									routine={activeRoutine}
									subTab={subTab}
									onSubTabChange={setSubTab}
								/>
							)}
						</>
					) : (
						<Typography sx={{ p: 2 }}>Select a table, view, function or procedure from the tree to view its details</Typography>
					)}
				</Stack>
	
				{editMode && (
					<RunSqlPanel
						statements={pendingStatements}
						statementStatuses={statementStatuses}
						statementErrors={statementErrors}
						isRunning={isRunning}
						collapsed={rightPanelCollapsed}
						onToggleCollapsed={() => setRightPanelCollapsed(current => !current)}
						onCancelClick={handleCancelEditClick}
						onDeleteStatement={handleDeleteStatement}
						onRun={handleRunStatements}
						onClearDone={handleClearDone}
						onClearAll={handleClearAll}
						resizable={panelResize('runSql', DEFAULT_RUN_SQL_PANEL_WIDTH)}
					/>
				)}
	
				<EditSchemaListDialog
					mode="overrides"
					open={editSchemaListDialogOpen}
					schemaList={schemaList}
					onCancel={() => setEditSchemaListDialogOpen(false)}
					onSave={handleUpdateSchemaList}
				/>
	
				<ExportTablesDialog
					open={exportSchemaDialogOpen}
					title="Export Table Schema"
					initialFormat="dbml"
					onCancel={() => setExportSchemaDialogOpen(false)}
					onExport={handleExportSchema}
				/>
	
				<ImportSchemaDialog
					open={importSchemaDialogOpen}
					onCancel={handleCloseImportDialog}
					onImportFile={handleImportFile}
					onImportText={handleImportText}
					onRunSqlImport={handleRunSqlImport}
					onImportSql={handleImportSql}
					onLoadConnections={handleLoadSqlImportConnections}
					connections={sqlImportConnections}
					onDiscardSqlRun={handleDiscardSqlRun}
					onResetSqlRun={() => setSqlRunResult(undefined)}
					sqlRunResult={sqlRunResult}
					sqlImportError={sqlImportError}
					busy={sqlImportBusy}
				/>
	
				<ImportSummaryDialog report={importReport ?? undefined} onClose={() => setImportReport(null)} />
	
				<ViewImportsDialog
					open={viewImportsDialogOpen}
					imports={imports}
					onCancel={() => setViewImportsDialogOpen(false)}
					onApply={handleApplyImports}
					onEdit={handleEditSqlImport}
					onRefresh={handleRefreshSqlImport}
				/>
	
				<EditSqlImportDialog
					open={editSqlImportOpen}
					config={editingSqlImport}
					connections={sqlImportConnections}
					linkedConnectionIds={linkedConnectionIdsFor(sqlImportConnections, editingSqlImport)}
					onCancel={handleCloseEditSqlImport}
					onSave={handleSaveSqlImport}
					onRunSqlImport={handleRunSqlImport}
					onDiscardSqlRun={handleDiscardSqlRun}
					onResetSqlRun={() => setSqlRunResult(undefined)}
					sqlRunResult={sqlRunResult}
					saveError={sqlImportSaveError}
					busy={sqlImportBusy}
				/>
	
				<ImportErrorDialog
					open={importError !== null}
					error={importError?.error ?? null}
					content={importError?.content ?? ''}
					onClose={() => setImportError(null)}
				/>
	
				<Dialog open={discardConfirm !== null} onClose={() => setDiscardConfirm(null)} maxWidth="sm" fullWidth>
					<DialogTitle>Discard Pending Changes</DialogTitle>
					<DialogContent>
						<DialogContentText>
							{(() => {
								let notDoneCount = pendingStatements.filter(statement => statementStatuses[statement.id] !== 'success').length;
								return `Discard ${notDoneCount} statement${StringUtils.getPlural(notDoneCount)} that ${notDoneCount === 1 ? 'has' : 'have'} not yet been run?`;
							})()}
						</DialogContentText>
					</DialogContent>
					<DialogActions>
						<Button onClick={() => setDiscardConfirm(null)}>Cancel</Button>
						<Button variant="contained" color="error" onClick={handleConfirmDiscard}>Discard</Button>
					</DialogActions>
				</Dialog>
			</Stack>
		</DataEditSettingsContext.Provider>
	);
}
