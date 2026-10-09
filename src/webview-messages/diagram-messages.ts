import { SchemaFormatId } from '../schema-conversion/schema-format-converter.js';
import { SqlImportConfig, SqlImportSectionId } from '../models/sql-import-config.js';
import { ExportDestination } from '../utils/export-utils.js';
import { SchemaImportErrorUtils } from '../utils/schema-import-error-utils.js';
import { SchemaImportEntry, SchemaImportReport, SchemaImportSummary, SchemasSchemaListEntry, SqlImportConnectionTarget, SqlImportMappings, SqlImportOutcome, SqlImportRunResult, SqlImportStatementInput } from './schemas-messages.js';

// Core diagram data model - shared by the mxGraph XML serializer/deserializer (src/diagram/) and the
// diagram custom editor's webview. Deliberately holds only structural/persisted content, not view state
// (current zoom/pan) - a diagram always opens fit-to-view rather than restoring a prior camera position.

export interface DiagramColumn {
	/**
	 * IDENTITY, not a display name: relationships anchor to this, the mxGraph column cell id ends with
	 * it, and React Flow handle ids are built from it. Long SQL name where DB2 has one, otherwise
	 * whatever single name form the column was resolved from. Never derived from a user setting - see
	 * diagram-column-labels.ts.
	 */
	name: string;
	/**
	 * DB2's short system name, long SQL name, and column heading, when they're known. Stored so (a) the
	 * row can be labelled per the user's `resultHeadingLabels` setting the same way the results grid and
	 * schema browser are, and (b) a foreign key naming a column in a DIFFERENT form than the identity -
	 * which an imported one always does, since imports carry short names - still resolves to the right
	 * column. Optional throughout: an imported-only column has no long name, and a diagram saved before
	 * these existed has none of them.
	 */
	shortName?: string;
	longName?: string;
	description?: string;
	type: string;
	primaryKey: boolean;
	foreignKey: boolean;
	identity: boolean;
	// Same always-written convention as primaryKey/foreignKey/identity above (never optional - a diagram
	// saved before these existed round-trips to false/false/false, the correct "unknown, not asserted"
	// default rather than a fabricated claim). Drive the canvas's "(NN, U, I)" indicator (see table-node.tsx)
	// and the export path (see diagram-schema-export.ts); DiagramTable.uniqueKeys/indexes below carry the
	// supplementary detail (constraint/index names, composite partner columns) these three don't have room
	// for, computed alongside them in diagram-resolved-table.ts so the two can't drift apart.
	notNull: boolean;
	unique: boolean;
	indexed: boolean;
	/**
	 * True when this column is new (doesn't exist in DB2 at all) or was modified by an import - see
	 * ResolvedColumn.isNew/importedFields, which is what this is derived from (see diagram-resolved-
	 * table.ts). Persisted (db2wbImported style key, see diagram-xml.ts) so a diagram opened cold, without
	 * re-importing anything this session, still shows the flag - but it's still a point-in-time snapshot,
	 * not live truth: a table resolved fresh (on add, on connect, or after an import changes) always
	 * recomputes it, and only an explicit "Sync with Database" or the narrower in-session auto-refresh
	 * (refreshImportedData) ever updates an already-open diagram's copy.
	 */
	imported?: boolean;
}

