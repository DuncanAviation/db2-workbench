import { Row } from '../interfaces/row.js';
import { SystemColumn } from '../models/system-column.js';
import { SystemRoutineDetail } from '../models/system-routine-detail.js';
import { SystemRoutineParam } from '../models/system-routine-param.js';
import { SystemRoutine } from '../models/system-routine.js';
import { SystemView } from '../models/system-view.js';
import { DbErrorUtils } from '../utils/db-error-utils.js';
import { SchemaImportErrorUtils } from '../utils/schema-import-error-utils.js';
import { SystemIndexAdvice } from '../models/system-index-advice.js';
import { SystemTrigger } from '../models/system-trigger.js';
import { ImportedTableSchema, ImportSourceFormat, ResolvedColumn, ResolvedForeignKey, ResolvedIndex, ResolvedTableKey, SchemaFormatId } from '../schema-conversion/schema-format-converter.js';
import { ExportDestination } from '../utils/export-utils.js';
import { SqlImportConfig, SqlImportSectionId, SqlImportTarget } from '../models/sql-import-config.js';
import { SqlImportSectionSummary } from '../schema-conversion/sql-import-converter.js';
import { DiagramExportFormat } from './diagram-messages.js';
import { DataEditSettings } from '../utils/data-edit-defaults.js';

// A serialization-safe projection of SystemTable - the whole tree is embedded once as initial
// state (JSON.stringify, no postMessage round trip - see SchemasProvider), so Date fields are
// normalized to ISO strings here, same convention as ResultsIndexAdvice.lastAdvised in
// results-messages.ts.
export interface SchemasSystemTable {
	schema: string;
	name: string;
	/** See SystemTable.tableType - 'M' is a materialized query table. */
	tableType: string;
	description: string;
	remarks: string;
	dbName: string;
	alteredTimestamp: string;
	fileType: string;
	location: string;
	tbDbName: string;
	tbName: string;
	tbMember: string;
	sysTable: string;
	selectOmit: string;
	insertable: string;
	iaspNumber: number;
	enabled: string;
	maintain: string;
	refresh: string;
	/** Absent unless this is a materialized query table that has been refreshed. */
	refreshTimestamp?: string;
	isolation: string;
	partTable: string;
	definer: string;
	mqtRstDfr: string;
	decFltRnd: string;
	control: string;
	temporalType: string;
	dropRule: string;
}

// A view as the tree and its Info tab show it. SystemView has no Date fields, so unlike SchemasSystemTable
// it needs no projection of its own - the alias just keeps the wire type named alongside the table one.
// The definition isn't part of it: it's fetched per view (LoadViewDefinitionMessage).
export type SchemasSystemView = SystemView;

// A function or procedure as the tree shows it. `signature` (`NAME(INTEGER, CHAR)`) is only set for an overload - the
// one case where the name alone doesn't say which function a row is. Parameters and the rest of the
// SYSROUTINES row are fetched per function when its tabs open (LoadRoutineParamsMessage,
// LoadRoutineDetailMessage).
export interface SchemasSystemRoutine extends SystemRoutine {
	signature?: string;
}

export type SchemasRoutineDetail = SystemRoutineDetail;
export type SchemasRoutineParam = SystemRoutineParam;

/** What a tree row or a "View Table Details" target can open besides a table. */
export type SchemasObjectKind = 'view' | 'function' | 'procedure';

// Tree bucket name for a wholly-imported table that specifies no schema at all - shared between host
// (SchemasProvider, which buckets/matches against it) and webview (which needs the same literal value
// to ask for such a table's columns/keys/etc. the same way it would for a real schema). Real handling
// of this case (matching, whether it should even be possible) is deferred - for now it's just not
// silently dropped. See [[imported-schema-tree-integration-plan]].
export const NO_SCHEMA_BUCKET = '(No Schema)';

// A table shown in the tree/opened as a tab may be backed by a real, connected DB2 table, by one or
// more imported files (DBML/Frictionless), or both - presence/absence of each slot is the whole
// signal: connected only = ordinary DB2 table; imported only = doesn't exist in DB2 yet ("Imported"
// badge); both = a real table enhanced with imported data ("Enhanced" badge). See
// src/schema-conversion/table-resolver.ts for how the two get reconciled wherever that matters.
export interface TreeTableEntry {
	connected?: SchemasSystemTable;
	imported?: ImportedTableSchema[];
	/** True when at least one import touching this table is currently switched off - what gates the table
	 * tab header's "Enable Imported Changes". Note `imported` above only carries the APPLIED contributions,
	 * so a table can have this flag and no `imported` at all (everything it had is switched off). */
	hasDisabledImports?: boolean;
}

// One import - a single file read or a single paste - and every table it contributed, as the "View
// Imports" dialog lists it. Built by SchemaTrees.groupImports from the flat per-connection imported-table
// store, which keeps no batch structure of its own. Shared with the diagram bundle (same dialog, same
// host service), same as SchemasSchemaListEntry.
export interface SchemaImportSummary {
	importId: string;
	/** True when a db2-workbench.sqlImports entry stands behind this import - the only kind that can be
	 * edited, refreshed or deleted, since everything else exists only until the window closes. */
	saved?: boolean;
	/** The imported file's base name, or 'Pasted text'. See ImportProvenance.sourceLabel. */
	sourceLabel: string;
	sourceFormat: ImportSourceFormat;
	/** ISO string. */
	importedAt: string;
	/** In import order. `schema` is NO_SCHEMA_BUCKET for a table the source file gave no schema for,
	 * matching how the tree buckets it - so the dialog and the tree name the same table the same way.
	 * `enabled` is whether this table's contribution is currently applied - false once it has been
	 * disabled, which is what the View Imports dialog's checkboxes show. */
	tables: {schema: string; table: string; enabled: boolean}[];
	/** Every connection a SAVED import is linked to, so the View Imports confirmation can say what stays
	 * behind when it is unlinked from this one, and what else it unlinks from when it is deleted outright.
	 * `current` marks the connection this list was built for, which is the one the confirmation is talking
	 * about rather than naming. Empty for an unsaved import, which belongs to the connection it was
	 * imported into and nothing else. */
	linkedConnections?: {id: string; name: string; current: boolean}[];
}

