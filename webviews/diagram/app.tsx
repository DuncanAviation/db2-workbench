import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, MouseEvent as ReactMouseEvent } from 'react';
// Box only (not Stack/Typography) - see the comment in table-node.tsx for why.
import { Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, IconButton, InputBase, Menu, MenuItem, Tooltip } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';
import MenuIcon from '@mui/icons-material/Menu';
import { Background, Panel, ReactFlow, useEdgesState, useNodesState } from '@xyflow/react';
import type { Edge, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './diagram.css';
import type { DiagramExportFormat, DiagramInboundMessage, DiagramModel, DiagramRelationship, DiagramSchemaGroup, DiagramSyncOrphan, DiagramSyncResultTable, DiagramTreeTable, MissingRelationshipTarget, MissingTargetTable } from '../../src/webview-messages/diagram-messages';
import { columnDisplayName } from '../../src/diagram/diagram-column-labels';
import type { ForeignKeyTarget } from '../../src/diagram/diagram-column-labels';
import type { SchemaImportReport, SchemaImportSummary, SchemasSchemaListEntry, SaveSqlImportRequest, SqlImportConnectionTarget, SqlImportMappings, SqlImportRunResult, SqlImportStatementInput } from '../../src/webview-messages/schemas-messages';
import type { DbErrorUtils } from '../../src/utils/db-error-utils';
import type { SchemaFormatId } from '../../src/schema-conversion/schema-format-converter';
import type { SchemaImportErrorUtils } from '../../src/utils/schema-import-error-utils';
import type { ExportDestination } from '../../src/utils/export-utils';
import { cardinalitiesByRelationshipId } from '../../src/diagram/diagram-cardinality';
import { columnKey, columnNamesForTable, relatedColumnKeys as computeRelatedColumnKeys } from '../../src/diagram/diagram-column-selection';
import { chooseEdgeHandles } from '../../src/diagram/diagram-edge-routing';
import { columnMatchesFilter, tableMatchesFilter, tableNameMatchesFilter } from '../../src/diagram/diagram-filter';
import { schemaLinks } from '../../src/diagram/diagram-schema-links';
import { tierForZoom } from '../../src/diagram/diagram-zoom-tiers';
import type { DiagramZoomTier } from '../../src/diagram/diagram-zoom-tiers';
import { getInitialState } from './initial-state';
import { diagramVsCodeApi } from './vscode-api';
import { HIGHLIGHT_COLOR, SCHEMA_LINK_COLOR } from './diagram-colors';
import { DiagramControls } from './components/diagram-controls';
import { ExportTablesDialog } from '../shared/components/export-tables-dialog';
import { FitViewOnAdd } from './components/fit-view-on-add';
import { SCHEMA_CENTER_SOURCE_ID, SCHEMA_CENTER_TARGET_ID, SCHEMA_DRAG_HANDLE_CLASS, schemaCenterHandles, SchemaGroupNode } from './components/schema-group-node';
import type { SchemaGroupNodeData } from './components/schema-group-node';
import { cardinalityMarkerId, RelationshipMarkers } from './components/relationship-markers';
import { SchemaOverviewMap } from './components/schema-overview-map';
import { SyncSummaryDialog } from './components/sync-summary-dialog';
import { AddMissingTargetsDialog } from './components/add-missing-targets-dialog';
import { ContextMenu } from '../shared/components/context-menu';
import { EditSchemaListDialog } from '../shared/components/edit-schema-list-dialog';
import { ImportErrorDialog } from '../shared/components/import-error-dialog';
import { KeepRemoveDialog } from '../shared/components/keep-remove-dialog';
import { ImportSchemaDialog } from '../shared/components/import-schema-dialog';
import { EditSqlImportDialog, linkedConnectionIdsFor } from '../shared/components/edit-sql-import-dialog';
import type { SqlImportConfig } from '../../src/models/sql-import-config';
import { ImportSummaryDialog } from '../shared/components/import-summary-dialog';
import { ViewImportsDialog } from '../shared/components/view-imports-dialog';
import { SchemaTree, TABLE_ROW_DRAG_MIME_TYPE } from '../shared/components/schema-tree';
import { tableKeyFromString } from '../shared/table-key';
import { TABLE_DRAG_HANDLE_CLASS, TableNode, tableMiddleHandles, tableNodeHandles } from './components/table-node';
import type { TableNodeData } from './components/table-node';
import { tableHeight, TABLE_WIDTH } from './layout-constants';

const nodeTypes = { schemaGroup: SchemaGroupNode, table: TableNode };

function buildNodes(model: DiagramModel, tableCountsBySchemaId: Map<string, number>): Node[] {
	let schemaNodes: Node<SchemaGroupNodeData>[] = model.schemas.map(schema => ({
		id: schema.id,
		type: 'schemaGroup',
		position: { x: schema.bounds.x, y: schema.bounds.y },
		width: schema.bounds.width,
		height: schema.bounds.height,
		selectable: false,
		zIndex: -1,
		// Restricts whole-box dragging to the title/label element (see SCHEMA_DRAG_HANDLE_CLASS) - without
		// this, React Flow starts a node drag from a mousedown anywhere in the box, which is exactly the
		// "goofy, can't pan a big schema" behavior this was added to fix.
		dragHandle: `.${SCHEMA_DRAG_HANDLE_CLASS}`,
		// React Flow's own stylesheet sets `.react-flow__node { pointer-events: all; }` unconditionally,
		// which silently defeats the pointer-events: none set on the fill boxes inside this node's own
		// component (schema-group-node.tsx) - that inner none only stops OUR content from being a hit-test
		// target, but the wrapper div React Flow renders around it still is one, at the same screen
		// position, so clicks inside the box kept landing on the node instead of falling through to the
		// pane behind it. An inline style here is the only thing that reliably beats that class rule's
		// specificity. The drag-handle label opts back in with its own pointer-events: auto (see
		// SCHEMA_DRAG_HANDLE_CLASS's styling), and diagram.css opts the resize handles back in too - both
		// override this inherited none since they set the property directly on themselves.
		style: { pointerEvents: 'none' },
		// Also a placeholder (see the table nodes' own height/handles comments below) - overwritten every
		// render by displayNodes using the node's own live width/height, so a schema being actively
		// resized keeps its cluster-tier link line anchored to the box's actual current center instead of
		// the last-persisted one.
		handles: schemaCenterHandles(schema.bounds.width, schema.bounds.height),
		// dimmed/onResizeEnd are placeholders, overwritten every render by the displayNodes derivation
		// below - same reasoning as the table nodes' placeholder data just below.
		data: { name: schema.name, color: schema.color, tableCount: tableCountsBySchemaId.get(schema.id) ?? 0, summary: false, dimmed: false, onResizeEnd: NOOP_RESIZE_END }
	}));

	let tableNodes: Node<TableNodeData>[] = model.tables.map(table => {
		// columnLabels is another placeholder here (see the data comment below) - displayNodes supplies the
		// real setting, so a change to it relabels every row without rebuilding the nodes from the model.
		let schema = model.schemas.find(candidate => candidate.id === table.schemaId);
		let relativePosition = schema
			? { x: table.position.x - schema.bounds.x, y: table.position.y - schema.bounds.y }
			: table.position;

		return {
			id: table.id,
			type: 'table',
			parentId: table.schemaId,
			position: relativePosition,
			// Restricts dragging to the header (see TABLE_DRAG_HANDLE_CLASS) - a mousedown anywhere
			// else starts no drag at all, so clicking a column row can't accidentally move the table
			// and swallow the click along with it.
			dragHandle: `.${TABLE_DRAG_HANDLE_CLASS}`,
			width: TABLE_WIDTH,
			height: tableHeight(table.columns.length, !!table.description),
			// Also a placeholder (see height's own comment above) - overwritten every render by
			// displayNodes once the current zoom tier is known, since the right handle geometry depends on
			// whether columns are actually being rendered.
			handles: tableNodeHandles(table),
			// dimmed/highlightedColumns/onColumnClick/missingTargets are placeholders, overwritten every
			// render by the displayNodes derivation below - kept here only so the base TableNodeData shape
			// is complete.
			data: {
				table: table, color: schema?.color ?? '#888888', expanded: false, dimmed: false,
				columnLabels: EMPTY_COLUMN_LABELS,
				highlightedColumns: EMPTY_COLUMN_SET, dimmedColumnNames: EMPTY_COLUMN_SET, onColumnClick: NOOP_COLUMN_CLICK,
				missingTargetsByColumn: EMPTY_MISSING_TARGETS, onAddMissingTarget: NOOP_ADD_MISSING_TARGET,
				foreignKeyTargetsByColumn: EMPTY_FOREIGN_KEY_TARGETS, outgoingRelationshipCount: 0
			}
		};
	});

	return [...schemaNodes, ...tableNodes];
}

// The `kind` discriminant on each edge's `data` is what displayEdges below uses to tell a column-level
// relationship line from a cluster-tier schema-link line apart - they're hidden at opposite tiers, and
// only relationship edges need chooseEdgeHandles' live left/right routing (a schema link's handles are
// fixed, always the box's own center).
interface RelationshipEdgeData {
	kind: 'relationship';
	fromColumn: string;
	toColumn: string;
	fromKey: string;
	toKey: string;
}

interface SchemaLinkEdgeData {
	kind: 'schemaLink';
}

function buildEdges(model: DiagramModel): Edge[] {
	// sourceHandle/targetHandle are deliberately not set here - which side of each table this edge
	// actually anchors to is chosen per render in displayEdges, based on current table positions, not
	// fixed once at model-build time.
	let relationshipEdges: Edge[] = model.relationships.map(relationship => ({
		id: relationship.id,
		source: relationship.fromTable,
		target: relationship.toTable,
		type: 'smoothstep',
		// Not a real interaction (no way to edit or act on a selected line), and React Flow's own
		// stylesheet turns a selected edge gray - clicking one just looked like it broke instead of doing
		// anything, so selection is turned off entirely rather than styled around.
		selectable: false,
		// Carried through so displayEdges can build the right handle ids and tell whether this specific
		// relationship touches the current column selection, without re-parsing either back out of a
		// composite key or a handle id.
		data: {
			kind: 'relationship',
			fromColumn: relationship.fromColumn,
			toColumn: relationship.toColumn,
			fromKey: columnKey(relationship.fromTable, relationship.fromColumn),
			toKey: columnKey(relationship.toTable, relationship.toColumn)
		} satisfies RelationshipEdgeData
	}));

	// One per distinct pair of schemas with at least one relationship crossing between them (see
	// diagram-schema-links.ts) - only ever shown at the cluster tier, once individual tables and their
	// own relationship lines are hidden, so there's still some visual indication two schemas are related.
	let schemaLinkEdges: Edge[] = schemaLinks(model).map(link => ({
		id: `schema-link-${link.id}`,
		source: link.schemaA,
		target: link.schemaB,
		sourceHandle: SCHEMA_CENTER_SOURCE_ID,
		targetHandle: SCHEMA_CENTER_TARGET_ID,
		type: 'straight',
		selectable: false,
		data: { kind: 'schemaLink' } satisfies SchemaLinkEdgeData
	}));

	return [...relationshipEdges, ...schemaLinkEdges];
}

// Every table's current absolute x position, read live off the React Flow node state (not the possibly-
// stale model) - a table's own position is stored relative to its parent schema group, so this resolves
// each one against its schema's current position, live during a drag rather than only after it's
// persisted back through the host.
function tableAbsoluteXById(nodes: Node[]): Map<string, number> {
	let schemaXById = new Map(nodes.filter(node => node.type === 'schemaGroup').map(node => [node.id, node.position.x]));

	return new Map(
		nodes
			.filter(node => node.type === 'table')
			.map(node => [node.id, (schemaXById.get(node.parentId ?? '') ?? 0) + node.position.x])
	);
}

const EMPTY_COLUMN_SET: ReadonlySet<string> = new Set();
const EMPTY_COLUMN_LABELS: readonly string[] = [];
const NOOP_COLUMN_CLICK = () => { };
const NOOP_RESIZE_END = () => { };
const NOOP_ADD_MISSING_TARGET = () => { };
const EMPTY_MISSING_TARGETS: ReadonlyMap<string, MissingRelationshipTarget> = new Map();
const EMPTY_FOREIGN_KEY_TARGETS: ReadonlyMap<string, ForeignKeyTarget[]> = new Map();
const EMPTY_RELATIONSHIPS: readonly DiagramRelationship[] = [];

export function App() {
	let initialState = getInitialState();
	let [model, setModel] = useState<DiagramModel>(initialState.model);
	// Only tracks which threshold band the current zoom falls into (not the raw zoom value) - a node
	// re-render pass only needs to happen when the tier actually changes, not on every frame of a zoom
	// gesture. Starts at 'cluster' since a freshly-opened diagram's fitView often lands there anyway
	// (many tables spread wide means a small initial zoom) - handleInit corrects it immediately either way.
	let [tier, setTier] = useState<DiagramZoomTier>('cluster');
	// `${tableId}.${columnName}` of the currently-selected column, or null. A column click toggles this;
	// clicking the pane background, or a different column, clears/replaces it.
	let [selectedColumnKey, setSelectedColumnKey] = useState<string | null>(null);
	// Raw text from the top-center filter field - kept separate from the derived match/dim state below so
	// the input itself never re-renders on anything but its own keystrokes.
	let [filterText, setFilterText] = useState('');
	// Name of the connection this diagram is currently pointed at, or undefined when it isn't connected.
	// Seeded from the initial state (so a second editor opened on an already-connected document doesn't
	// claim to be disconnected) and replaced by the host's connectionChanged message after every attempt.
	// Nothing about the connection is persisted in the file - a reopened diagram always starts disconnected.
	let [connectionName, setConnectionName] = useState<string | undefined>(initialState.connectionName);
	let [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
	// "Export..." from the same menu - works whether or not the diagram is connected (see
	// ExportTablesDialog below), so it's not gated behind connectionName the way the picker is.
	let [exportDialogOpen, setExportDialogOpen] = useState(false);
	// "Export..." from a table's own right-click menu - the same ExportTablesDialog, pinned to these table
	// ids (the right-clicked table, or the whole multi-selection it was part of) instead of the whole
	// diagram. null while closed; whichever of this and exportDialogOpen is set decides what the dialog's
	// `open`/`title`/`hasFilter` props resolve to below.
	let [exportTableIds, setExportTableIds] = useState<string[] | null>(null);
	// "Sync with Database" from the same menu - null means no Keep/Remove confirmation is showing. Set
	// from a syncOrphansFound push, which only arrives when the host's resolve found at least one table
	// that no longer resolves against either the database or a current import; a sync with no orphans
	// applies straight through on the host side with no round trip through this state at all.
	let [syncOrphans, setSyncOrphans] = useState<DiagramSyncOrphan[] | null>(null);
	// The post-sync summary dialog - null means it isn't showing. Only ever set from a syncSummary push,
	// which only arrives once Sync's edit actually changed something (see DiagramEditorProvider.applySync);
	// a genuine no-op reports through the host's own toast instead, never through this.
	let [syncSummary, setSyncSummary] = useState<DiagramSyncResultTable[] | null>(null);
	// True while a connect attempt is in flight, which replaces the menu button with a spinner so a second
	// attempt can't be started on top of the first (the host would tear down the half-open connection under
	// it). Seeded from the initial state because the attempt can predate the webview: "New Diagram" from a
	// connection's context menu is already connecting by the time this mounts. Every attempt, successful or
	// not, ends in a connectionChanged message, which is what clears this.
	let [connecting, setConnecting] = useState(!!initialState.connecting);
	// db2-workbench.resultHeadingLabels - which name form each column row is labelled with. Seeded from
	// the initial state and replaced by a columnLabelsChanged push, so changing the setting relabels an
	// open diagram rather than needing it reopened.
	let [columnLabels, setColumnLabels] = useState<string[]>(initialState.columnLabels);
	// The connection's tables, for the left-hand picker. Undefined means "not fetched yet" (either not
	// connected at all, or the fetch is still in flight), which is a different state from an empty object
	// meaning "connected, and this connection genuinely has no tables" - the tree's empty message differs.
	let [treeTablesBySchema, setTreeTablesBySchema] = useState<Record<string, DiagramTreeTable[]> | undefined>(undefined);
	// The tables with at least one switched-off import, pushed alongside the tree - what gates "Enable
	// Imported Changes" on a node. Session state held per connection host-side, so it can't come off the
	// saved model: a node whose every import is switched off stays on the canvas looking like any other.
	let [disabledImportTables, setDisabledImportTables] = useState<{ schema: string; table: string }[]>([]);
	// The picker's own filter, entirely separate from the canvas filter field at top-center - one narrows
	// what you could add, the other dims what is already on the diagram.
	let [treeFilterText, setTreeFilterText] = useState('');
	// tableKeyToString values of the tables selected for adding, held here rather than inside the tree
	// so the count footer and the Add action can both read it. The tree owns the *interaction* (which
	// modifier does what, where a shift range runs to) and hands back the resulting set.
	let [selectedTableKeys, setSelectedTableKeys] = useState<ReadonlySet<string>>(() => new Set());
	// Whether a table-row drag (see schema-tree.tsx's TABLE_ROW_DRAG_MIME_TYPE) is currently over the
	// canvas - shows the single drop-target overlay below. A ref rather than relying on dragenter/dragleave
	// alone: those fire (and bubble) once per DOM element the pointer crosses while dragging - React Flow's
	// canvas has plenty of them (nodes, edges, the background pattern) - so a plain boolean flipped straight
	// from those events would flicker on/off as the drag passes over each one. Counting enters against
	// leaves and only clearing at zero is the standard fix.
	let dragOverCount = useRef(0);
	let [isDraggingTablesOver, setIsDraggingTablesOver] = useState(false);
	// What the "Edit Schema List" dialog edits, pushed alongside the tables themselves. Every schema the
	// connection knows about, including ones the user hid or added by hand and ones that exist only
	// because something was imported into them.
	let [schemaList, setSchemaList] = useState<SchemasSchemaListEntry[]>([]);
	let [editSchemaListDialogOpen, setEditSchemaListDialogOpen] = useState(false);
	let [importSchemaDialogOpen, setImportSchemaDialogOpen] = useState(false);
	// Set from an importSchemaError push - null means no error dialog is showing. Carries the text that
	// failed to parse alongside the problems, so each one can be shown against its own source line.
	let [importError, setImportError] = useState<{ error: SchemaImportErrorUtils.SerializedImportError; content: string } | null>(null);
	// The SQL import's state, same as the schema browser's: the run being mapped, a failed import attempt,
	// and whether a run/import is in flight. All arrive as messages, so none of it can live in the dialog.
	let [sqlRunResult, setSqlRunResult] = useState<SqlImportRunResult | undefined>(undefined);
	let [sqlImportConnections, setSqlImportConnections] = useState<SqlImportConnectionTarget[] | null>(null);
	// undefined = no editor open. null = open, entry still loading. A config = open on that entry.
	let [editingSqlImport, setEditingSqlImport] = useState<SqlImportConfig | null | undefined>(undefined);
	let [editSqlImportOpen, setEditSqlImportOpen] = useState(false);
	let [sqlImportSaveError, setSqlImportSaveError] = useState<string | undefined>(undefined);
	let [sqlImportError, setSqlImportError] = useState<DbErrorUtils.SerializedError | undefined>(undefined);
	let [sqlImportBusy, setSqlImportBusy] = useState(false);
	// Shown after any import lands, whatever it came from - see ImportSummaryDialog.
	let [importReport, setImportReport] = useState<SchemaImportReport | null>(null);
	// Foreign keys on the diagram whose referenced table isn't - pushed by the host (the model only
	// records the relationships that were actually drawn, so this can't be derived here). Always empty
	// while disconnected, since bringing a table in needs a connection.
	let [missingTargets, setMissingTargets] = useState<MissingRelationshipTarget[]>([]);
	// The marker whose targets the user is picking from, or null when no picker is open - only ever set
	// for a column pointing at more than one absent table (see handleAddMissingTarget).
	let [missingTargetChoice, setMissingTargetChoice] = useState<MissingRelationshipTarget | null>(null);
	// Right-click "Remove" on a table or a schema's header - null means the menu is closed. `kind`
	// disambiguates which host message the single "Remove" item sends (removeTable/removeTables vs
	// removeSchema), since both node types share this one context menu rather than each declaring its
	// own. `ids` is always one schema id for kind 'schema'; for kind 'table' it's every table the action
	// applies to - one table, or the whole multi-selection when the right-click landed inside it (see
	// handleNodeContextMenu).
	let [nodeContextMenu, setNodeContextMenu] = useState<{ mouseX: number; mouseY: number; kind: 'table' | 'schema'; ids: string[] } | null>(null);
	// Snapshot of the table ids awaiting a "Remove N Tables?" confirmation - null means the dialog is
	// closed. Only used for 2+ tables; removing a single table (from the menu, or a batch of one) never
	// prompts, matching the plain single-table Remove's existing no-confirmation behavior.
	let [removeTablesConfirm, setRemoveTablesConfirm] = useState<string[] | null>(null);
	// The tables an import removal would leave with no source at all - null means no prompt is showing. Set
	// from an importRemovalOrphanFound push, which only lists tables the host found in no connected schema;
	// a table backed by real DB2 data just reverts, with nothing to ask. A list because removing a whole
	// import (see the View Imports dialog) can strand several at once. Nothing has been discarded while
	// this is set - the reply is what decides whether anything happens.
	let [importRemovalOrphans, setImportRemovalOrphans] = useState<DiagramSyncOrphan[] | null>(null);
	// The View Imports dialog and the list it shows - `null` is "asked, still waiting", as opposed to an
	// empty array, which is a real "nothing imported". Fetched on open, never from initial state, since it
	// changes with every import or removal made from either this diagram or a schema browser.
	let [viewImportsDialogOpen, setViewImportsDialogOpen] = useState(false);
	let [imports, setImports] = useState<SchemaImportSummary[] | null>(null);

	// Resolves a foreign key's target column back to its own DiagramColumn, so its tooltip can show the
	// SAME name form the target table's own rows are labelled with (columnDisplayName/resultHeadingLabels),
	// not the raw identity `relationship.toColumn` happens to be stored as.
	let tableById = useMemo(() => new Map(model.tables.map(table => [table.id, table])), [model.tables]);

	let tableCountsBySchemaId = useMemo(() => {
		let counts = new Map<string, number>();

		for(let table of model.tables) {
			counts.set(table.schemaId, (counts.get(table.schemaId) ?? 0) + 1);
		}

		return counts;
	}, [model.tables]);

	let initialNodes = useMemo(() => buildNodes(model, tableCountsBySchemaId), [model, tableCountsBySchemaId]);
	let initialEdges = useMemo(() => buildEdges(model), [model]);

	let [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
	let [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

	// The extension host pushes a fresh model on every change (a local edit, an undo/redo, a revert) so
	// every open webview for the same document - not just the one that made the edit - stays in sync.
	useEffect(() => {
		function onMessage(event: MessageEvent<DiagramInboundMessage>) {
			if(event.data.command === 'modelUpdated') {
				setModel(event.data.model);
			} else if(event.data.command === 'connectionChanged') {
				// Absent connectionName means the connection couldn't be opened, which puts this back to
				// "Not connected" rather than leaving a stale name up.
				setConnecting(false);
				setConnectionName(event.data.connectionName);
				// Whatever was in the picker belonged to the previous connection - clearing both the tables and
				// the selection avoids offering tables from one database while connected to another, which would
				// otherwise be possible after switching via "Change Connection". Only ever reached when the
				// connection really was re-resolved; a cancelled attempt arrives as connectAborted instead and
				// leaves all of this alone.
				setTreeTablesBySchema(undefined);
				setSelectedTableKeys(new Set());
				setSchemaList([]);
			} else if(event.data.command === 'connectAborted') {
				// Nothing changed host-side (cancelled quick-pick) - end the spinner and leave the connection,
				// its loaded tables and the current selection exactly as they were.
				setConnecting(false);
			} else if(event.data.command === 'schemaTablesLoaded') {
				setTreeTablesBySchema(event.data.tablesBySchema);
				setSchemaList(event.data.schemaList);
				setDisabledImportTables(event.data.disabledImportTables ?? []);
			} else if(event.data.command === 'columnLabelsChanged') {
				setColumnLabels(event.data.columnLabels);
			} else if(event.data.command === 'importSchemaError') {
				setImportError({ error: event.data.error, content: event.data.content });
			} else if(event.data.command === 'importSchemaSummary') {
				setImportReport(event.data.report);
			} else if(event.data.command === 'sqlImportRunResult') {
				setSqlImportBusy(false);
				setSqlRunResult(event.data.result);
			} else if(event.data.command === 'sqlImportResult') {
				setSqlImportBusy(false);

				if(event.data.result.kind === 'imported') {
					setImportSchemaDialogOpen(false);
					setSqlRunResult(undefined);
					setImportReport(event.data.result.report);
				} else {
					setSqlImportError(event.data.result.error);
				}
			} else if(event.data.command === 'missingTargetsLoaded') {
				setMissingTargets(event.data.targets);
			} else if(event.data.command === 'importRemovalOrphanFound') {
				setImportRemovalOrphans(event.data.orphans);
			} else if(event.data.command === 'openSqlImportEditor') {
				handleEditSqlImport(event.data.importId);
			} else if(event.data.command === 'sqlImportLoaded') {
				setEditingSqlImport(event.data.config);
			} else if(event.data.command === 'sqlImportSaved') {
				setSqlImportBusy(false);

				if(event.data.saved) {
					handleCloseEditSqlImport();
				} else {
					setSqlImportSaveError(event.data.message);
				}
			} else if(event.data.command === 'sqlImportConnectionsLoaded') {
				setSqlImportConnections(event.data.connections);
			} else if(event.data.command === 'importsLoaded') {
				setImports(event.data.imports);
			} else if(event.data.command === 'syncOrphansFound') {
				setSyncOrphans(event.data.orphans);
			} else if(event.data.command === 'syncSummary') {
				setSyncSummary(event.data.tables);
			}
		}

		window.addEventListener('message', onMessage);
		// Announced only once the listener above is actually attached, which is the whole point: the host
		// may have a connection waiting for this diagram ("New Diagram" from a connection's context
		// menu), and anything it posted before now would have been dropped rather than queued.
		diagramVsCodeApi.postMessage({ command: 'ready' });

		return () => window.removeEventListener('message', onMessage);
		// See the schema browser's copy of this listener - the handlers are stable, and re-subscribing on
		// every render would tear down and rebuild it for nothing.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		// React Flow's multi-select (ctrl+click) is purely local node state, not anything the model stores -
		// so a wholesale rebuild from the model (a fresh set of node objects, none of them marked selected)
		// would otherwise silently clear the user's selection on every edit, including the very drag that
		// just moved the selected tables. Carrying forward whichever ids were selected in the PREVIOUS node
		// list keeps the selection (and its marching-ants highlight, see table-node.tsx) across the rebuild.
		setNodes(previousNodes => {
			let selectedIds = new Set(previousNodes.filter(node => node.selected).map(node => node.id));
			return buildNodes(model, tableCountsBySchemaId).map(node => selectedIds.has(node.id) ? { ...node, selected: true } : node);
		});

		setEdges(buildEdges(model));
	}, [model, tableCountsBySchemaId, setNodes, setEdges]);

	// There is deliberately NO useNodesInitialized()-gated updateNodeInternals() nudge here any more, and
	// adding one back would be a bug rather than a safety net. Two reasons, both verified against the
	// @xyflow internals:
	//
	// 1. It would gate on nothing. useNodesInitialized() is true once every non-hidden node has a defined
	//    `measured`, and displayNodes below now declares `measured` on every node itself (see the schema
	//    group's and the table's own comments there), so it is true from the first render. An earlier
	//    version of this file carried exactly that effect back when nothing declared `measured`.
	// 2. It wouldn't be a fix for anything. updateNodeInternals() re-reads handle positions from the DOM
	//    (getHandleBounds) and overwrites the declarative bounds with them. React Flow's own
	//    ResizeObserver already does that whenever it fires for a node, so the DOM <Handle> elements in
	//    table-node.tsx are placed to measure exactly what tableNodeHandles declares (see HANDLE_STYLE) -
	//    before that, a re-measure moved every line up to a unit off its row. The declarative geometry is
	//    still the source of truth; the DOM copy only has to agree with it.
	//
	// Nothing needs nudging anyway: adoptUserNodes re-parses node.handles on every nodes change, and
	// displayNodes below hands React Flow a fresh object every render, so a changed handle declaration is
	// picked up on the same render it changes.

	let schemaById = useMemo(() => new Map<string, DiagramSchemaGroup>(model.schemas.map(schema => [schema.id, schema])), [model.schemas]);

	// Blank filter text means "nothing is filtered" - every consumer below treats that as "don't dim
	// anything" rather than computing (and then ignoring) a match for every table on every render.
	let hasFilter = filterText.trim().length > 0;

	// Whether each table matches the current filter text (see diagram-filter.ts for what "matches" means)
	// - computed once per filter/model change rather than inline per node, since displayEdges below also
	// needs it (a relationship dims when neither of its two tables matches).
	let filterMatchByTableId = useMemo(() => {
		let matches = new Map<string, boolean>();

		for(let table of model.tables) {
			let schemaName = schemaById.get(table.schemaId)?.name ?? '';
			matches.set(table.id, tableMatchesFilter(table, schemaName, filterText));
		}

		return matches;
	}, [model.tables, schemaById, filterText]);

	// Whether at least one of a schema's own tables matches the current filter - a schema with no matches
	// at all (including one with no tables) dims along with them, so a fully-filtered-out schema doesn't
	// sit at full visual weight next to ones that actually have something matching inside.
	let schemaHasMatchById = useMemo(() => {
		let hasMatch = new Map<string, boolean>(model.schemas.map(schema => [schema.id, false]));

		for(let table of model.tables) {
			if(filterMatchByTableId.get(table.id)) {
				hasMatch.set(table.schemaId, true);
			}
		}

		return hasMatch;
	}, [model.schemas, model.tables, filterMatchByTableId]);

	// Per-table set of column names to dim, for the case where the filter matches one or more columns but
	// not the table itself (name/schema/description) - the table stays at full weight (it's relevant, the
	// filter did match something in it) but only the matching columns should read as the reason why, so
	// every other column dims same as a non-matching table would. A table that matches by name (or doesn't
	// match at all) gets no entry here - every column renders the same as before, either all normal or all
	// dimmed by the whole-table `dimmed` flag.
	let dimmedColumnNamesByTableId = useMemo(() => {
		let result = new Map<string, ReadonlySet<string>>();

		if(!hasFilter) {
			return result;
		}

		for(let table of model.tables) {
			let schemaName = schemaById.get(table.schemaId)?.name ?? '';

			if(tableNameMatchesFilter(table, schemaName, filterText) || !filterMatchByTableId.get(table.id)) {
				continue;
			}

			let nonMatching = table.columns.filter(column => !columnMatchesFilter(column, filterText)).map(column => column.name);

			if(nonMatching.length > 0) {
				result.set(table.id, new Set(nonMatching));
			}
		}

		return result;
	}, [model.tables, schemaById, filterText, hasFilter, filterMatchByTableId]);

	// Which end of each relationship gets a crow's foot and which gets a single bar (see
	// diagram-cardinality.ts) - derived from the model rather than the React Flow node state, since it
	// depends only on the columns' key flags and so can't change during a drag or a zoom.
	let cardinalityByRelationshipId = useMemo(() => cardinalitiesByRelationshipId(model), [model]);

	// Every column key connected to the current selection (plus the selection itself) - null means
	// nothing is selected, which every consumer below treats as "don't dim/highlight anything".
	let relatedColumnKeys = useMemo(() => computeRelatedColumnKeys(model.relationships, selectedColumnKey), [selectedColumnKey, model.relationships]);

	// The host owns the whole choose-a-connection flow (quick-pick, password, progress notification) -
	// this just asks for it, and waits for the connectionChanged message to come back. Doubles as
	// "switch connection" once connected, which is why the menu item's label changes rather than being
	// disabled after the first connect.
	let handleConnectToDatabase = useCallback(() => {
		setMenuAnchor(null);
		setConnecting(true);
		diagramVsCodeApi.postMessage({ command: 'connectToDatabase' });
	}, []);

	// Backs ExportTablesDialog for BOTH its callers (the diagram's own "Export..." and a table's own,
	// which sets exportTableIds - see handleOpenExportTables) - exportTableIds set means this export is
	// pinned to that exact table selection, so it posts exportTables (tableIds, no scope/filterText)
	// instead; `scope` is always 'all' in that case since the JSX below passes `hasFilter={undefined}`
	// whenever exportTableIds is set, which hides the dialog's Scope step entirely. Otherwise the host does
	// the actual filtering (filterDiagramModel, the same rule set tableMatchesFilter already applies on the
	// canvas) and serialization - filterText
	// rides along unconditionally, ignored by the host when scope is "all". Neither path gets a reply
	// message, same convention as exportSchema: the host resolves via a native Save dialog and a toast.
	let handleExport = useCallback((format: DiagramExportFormat, scope: 'all' | 'filtered', destination: ExportDestination) => {
		if(exportTableIds) {
			let tableIds = exportTableIds;
			setExportTableIds(null);
			diagramVsCodeApi.postMessage({ command: 'exportTables', tableIds: tableIds, format: format, destination: destination });
			return;
		}

		setExportDialogOpen(false);
		diagramVsCodeApi.postMessage({ command: 'exportDiagram', format: format, scope: scope, filterText: filterText, destination: destination });
	}, [exportTableIds, filterText]);

	let handleOpenExportDialog = useCallback(() => {
		setMenuAnchor(null);
		setExportDialogOpen(true);
	}, []);

	// The host does the whole resolve (and, if disconnected, the connect prompt first - same as "Open
	// Schema"). Nothing to seed here: a sync that finds nothing needing confirmation just applies and
	// reports a toast without ever touching syncOrphans.
	let handleSyncWithDatabase = useCallback(() => {
		setMenuAnchor(null);
		diagramVsCodeApi.postMessage({ command: 'syncDiagram' });
	}, []);

	let handleConfirmSync = useCallback((removeTableIds: string[]) => {
		setSyncOrphans(null);
		diagramVsCodeApi.postMessage({ command: 'confirmSync', tableIds: removeTableIds });
	}, []);

	let handleCancelSync = useCallback(() => {
		setSyncOrphans(null);
		diagramVsCodeApi.postMessage({ command: 'cancelSync' });
	}, []);

	// The host relays out every table already on the diagram (see rearrangeTables in
	// diagram-add-tables.ts) and pushes the updated model back through the same onDidChangeDocument /
	// initial-state refresh path every other edit already uses - nothing extra to do here.
	let handleRearrangeTables = useCallback(() => {
		setMenuAnchor(null);
		diagramVsCodeApi.postMessage({ command: 'rearrangeTables' });
	}, []);

	// The host does all the real work here: three catalog lookups per table, then one undoable edit for
	// the whole batch (see DiagramEditorProvider.handleAddTables). The webview doesn't send the columns
	// or descriptions it already has in the picker - a webview isn't a trusted source of catalog data,
	// and the host has them cached anyway.
	let handleAddTablesToDiagram = useCallback((keys: ReadonlySet<string>) => {
		diagramVsCodeApi.postMessage({
			command: 'addTables',
			tables: [...keys].map(key => tableKeyFromString(key))
		});
	}, []);

	// Dropping a table-row drag onto the canvas is deliberately just another way to trigger the exact same
	// "Add N Tables to Diagram" action as the tree's own right-click menu - the drop point itself carries no
	// meaning, so there's no coordinate translation here at all, just reading back the keys the drag started
	// with. Every handler below first checks dataTransfer.types for TABLE_ROW_DRAG_MIME_TYPE so a drag from
	// somewhere else entirely (a file from the OS, editor text) is ignored rather than shown a drop target
	// it can't actually satisfy.
	let isTableRowDrag = useCallback((event: DragEvent) => event.dataTransfer.types.includes(TABLE_ROW_DRAG_MIME_TYPE), []);

	let handleCanvasDragEnter = useCallback((event: DragEvent) => {
		if(!isTableRowDrag(event)) {
			return;
		}

		event.preventDefault();
		dragOverCount.current += 1;
		setIsDraggingTablesOver(true);
	}, [isTableRowDrag]);

	let handleCanvasDragOver = useCallback((event: DragEvent) => {
		if(!isTableRowDrag(event)) {
			return;
		}

		// Required on every dragover, not just dragenter - a browser treats a target as refusing the drop
		// (and shows the "not allowed" cursor) unless this fires continuously while the drag is over it.
		event.preventDefault();
		event.dataTransfer.dropEffect = 'copy';
	}, [isTableRowDrag]);

	let handleCanvasDragLeave = useCallback((event: DragEvent) => {
		if(!isTableRowDrag(event)) {
			return;
		}

		event.preventDefault();
		dragOverCount.current = Math.max(0, dragOverCount.current - 1);

		if(dragOverCount.current === 0) {
			setIsDraggingTablesOver(false);
		}
	}, [isTableRowDrag]);

	let handleCanvasDrop = useCallback((event: DragEvent) => {
		if(!isTableRowDrag(event)) {
			return;
		}

		event.preventDefault();
		dragOverCount.current = 0;
		setIsDraggingTablesOver(false);

		let raw = event.dataTransfer.getData(TABLE_ROW_DRAG_MIME_TYPE);

		if(!raw) {
			return;
		}

		handleAddTablesToDiagram(new Set<string>(JSON.parse(raw)));
	}, [handleAddTablesToDiagram, isTableRowDrag]);

	// Rebuilt per open by the tree so the label can count the rows the right-click actually applies to,
	// which is not always the current selection (right-clicking outside it re-selects that one row).
	let treeContextMenuItems = useCallback((keys: ReadonlySet<string>) => [{
		label: `Add ${keys.size} Table${keys.size === 1 ? '' : 's'} to Diagram`,
		onClick: () => handleAddTablesToDiagram(keys)
	}], [handleAddTablesToDiagram]);

	// This table's own outgoing relationships (it's the fromTable end) - what a table's tooltip counts,
	// and what a column's tooltip names as "foreign key to". Grouped by fromTable so each node gets only
	// its own, the same reasoning as missingTargetsByTableId below.
	let outgoingRelationshipsByTableId = useMemo(() => {
		let grouped = new Map<string, DiagramRelationship[]>();

		for(let relationship of model.relationships) {
			let forTable = grouped.get(relationship.fromTable) ?? [];
			forTable.push(relationship);
			grouped.set(relationship.fromTable, forTable);
		}

		return grouped;
	}, [model.relationships]);

	// Grouped per table so each node gets only its own, keyed by column name - a node would otherwise
	// have to scan the whole diagram's list once per column on every render.
	let missingTargetsByTableId = useMemo(() => {
		let grouped = new Map<string, Map<string, MissingRelationshipTarget>>();

		for(let target of missingTargets) {
			let forTable = grouped.get(target.tableId) ?? new Map<string, MissingRelationshipTarget>();
			forTable.set(target.columnName, target);
			grouped.set(target.tableId, forTable);
		}

		return grouped;
	}, [missingTargets]);

	// Same message the picker's "Add to Diagram" posts. Nothing is cleared optimistically: the host's
	// edit fires a model update, which triggers a fresh missing-targets push, so the marker disappears
	// only once the tables are genuinely on the diagram (and correctly stays put if an add failed
	// because the target no longer exists).
	let addMissingTargetTables = useCallback((targets: readonly MissingTargetTable[]) => {
		diagramVsCodeApi.postMessage({
			command: 'addTables',
			tables: targets.map(target => ({ schema: target.targetSchema, table: target.targetTable }))
		});
	}, []);

	// One absent table is added on the click itself - a dialog offering a single checkbox would only ask
	// the user to confirm the thing they just clicked. Several (two foreign keys leaving the same column)
	// open the picker instead, since there'd otherwise be no way to say which one, or to take more than
	// one.
	let handleAddMissingTarget = useCallback((target: MissingRelationshipTarget) => {
		if(target.targets.length === 1) {
			addMissingTargetTables(target.targets);
			return;
		}

		setMissingTargetChoice(target);
	}, [addMissingTargetTables]);

	let handleAddChosenMissingTargets = useCallback((targets: MissingTargetTable[]) => {
		setMissingTargetChoice(null);
		addMissingTargetTables(targets);
	}, [addMissingTargetTables]);

	let handleColumnClick = useCallback((tableId: string, columnName: string) => {
		let key = columnKey(tableId, columnName);
		setSelectedColumnKey(current => current === key ? null : key);
	}, []);

	// Sent once dragging a resize handle finishes (NodeResizer's own onResizeEnd, not a per-frame
	// callback). The params are already the model's absolute {x, y, width, height} shape - see the
	// comment in schema-group-node.tsx for why a top/left handle drag needs the full rectangle, not just
	// width/height.
	let handleResizeSchema = useCallback((schemaId: string, bounds: { x: number; y: number; width: number; height: number }) => {
		diagramVsCodeApi.postMessage({ command: 'resizeSchema', schemaId: schemaId, bounds: bounds });
	}, []);

	// Derives each node's *visual* state (hidden at the cluster tier, expanded columns, schema summary
	// mode, column selection highlighting) from the underlying nodes on every render - dragging a table
	// only ever changes its position (handled by onNodesChange above), never this derived layer, so drag
	// state and zoom-tier/selection state can't fight each other.
	let displayNodes = useMemo(() => nodes.map(node => {
		if(node.type === 'schemaGroup') {
			return {
				...node,
				// Read live off the node itself (not schema.bounds from the model) so an in-progress resize
				// keeps the cluster-tier link line anchored to the box's actual current center, the same
				// live-during-drag reasoning as tableAbsoluteXById below.
				handles: schemaCenterHandles(node.width ?? 0, node.height ?? 0),
				// Declared explicitly because React Flow will never fill it in for this node, and NodeResizer
				// breaks outright without it. Any node that declares `handles` (this one and every table node)
				// gets a non-undefined internals.handleBounds on its very first adoption, which makes
				// useNodeObserver's `isInitialized` true immediately - so its ResizeObserver never observes the
				// element, the DOM measurement pass never runs, and `measured` stays undefined forever.
				// Harmless nearly everywhere, since React Flow's getNodeDimensions() falls back to
				// width/height - but XYResizer's drag start reads `node.measured.width ?? 0` with NO fallback,
				// so a resize begins from 0x0 and snaps straight to minWidth/minHeight, which is exactly the
				// "box folds into a line" bug. We're already authoritative on this box's size (width/height
				// above are what React Flow applies as the element's own inline style), so stating it here just
				// tells React Flow what it would have measured anyway.
				measured: { width: node.width ?? 0, height: node.height ?? 0 },
				data: {
					...node.data,
					summary: tier === 'cluster',
					dimmed: hasFilter && !(schemaHasMatchById.get(node.id) ?? true),
					onResizeEnd: handleResizeSchema
				}
			};
		}

		let expanded = tier === 'expanded';
		let data = node.data as TableNodeData;

		let highlightedColumns = relatedColumnKeys ? columnNamesForTable(relatedColumnKeys, node.id) : EMPTY_COLUMN_SET;
		// A collapsed table keeps its full expanded footprint now (a solid name block filling the same
		// space columns would occupy - see table-node.tsx - rather than shrinking to just the header), so
		// there's only one height, not one per tier. Neighboring tables' spacing was already laid out
		// assuming this full size (see diagram-add-tables.ts), so this also stops the old collapsed-tier gap
		// between a table's visual box and the room actually reserved for it.
		let fullHeight = tableHeight(data.table.columns.length, !!data.table.description);

		let outgoingRelationships = outgoingRelationshipsByTableId.get(node.id) ?? EMPTY_RELATIONSHIPS;
		// Regrouped by fromColumn per node rather than memoized separately - cheap (at most a handful of
		// relationships per table) and avoids a second Map lookup layer for what's ultimately a small list.
		let foreignKeyTargetsByColumn = new Map<string, ForeignKeyTarget[]>();

		for(let relationship of outgoingRelationships) {
			// relationship.toColumn is the target's IDENTITY, not necessarily what its own row is labelled
			// with - resolve back to the real DiagramColumn so the tooltip reads the same name form the
			// target table's own rows do, whatever the user's resultHeadingLabels setting currently is.
			// Falls back to the raw identity if the target table/column can't be found (shouldn't happen for
			// a relationship that's actually drawn, but a tooltip is exactly the wrong place to throw).
			let targetColumn = tableById.get(relationship.toTable)?.columns.find(column => column.name === relationship.toColumn);
			let toColumn = targetColumn ? columnDisplayName(targetColumn, columnLabels) : relationship.toColumn;

			let targets = foreignKeyTargetsByColumn.get(relationship.fromColumn) ?? [];
			targets.push({toTable: relationship.toTable, toColumn: toColumn});
			foreignKeyTargetsByColumn.set(relationship.fromColumn, targets);
		}

		return {
			...node,
			hidden: tier === 'cluster',
			height: fullHeight,
			// Declared for the same reason as the schema group's `measured` above, but for fitView rather
			// than NodeResizer. fitView() only queues a fit, and React Flow applies it on the next nodes
			// update only once every visible node has a `measured` size - until then it waits for a
			// ResizeObserver measurement instead. That measurement only arrives when a table element mounts
			// or changes size, while every rebuild from the model (each modelUpdated) hands React Flow nodes
			// without `measured`. So after any edit, and for tables that were never scrolled into view
			// (onlyRenderVisibleElements), the Fit view button did nothing until some later zoom happened to
			// remount one. width/height here are what React Flow sets as the element's own inline size, so
			// this is what it would have measured anyway.
			measured: { width: node.width ?? TABLE_WIDTH, height: fullHeight },
			// The per-column handles from tableNodeHandles are positioned assuming every row is showing as
			// its own DOM element (see table-node.tsx's ColumnRow) - only true while expanded. Collapsed
			// falls back to a single table-middle handle instead, now centered on the same full height.
			handles: expanded ? tableNodeHandles(data.table) : tableMiddleHandles(fullHeight),
			data: {
				...data,
				expanded: expanded,
				columnLabels: columnLabels,
				// Column selection no longer dims uninvolved tables - `dimmed` is driven by the filter field
				// instead, the "dim what doesn't match" behavior this was originally modeled on.
				dimmed: hasFilter && !(filterMatchByTableId.get(node.id) ?? true),
				dimmedColumnNames: dimmedColumnNamesByTableId.get(node.id) ?? EMPTY_COLUMN_SET,
				highlightedColumns: highlightedColumns,
				onColumnClick: handleColumnClick,
				missingTargetsByColumn: missingTargetsByTableId.get(node.id) ?? EMPTY_MISSING_TARGETS,
				onAddMissingTarget: handleAddMissingTarget,
				foreignKeyTargetsByColumn: foreignKeyTargetsByColumn,
				outgoingRelationshipCount: outgoingRelationships.length
			}
		};
	}), [nodes, tier, columnLabels, relatedColumnKeys, handleColumnClick, handleResizeSchema, hasFilter, filterMatchByTableId, dimmedColumnNamesByTableId, schemaHasMatchById, missingTargetsByTableId, handleAddMissingTarget, outgoingRelationshipsByTableId, tableById]);

	let displayEdges = useMemo(() => {
		let tableXById = tableAbsoluteXById(nodes);

		return edges.map(edge => {
			let edgeData = edge.data as RelationshipEdgeData | SchemaLinkEdgeData | undefined;

			// The cluster-tier schema link is the mirror image of a column-level relationship: shown only
			// once tables (and their own relationship lines) are hidden, and its handles are fixed to each
			// schema box's own center (schemaCenterHandles) rather than needing chooseEdgeHandles' live
			// left/right routing - there's no "side" to route around, just two boxes.
			if(edgeData?.kind === 'schemaLink') {
				return {
					...edge,
					hidden: tier !== 'cluster',
					// vectorEffect keeps the stroke a constant width in actual screen pixels regardless of
					// zoom - without it, a flow-space strokeWidth shrinks along with everything else as you
					// zoom out, and the cluster tier's own zoom range (0.02-0.15) goes low enough that a
					// couple flow-units renders as a fraction of a screen pixel and all but disappears right
					// when this line is the only thing left to show a relationship exists at all. 2.5px
					// (rather than a hairline 1px) is deliberate too - the portion of the line inside either
					// box (it terminates at each box's own center) reads faintly against the box's own tint
					// no matter what, same as any ER tool's relationship lines; a thin line left almost
					// nothing visible even in the open gap between the two boxes.
					style: { stroke: SCHEMA_LINK_COLOR, strokeWidth: 2.5, vectorEffect: 'non-scaling-stroke' as const }
				};
			}

			let touchesSelection = !!selectedColumnKey && !!edgeData && (edgeData.fromKey === selectedColumnKey || edgeData.toKey === selectedColumnKey);

			// Recomputed every render (including live during a drag, since `nodes` updates immediately)
			// so a relationship always anchors to whichever side of each table is actually closest to the
			// other one, instead of a fixed side that can end up looping around once tables are
			// rearranged - see diagram-edge-routing.ts.
			let handles = edgeData
				? chooseEdgeHandles(edgeData.fromColumn, edgeData.toColumn, tableXById.get(edge.source) ?? 0, tableXById.get(edge.target) ?? 0, tier === 'expanded')
				: undefined;

			// A relationship line dims along with its two tables, but only once NEITHER end matches - a
			// line where one side matches the filter and the other doesn't is exactly the "what does this
			// match connect to" context a filter should keep visible, not hide away.
			let dimmedByFilter = hasFilter
				&& !(filterMatchByTableId.get(edge.source) ?? true)
				&& !(filterMatchByTableId.get(edge.target) ?? true);

			// markerStart is the source (foreign-key) end and markerEnd the target (referenced) end, matching
			// how buildEdges maps a relationship's from/to onto source/target. Defaults cover a relationship
			// whose from table isn't in the model at all - the same 1:N shape every ER diagram assumes when
			// it has nothing more specific to go on.
			let cardinality = cardinalityByRelationshipId.get(edge.id);

			// Only the touching edge is styled - a column selection no longer fades every other
			// relationship line, matching the same call made for tables above.
			return {
				...edge,
				...handles,
				hidden: tier === 'cluster',
				animated: touchesSelection,
				markerStart: cardinalityMarkerId(cardinality?.from ?? 'many', 'start'),
				markerEnd: cardinalityMarkerId(cardinality?.to ?? 'one', 'end'),
				style: {
					stroke: touchesSelection ? HIGHLIGHT_COLOR : undefined,
					strokeWidth: touchesSelection ? 3 : 1,
					opacity: dimmedByFilter ? 0.25 : 1
				}
			};
		});
	}, [edges, nodes, tier, selectedColumnKey, hasFilter, filterMatchByTableId, cardinalityByRelationshipId]);

	let handleInit = useCallback((instance: { getZoom: () => number }) => {
		setTier(tierForZoom(instance.getZoom()));
	}, []);

	let handleMoveEnd = useCallback((_event: unknown, viewport: { zoom: number }) => {
		setTier(current => {
			let next = tierForZoom(viewport.zoom);
			return next === current ? current : next;
		});
	}, []);

	// Only sent once the drag actually finishes (not on every intermediate frame) - React Flow already
	// gives the dropped position relative to the parent schema group, so this just converts it back to
	// the model's absolute coordinates before handing it to the host.
	//
	// `draggedNodes` is EVERY node React Flow actually moved as part of this drag, not just the one the
	// pointer was on - ctrl+click selects several tables first, and dragging any one of them drags the
	// whole selection as a rigid group. React Flow already updated all of their positions in the
	// webview's own node state (that's onNodesChange's job); without reading this third argument, only
	// the one table under the pointer would ever be reported to the host, and every other selected table
	// would revert the moment the host's resulting modelUpdated rebuilds the node list from the (still
	// stale, for them) model.
	let handleNodeDragStop = useCallback((_event: unknown, node: Node, draggedNodes: Node[]) => {
		if(node.type === 'schemaGroup') {
			// A schema group is top-level (no parentId), so its own position is already absolute - unlike
			// a table, no parent-relative conversion needed. Schema groups are never selectable (see
			// buildNodes), so a schema drag is always exactly this one node, never a batch. A separate
			// message from resizeSchema, since a plain move needs to shift every table in the schema along
			// with it, which resizeSchema deliberately does not do - see moveSchema in
			// diagram-model-editor.ts.
			diagramVsCodeApi.postMessage({
				command: 'moveSchema',
				schemaId: node.id,
				position: { x: node.position.x, y: node.position.y }
			});

			return;
		}

		// Every dragged table, converted from its parent-relative position back to the model's absolute
		// coordinates - one table's own drag falls through this same path as a batch of one, so there's
		// only ever one message shape to send from here.
		let tableMoves = draggedNodes
			.filter((candidate): candidate is Node & {parentId: string} => candidate.type === 'table' && !!candidate.parentId)
			.map(table => {
				let schema = schemaById.get(table.parentId);
				return schema ? { tableId: table.id, position: { x: schema.bounds.x + table.position.x, y: schema.bounds.y + table.position.y } } : undefined;
			})
			.filter((move): move is { tableId: string; position: { x: number; y: number } } => !!move);

		if(tableMoves.length === 0) {
			return;
		}

		diagramVsCodeApi.postMessage(
			tableMoves.length === 1
				? { command: 'moveTable', tableId: tableMoves[0].tableId, position: tableMoves[0].position }
				: { command: 'moveTables', tables: tableMoves }
		);
	}, [schemaById]);

	// A column click stops propagation before this ever fires (see table-node.tsx's ColumnRow) - this
	// only ever sees clicks on a table's header/body, which is the "clicked a table" interaction the
	// public onDiagramTableSelected API event exists for, distinct from column selection.
	let handleNodeClick = useCallback((_event: unknown, node: Node) => {
		if(node.type !== 'table') {
			return;
		}

		diagramVsCodeApi.postMessage({ command: 'tableClicked', tableId: node.id });
	}, []);

	let handlePaneClick = useCallback(() => {
		setSelectedColumnKey(null);
	}, []);

	// One context menu for both node types - a schema group only receives this event at all when the
	// right-click lands on its header label (see SCHEMA_DRAG_HANDLE_CLASS's pointer-events comments in
	// schema-group-node.tsx; everywhere else in the box is pointer-events: none and falls through to the
	// pane), which is exactly where the "Remove" option on a schema is meant to live. A table receives it
	// anywhere in its own box, header or column rows alike.
	let handleNodeContextMenu = useCallback((event: ReactMouseEvent, node: Node) => {
		if(node.type !== 'table' && node.type !== 'schemaGroup') {
			return;
		}

		event.preventDefault();

		if(node.type === 'schemaGroup') {
			setNodeContextMenu({ mouseX: event.clientX, mouseY: event.clientY, kind: 'schema', ids: [node.id] });
			return;
		}

		// Right-clicking a table that's part of the current multi-selection (ctrl+click several - see
		// table-node.tsx's marching-ants selected border) acts on the WHOLE selection, the same convention
		// the shared schema tree's own right-click menu follows (see handleTableContextMenu there);
		// right-clicking a table outside the selection replaces the selection with just that one first, so
		// "Remove" never silently acts on rows the user can't see are selected.
		let selectedTableIds = nodes.filter(candidate => candidate.type === 'table' && candidate.selected).map(candidate => candidate.id);
		let isInSelection = selectedTableIds.includes(node.id);
		let ids = isInSelection && selectedTableIds.length > 1 ? selectedTableIds : [node.id];

		if(!isInSelection) {
			setNodes(current => current.map(candidate => ({ ...candidate, selected: candidate.id === node.id })));
		}

		setNodeContextMenu({ mouseX: event.clientX, mouseY: event.clientY, kind: 'table', ids: ids });
	}, [nodes, setNodes]);

	// The single table the "Disable Imported Changes" item applies to, or undefined when the item should not
	// be offered at all: a schema group, a multi-table selection (every one of them would need its own
	// confirmation), a table with no import behind it, or one that's merely 'orphaned' - an orphan has no
	// import left to discard, it's what a table becomes once its import is already gone. Deliberately NOT
	// gated on connectionName: a disconnected diagram still shows Imported/Enhanced badges (they are saved
	// with the file), and the host prompts for a connection on the way through, same as "Open Schema".
	let importedContextMenuTable = useMemo(() => {
		if(!nodeContextMenu || nodeContextMenu.kind !== 'table' || nodeContextMenu.ids.length !== 1) {
			return undefined;
		}

		let table = tableById.get(nodeContextMenu.ids[0]);

		return table?.importStatus === 'imported' || table?.importStatus === 'enhanced' ? table : undefined;
	}, [nodeContextMenu, tableById]);

	// The single table "Enable Imported Changes" applies to, or undefined when the item should not be
	// offered: gated on the host's own list of tables with something switched off, not on importStatus -
	// a node whose every import is disabled shows no badge at all (it resolved against DB2 alone, or kept
	// what the file saved), so the badge can't answer this. Matched on schema group name + table name, the
	// same pairing DiagramEditorProvider.diagramTargetsFor uses on the way back.
	let disabledImportContextMenuTable = useMemo(() => {
		if(!nodeContextMenu || nodeContextMenu.kind !== 'table' || nodeContextMenu.ids.length !== 1) {
			return undefined;
		}

		let table = tableById.get(nodeContextMenu.ids[0]);

		if(!table) {
			return undefined;
		}

		let schemaName = schemaById.get(table.schemaId)?.name ?? table.schemaId;
		let disabled = disabledImportTables.some(entry => entry.schema.toUpperCase() === schemaName.toUpperCase() && entry.table.toUpperCase() === table.name.toUpperCase());

		return disabled ? table : undefined;
	}, [nodeContextMenu, tableById, schemaById, disabledImportTables]);

	// A single table (whether the menu opened on just one, or a "selection" of one) removes immediately,
	// same as before this ever supported a batch. 2+ tables go through the confirm dialog first instead
	// of posting right away - see removeTablesConfirm. The host applies whichever it ends up doing as a
	// single undoable edit (see removeTable/removeTables/removeSchema in diagram-model-editor.ts) and
	// pushes the resulting model back through modelUpdated; nothing is removed optimistically here.
	let handleRemoveNode = useCallback(() => {
		if(!nodeContextMenu) {
			return;
		}

		let { kind, ids } = nodeContextMenu;
		setNodeContextMenu(null);

		if(kind === 'schema') {
			diagramVsCodeApi.postMessage({ command: 'removeSchema', schemaId: ids[0] });
			return;
		}

		if(ids.length > 1) {
			setRemoveTablesConfirm(ids);
			return;
		}

		diagramVsCodeApi.postMessage({ command: 'removeTable', tableId: ids[0] });
	}, [nodeContextMenu]);

	// "Open Schema" - only offered for a single table (see its guard at the menu item below), the same
	// destination F12 "Go to Definition" opens from a SQL editor. The host resolves schema/table name from
	// the model itself (see DiagramEditorProvider.handleOpenSchemaForTable), prompting for a connection
	// first if this diagram isn't connected yet - same as "Connect to Database".
	let handleOpenSchema = useCallback(() => {
		if(!nodeContextMenu || nodeContextMenu.kind !== 'table') {
			return;
		}

		let tableId = nodeContextMenu.ids[0];
		setNodeContextMenu(null);
		diagramVsCodeApi.postMessage({ command: 'openSchemaForTable', tableId: tableId });
	}, [nodeContextMenu]);

	// "Export..." from a table's own right-click menu - opens the shared ExportTablesDialog pinned to
	// whichever table ids the menu is already showing (see handleNodeContextMenu's selection-vs-single-table
	// rule); the actual postMessage happens in handleExport once the dialog's own Format/destination choice
	// comes back.
	let handleOpenExportTables = useCallback(() => {
		if(!nodeContextMenu || nodeContextMenu.kind !== 'table') {
			return;
		}

		setExportTableIds(nodeContextMenu.ids);
		setNodeContextMenu(null);
	}, [nodeContextMenu]);

	// "Disable Imported Changes" - the same action the schema browser's table tab header offers, and the
	// same host-side call behind it (SchemaTrees.disableImportedTableData), so switching an import off here
	// switches it off there too. No confirmation: it only switches imported data off for this connection,
	// and "Enable Imported Changes" or View Imports switches it straight back on.
	let handleDisableImportedChange = useCallback(() => {
		if(!importedContextMenuTable?.importStatus) {
			return;
		}

		diagramVsCodeApi.postMessage({ command: 'disableImportedTableData', tableId: importedContextMenuTable.id });
		setNodeContextMenu(null);
	}, [importedContextMenuTable]);

	// The host resolves the node against the result and pushes the model back, same as every other edit
	// here.
	let handleEnableImportedChange = useCallback(() => {
		if(!disabledImportContextMenuTable) {
			return;
		}

		diagramVsCodeApi.postMessage({ command: 'enableImportedTableData', tableId: disabledImportContextMenuTable.id });
		setNodeContextMenu(null);
	}, [disabledImportContextMenuTable]);

	// OK on the Keep/Remove prompt the host raises for a table that would be left with no source. Keep
	// (the default) discards only the import and leaves the box flagged 'orphaned'; Remove takes the box
	// off the diagram with it. The host applies whichever comes back - nothing is removed optimistically
	// here, same as every other edit.
	let handleConfirmImportRemoval = useCallback((removeKeys: string[]) => {
		if(!importRemovalOrphans) {
			return;
		}

		diagramVsCodeApi.postMessage({ command: 'confirmImportRemoval', removeTableIds: removeKeys });
		setImportRemovalOrphans(null);
	}, [importRemovalOrphans]);

	// Cancel on the same prompt - the import stays, since the host deliberately asks before discarding
	// anything (unlike Sync's own Keep/Remove dialog, which cancels an already-finished resolve).
	let handleCancelImportRemoval = useCallback(() => {
		diagramVsCodeApi.postMessage({ command: 'cancelImportRemoval' });
		setImportRemovalOrphans(null);
	}, []);

	let handleConfirmRemoveTables = useCallback(() => {
		if(!removeTablesConfirm) {
			return;
		}

		diagramVsCodeApi.postMessage({ command: 'removeTables', tableIds: removeTablesConfirm });
		setRemoveTablesConfirm(null);
	}, [removeTablesConfirm]);

	// The tree's own vertical-dots menu. Both entries are the schema browser's, and deliberately the same
	// features rather than diagram-flavored copies: the host side of both is one shared service (see
	// SchemaTrees), so a schema hidden or a file imported here shows up there too, and vice versa.
	// Always re-fetches rather than reusing whatever the last open left behind - an import (or a removal)
	// could have happened here, on another diagram, or in a schema browser on this connection since then.
	// Declared above treeMenuItems because that memo captures it during render.
	let handleOpenViewImports = useCallback(() => {
		setImports(null);
		setViewImportsDialogOpen(true);
		diagramVsCodeApi.postMessage({ command: 'loadImports' });
	}, []);

	// The dialog stays open and repaints off the host's refreshed list. Tables on this canvas that the
	// change affects are reconciled host-side - reverted, flagged as orphans, or (after the Keep/Remove
	// prompt) taken off the diagram - so nothing is applied optimistically here.
	let handleApplyImports = useCallback((change: ViewImportsDialog.Change) => {
		diagramVsCodeApi.postMessage({
			command: 'applyImports',
			disable: change.disable,
			enable: change.enable,
			unlinkImportIds: change.unlinkImportIds,
			deleteImportIds: change.deleteImportIds
		});
	}, []);

	let treeMenuItems = useMemo(() => [
		{ label: 'Edit Schema List', onClick: () => setEditSchemaListDialogOpen(true) },
		{ label: 'Import', onClick: () => setImportSchemaDialogOpen(true) },
		{ label: 'View Imports', onClick: handleOpenViewImports }
	], [handleOpenViewImports]);

	// All three of these close optimistically rather than waiting for the host's reply, the same
	// convention the schema browser's copies of these dialogs follow: the result comes back as a
	// schemaTablesLoaded push (a rebuilt tree) or an importSchemaError push, not as a direct response.
	let handleUpdateSchemaList = useCallback((result: { hiddenSchemas: string[]; newSchemas: string[]; deletedSchemas: string[] }) => {
		setEditSchemaListDialogOpen(false);
		// Anything selected may have just been hidden or deleted out from under the selection - dropping it
		// beats holding keys the tree no longer shows, which "Add N Tables to Diagram" would still act on.
		setSelectedTableKeys(new Set());
		diagramVsCodeApi.postMessage({ command: 'updateSchemaList', ...result });
	}, []);

	let handleImportFile = useCallback(() => {
		setImportSchemaDialogOpen(false);
		diagramVsCodeApi.postMessage({ command: 'importSchema' });
	}, []);

	let handleImportText = useCallback((format: SchemaFormatId, content: string) => {
		setImportSchemaDialogOpen(false);
		diagramVsCodeApi.postMessage({ command: 'importSchemaFromText', format: format, content: content });
	}, []);

	// The SQL path keeps the dialog open across both of its steps, so these only mark the request as in
	// flight and wait for the host's reply - unlike the file/paste paths, which close optimistically.
	let handleRunSqlImport = useCallback((statements: SqlImportStatementInput[]) => {
		setSqlImportBusy(true);
		setSqlImportError(undefined);
		diagramVsCodeApi.postMessage({ command: 'runSqlImport', statements: statements });
	}, []);

	let handleImportSql = useCallback((request: { runId: string; name: string; mappings: SqlImportMappings; save: boolean; connectionIds: string[] }) => {
		setSqlImportBusy(true);
		setSqlImportError(undefined);
		diagramVsCodeApi.postMessage({ command: 'importSqlSchema', ...request });
	}, []);

	// Re-fetched every time the dialog opens rather than held: a connection could have been added, renamed
	// or deleted since this diagram was opened, and this list is only looked at while the dialog is up.
	let handleLoadSqlImportConnections = useCallback(() => {
		setSqlImportConnections(null);
		diagramVsCodeApi.postMessage({ command: 'loadSqlImportConnections' });
	}, []);

	// See the schema browser's copy of these - same dialog, same host service, same rules.
	let handleEditSqlImport = useCallback((importId: string) => {
		setViewImportsDialogOpen(false);
		setEditingSqlImport(null);
		setEditSqlImportOpen(true);
		setSqlImportSaveError(undefined);
		setSqlRunResult(undefined);
		setSqlImportConnections(null);
		diagramVsCodeApi.postMessage({ command: 'loadSqlImportConnections' });
		diagramVsCodeApi.postMessage({ command: 'loadSqlImport', importId: importId });
	}, []);

	let handleRefreshSqlImport = useCallback((importId: string) => {
		diagramVsCodeApi.postMessage({ command: 'refreshSqlImport', importId: importId });
	}, []);

	let handleSaveSqlImport = useCallback((request: SaveSqlImportRequest) => {
		setSqlImportBusy(true);
		setSqlImportSaveError(undefined);
		diagramVsCodeApi.postMessage({ command: 'saveSqlImport', ...request });
	}, []);

	let handleCloseEditSqlImport = useCallback(() => {
		setEditSqlImportOpen(false);
		setEditingSqlImport(undefined);
		setSqlRunResult(undefined);
		setSqlImportSaveError(undefined);
	}, []);

	let handleDiscardSqlRun = useCallback((runId: string) => {
		diagramVsCodeApi.postMessage({ command: 'discardSqlImportRun', runId: runId });
	}, []);

	let handleCloseImportDialog = useCallback(() => {
		setImportSchemaDialogOpen(false);
		setSqlRunResult(undefined);
		setSqlImportError(undefined);
	}, []);

	return (
		<Box sx={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'row' }}>
			{/* Only rendered once connected - an always-present empty rail would just take space from the
			canvas on a diagram being read rather than built. The tree collapses to a thin strip via its own
			button, so it can be got out of the way without disconnecting. */}
			{connectionName && (
				// A plain wrapper now that the selection footer is gone - kept rather than collapsed away
				// because the tree still needs a fixed-width, non-shrinking column of its own beside the
				// canvas, and because this is where anything docked under the tree would go.
				<Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, flexShrink: 0 }}>
					<SchemaTree
						tablesBySchema={treeTablesBySchema ?? {}}
						filterText={treeFilterText}
						onFilterTextChange={setTreeFilterText}
						selection={{
							mode: 'multi',
							selectedKeys: selectedTableKeys,
							onSelectionChange: setSelectedTableKeys,
							contextMenuItems: treeContextMenuItems
						}}
						menuItems={treeMenuItems}
						loading={treeTablesBySchema === undefined}
						title={connectionName}
						emptyMessage={treeTablesBySchema === undefined ? 'Loading tables...' : 'No tables match the current filter'}
					/>

				</Box>
			)}

			{/* Wraps just the canvas (not the tree beside it) so the drop-target overlay below covers exactly
			the area a drop actually lands on. flexGrow/minWidth reproduce the sizing ReactFlow got for free
			as a direct flex child before this wrapper existed; ReactFlow itself still renders at 100%/100%
			of it via its own stylesheet. */}
			<Box
				sx={{ position: 'relative', flexGrow: 1, minWidth: 0, height: '100%' }}
				onDragEnter={handleCanvasDragEnter}
				onDragOver={handleCanvasDragOver}
				onDragLeave={handleCanvasDragLeave}
				onDrop={handleCanvasDrop}
			>
				<ReactFlow
					nodes={displayNodes}
					edges={displayEdges}
					nodeTypes={nodeTypes}
					onNodesChange={onNodesChange}
					onEdgesChange={onEdgesChange}
					onInit={handleInit}
					onMoveEnd={handleMoveEnd}
					onNodeDragStop={handleNodeDragStop}
					onNodeClick={handleNodeClick}
					onNodeContextMenu={handleNodeContextMenu}
					onPaneClick={handlePaneClick}
					nodesConnectable={false}
					elementsSelectable
					onlyRenderVisibleElements
					minZoom={0.02}
					maxZoom={2}
					fitView
					fitViewOptions={{ padding: 0.15 }}
					// The "React Flow" attribution link in the bottom-right corner opens an external browser
					// tab when clicked - unwanted/confusing behavior inside a VS Code webview (nobody's going
					// to sponsor the library from inside a private internal extension). Hiding it is a
					// documented option (proOptions.hideAttribution), not something the license requires.
					proOptions={{ hideAttribution: true }}
				>
					<Background gap={24} size={1} />

					{/* Just the <marker> defs every relationship line's markerStart/markerEnd points at - renders
				nothing itself, and lives here (once) rather than per edge since marker ids resolve
				document-wide. */}
					<RelationshipMarkers />

					{/* Filters visually (dims non-matching tables/relationships, see filterMatchByTableId)
				rather than hiding anything - nothing re-layouts or jumps around, and clearing the field
				can never lose your place on the canvas. InputBase (not a full TextField) since the
				wrapping Box already supplies the bordered/paper look every other panel here uses. */}
					{/* The top-left menu the design called for: Export and Connect to Database. */}
					<Panel position="top-left">
						{/* The spinner REPLACES the button rather than sitting beside it or disabling it in place:
					every entry behind the menu needs the connection that's still being established, so there
					is nothing useful to open while it is, and a disabled-looking button invites clicking. The
					wrapper keeps the button's own footprint so the panel doesn't resize as it swaps. */}
						<Box sx={{
							display: 'flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30,
							backgroundColor: 'background.paper', border: '1px solid', borderColor: 'divider', borderRadius: 1
						}}>
							{connecting ? (
								<Tooltip title="Connecting to database..." placement="right">
									{/* Wrapped so the tooltip has a hoverable child that isn't the spinning element itself. */}
									<Box sx={{ display: 'flex' }}>
										<CircularProgress size={16} sx={{ color: 'primary.main' }} />
									</Box>
								</Tooltip>
							) : (
								<IconButton size="small" onClick={event => setMenuAnchor(event.currentTarget)} aria-label="Diagram menu" sx={{ borderRadius: 0, color: 'primary.main' }}>
									<MenuIcon fontSize="small" />
								</IconButton>
							)}
						</Box>

						<Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)}>
							<MenuItem onClick={handleConnectToDatabase} sx={{ fontSize: '0.8rem', gap: 1 }}>
								{connectionName ? 'Reconnect' : 'Connect'}
							</MenuItem>
							<MenuItem onClick={handleSyncWithDatabase} sx={{ fontSize: '0.8rem', gap: 1 }}>
								Sync with Database
							</MenuItem>
							<MenuItem onClick={handleRearrangeTables} sx={{ fontSize: '0.8rem', gap: 1 }}>
								Rearrange Tables
							</MenuItem>
							<MenuItem onClick={handleOpenExportDialog} sx={{ fontSize: '0.8rem', gap: 1 }}>
								Export...
							</MenuItem>
						</Menu>
					</Panel>

					<Panel position="top-center">
						<Box sx={{
							display: 'flex', alignItems: 'center', gap: 0.5, width: 260,
							backgroundColor: 'background.paper', border: '1px solid', borderColor: 'divider', borderRadius: 1,
							px: 1, py: 0.5
						}}>
							<SearchIcon fontSize="small" sx={{ color: 'text.secondary' }} />
							<InputBase
								value={filterText}
								onChange={event => setFilterText(event.target.value)}
								placeholder="Filter tables"
								sx={{ flexGrow: 1, fontSize: '0.8rem' }}
								inputProps={{ 'aria-label': 'Filter tables' }}
							/>
							{filterText && (
								<IconButton size="small" onClick={() => setFilterText('')} aria-label="Clear filter">
									<ClearIcon fontSize="small" />
								</IconButton>
							)}
						</Box>
					</Panel>

					{/* Custom controls (DiagramControls) sit in the same bottom-right group as the minimap,
				just to its left via flex order + gap, rather than React Flow's built-in <Controls> - see
				that component's own comment for why it can't just be dropped in alongside the minimap. */}
					{/* Renders nothing - it just re-frames the canvas when an add brings new tables in. Lives
				inside <ReactFlow> because useReactFlow only works within the provider ReactFlow sets up. */}
					<FitViewOnAdd tableCount={model.tables.length} />

					<Panel position="bottom-right">
						<Box sx={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-end', gap: 1 }}>
							<DiagramControls />
							<SchemaOverviewMap schemas={model.schemas} tableCountsBySchemaId={tableCountsBySchemaId} />
						</Box>
					</Panel>

					<Panel position="top-right">
						<Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, backgroundColor: 'background.paper', border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1 }}>
							<Box>
								<Box sx={{ fontSize: '0.875rem', fontWeight: 600 }}>{initialState.fileName}</Box>
								<Box sx={{ fontSize: '0.75rem', color: 'text.secondary' }}>{model.tables.length} tables - {model.relationships.length} relationships</Box>
							</Box>

							{model.schemas.length > 0 && (
								<Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, borderTop: '1px solid', borderColor: 'divider', pt: 0.75 }}>
									{model.schemas.map(schema => (
										<Box key={schema.id} sx={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 1 }}>
											<Box sx={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: schema.color, flexShrink: 0 }} />
											<Box sx={{ fontSize: '0.75rem' }}>{schema.name}</Box>
										</Box>
									))}
								</Box>
							)}
						</Box>
					</Panel>
				</ReactFlow>

				{/* The single drop target for a table-row drag, the same idea as an email client's one
			whole-window "drop attachment here" overlay rather than a per-schema-group affordance - the drop
			doesn't need to land on anything in particular (see handleCanvasDrop), so there's nothing more
			specific to highlight. pointerEvents: none keeps it out of the drag's own hit-testing, so
			dragenter/dragleave keep bubbling to the wrapper Box above instead of pairing up against this. */}
				{isDraggingTablesOver && (
					<Box sx={{
						position: 'absolute', inset: 0, zIndex: 1000, pointerEvents: 'none',
						display: 'flex', alignItems: 'center', justifyContent: 'center',
						backgroundColor: 'action.hover',
						border: '2px dashed', borderColor: 'primary.main'
					}}>
						<Box sx={{
							backgroundColor: 'background.paper', border: '1px solid', borderColor: 'divider',
							borderRadius: 1, px: 2, py: 1, fontSize: '0.875rem', fontWeight: 600
						}}>
							Drop to add to diagram
						</Box>
					</Box>
				)}
			</Box>

			<ContextMenu position={nodeContextMenu} onClose={() => setNodeContextMenu(null)}>
				{nodeContextMenu?.kind === 'table' && nodeContextMenu.ids.length === 1 && (
					<MenuItem onClick={handleOpenSchema}>Open Schema</MenuItem>
				)}
				{nodeContextMenu?.kind === 'table' && (
					<MenuItem onClick={handleOpenExportTables}>
						{nodeContextMenu.ids.length > 1 ? `Export ${nodeContextMenu.ids.length} Tables...` : 'Export...'}
					</MenuItem>
				)}
				{importedContextMenuTable && (
					<MenuItem onClick={handleDisableImportedChange}>Disable Imported Changes</MenuItem>
				)}
				{/* Both can show at once on a partly-disabled table: some of its imports are on, some off. */}
				{disabledImportContextMenuTable && (
					<MenuItem onClick={handleEnableImportedChange}>Enable Imported Changes</MenuItem>
				)}
				<MenuItem onClick={handleRemoveNode}>
					{nodeContextMenu?.kind === 'table' && nodeContextMenu.ids.length > 1 ? `Remove ${nodeContextMenu.ids.length} Tables` : 'Remove'}
				</MenuItem>
			</ContextMenu>

			<Dialog open={removeTablesConfirm !== null} onClose={() => setRemoveTablesConfirm(null)} maxWidth="sm" fullWidth>
				<DialogTitle>Remove Tables</DialogTitle>
				<DialogContent>
					<DialogContentText>
						Remove {removeTablesConfirm?.length ?? 0} tables from the diagram? Any relationship lines touching them are removed too.
					</DialogContentText>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setRemoveTablesConfirm(null)}>Cancel</Button>
					<Button variant="contained" color="error" onClick={handleConfirmRemoveTables}>Remove</Button>
				</DialogActions>
			</Dialog>

			<ExportTablesDialog
				open={exportDialogOpen || exportTableIds !== null}
				title={exportTableIds ? `Export ${exportTableIds.length === 1 ? '1 Table' : `${exportTableIds.length} Tables`}` : 'Export Diagram'}
				initialFormat="drawio"
				hasFilter={exportTableIds ? undefined : hasFilter}
				onCancel={() => {
					setExportDialogOpen(false);
					setExportTableIds(null);
				}}
				onExport={handleExport}
			/>

			<KeepRemoveDialog
				open={importRemovalOrphans !== null}
				title="Nothing Left Backing These Tables"
				description="These tables exist in no connected schema, so removing their imported data leaves nothing backing them. Keep them on the diagram (shown as New) or remove them."
				rows={(importRemovalOrphans ?? []).map(orphan => ({ key: orphan.tableId, label: `${orphan.schema}.${orphan.table}` }))}
				onCancel={handleCancelImportRemoval}
				onConfirm={handleConfirmImportRemoval}
			/>

			<KeepRemoveDialog
				open={syncOrphans !== null}
				title="Tables No Longer Found"
				description="These tables no longer resolve against the database or an imported file. Keep them on the diagram (shown as New) or remove them."
				rows={(syncOrphans ?? []).map(orphan => ({ key: orphan.tableId, label: `${orphan.schema}.${orphan.table}` }))}
				onCancel={handleCancelSync}
				onConfirm={handleConfirmSync}
			/>

			<SyncSummaryDialog open={syncSummary !== null} tables={syncSummary ?? []} onClose={() => setSyncSummary(null)} />

			<AddMissingTargetsDialog
				target={missingTargetChoice}
				onCancel={() => setMissingTargetChoice(null)}
				onAdd={handleAddChosenMissingTargets}
			/>

			<EditSchemaListDialog
				open={editSchemaListDialogOpen}
				schemaList={schemaList}
				onCancel={() => setEditSchemaListDialogOpen(false)}
				onSave={handleUpdateSchemaList}
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
		</Box>
	);
}