export interface DiagramTable {
	// `${schema}.${name}` - stable across the file, used to reference this table as a relationship
	// endpoint and as the mxGraph cell id.
	id: string;
	// References DiagramSchemaGroup.id, not a raw schema name - a table always belongs to exactly one
	// schema group.
	schemaId: string;
	name: string;
	description?: string;
	position: {x: number; y: number};
	columns: DiagramColumn[];
	// UNIQUE constraints, one entry per constraint (not per column) - a composite unique constraint's
	// columns all share one entry, same grouping table-resolver.ts's own groupByConstraint already applies
	// to the underlying SYSCST/SYSKEYCST rows. `name` is the real constraint name (or table-resolver's own
	// synthetic import-only name) rather than DiagramColumn.unique's plain boolean, so a tooltip can say
	// which OTHER columns share the constraint, and so export can reconstruct a composite UNIQUE instead of
	// N independent single-column ones. Omitted when empty, same optional convention as description/
	// importStatus above.
	uniqueKeys?: { name: string; columns: string[] }[];
	// Actual DB2 indexes (QSYS2.SYSPARTITIONINDEXSTAT), one entry per index - NOT the schema browser's
	// Advised Indexes tab, which is a recommendation, not something that exists. `columns` preserves the
	// index's own key order (see table-resolver.ts's own comment on why index column order matters, unlike
	// a key/FK's unordered column set). Omitted when empty, same convention as uniqueKeys above.
	indexes?: { name: string; columns: string[]; unique: boolean }[];
	/**
	 * 'imported' when this table doesn't exist in DB2 at all (everything about it came from an import);
	 * 'enhanced' when it's a real, connected table that has also picked up at least one import-sourced
	 * column, key, or foreign key; 'orphaned' when a "Sync with Database" could resolve it against NEITHER
	 * the database NOR any current import, but the user chose to keep it anyway (see the Keep/Remove
	 * confirmation in diagram-editor-provider.ts's handleConfirmSync) - shown with the same "New" badge as
	 * an unconfirmed row elsewhere (ImportBadgeKind 'new'), not a separate alarming label, since the same
	 * underlying fact applies: don't trust this as confirmed DB2 data. Absent for a plain connected table
	 * with no import touching it. 'imported'/'enhanced' are derived fresh on every resolve (see
	 * diagram-resolved-table.ts's tableImportStatus); 'orphaned' is set only by Sync itself, since a normal
	 * resolve never produces it - a table that fails to resolve at all yields no ResolvedTable, only a
	 * caller-side "missing" callback. Persisted (see diagram-xml.ts) so a diagram opened cold shows
	 * whichever of the three was true as of the last save/sync, same reasoning as DiagramColumn.imported.
	 */
	importStatus?: 'imported' | 'enhanced' | 'orphaned';
}

export interface DiagramRelationship {
	id: string;
	// Endpoints reference a specific column, not just a table - see the diagram prototype's research
	// notes on why column-level (not table-level) edges are both the more useful visual and the more
	// robust choice in React Flow. Always foreign-key-to-primary-key, so cardinality (crow's-foot "many"
	// at fromTable, "one" at toTable) is implied by which end is which, not a separate stored field.
	fromTable: string;
	fromColumn: string;
	toTable: string;
	toColumn: string;
}

export interface DiagramSchemaGroup {
	// Currently just the schema name, kept as a distinct field from `name` (rather than reusing `name`
	// directly everywhere) so a future diagram spanning tables from multiple connections isn't forced
	// to assume schema names are globally unique.
	id: string;
	name: string;
	// Drives the color-coded border and the legend - assigned once, stable across edits/reloads rather
	// than recomputed from a hash each render.
	color: string;
	// Authoritative on load - read directly from the schema group's own stored mxGraph geometry rather
	// than recomputed from its tables' positions (see the prototype's minimap research on why a stored
	// bound beats an inferred one). Recomputed only when an edit actually changes which tables belong to
	// the group or where they sit.
	bounds: {x: number; y: number; width: number; height: number};
}

export interface DiagramModel {
	schemas: DiagramSchemaGroup[];
	tables: DiagramTable[];
	relationships: DiagramRelationship[];
}

// Embedded once via window.__INITIAL_STATE__ when the webview first mounts - see
// WebviewHtmlUtils.getReactWebviewHtml. fileName is display-only (the editor tab already shows it, but
// the diagram's own top-right info panel repeats it per the design spec).
export interface DiagramInitialState {
	model: DiagramModel;
	fileName: string;
	/** Absent until the user picks a connection from the diagram's own menu - a diagram is deliberately
	 * not bound to one (nothing about a connection is stored in the file), so it always opens
	 * disconnected. Present here rather than only pushed over a message so a SECOND editor opened on an
	 * already-connected document (supportsMultipleEditorsPerDocument) starts out showing the connection
	 * too, instead of claiming to be disconnected. See DiagramEditorProvider.connectionsByDocumentUri. */
	connectionName?: string;
	/**
	 * True when the host is ALREADY establishing a connection for this diagram at the moment the webview
	 * mounts - i.e. "New Diagram" from a connection's context menu, whose connect attempt is kicked off by
	 * the webview's own `ready` message and can take as long as a password prompt plus a connection handshake. The
	 * webview shows a spinner in place of its menu button for the duration, so the menu can't be used to
	 * start a second, competing connect. Cleared by the connectionChanged message that ends every attempt,
	 * successful or not. A connect the user starts from the menu itself doesn't need this - the webview
	 * already knows it asked for that one.
	 */
	connecting?: boolean;
	/**
	 * `db2-workbench.resultHeadingLabels`, in the user's configured order - which name form each column
	 * row is labelled with (see diagram-column-labels.ts). Pushed again as a columnLabelsChanged message
	 * if the setting changes while the diagram is open, so an open canvas relabels rather than needing a
	 * reopen.
	 */
	columnLabels: string[];
}