// One table of one import, as identified for removal. Not just {schema, table}: removing an import must
// leave a DIFFERENT import's contribution to that same table alone, which needs the batch id too.
export interface SchemaImportEntry {
	importId: string;
	schema: string;
	table: string;
}

export interface SchemasInitialState {
	connectionName: string;
	tablesBySchema: Record<string, TreeTableEntry[]>;
	/** Every visible schema's views, keyed the same way as tablesBySchema. Kept in a map of its own rather
	 * than folded into TreeTableEntry, so nothing that walks tables (imports, the diagram picker) has to
	 * learn to skip views. A schema with no views may be absent. */
	viewsBySchema: Record<string, SchemasSystemView[]>;
	/** Every visible schema's user-defined functions, kept apart from tables for the same reason as
	 * viewsBySchema. One entry per overload. A schema with no functions may be absent. */
	functionsBySchema: Record<string, SchemasSystemRoutine[]>;
	/** Every visible schema's procedures, the same way as functionsBySchema. */
	proceduresBySchema: Record<string, SchemasSystemRoutine[]>;
	/** Every schema currently known for this connection (the library list plus any manually added ones),
	 * including hidden ones - not derivable from tablesBySchema alone since hidden schemas are excluded
	 * from it. Backs the "Edit Schema List" dialog. See GlobalStates.SchemaListOverrides. */
	schemaList: SchemasSchemaListEntry[];
	/** This connection's current sort sequence (QSYS2.JOB_INFO.SORT_SEQUENCE_NAME/_LIBRARY) - lets the
	 * Advised Indexes tab warn before running a Create Index whose advice was generated under a
	 * different sort sequence than this connection is currently running under. */
	currentSortSequence: string;
	currentSortSequenceLibrary: string;
	/** Set when the panel was opened via "View Table Details" from a SQL editor and the table at the
	 * cursor resolved to a real table or view - opens its tab on first mount, same as clicking it in
	 * the tree. `kind: 'view'` opens the view's tab rather than a table's, and `kind: 'function'`/
	 * `'procedure'` a routine's, with `table` holding its specific name. See SchemasProvider.TableTarget. */
	initialSelectedTable?: {schema: string; table: string; kind?: SchemasObjectKind};
	/** Set when "View Table Details" couldn't resolve the table to a real one in the target schema -
	 * pre-fills the tree filter with the table name instead of opening a tab, so the user can find it
	 * themselves. See SchemasProvider.TableTarget. */
	initialFilterText?: string;
	/** Set when the panel was opened by the Edit SQL Import command - opens that import's editor on first
	 * mount. Carried in initial state rather than pushed as a message because a brand-new panel isn't
	 * listening yet when the command fires; an ALREADY-open panel gets OpenSqlImportEditorMessage instead. */
	initialSqlImportEditorId?: string;
	/** Each resizable panel's width as last dragged (GlobalStates.schemaBrowserPanelWidths) - a panel never
	 * dragged is absent and takes its default. */
	panelWidths?: Partial<Record<SchemaBrowserPanel, number>>;
	/** The Data tab's edit settings (Configurations.dataEditSettings) as the panel opened - kept current
	 * afterwards by DataEditSettingsChangedMessage. */
	dataEditSettings: DataEditSettings;
}

/** The schema browser's panels with a draggable divider: the tree, and the Run SQL panel of edit mode. */
export type SchemaBrowserPanel = 'tree' | 'runSql';

export interface SchemasSchemaListEntry {
	name: string;
	hidden: boolean;
	/** True only for a schema the user added by name (GlobalStates.SchemaListOverrides.added), which is what
	 * the "Edit Schema List" dialog's Delete button is gated on: deleting is only meaningful for a name the
	 * overrides are holding onto. A library-list schema can only ever be hidden, and an import-only one
	 * disappears from this list on its own once its import is disabled. */
	added: boolean;
}

// Columns aren't part of SchemasInitialState (unlike SchemasSystemTable) - the Columns tab loads
// them lazily, on demand, rather than eagerly querying SYSCOLUMNS2 for every table up front.
export interface LoadColumnsMessage {
	command: 'loadColumns';
	schema: string;
	table: string;
	/** See MemoryCache.deleteColumnsCache - used by the Columns tab's Refresh action rather than its
	 * initial (cache-friendly) load. */
	forceRefresh?: boolean;
}

// Table keys and foreign keys aren't part of SchemasInitialState either, same reasoning as columns above.
export interface LoadTableKeysMessage {
	command: 'loadTableKeys';
	schema: string;
	table: string;
	/** See MemoryCache.deleteTableKeysCache - used by the Table Keys tab's Refresh action rather than
	 * its initial (cache-friendly) load. */
	forceRefresh?: boolean;
}

export interface LoadForeignKeysMessage {
	command: 'loadForeignKeys';
	schema: string;
	table: string;
	/** See MemoryCache.deleteForeignKeysCache - used by the Foreign Keys tab's Refresh action rather
	 * than its initial (cache-friendly) load. */
	forceRefresh?: boolean;
}

// Index advice isn't part of SchemasInitialState either, same reasoning as columns above.
export interface LoadIndexAdviceMessage {
	command: 'loadIndexAdvice';
	schema: string;
	table: string;
	/** See DbConnections.ListIndexAdviceOptions.forceRefresh - used by the Advised Indexes tab's manual
	 * refresh action rather than its initial (cache-friendly) load. */
	forceRefresh?: boolean;
}

// Current indexes aren't part of SchemasInitialState either, same reasoning as columns above.
export interface LoadIndexesMessage {
	command: 'loadIndexes';
	schema: string;
	table: string;
	/** See MemoryCache.deleteIndexesCache - used by the Indexes tab's Refresh action rather than its
	 * initial (cache-friendly) load. */
	forceRefresh?: boolean;
}