// Host -> webview. Pushed whenever DiagramDocument's content changes for any reason (a local edit, an
// undo/redo, a revert) so every open webview for the same document stays in sync, not just the one that
// triggered the change.
export interface DiagramModelUpdatedMessage {
	command: 'modelUpdated';
	model: DiagramModel;
}

// Sent when a connect attempt actually resolved to a connection - or to none, when it could not be
// opened, which is what lets the webview drop back to "Not connected" rather than being left showing a
// half-finished state. Either way this REPLACES what the webview held: it throws away the table picker's
// contents and selection, since those belonged to whatever connection was in play before.
export interface DiagramConnectionChangedMessage {
	command: 'connectionChanged';
	connectionName?: string;
}

// Sent when a connect attempt ended without touching the connection at all - today, cancelling the
// quick-pick. Deliberately NOT a connectionChanged carrying the old name: the webview discards its picker
// state on every connectionChanged, so reporting a no-op that way emptied the table tree (leaving it stuck
// on "Loading tables...") for a connection that was never actually disturbed. All this ends is the
// webview's connecting spinner.
export interface DiagramConnectAbortedMessage {
	command: 'connectAborted';
}

// One row of the diagram's table-picker tree. Deliberately only the three fields the tree renders,
// not SystemTable's dozen DB2 columns - the picker exists to choose tables, and everything else about
// one is fetched when it's actually added to the diagram. Structurally matches SchemaTreeEntry in
// webviews/shared/components/schema-tree.tsx, which is what lets the webview pass these straight
// through without a second mapping step.
export interface DiagramTreeTable {
	schema: string;
	table: string;
	description?: string;
}

// Sent after connectionChanged, once the connection's tables have actually been fetched - a separate
// message rather than a field on connectionChanged because the fetch can take a noticeable moment on a
// large library list, and the connection name should appear immediately rather than waiting on it.
// Re-sent (not a distinct message) after anything that changes what the tree should show: an "Edit
// Schema List" save, or an import - the whole tree is rebuilt host-side either way, so there is nothing
// a delta message would save.
export interface DiagramSchemaTablesMessage {
	command: 'schemaTablesLoaded';
	tablesBySchema: Record<string, DiagramTreeTable[]>;
	/**
	 * What the "Edit Schema List" dialog edits. Reuses the schema browser's own entry type rather than
	 * redeclaring it, because the dialog itself is shared between the two bundles
	 * (webviews/shared/components/edit-schema-list-dialog.tsx) and is typed against that.
	 */
	schemaList: SchemasSchemaListEntry[];
	/** The tables with at least one switched-off import, as schema+table (NO_SCHEMA_BUCKET included), so a
	 * node's context menu can offer "Enable Imported Changes". Carried here rather than on DiagramTable
	 * because that type is persisted in the .db2diagram file and this is session state - and because a node
	 * whose every import is switched off stays on the canvas, so the model alone can't tell. */
	disabledImportTables: {schema: string; table: string}[];
}

// Reply to ImportDiagramSchemaMessage/ImportDiagramSchemaFromTextMessage when the file can't be read or
// the content can't be parsed - the diagram's half of what SchemasProvider posts for the same failure.
// `content` is the text that failed, which is what the error dialog needs to show the offending source
// line for each problem's reported location.
export interface DiagramImportSchemaErrorMessage {
	command: 'importSchemaError';
	error: SchemaImportErrorUtils.SerializedImportError;
	content: string;
}

// Replies to the diagram's SQL import messages - the schema browser's SqlImportRunResultMessage /
// SqlImportResultMessage / ImportSchemaSummaryMessage under this bundle's own union.
export interface DiagramSqlImportRunResultMessage {
	command: 'sqlImportRunResult';
	result: SqlImportRunResult;
}

export interface DiagramSqlImportLoadedMessage {
	command: 'sqlImportLoaded';
	config?: SqlImportConfig;
}

export interface DiagramSqlImportSavedMessage {
	command: 'sqlImportSaved';
	saved: boolean;
	message?: string;
}

export interface DiagramOpenSqlImportEditorMessage {
	command: 'openSqlImportEditor';
	importId: string;
}

export interface DiagramSqlImportConnectionsMessage {
	command: 'sqlImportConnectionsLoaded';
	connections: SqlImportConnectionTarget[];
}

export interface DiagramSqlImportResultMessage {
	command: 'sqlImportResult';
	result: SqlImportOutcome;
}

export interface DiagramImportSchemaSummaryMessage {
	command: 'importSchemaSummary';
	report: SchemaImportReport;
}

// Sent when `db2-workbench.resultHeadingLabels` changes - the column rows relabel in place. Only the
// labelling changes: a column's identity (and so every relationship anchor) deliberately doesn't move
// with the setting, see DiagramColumn.name.
export interface DiagramColumnLabelsMessage {
	command: 'columnLabelsChanged';
	columnLabels: string[];
}

// One referenced-but-absent table a missing-target marker offers to bring in.
export interface MissingTargetTable {
	targetSchema: string;
	targetTable: string;
	targetColumn: string;
}

// One column on the diagram carrying at least one foreign key whose referenced table ISN'T on it -
// drawn as a "bring that table in" marker on its column (see table-node.tsx). Declared here, alongside
// the message that carries it, for the same reason DiagramTreeTable is: it's a wire type. The rule for
// deciding which keys qualify lives in src/diagram/diagram-missing-targets.ts.
export interface MissingRelationshipTarget {
	/** The table ON the diagram that declares the foreign key. */
	tableId: string;
	/** Its column - the row the marker is drawn on. */
	columnName: string;
	// Every distinct table this column's unresolved foreign keys point at, not just the first - DB2
	// permits more than one key to leave the same column, and the marker offers the whole set as a
	// checkbox list rather than silently picking one (see add-missing-targets-dialog.tsx). Never empty.
	targets: MissingTargetTable[];
}

// Pushed by the host rather than derived in the webview because the model only stores the
// relationships that were actually drawn: a skipped key leaves nothing behind but a column flagged
// foreignKey, which says nothing about what it points at. Empty whenever the diagram is
// disconnected, since there'd be no way to act on a marker anyway.
export interface DiagramMissingTargetsMessage {
	command: 'missingTargetsLoaded';
	targets: MissingRelationshipTarget[];
}

// One table that resolves against NEITHER a connected row NOR any current import, offered to the user as
// a Keep/Remove choice. Raised by "Sync with Database" (every such table on the diagram at once) and by
// "Disable Imported Changes" (the one table, when disabling its import is what would leave it with no
// source at all). Declared here, alongside the messages that carry it, for the same reason
// MissingRelationshipTarget is: it's a wire type. schema/table (not just tableId) are what the Keep/Remove
// confirmation dialog displays.
export interface DiagramSyncOrphan {
	tableId: string;
	schema: string;
	table: string;
}

// Sent after a "Sync with Database" resolve finds at least one orphan (see DiagramSyncOrphan) - the
// webview shows the Keep/Remove confirmation dialog and replies with ConfirmSyncMessage or
// CancelSyncMessage. Not sent at all when there's nothing to confirm; the host applies that sync
// immediately instead (see DiagramEditorProvider.handleSyncDiagram).
export interface DiagramSyncOrphansMessage {
	command: 'syncOrphansFound';
	orphans: DiagramSyncOrphan[];
}

// Reply to LoadDiagramImportsMessage and to ApplyDiagramImportsMessage - this connection's imports as
// the View Imports dialog lists them, the whole list either way. Reuses the schema browser's summary type
// for the same reason the schema list does: the dialog itself is shared and is typed against it.
export interface DiagramImportsMessage {
	command: 'importsLoaded';
	imports: SchemaImportSummary[];
}