// Triggers aren't part of SchemasInitialState either, same reasoning as columns above.
export interface LoadTriggersMessage {
	command: 'loadTriggers';
	schema: string;
	table: string;
	/** See MemoryCache.deleteTriggersCache - used by the Triggers tab's Refresh action rather than its
	 * initial (cache-friendly) load. */
	forceRefresh?: boolean;
}

// An external trigger's program source, read when the Triggers tab's View Source is used on it (an SQL
// trigger's body already came with TriggersLoadedMessage). triggerName routes the reply to the dialog
// that asked, since one table can have several triggers.
export interface LoadTriggerSourceMessage {
	command: 'loadTriggerSource';
	schema: string;
	table: string;
	triggerName: string;
	programLibrary: string;
	programName: string;
}

// Deliberately generic (not e.g. "createIndex") - any future feature in this webview that generates
// SQL for the user to review and run can reuse this same message. Carries schema/table (unlike
// results-messages.ts's now-removed equivalent) so the host knows which table's Advised Indexes tab to
// recheck once the statement finishes running.
export interface RunGeneratedSqlMessage {
	command: 'runGeneratedSql';
	schema: string;
	table: string;
	sql: string;
	/** Set when this statement is a Create Index generated from an Advised Indexes recommendation -
	 * lets the host match it against the connection's current sort sequence (see
	 * DbConnections.executeCreateIndex()) rather than always running on the panel's own connection. */
	sortSequence?: string;
	sortSequenceLibrary?: string;
	/** Set when the Create Index dialog's "Delete advised index" checkbox was checked - a
	 * `DELETE FROM QSYS2.SYSIXADV WHERE RRN(SYSIXADV) = <id>` statement (SystemIndexAdvice.id) built by
	 * the Advised Indexes tab. Always run after `sql` succeeds, over the worker connection
	 * (DbConnections.deleteIndexAdvice()) rather than folded into `sql` as a multi-statement batch. */
	deleteAdviceSql?: string;
}

// Built by the Indexes tab's row context menu (Delete) - same convention as RunGeneratedSqlMessage,
// but always runs over the session's worker connection (DbConnections.deleteIndex()) rather than the
// main connection, since dropping an index shouldn't disturb an open result cursor.
export interface DeleteIndexMessage {
	command: 'deleteIndex';
	schema: string;
	table: string;
	sql: string;
}

// Built by the Indexes tab's row context menu (Rename) - same worker-connection reasoning as
// DeleteIndexMessage above. The new name's length is validated webview-side before this is sent.
export interface RenameIndexMessage {
	command: 'renameIndex';
	schema: string;
	table: string;
	sql: string;
}

// Built by the Advised Indexes tab's row Delete action - same
// `DELETE FROM QSYS2.SYSIXADV WHERE RRN(SYSIXADV) = <id>` statement and worker-connection handling
// (DbConnections.deleteIndexAdvice()) as RunGeneratedSqlMessage.deleteAdviceSql, just standalone
// rather than tied to a Create Index run.
export interface DeleteIndexAdviceMessage {
	command: 'deleteIndexAdvice';
	schema: string;
	table: string;
	sql: string;
}

// A view's SQL isn't part of SchemasInitialState (or of SchemasSystemView) - it can run to 10K characters a
// view, so the Definition tab loads it when opened. Carries `table` (the view's name) like every other
// tab-scoped message, so the reply routes through SchemasInboundMessage the same way. A materialized query
// table's Definition tab sends it too, with `source: 'mqt'` - the same tab over SYSTABLES.MQTDEF.
export interface LoadViewDefinitionMessage {
	command: 'loadViewDefinition';
	schema: string;
	table: string;
	/** Where the definition is read from - a view's SYSVIEWS row when absent. */
	source?: 'view' | 'mqt';
	/** Bypasses the cached definition - the Definition tab's Refresh action. */
	forceRefresh?: boolean;
}

// A function's SYSPARMS rows - its parameters and its results, which the Parameters and Result Columns tabs
// split by row type. `table` is the function's specific name, so the reply routes through
// SchemasInboundMessage like every other tab-scoped message.
export interface LoadRoutineParamsMessage {
	command: 'loadRoutineParams';
	schema: string;
	table: string;
	/** Bypasses the cached rows - the tabs' Refresh action. */
	forceRefresh?: boolean;
}

// The rest of a function's SYSROUTINES row, body included - read when the Info or Definition tab opens,
// for the same reason a view's definition is.
export interface LoadRoutineDetailMessage {
	command: 'loadRoutineDetail';
	schema: string;
	table: string;
	/** Bypasses the cached row - the Definition tab's Refresh action. */
	forceRefresh?: boolean;
}

// The statement that recreates a routine (QSYS2.GENERATE_SQL) - what the Definition tab shows first.
export interface LoadRoutineDdlMessage {
	command: 'loadRoutineDdl';
	schema: string;
	/** The routine's specific name. */
	table: string;
	routineType: SystemRoutine.RoutineType;
	forceRefresh?: boolean;
}

// An external routine's program source - the Program Source tab. Never cached, so a Refresh just asks again.
export interface LoadRoutineSourceMessage {
	command: 'loadRoutineSource';
	schema: string;
	/** The routine's specific name. */
	table: string;
	/** Accepted for symmetry with the other routine loads, and meaningless: source is never cached. */
	forceRefresh?: boolean;
}

// Data isn't part of SchemasInitialState either, same reasoning as columns above - and unlike the
// other lazy tabs it's paged (offset/limit) rather than loaded in one shot, so it has no
// forceRefresh flag; Refresh just re-sends offset: 0.
export interface LoadTableDataMessage {
	command: 'loadTableData';
	schema: string;
	table: string;
	offset: number;
	limit: number;
	/** Single-column sort - replaces the default primary-key order entirely. systemName (the real
	 * DB2 column), not sqlName. See DataQueries.ListTableDataOptions.orderBy. */
	orderBy?: {systemName: string; direction: 'asc' | 'desc'};
	/** The Edit Search dialog's WHERE clause body (no "where" keyword) - built by
	 * SearchCriteriaUtils.buildWhereClause() (Fields tab) or typed directly (Custom tab). See
	 * DataQueries.ListTableDataOptions.where. */
	where?: string;
}