// Sent when discarding imported data would leave a table on this diagram with no source at all - it
// exists in no connected schema, so nothing would back it. Nothing has been discarded yet at this point:
// the webview shows the same Keep/Remove dialog Sync uses and replies with ConfirmImportRemovalMessage or
// CancelImportRemovalMessage, and only the reply decides whether anything happens at all. A table that IS
// backed by a real DB2 row is never listed here - it simply reverts to its real data, with no second
// question to ask.
//
// A list rather than a single orphan because disabling a whole import (see ApplyDiagramImportsMessage)
// can strand several tables at once; "Disable Imported Changes" on one node just sends a one-element list.
export interface DiagramImportRemovalOrphanMessage {
	command: 'importRemovalOrphanFound';
	orphans: DiagramSyncOrphan[];
}


// DiagramTable.importStatus does - see SyncResultTable in diagram-add-tables.ts, which this mirrors
// exactly (kept separate since webview-messages/*.ts are the wire-type layer, deliberately with nothing
// importing back from src/diagram/).
export interface DiagramSyncResultTable {
	tableId: string;
	schema: string;
	table: string;
	status: 'updated' | 'removed' | 'orphaned';
}

// Sent once a "Sync with Database" edit actually applies something - the webview shows a summary dialog
// listing every affected table (scrollable, single OK button) instead of the plain toast Sync otherwise
// reports through directly. Not sent at all when the sync was a genuine no-op; the host's toast covers
// that case on its own (see DiagramEditorProvider.applySync).
export interface DiagramSyncSummaryMessage {
	command: 'syncSummary';
	tables: DiagramSyncResultTable[];
}

export type DiagramInboundMessage = DiagramSqlImportLoadedMessage | DiagramSqlImportSavedMessage | DiagramOpenSqlImportEditorMessage | DiagramSqlImportConnectionsMessage | DiagramSqlImportRunResultMessage | DiagramSqlImportResultMessage | DiagramImportSchemaSummaryMessage | DiagramImportsMessage | DiagramModelUpdatedMessage | DiagramConnectionChangedMessage | DiagramConnectAbortedMessage | DiagramSchemaTablesMessage | DiagramMissingTargetsMessage | DiagramImportSchemaErrorMessage | DiagramColumnLabelsMessage | DiagramSyncOrphansMessage | DiagramSyncSummaryMessage | DiagramImportRemovalOrphanMessage;

// Webview -> host.
export interface MoveTableMessage {
	command: 'moveTable';
	tableId: string;
	position: {x: number; y: number};
}

// Ending a multi-select drag (ctrl+click several tables, then drag any one of them) - one message for
// every table that moved, applied as a single edit host-side (see moveTables in diagram-model-editor.ts)
// so one Ctrl+Z undoes the whole drag. MoveTableMessage stays the single-table path (a plain, unselected
// drag); this is deliberately a separate message rather than always sending a one-element batch, so the
// common case's wire shape doesn't change.
export interface MoveTablesMessage {
	command: 'moveTables';
	tables: {tableId: string; position: {x: number; y: number}}[];
}

// A table's header/body was clicked (not a column - that's a separate, diagram-local relationship-
// highlighting interaction, never sent to the host). Only the id travels over the wire; the host already
// has the full model and resolves schema/table name from it.
export interface TableClickedMessage {
	command: 'tableClicked';
	tableId: string;
}

export interface ResizeSchemaMessage {
	command: 'resizeSchema';
	schemaId: string;
	bounds: {x: number; y: number; width: number; height: number};
}

// A plain drag of the schema group's title (not a resize handle) - distinct from ResizeSchemaMessage
// since it shifts every table belonging to the schema along with it; see moveSchema in
// diagram-model-editor.ts for why these can't share one message/edit.
export interface MoveSchemaMessage {
	command: 'moveSchema';
	schemaId: string;
	position: {x: number; y: number};
}

// Right-click "Remove" on a table node. Removes the table and every relationship touching it - see
// removeTable in diagram-model-editor.ts. Undoable, the same as every other diagram edit.
export interface RemoveTableMessage {
	command: 'removeTable';
	tableId: string;
}

// Right-click "Remove" with 2+ tables selected on the canvas at once - one message for the whole
// selection, applied as a single edit host-side (see removeTables in diagram-model-editor.ts) so one
// Ctrl+Z restores every one of them. RemoveTableMessage stays the single-table path.
export interface RemoveTablesMessage {
	command: 'removeTables';
	tableIds: string[];
}

// Right-click "Remove" on a schema group's header. Removes the schema, every table it contains, and
// every relationship touching one of those tables (including one crossing into a schema that stays) -
// see removeSchema in diagram-model-editor.ts.
export interface RemoveSchemaMessage {
	command: 'removeSchema';
	schemaId: string;
}

// Right-click "Disable Imported Changes" on a table node carrying an Imported/Enhanced badge - the same
// action (and the same host-side SchemaTrees.disableImportedTableData call) the schema browser's table tab
// header offers, so an import disabled from either surface is disabled for both. Only the id travels,
// same as OpenSchemaForTableMessage - the host resolves schema/table name from the model. If this diagram
// isn't connected yet, the host prompts for a connection first, same as "Connect to Database": the imported
// data being disabled is held per connection, and what the table should look like without it is a database
// question.
export interface DisableImportedTableDataMessage {
	command: 'disableImportedTableData';
	tableId: string;
}

// The inverse menu item, offered only for a node listed in DiagramSchemaTablesMessage.disabledImportTables
// - switches every import touching that one table back on and resolves the node against the result. No
// confirmation and no Keep/Remove prompt: enabling only ever gives a table MORE to resolve against, so it
// can't strand anything. Same connection handling as disabling.
export interface EnableImportedTableDataMessage {
	command: 'enableImportedTableData';
	tableId: string;
}

// Reply to DiagramImportRemovalOrphanMessage: OK on the Keep/Remove dialog. A row switched to Remove goes
// off the diagram along with its import; one left at Keep stays, flagged 'orphaned' (the "New" badge),
// with the data the import left behind. Either way the import itself is discarded, which is what the
// dialog was blocking.
export interface ConfirmImportRemovalMessage {
	command: 'confirmImportRemoval';
	/** The orphaned tables the user switched to Remove. Everything else stays, flagged 'orphaned'. */
	removeTableIds: string[];
}

// Reply to DiagramImportRemovalOrphanMessage: Cancel on the Keep/Remove dialog - backs out of the whole
// action, leaving the import in place. Nothing was discarded before the prompt, so this is a true
// no-op rather than an undo (contrast CancelSyncMessage, which also lands before anything applies).
export interface CancelImportRemovalMessage {
	command: 'cancelImportRemoval';
}

// Right-click "Open Schema" on a table node - same target the F12 "Go to Definition" command in a SQL
// editor lands on (Commands.showTableDetails/SchemasProvider.show): reveals or opens that connection's
// schema browser tab with the table selected. Only the id travels over the wire, same as
// TableClickedMessage - the host already has the full model and resolves schema/table name from it. If
// this diagram isn't connected yet, the host prompts for a connection first, same as "Connect to Database".
export interface OpenSchemaForTableMessage {
	command: 'openSchemaForTable';
	tableId: string;
}

// "Connect to Database" from the diagram's own menu. Carries nothing on purpose: the host hands the
// choice straight to DbConnections' existing quick-pick (see DiagramEditorProvider.handleConnectToDatabase)
// rather than the webview trying to enumerate or pre-select connections itself.
export interface ConnectToDatabaseMessage {
	command: 'connectToDatabase';
}

// "Add to Diagram" from the table picker's right-click menu. Carries only schema/table names: the
// host resolves each table's columns, keys and foreign keys itself (see
// DiagramEditorProvider.handleAddTables), since the picker deliberately only ever fetched enough to
// render a tree row.
export interface AddTablesMessage {
	command: 'addTables';
	tables: {schema: string; table: string}[];
}

// Posted once when the webview mounts. Exists so the host can act on something it decided BEFORE the
// panel existed - specifically "New Diagram" from a connection's context menu, which knows which
// connection to use but has no webview to tell yet. A webview postMessage sent before the page's own
// listener is attached is dropped, not queued, so this is the only race-free trigger for it.
export interface DiagramReadyMessage {
	command: 'ready';
}