// Built by RunSqlPanel's Run confirmation - raw SQL text only (no per-statement kind), since the host
// just executes each one in order over the worker connection (DataQueries.executeStatements); kind is
// only ever needed for display, which the webview derives itself via StatementParser.classifyKind.
export interface RunDataEditStatementsMessage {
	command: 'runDataEditStatements';
	statements: string[];
}

// Built by the schema tree's "Edit Schema List" dialog - hiddenSchemas is the dialog's full replacement
// set (not a delta), while newSchemas is only the brand-new names typed in this dialog session, so the
// host only has to batch-fetch tables for those rather than re-fetching everything already known. See
// SchemasProvider's 'updateSchemaList' handler and GlobalStates.SchemaListOverrides.
export interface UpdateSchemaListMessage {
	command: 'updateSchemaList';
	hiddenSchemas: string[];
	newSchemas: string[];
	/** Custom (non-library-list) schemas the user deleted outright - removed from the overrides
	 * entirely (not just hidden) and their cache wiped, so they don't resurface. See
	 * MemoryCache.deleteSchemaCache. */
	deletedSchemas: string[];
}

// Table tab header's Export menu. `.drawio` reuses the diagram's own serializer (see
// SchemasProvider.handleExportSchema: the resolved table is converted through toDiagramTable, dropped
// into a fresh empty DiagramModel via addTables, then diagramModelToXml - the exact "start a new diagram
// and add this one table" path); dbml/frictionless run the resolved table through the chosen
// SchemaFormatConverter directly, same as before `.drawio` existed as an option here. Either way ends in
// a native Save dialog. No reply message - resolves entirely via AlertUtils like the results side's
// exportData does.
export interface ExportSchemaMessage {
	command: 'exportSchema';
	schema: string;
	table: string;
	format: DiagramExportFormat;
	destination: ExportDestination;
}

// ImportSchemaDialog's "File" tab - the host owns the whole flow (open-file dialog, read, detect format
// by extension, parse, toast) with no payload from the webview and no reply, since v1 only reports a
// table count and does nothing else with the result. See SchemasProvider's handleImportSchema.
export interface ImportSchemaMessage {
	command: 'importSchema';
}

// ImportSchemaDialog's "Paste" tab - same host-side merge/toast as ImportSchemaMessage, but the format
// can't be sniffed from a filename since there isn't one, so the user picks it explicitly.
export interface ImportSchemaFromTextMessage {
	command: 'importSchemaFromText';
	format: SchemaFormatId;
	content: string;
}

// Table tab header's "Disable Imported Changes" menu item - disables every imported contribution
// (columns/keys/foreign keys/indexes) for this one table, from every import that touched it, reverting
// it to whatever real DB2 data (if any) exists on its own. Reversible: the View Imports dialog lists the
// table unchecked under each import that contributed it, and re-checking it brings it back. See
// SchemasProvider's 'disableImportedTableData' handler and SchemaTrees.disableImportedTableData. No reply
// message - a schemaListUpdated push (same as updateSchemaList) carries the refreshed tree.
export interface DisableImportedTableDataMessage {
	command: 'disableImportedTableData';
	schema: string;
	table: string;
}

// The inverse menu item, offered only while TreeTableEntry.hasDisabledImports is set - switches every
// import touching this one table back on. No confirmation behind it, same as disabling: both directions
// only switch imported data on or off for this connection, and the same menu switches it back.
export interface EnableImportedTableDataMessage {
	command: 'enableImportedTableData';
	schema: string;
	table: string;
}

// Sent when a drag (or arrow key, or double-click) on a panel's divider settles, not on every move.
export interface SavePanelWidthMessage {
	command: 'savePanelWidth';
	panel: SchemaBrowserPanel;
	width: number;
}

// The Data tab's Settings dialog saved - the host writes db2-workbench.dataEdit.*, and the change comes
// back to every open schemas panel as DataEditSettingsChangedMessage.
export interface SaveDataEditSettingsMessage {
	command: 'saveDataEditSettings';
	settings: DataEditSettings;
}

// Step 1 of a SQL import: run every statement the user filled in, on the worker connection. Answered
// with a SqlImportRunResultMessage - either the result columns to map, or the first statement's error.
// The rows themselves stay on the host under the returned run id; see SqlSchemaImports.
export interface RunSqlImportMessage {
	command: 'runSqlImport';
	statements: SqlImportStatementInput[];
}

// Step 2: apply a run's rows through the mapping the user built. Answered with a
// SqlImportResultMessage, whose report feeds the import summary dialog.
export interface ImportSqlSchemaMessage {
	command: 'importSqlSchema';
	runId: string;
	name: string;
	mappings: SqlImportMappings;
	/** Write this import to db2-workbench.sqlImports so it re-runs whenever a linked connection opens. */
	save: boolean;
	/** The connections a saved import is linked to. Empty when it isn't being saved. */
	connectionIds: string[];
}

// The import dialog's connection checkbox list, fetched when the dialog opens rather than carried in
// initial state - a connection added or renamed since the panel opened would otherwise be wrong or
// missing, and this list is only ever looked at while the dialog is on screen. Answered with a
// SqlImportConnectionsLoadedMessage.
export interface LoadSqlImportConnectionsMessage {
	command: 'loadSqlImportConnections';
}

// The View Imports dialog's pencil (and the Edit SQL Import command): asks for a saved import's statements
// and mapping so the edit dialog can open on them. Answered with a SqlImportLoadedMessage.
export interface LoadSqlImportMessage {
	command: 'loadSqlImport';
	importId: string;
}

// The edit dialog's Save / Save & Re-run. The statements and mapping replace the saved entry's; rerun says
// whether the Tables statement runs now or on the next connection. Answered with a SqlImportSavedMessage.
// What the edit dialog hands its host - the SaveSqlImportMessage minus the command, so the dialog and
// both bundles' handlers agree on one shape.
export interface SaveSqlImportRequest {
	importId: string;
	name: string;
	statements: SqlImportStatementInput[];
	mappings: SqlImportMappings;
	resultColumns: Partial<Record<SqlImportSectionId, string[]>>;
	connectionIds: string[];
	rerun: boolean;
}