// The tree's own vertical-dots menu, available wherever the shared tree is - the schema browser's
// equivalents (UpdateSchemaListMessage/ImportSchemaMessage/ImportSchemaFromTextMessage in
// schemas-messages.ts) are deliberately not reused: each bundle posts through its own union, and the
// host handlers differ in what they push back afterwards. The work behind all three is shared, though -
// see the SchemaTrees service, which both providers delegate to.
export interface UpdateDiagramSchemaListMessage {
	command: 'updateSchemaList';
	hiddenSchemas: string[];
	newSchemas: string[];
	deletedSchemas: string[];
}

// "Import" -> "Import File...". The host owns the native file dialog, so this carries nothing.
export interface ImportDiagramSchemaMessage {
	command: 'importSchema';
}

// "Import" -> pasted text. Format is explicit since there's no filename to sniff it from.
export interface ImportDiagramSchemaFromTextMessage {
	command: 'importSchemaFromText';
	format: SchemaFormatId;
	content: string;
}

// The diagram's half of the SQL import flow - same dialog, same host service, same payload types as
// RunSqlImportMessage/ImportSqlSchemaMessage/DiscardSqlImportRunMessage in schemas-messages.ts.
export interface RunDiagramSqlImportMessage {
	command: 'runSqlImport';
	statements: SqlImportStatementInput[];
}

export interface ImportDiagramSqlSchemaMessage {
	command: 'importSqlSchema';
	runId: string;
	name: string;
	mappings: SqlImportMappings;
	save: boolean;
	connectionIds: string[];
}

// The diagram's half of LoadSqlImportConnectionsMessage. A diagram opened without a connection still
// gets the list - it just has nothing flagged current, so nothing is pre-checked.
export interface LoadDiagramSqlImportConnectionsMessage {
	command: 'loadSqlImportConnections';
}

// The diagram's half of the saved-import editing messages - same dialog, same host service, same payloads
// as LoadSqlImportMessage/SaveSqlImportMessage/RefreshSqlImportMessage.
export interface LoadDiagramSqlImportMessage {
	command: 'loadSqlImport';
	importId: string;
}

export interface SaveDiagramSqlImportMessage {
	command: 'saveSqlImport';
	importId: string;
	name: string;
	statements: SqlImportStatementInput[];
	mappings: SqlImportMappings;
	resultColumns: Partial<Record<SqlImportSectionId, string[]>>;
	connectionIds: string[];
	rerun: boolean;
}

export interface RefreshDiagramSqlImportMessage {
	command: 'refreshSqlImport';
	importId: string;
}

export interface DiscardDiagramSqlImportRunMessage {
	command: 'discardSqlImportRun';
	runId: string;
}

// The tree menu's "View Imports" item and the changes its dialog applies - the diagram's half of
// LoadImportsMessage/ApplyImportsMessage in schemas-messages.ts, same dialog, same shared store. The
// reply (DiagramImportsMessage) is the whole current list either way. An apply here does more than the
// schema browser's: tables already on this canvas have to be resolved again without the disabled data,
// which is why it can raise DiagramImportRemovalOrphanMessage first.
export interface LoadDiagramImportsMessage {
	command: 'loadImports';
}

export interface ApplyDiagramImportsMessage {
	command: 'applyImports';
	disable: SchemaImportEntry[];
	enable: SchemaImportEntry[];
	/** See ApplyImportsMessage - same dialog, same confirmation, same host-side re-derivation. */
	unlinkImportIds?: string[];
	deleteImportIds?: string[];
}

// `.drawio` (the diagram's own native format, full fidelity) plus the two schema-conversion formats the
// schema browser's own Export already offers - reusing SchemaFormatId rather than inventing a parallel
// id keeps the two Export features' format identifiers from ever drifting apart. A DBML/Frictionless
// export is necessarily best-effort: the diagram model doesn't carry everything those formats could in
// principle hold (nullability, UNIQUE constraints, indexes, composite FKs - see
// diagram-schema-export.ts's own comment for the full list), unlike `.drawio`, which round-trips the
// diagram exactly.
export type DiagramExportFormat = 'drawio' | SchemaFormatId;