export interface SaveSqlImportMessage {
	command: 'saveSqlImport';
	importId: string;
	name: string;
	statements: SqlImportStatementInput[];
	mappings: SqlImportMappings;
	/** What the statements returned when they last ran - the recorded set if nothing was re-run. */
	resultColumns: Partial<Record<SqlImportSectionId, string[]>>;
	connectionIds: string[];
	rerun: boolean;
}

// The View Imports dialog's refresh action (and the Refresh SQL Import command): re-runs every section of
// one saved import. No reply beyond the refreshed import list the host pushes anyway.
export interface RefreshSqlImportMessage {
	command: 'refreshSqlImport';
	importId: string;
}

// The dialog was closed (or stepped back to be re-run) without importing - lets the host drop the run's
// rows instead of holding a result set for the rest of the session. No reply.
export interface DiscardSqlImportRunMessage {
	command: 'discardSqlImportRun';
	runId: string;
}

// The tree menu's "View Imports" item - asks for this session's imports for this connection, answered
// with an ImportsLoadedMessage. Fetched on open rather than carried in initial state: the dialog is
// rarely opened, and the list changes with every import/removal from either surface.
export interface LoadImportsMessage {
	command: 'loadImports';
}

// "Apply" in the View Imports dialog - the difference between what its checkboxes now show and what is
// currently applied, in both directions. Answered with a fresh ImportsLoadedMessage (the dialog stays
// open), with the rebuilt tree arriving separately off SCHEMA_TREE_CHANGED like every other import
// mutation.
//
// Disabling is reversible and per connection: the rows stay in the store, hidden from every consumer
// until re-enabled (see SchemaTrees's disabled-entry set). Unlinking and deleting are not - they are the
// only things that take an import off the dialog's list, and only an import this apply leaves fully
// disabled can be named for either, which the host re-derives for itself (see findImportsToUnlink /
// findImportsToDelete) rather than trusting the list.
export interface ApplyImportsMessage {
	command: 'applyImports';
	disable: SchemaImportEntry[];
	enable: SchemaImportEntry[];
	/** Saved imports to unlink from THIS connection - their data goes, their settings entry stays for
	 * whatever other connections it is linked to. */
	unlinkImportIds?: string[];
	/** Imports to remove outright - their data goes, and a saved one's settings entry with it. */
	deleteImportIds?: string[];
}

// The SQL import payloads, declared here (rather than on SqlSchemaImports, which reaches vscode and
// odbc) so the host service, both message unions and the dialog itself all work from one set of types.

export interface SqlImportStatementInput {
	section: SqlImportSectionId;
	sql: string;
}

// One statement's outcome, as the mapping step needs it: the column names to map onto targets, how much
// came back, and a few real rows so a reversed child/parent mapping is visible before importing. Never
// the rows themselves - a 50,000-row result stays on the host.
export interface SqlImportRunSection {
	section: SqlImportSectionId;
	resultColumns: string[];
	rowCount: number;
	/** The statement returned more rows than db2-workbench.sqlImportRowLimit allows. */
	truncated: boolean;
	sampleRows: Record<string, string>[];
}

// An error carries the section that produced it so the dialog can render it under that statement's own
// text area, rather than as a dialog-level failure with no indication of which statement is wrong.
export type SqlImportRunResult =
	| {kind: 'ran'; runId: string; sections: SqlImportRunSection[]}
	| {kind: 'error'; section: SqlImportSectionId; error: DbErrorUtils.SerializedError};

/** Per section, result column -> target. A section with no statement is absent. */
export type SqlImportMappings = Partial<Record<SqlImportSectionId, Record<string, SqlImportTarget>>>;

export type SqlImportOutcome =
	| {kind: 'imported'; report: SchemaImportReport}
	| {kind: 'error'; error: DbErrorUtils.SerializedError};

// What one import actually did, as the summary dialog states it. Every source produces one (a DBML or
// Frictionless file included - those landed silently before), so the dialog says the same things in the
// same order whatever the import came from. `sections` is SQL-only: a file import has no sections and
// no rows to skip or dedupe.
// One connection a saved SQL import can be linked to, as the import dialog's checkbox list shows it.
// Shared with the diagram bundle, same as SchemaImportSummary - one dialog, one shape.
export interface SqlImportConnectionTarget {
	id: string;
	name: string;
	/** The connection the panel this dialog was opened from is pointed at - pre-checked when a NEW import
	 * is being made, since that is the one it was just run against. */
	current: boolean;
	/** Which saved imports this connection already links (ConnectionConfig.sqlImportIds). The edit dialog
	 * pre-checks by this instead of by the current flag: an existing import's links are its own, and checking the
	 * panel's connection would quietly unlink every other one on the next save. */
	sqlImportIds: string[];
}

export interface SchemaImportReport {
	importId: string;
	sourceLabel: string;
	sourceFormat: ImportSourceFormat;
	tableCount: number;
	columnCount: number;
	foreignKeyCount: number;
	/** Tables the source gave no schema for - grouped under `noSchemaBucket` rather than matched. */
	noSchemaCount: number;
	noSchemaBucket: string;
	sections?: SqlImportSectionSummary[];
}

export type SchemasOutboundMessage = LoadViewDefinitionMessage | LoadRoutineParamsMessage | LoadRoutineDetailMessage | LoadRoutineDdlMessage | LoadRoutineSourceMessage | LoadSqlImportMessage | SaveSqlImportMessage | RefreshSqlImportMessage | LoadSqlImportConnectionsMessage | RunSqlImportMessage | ImportSqlSchemaMessage | DiscardSqlImportRunMessage | LoadImportsMessage | ApplyImportsMessage | LoadColumnsMessage | LoadTableKeysMessage | LoadForeignKeysMessage | LoadIndexesMessage | LoadIndexAdviceMessage | LoadTriggersMessage | LoadTriggerSourceMessage | RunGeneratedSqlMessage | DeleteIndexMessage | RenameIndexMessage | DeleteIndexAdviceMessage | LoadTableDataMessage | RunDataEditStatementsMessage | UpdateSchemaListMessage | ExportSchemaMessage | ImportSchemaMessage | ImportSchemaFromTextMessage | DisableImportedTableDataMessage | EnableImportedTableDataMessage | SavePanelWidthMessage | SaveDataEditSettingsMessage;

export interface ColumnsLoadedMessage {
	command: 'columnsLoaded';
	schema: string;
	table: string;
	columns: ResolvedColumn[];
}

export interface ColumnsErrorMessage {
	command: 'columnsError';
	schema: string;
	table: string;
	/** The whole caught error, normalized - not pre-formatted into a display string. See
	 * DbErrorUtils.serialize and TableDataErrorMessage.error above for the same convention. */
	error: DbErrorUtils.SerializedError;
}

export interface TableKeysLoadedMessage {
	command: 'tableKeysLoaded';
	schema: string;
	table: string;
	tableKeys: ResolvedTableKey[];
}

export interface TableKeysErrorMessage {
	command: 'tableKeysError';
	schema: string;
	table: string;
	/** The whole caught error, normalized - not pre-formatted into a display string. See
	 * DbErrorUtils.serialize and TableDataErrorMessage.error above for the same convention. */
	error: DbErrorUtils.SerializedError;
}

export interface ForeignKeysLoadedMessage {
	command: 'foreignKeysLoaded';
	schema: string;
	table: string;
	foreignKeys: ResolvedForeignKey[];
}

export interface ForeignKeysErrorMessage {
	command: 'foreignKeysError';
	schema: string;
	table: string;
	/** The whole caught error, normalized - not pre-formatted into a display string. See
	 * DbErrorUtils.serialize and TableDataErrorMessage.error above for the same convention. */
	error: DbErrorUtils.SerializedError;
}

export interface IndexesLoadedMessage {
	command: 'indexesLoaded';
	schema: string;
	table: string;
	indexes: ResolvedIndex[];
}

export interface IndexesErrorMessage {
	command: 'indexesError';
	schema: string;
	table: string;
	/** The whole caught error, normalized - not pre-formatted into a display string. See
	 * DbErrorUtils.serialize and TableDataErrorMessage.error above for the same convention. */
	error: DbErrorUtils.SerializedError;
}

// A serialization-safe projection of SystemIndexAdvice - postMessage delivers Dates via structured
// clone, but lastAdvised is normalized to an ISO string here anyway, same convention as
// SchemasSystemTable's timestamps above, so both wire types behave identically.
export type SchemasIndexAdvice = Omit<SystemIndexAdvice, 'lastAdvised'> & {lastAdvised: string};

export interface IndexAdviceLoadedMessage {
	command: 'indexAdviceLoaded';
	schema: string;
	table: string;
	indexAdvice: SchemasIndexAdvice[];
}

export interface IndexAdviceErrorMessage {
	command: 'indexAdviceError';
	schema: string;
	table: string;
	/** The whole caught error, normalized - not pre-formatted into a display string. See
	 * DbErrorUtils.serialize and TableDataErrorMessage.error above for the same convention. */
	error: DbErrorUtils.SerializedError;
}

// A serialization-safe projection of SystemTrigger - its Dates normalized to ISO strings, same
// convention as SchemasIndexAdvice above.
export type SchemasTrigger = Omit<SystemTrigger, 'created' | 'lastAltered'> & {created: string; lastAltered?: string};

export interface TriggersLoadedMessage {
	command: 'triggersLoaded';
	schema: string;
	table: string;
	triggers: SchemasTrigger[];
}

export interface TriggersErrorMessage {
	command: 'triggersError';
	schema: string;
	table: string;
	/** The whole caught error, normalized - see TableDataErrorMessage.error for the same convention. */
	error: DbErrorUtils.SerializedError;
}

/** One source a trigger's or routine's program was compiled from - its text, or why it couldn't be read. */
export interface SchemasProgramSource {
	/** The ILE module it built - absent for an OPM program. */
	module?: string;
	/** LIB/FILE(MBR), or the IFS path. */
	location: string;
	text?: string;
	error?: DbErrorUtils.SerializedError;
	/** Why the source wasn't read at all - e.g. it was a temporary copy in QTEMP, or a member that's gone. */
	unavailable?: string;
	/** Said above the source - e.g. that it's a copy shown in place of a member that's gone, and which. */
	notice?: { text: string; severity: 'info' | 'warning' };
}

export interface TriggerSourceLoadedMessage {
	command: 'triggerSourceLoaded';
	schema: string;
	table: string;
	triggerName: string;
	/** Empty when the program records no source location at all. */
	sources: SchemasProgramSource[];
	/** The programs the trigger's program hands this table's work to, found through a routing table it
	 * reads (see trigger-dispatch.ts) - most certain first, absent for a program that dispatches nothing. */
	handlers?: SchemasTriggerHandler[];
}

/** A program a dispatching trigger program calls for this table, and its source. */
export interface SchemasTriggerHandler {
	/** LIB/OBJECT (*SRVPGM). */
	program: string;
	/** The object's name alone - what its source tabs are labelled with. */
	object: string;
	/** The service program export the routing row names. */
	entry?: string;
	/** LIB/TABLE - the routing table whose row named this program. */
	via: string;
	/** Set when the routing row fails a `column = 'literal'` condition the dispatcher's own SQL puts on the
	 * rows it reads - an active flag set off, typically - so this handler isn't called today. */
	unselected?: {column: string; value: string; actual: string};
	/** Narrowed to the entry's own module when it can be told apart, as a routine's Program Source tab does. */
	sources: SchemasProgramSource[];
}

export interface TriggerSourceErrorMessage {
	command: 'triggerSourceError';
	schema: string;
	table: string;
	triggerName: string;
	/** Finding where the source is failed - a failure reading one source is carried on that source instead. */
	error: DbErrorUtils.SerializedError;
}