// "Export..." from the diagram's own menu. `scope` is "all" vs "filtered", the same distinction
// ExportTablesDialog offers; `filterText` rides along unconditionally rather than the webview
// pre-computing a table list, so the host can derive the exact same filtered model via filterDiagramModel
// (see diagram-filter.ts) that the canvas is already dimming against - one filter implementation, not two
// that could drift. Ignored by the host when scope is "all". `scope` applies to every format the same
// way, format only changes what filterDiagramModel's result gets serialized into.
export interface ExportDiagramMessage {
	command: 'exportDiagram';
	format: DiagramExportFormat;
	scope: 'all' | 'filtered';
	filterText: string;
	destination: ExportDestination;
}

// "Export..." from a table's own right-click menu (see ContextMenu in app.tsx) - exports only `tableIds`
// (the table that was right-clicked, or the whole multi-selection it was part of), unlike
// ExportDiagramMessage's "all"/"filtered" scope over the WHOLE diagram. No `scope`/`filterText` of its
// own: the host restricts the model to exactly these tables (see restrictDiagramModelToTables in
// diagram-filter.ts) the same way filterDiagramModel restricts to a filter match - a relationship survives
// only when both endpoints are in the set.
export interface ExportTablesMessage {
	command: 'exportTables';
	tableIds: string[];
	format: DiagramExportFormat;
	destination: ExportDestination;
}

// "Sync with Database" from the diagram's own menu. Carries nothing, same as ConnectToDatabaseMessage -
// the host resolves every table already on the diagram against current DB2+imports itself (see
// DiagramEditorProvider.handleSyncDiagram). Prompts for a connection first if this diagram isn't
// connected yet, same convention OpenSchemaForTableMessage already follows.
export interface SyncDiagramMessage {
	command: 'syncDiagram';
}

// Reply to DiagramSyncOrphansMessage: OK on the Keep/Remove dialog. tableIds is only the ones the user
// switched to Remove - everything else defaulted to Keep, which is what turns into DiagramTable.
// importStatus 'orphaned' rather than a removal (see syncTables in diagram-add-tables.ts).
export interface ConfirmSyncMessage {
	command: 'confirmSync';
	tableIds: string[];
}

// Reply to DiagramSyncOrphansMessage: Cancel on the Keep/Remove dialog - backs out of the WHOLE sync
// (not just the orphan handling), so nothing this sync would have updated lands either. Clears the
// host's pending resolve for this panel (see DiagramEditorProvider.pendingSyncByPanel).
export interface CancelSyncMessage {
	command: 'cancelSync';
}

// "Rearrange Tables" from the diagram's own menu. Carries nothing, same as SyncDiagramMessage - the whole
// diagram is already in the document, nothing to resolve first (unlike Sync, this never needs a
// connection at all). See rearrangeTables in diagram-add-tables.ts.
export interface RearrangeTablesMessage {
	command: 'rearrangeTables';
}

export type DiagramOutboundMessage = LoadDiagramSqlImportMessage | SaveDiagramSqlImportMessage | RefreshDiagramSqlImportMessage | LoadDiagramSqlImportConnectionsMessage | RunDiagramSqlImportMessage | ImportDiagramSqlSchemaMessage | DiscardDiagramSqlImportRunMessage | LoadDiagramImportsMessage | ApplyDiagramImportsMessage | MoveTableMessage | MoveTablesMessage | TableClickedMessage | ResizeSchemaMessage | MoveSchemaMessage | RemoveTableMessage | RemoveTablesMessage | RemoveSchemaMessage | OpenSchemaForTableMessage | ConnectToDatabaseMessage | AddTablesMessage | DiagramReadyMessage | UpdateDiagramSchemaListMessage | ImportDiagramSchemaMessage | ImportDiagramSchemaFromTextMessage | ExportDiagramMessage | ExportTablesMessage | SyncDiagramMessage | ConfirmSyncMessage | CancelSyncMessage | RearrangeTablesMessage | DisableImportedTableDataMessage | EnableImportedTableDataMessage | ConfirmImportRemovalMessage | CancelImportRemovalMessage;