export interface TableDataLoadedMessage {
	command: 'tableDataLoaded';
	schema: string;
	table: string;
	offset: number;
	rows: Row[];
	/** Full column metadata (not just sqlName) - already sent to a webview as-is elsewhere
	 * (ColumnsLoadedMessage.columns), and carries the systemName/dataType/length/scale the Edit
	 * Search dialog and sort need, so it's reused here rather than inventing a slimmer projection.
	 * Always present even when rows is empty (e.g. an empty table, or a page past the end), unlike
	 * the results grid's columns (Object.keys(rows[0])). */
	columns: SystemColumn[];
	columnLabels: Record<string, string[]>;
	hasMore: boolean;
	/** The column(s) that key a row for update/delete - real primary-key/identity column(s), or the
	 * single synthetic "$RRN" fallback when the table has neither. See DataQueries.KeyColumn - kept
	 * as an inline shape here (rather than importing that type) since this file is bundled into the
	 * webview and DataQueries pulls in the extension-host-only Extension class. */
	keyColumns: Array<{systemName: string; isRrn: boolean}>;
}

export interface TableDataErrorMessage {
	command: 'tableDataError';
	schema: string;
	table: string;
	/** The whole caught error, normalized - not pre-formatted into a display string, so the webview
	 * decides how to present it (message + optional DbErrorTable). See DbErrorUtils.serialize and
	 * webviews/shared/components/sql-error-display.tsx. */
	error: DbErrorUtils.SerializedError;
}

export interface ViewDefinitionLoadedMessage {
	command: 'viewDefinitionLoaded';
	schema: string;
	table: string;
	/** Exactly as SYSVIEWS stores it. */
	definition: string;
	/** Run through the SQL formatter with the user's formatting settings - the Definition tab's default
	 * view. Equal to `definition` when the formatter couldn't handle it. */
	formatted: string;
}

export interface ViewDefinitionErrorMessage {
	command: 'viewDefinitionError';
	schema: string;
	table: string;
	/** The whole caught error, normalized - see TableDataErrorMessage.error for the same convention. */
	error: DbErrorUtils.SerializedError;
}

export interface RoutineParamsLoadedMessage {
	command: 'routineParamsLoaded';
	schema: string;
	table: string;
	params: SchemasRoutineParam[];
}

export interface RoutineParamsErrorMessage {
	command: 'routineParamsError';
	schema: string;
	table: string;
	error: DbErrorUtils.SerializedError;
}

export interface RoutineDetailLoadedMessage {
	command: 'routineDetailLoaded';
	schema: string;
	table: string;
	/** Undefined when the function no longer exists. */
	detail?: SchemasRoutineDetail;
	/** The body run through the SQL formatter, as ViewDefinitionLoadedMessage.formatted. Equal to the raw
	 * body when the formatter couldn't handle it, and empty for an external function. */
	formattedDefinition: string;
}

export interface RoutineDetailErrorMessage {
	command: 'routineDetailError';
	schema: string;
	table: string;
	error: DbErrorUtils.SerializedError;
}

export interface RoutineDdlLoadedMessage {
	command: 'routineDdlLoaded';
	schema: string;
	table: string;
	ddl: string;
}

/** GENERATE_SQL failed - the Definition tab falls back to the stored body. */
export interface RoutineDdlErrorMessage {
	command: 'routineDdlError';
	schema: string;
	table: string;
	error: DbErrorUtils.SerializedError;
}

export interface RoutineSourceLoadedMessage {
	command: 'routineSourceLoaded';
	schema: string;
	table: string;
	/** The object the routine runs, as LIB/OBJ (type) - empty when its external name names none. */
	program: string;
	/** A service program's export the routine calls. */
	entry?: string;
	/** One per module, as for a trigger's program, with the module that defines `entry` moved first when
	 * one could be told (see findEntrySource). Empty when `unavailable` says why. */
	sources: SchemasProgramSource[];
	/** True when the entry's module was found, and so is the one source - false when none could be told apart, and every module is listed. */
	entryModuleFound?: boolean;
	/** True when the external name gave no library (or `*LIBL`), so `program`'s library is the one the
	 * library list found - the one thing here the Info tab's External Name doesn't already say. */
	resolvedFromLibraryList?: boolean;
	/** Why there is no source to show: a Java routine, a program that no longer exists, and so on. */
	unavailable?: string;
}

export interface RoutineSourceErrorMessage {
	command: 'routineSourceError';
	schema: string;
	table: string;
	error: DbErrorUtils.SerializedError;
}

export type SchemasInboundMessage = ViewDefinitionLoadedMessage | ViewDefinitionErrorMessage | RoutineParamsLoadedMessage | RoutineParamsErrorMessage | RoutineDetailLoadedMessage | RoutineDetailErrorMessage | RoutineDdlLoadedMessage | RoutineDdlErrorMessage | RoutineSourceLoadedMessage | RoutineSourceErrorMessage | ColumnsLoadedMessage | ColumnsErrorMessage | TableKeysLoadedMessage | TableKeysErrorMessage | ForeignKeysLoadedMessage | ForeignKeysErrorMessage | IndexesLoadedMessage | IndexesErrorMessage | IndexAdviceLoadedMessage | IndexAdviceErrorMessage | TriggersLoadedMessage | TriggersErrorMessage | TriggerSourceLoadedMessage | TriggerSourceErrorMessage | TableDataLoadedMessage | TableDataErrorMessage;

// Sent to a schemas panel that's already open when "View Table Details" is invoked again for the
// same connection - the resolved case (SchemasProvider.TableTarget's 'table' and 'view' kinds). Kept out
// of SchemasInboundMessage above since that union's members all carry schema/table fields that tab
// components switch on unconditionally - adding SetFilterMessage (below) to it would break that.
export interface SelectTableMessage {
	command: 'selectTable';
	schema: string;
	table: string;
	/** Set for a view or a routine, which opens its own kind of tab rather than a table tab. For a
	 * function or procedure, `table` is its specific name. */
	kind?: SchemasObjectKind;
}

// Same as SelectTableMessage, but for the unresolved-table case (SchemasProvider.TableTarget's
// 'filter' kind) - pre-fills the tree filter instead of opening a tab.
export interface SetFilterMessage {
	command: 'setFilter';
	filterText: string;
}

// Reply to RunDataEditStatementsMessage - not scoped to one table's tab (RunSqlPanel's pending
// statements can span multiple open tables), so it's routed through this app-level union rather than
// SchemasInboundMessage, same as SelectTableMessage/SetFilterMessage above. executedCount is how many
// of the statements RunSqlPanel sent succeeded, in order - the webview splices that many off the front
// of its own pendingStatements list; failed indicates DataQueries.executeStatements stopped early
// (the statement at index executedCount is the one that failed), in which case the app-level state
// keeps editMode on and leaves the remaining statements in place rather than clearing everything.
export interface RunDataEditStatementsResultMessage {
	command: 'runDataEditStatementsResult';
	executedCount: number;
	failed: boolean;
	/** Only set when failed - the whole caught error behind why the statement at index executedCount
	 * failed, normalized but not pre-formatted - see TableDataErrorMessage.error. */
	error?: DbErrorUtils.SerializedError;
}

// Sent once per statement, before and after it runs (status 'running' then 'success'/'error') - lets
// RunSqlPanel show a live spinner/checkmark/x next to whichever statement is currently executing.
// index is the statement's position in the array RunDataEditStatementsMessage sent, which the webview
// maps back to a statement id via the id list it snapshotted when the run started (see app.tsx).
export interface RunDataEditStatementProgressMessage {
	command: 'runDataEditStatementProgress';
	index: number;
	status: 'running' | 'success' | 'error';
}

// db2-workbench.dataEdit.* changed - from the Settings dialog, Ctrl+, or settings.json alike. App-level,
// since the settings apply to every table's Data tab.
export interface DataEditSettingsChangedMessage {
	command: 'dataEditSettingsChanged';
	settings: DataEditSettings;
}

// Reply to UpdateSchemaListMessage - the schema tree's whole state (both the visible tablesBySchema and
// the dialog-backing schemaList) rebuilt from the newly saved overrides, same shape as SchemasInitialState
// carries at panel-open. App-level (not table-tab-scoped) for the same reason as SelectTableMessage/
// SetFilterMessage above.
export interface SchemaListUpdatedMessage {
	command: 'schemaListUpdated';
	tablesBySchema: Record<string, TreeTableEntry[]>;
	viewsBySchema: Record<string, SchemasSystemView[]>;
	functionsBySchema: Record<string, SchemasSystemRoutine[]>;
	proceduresBySchema: Record<string, SchemasSystemRoutine[]>;
	schemaList: SchemasSchemaListEntry[];
}

// Reply to ImportSchemaMessage/ImportSchemaFromTextMessage when converter.import() (or reading the
// chosen file) throws - replaces a plain error toast with enough detail for ImportErrorDialog to show
// each problem in a scrollable table. App-level for the same reason as SchemaListUpdatedMessage above -
// the Import dialog isn't scoped to any open table tab either. See SchemasProvider's
// handleImportSchema/handleImportSchemaFromText and SchemaImportErrorUtils.serialize.
export interface ImportSchemaErrorMessage {
	command: 'importSchemaError';
	error: SchemaImportErrorUtils.SerializedImportError;
	/** The raw text that failed to parse - lets the dialog show the specific source line each error's
	 * location points at. Sent back even for the "paste" import path (where the webview technically
	 * already has this) since ImportSchemaDialog closes optimistically and may no longer have it in
	 * state by the time this arrives. */
	content: string;
}

// Reply to LoadImportsMessage and to ApplyImportsMessage - the whole current list either way, so the
// dialog never has to reconcile an apply against what it was showing. App-level for the same reason as
// SchemaListUpdatedMessage.
export interface ImportsLoadedMessage {
	command: 'importsLoaded';
	imports: SchemaImportSummary[];
}

// Reply to RunSqlImportMessage - either the mapping step's input or the failing statement's error.
export interface SqlImportRunResultMessage {
	command: 'sqlImportRunResult';
	result: SqlImportRunResult;
}

// Reply to LoadSqlImportConnectionsMessage - every configured connection, with the one this panel is
// pointed at flagged so the dialog can pre-check it.
// The Edit SQL Import command, which lives on the host but whose dialog lives here - the command picks the
// import and this opens the editor on it. The panel fetches the entry itself, exactly as the pencil does.
export interface OpenSqlImportEditorMessage {
	command: 'openSqlImportEditor';
	importId: string;
}

export interface SqlImportConnectionsLoadedMessage {
	command: 'sqlImportConnectionsLoaded';
	connections: SqlImportConnectionTarget[];
}

// Reply to LoadSqlImportMessage - the saved entry exactly as settings holds it, which is what the edit
// dialog's two steps are built from. Absent when the entry has since been deleted.
export interface SqlImportLoadedMessage {
	command: 'sqlImportLoaded';
	config?: SqlImportConfig;
}

// Reply to SaveSqlImportMessage. A rejected save (a statement that isn't read-only, no Tables statement)
// keeps the dialog open with the reason; a successful one closes it.
export interface SqlImportSavedMessage {
	command: 'sqlImportSaved';
	saved: boolean;
	message?: string;
}

// Reply to ImportSqlSchemaMessage. A successful import's tree repaint still rides SCHEMA_TREE_CHANGED
// like every other import; this carries the summary the dialog shows on top of it.
export interface SqlImportResultMessage {
	command: 'sqlImportResult';
	result: SqlImportOutcome;
}

// The summary shown after a DBML or Frictionless import lands. SQL imports get theirs from
// SqlImportResultMessage instead, since that reply already has to carry a failure case too.
export interface ImportSchemaSummaryMessage {
	command: 'importSchemaSummary';
	report: SchemaImportReport;
}

export type SchemasTreeInboundMessage = SqlImportLoadedMessage | SqlImportSavedMessage | OpenSqlImportEditorMessage | SqlImportConnectionsLoadedMessage | SqlImportRunResultMessage | SqlImportResultMessage | ImportSchemaSummaryMessage | ImportsLoadedMessage | SelectTableMessage | SetFilterMessage | RunDataEditStatementsResultMessage | RunDataEditStatementProgressMessage | SchemaListUpdatedMessage | ImportSchemaErrorMessage | DataEditSettingsChangedMessage;
