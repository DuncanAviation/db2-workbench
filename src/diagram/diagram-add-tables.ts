import { DiagramColumn, DiagramModel, DiagramRelationship, DiagramSchemaGroup, DiagramTable } from '../webview-messages/diagram-messages.js';
import { findColumnIdentity } from './diagram-column-labels.js';
import { LayoutEdge, LayoutNode, layoutTables } from './diagram-layout.js';
import { DiagramModelEdit } from './diagram-model-editor.js';

// Adds a batch of database tables to an existing DiagramModel: creates any schema group they need,
// lays them out (via layoutTables - see placeTables below), draws the relationships their foreign keys
// imply, and grows the affected schema boxes to contain the result. Pure (no vscode, no DB access) for
// the same reason as diagram-model-editor.ts - the caller (DiagramEditorProvider) does the querying and
// hands the already-resolved definitions in, which is what makes all of this layout/merge logic
// unit-testable.

// Geometry mirrors diagram-xml.ts's TABLE_WIDTH/HEADER_HEIGHT/ROW_HEIGHT (and, through it,
// webviews/diagram/layout-constants.ts) - a mismatch wouldn't break correctness, since both sides read
// column count off the model, but the initial placement would be visibly loose or overlapping.
const TABLE_WIDTH = 390;
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 24;

// Gap between neighboring tables inside a schema box, and between the box's edge and its contents.
// PADDING_TOP is larger because the schema group's own title sits inside its top edge. Also mirrored in
// diagram-layout.ts, which needs its own copies to hand to ELK as layoutOptions.
const TABLE_GAP = 40;
const SCHEMA_PADDING = 40;
const SCHEMA_PADDING_TOP = 60;
// Space left between two schema boxes when a new one has to be placed beside the existing ones.
const SCHEMA_GAP = 80;

// Assigned round-robin to new schema groups, skipping colors already in use so two boxes in the same
// diagram only ever share a color once the palette is genuinely exhausted. Chosen to stay legible
// against both light and dark VS Code themes, since the diagram canvas follows the editor theme.
const SCHEMA_COLORS = ['#4C9AFF', '#36B37E', '#FF8B00', '#9F6BD8', '#FF5630', '#00A3BF', '#C1A300', '#DE5B9E'];
const FALLBACK_SCHEMA_COLOR = '#888888';

export interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

// A foreign key as the caller resolved it from QSYS2.SYSREFCST - schema-qualified on the referenced
// side, since an FK can perfectly well point at a table in another library.
export interface ResolvedForeignKey {
	fromColumn: string;
	toSchema: string;
	toTable: string;
	toColumn: string;
}

// One table, fully resolved: its columns in display order plus every foreign key it declares. The
// caller builds these from MemoryCache (columns, table keys, foreign keys); nothing here queries.
export interface ResolvedTable {
	schema: string;
	table: string;
	description?: string;
	columns: DiagramColumn[];
	foreignKeys: ResolvedForeignKey[];
	// Same field, same meaning as DiagramTable.importStatus - carried on this intermediate shape so
	// placeTables (a fresh add) and updateTables (a refresh of a table already here) can both copy it
	// straight onto the model without recomputing anything; toDiagramTable is the one place that actually
	// derives it.
	importStatus?: 'imported' | 'enhanced';
	// Same fields, same meaning as DiagramTable.uniqueKeys/indexes - carried through unchanged for the same
	// reason importStatus is: this shape only ever gets built by diagram-resolved-table.ts's toDiagramTable,
	// which is the one place that actually derives them.
	uniqueKeys?: DiagramTable['uniqueKeys'];
	indexes?: DiagramTable['indexes'];
}

export function diagramTableId(schema: string, table: string): string {
	return `${schema}.${table}`;
}

export function tableHeight(columnCount: number): number {
	return HEADER_HEIGHT + columnCount * ROW_HEIGHT;
}

/**
 * Adds every table in `tables` that isn't already on the diagram, returning the undo/redo pair for the
 * whole batch as a single edit (one Ctrl+Z undoes the entire add, not one table of it). Returns
 * undefined when there is nothing new to add, which is what keeps a re-add of already-present tables
 * from pushing an empty entry onto VS Code's undo stack and marking the document dirty.
 *
 * `existingForeignKeysByTableId` is the foreign keys declared by the tables ALREADY on the diagram.
 * Without it only the new tables' own keys get drawn, which silently misses every relationship
 * pointing the other way - most obviously the missing-FK-target marker flow, where the whole point of
 * the click is that a table already on the diagram references the one being added.
 *
 * Async because placeTables' arrangement of each schema's new batch goes through layoutTables (ELK) -
 * existing tables are never touched (they're only ever read, as `siblingTables`, to know where the new
 * batch has to start), so this is scoped to arranging the new batch well among itself, not to anchoring
 * it near a specific existing sibling it happens to reference. See layoutTables' own doc comment.
 */
export async function addTables(model: DiagramModel, tables: ResolvedTable[], existingForeignKeysByTableId: ReadonlyMap<string, ResolvedForeignKey[]> = new Map()): Promise<DiagramModelEdit | undefined> {
	let existingTableIds = new Set(model.tables.map(table => table.id));
	let newTables = tables.filter(table => !existingTableIds.has(diagramTableId(table.schema, table.table)));

	if(newTables.length === 0) {
		return undefined;
	}

	let addedSchemas: DiagramSchemaGroup[] = [];
	let addedTables: DiagramTable[] = [];
	let addedRelationships: DiagramRelationship[] = [];
	let boundsChanges: {schema: DiagramSchemaGroup; previous: Bounds; next: Bounds}[] = [];

	// Schema boxes are placed (and, for existing ones, grown) one schema at a time, and each placement
	// has to see the boxes added by earlier iterations - otherwise two new schemas in the same batch
	// would both be placed to the right of the same existing box, on top of each other.
	let placedSchemas = [...model.schemas];

	for(let [schemaName, schemaTables] of groupBySchema(newTables)) {
		let existingSchema = model.schemas.find(candidate => candidate.id === schemaName);
		let schema = existingSchema ?? createSchemaGroup(schemaName, placedSchemas);

		if(!existingSchema) {
			addedSchemas.push(schema);
			placedSchemas.push(schema);
		}

		let siblingTables = [...model.tables, ...addedTables].filter(table => table.schemaId === schema.id);
		let siblingIds = new Set(siblingTables.map(table => table.id));
		let anchorId = findAnchorSibling(schemaTables, siblingIds, existingForeignKeysByTableId);
		let placements = await placeTables(schemaTables, schema, siblingTables, anchorId);

		for(let placement of placements) {
			addedTables.push(placement);
		}

		// Union rather than replace, so a schema box the user has deliberately resized larger keeps its
		// size - the add only ever needs to guarantee the new tables are inside it.
		let previous = schema.bounds;
		let next = unionBounds(previous, contentBounds([...siblingTables, ...placements]));

		if(!boundsEqual(previous, next)) {
			boundsChanges.push({schema: schema, previous: previous, next: next});
			// Written straight to the schema now, not left for apply() below, because the next iteration's
			// createSchemaGroup places its box to the right of everything already placed - and a schema
			// created earlier in this same batch still has its initial 0x0 bounds until this line runs.
			schema.bounds = next;
		}
	}

	// Called before apply() below, so model.tables is still only what was on the diagram beforehand -
	// which is exactly the distinction buildRelationships needs between existing and newly added.
	addedRelationships.push(...buildRelationships(model, newTables, [...model.tables, ...addedTables], existingForeignKeysByTableId));

	let apply = () => {
		model.schemas.push(...addedSchemas);
		model.tables.push(...addedTables);
		model.relationships.push(...addedRelationships);

		for(let change of boundsChanges) {
			change.schema.bounds = change.next;
		}
	};

	// Removal is by object identity, not by id, so an unrelated later edit that happens to reuse an id
	// (re-adding a table this undo had removed, say) can't have its own object pulled out from under it.
	let revert = () => {
		model.schemas = model.schemas.filter(schema => !addedSchemas.includes(schema));
		model.tables = model.tables.filter(table => !addedTables.includes(table));
		model.relationships = model.relationships.filter(relationship => !addedRelationships.includes(relationship));

		for(let change of boundsChanges) {
			change.schema.bounds = change.previous;
		}
	};

	apply();

	return {
		label: newTables.length === 1 ? 'Add Table' : `Add ${newTables.length} Tables`,
		undo: revert,
		redo: apply
	};
}

// Insertion-ordered, so a batch's schema boxes end up laid out left to right in the order the tables
// came back from the picker rather than in an arbitrary Map iteration order.
function groupBySchema(tables: ResolvedTable[]): Map<string, ResolvedTable[]> {
	let grouped = new Map<string, ResolvedTable[]>();

	for(let table of tables) {
		let existing = grouped.get(table.schema);
		existing ? existing.push(table) : grouped.set(table.schema, [table]);
	}

	return grouped;
}

function createSchemaGroup(schemaName: string, placedSchemas: DiagramSchemaGroup[]): DiagramSchemaGroup {
	let usedColors = new Set(placedSchemas.map(schema => schema.color));
	let color = SCHEMA_COLORS.find(candidate => !usedColors.has(candidate))
		?? SCHEMA_COLORS[placedSchemas.length % SCHEMA_COLORS.length]
		?? FALLBACK_SCHEMA_COLOR;

	// Placed to the right of everything already on the canvas and aligned to the topmost existing box,
	// which reads as "appended" rather than dropped into the middle of the user's arrangement. Bounds
	// start empty and are grown to fit by the union in addTables.
	let x = placedSchemas.length === 0 ? 0 : Math.max(...placedSchemas.map(schema => schema.bounds.x + schema.bounds.width)) + SCHEMA_GAP;
	let y = placedSchemas.length === 0 ? 0 : Math.min(...placedSchemas.map(schema => schema.bounds.y));

	return {id: schemaName, name: schemaName, color: color, bounds: {x: x, y: y, width: 0, height: 0}};
}

// Arranges a schema's new batch among ITSELF using layoutTables (ELK) for their RELATIVE positions -
// existing siblings are never inputs to that layout call (layoutTables has no pinned/fixed-node support;
// see its own doc comment), only read-only context for where to try placing the resulting block. That
// placement DOES try to land next to a specific existing sibling the batch relates to (see
// findAnchorSibling/anchorTableId below), but it's a one-shot heuristic, not a real constraint solver -
// it only takes the first open spot it finds beside the anchor and otherwise falls back to the old
// below-everything spot. It does not have to be perfect: "Rearrange Tables" (rearrangeTables below) is
// always available afterward to fix the whole diagram up properly, which is what actually needs to be
// good - this just avoids the common case of a related table landing somewhere obviously disconnected.
async function placeTables(tables: ResolvedTable[], schema: DiagramSchemaGroup, siblingTables: DiagramTable[], anchorTableId?: string): Promise<DiagramTable[]> {
	if(tables.length === 0) {
		return [];
	}

	let idOf = (table: ResolvedTable) => diagramTableId(table.schema, table.table);
	let idsInBatch = new Set(tables.map(idOf));

	let nodes: LayoutNode[] = tables.map(table => ({
		id: idOf(table),
		groupId: schema.id,
		width: TABLE_WIDTH,
		height: tableHeight(table.columns.length)
	}));

	// Only foreign keys where BOTH ends are in this batch - a key pointing at (or declared by) an
	// existing sibling has no second node in this call's graph to connect to.
	let edges: LayoutEdge[] = tables.flatMap(table => table.foreignKeys
		.filter(foreignKey => idsInBatch.has(diagramTableId(foreignKey.toSchema, foreignKey.toTable)))
		.map(foreignKey => ({fromId: idOf(table), toId: diagramTableId(foreignKey.toSchema, foreignKey.toTable)})));

	let layout = await layoutTables(nodes, edges);
	let rawPositions = [...tables.map(idOf)].map(id => requireLayoutPosition(layout, id));

	// The batch's own footprint (as ELK arranged it, before translation) - needed to check whether the
	// anchor spot below actually has room for the whole block, not just its top-left corner.
	let batchWidth = Math.max(...rawPositions.map(position => position.x)) - Math.min(...rawPositions.map(position => position.x)) + TABLE_WIDTH;
	let batchHeight = Math.max(...tables.map((table, index) => rawPositions[index].y + tableHeight(table.columns.length))) - Math.min(...rawPositions.map(position => position.y));

	let belowEverything = {
		left: schema.bounds.x + SCHEMA_PADDING,
		top: siblingTables.length === 0
			? schema.bounds.y + SCHEMA_PADDING_TOP
			: Math.max(...siblingTables.map(table => table.position.y + tableHeight(table.columns.length))) + TABLE_GAP
	};

	let anchor = anchorTableId ? siblingTables.find(table => table.id === anchorTableId) : undefined;
	// Straight to the right of the anchor, top-aligned with it - simple to reason about and to check for
	// overlap, unlike trying to slot into whatever gap happens to be nearby.
	let besideAnchor = anchor ? {left: anchor.position.x + TABLE_WIDTH + TABLE_GAP, top: anchor.position.y} : undefined;

	let spot = besideAnchor && !overlapsAnySibling(besideAnchor, batchWidth, batchHeight, siblingTables)
		? besideAnchor
		: belowEverything;

	// layoutTables arranges the batch relative to ITSELF starting near its own origin - translated here so
	// its top-left corner lands exactly at the chosen spot.
	let dx = spot.left - Math.min(...rawPositions.map(position => position.x));
	let dy = spot.top - Math.min(...rawPositions.map(position => position.y));

	return tables.map((table, index) => ({
		id: idOf(table),
		schemaId: schema.id,
		name: table.table,
		...(table.description ? {description: table.description} : {}),
		...(table.importStatus ? {importStatus: table.importStatus} : {}),
		...(table.uniqueKeys?.length ? {uniqueKeys: table.uniqueKeys} : {}),
		...(table.indexes?.length ? {indexes: table.indexes} : {}),
		position: {x: rawPositions[index].x + dx, y: rawPositions[index].y + dy},
		columns: table.columns
	}));
}

// The first existing sibling the new batch relates to, in either direction - outbound (a new table's own
// key points at a sibling already in the schema) or inbound (a sibling's key points at one of the new
// tables, the same direction buildRelationships draws an edge for). "First found" rather than "best" is
// deliberate: this only feeds a best-effort placement hint (see placeTables above), not anything that
// needs to be exhaustively correct.
function findAnchorSibling(
	tables: ResolvedTable[],
	siblingIds: ReadonlySet<string>,
	existingForeignKeysByTableId: ReadonlyMap<string, ResolvedForeignKey[]>
): string | undefined {
	for(let table of tables) {
		for(let foreignKey of table.foreignKeys) {
			let targetId = diagramTableId(foreignKey.toSchema, foreignKey.toTable);

			if(siblingIds.has(targetId)) {
				return targetId;
			}
		}
	}

	let idsInBatch = new Set(tables.map(table => diagramTableId(table.schema, table.table)));

	for(let [fromId, foreignKeys] of existingForeignKeysByTableId) {
		if(siblingIds.has(fromId) && foreignKeys.some(foreignKey => idsInBatch.has(diagramTableId(foreignKey.toSchema, foreignKey.toTable)))) {
			return fromId;
		}
	}

	return undefined;
}

function overlapsAnySibling(spot: {left: number; top: number}, width: number, height: number, siblingTables: DiagramTable[]): boolean {
	return siblingTables.some(table => {
		let siblingHeight = tableHeight(table.columns.length);
		let overlapsX = spot.left < table.position.x + TABLE_WIDTH && table.position.x < spot.left + width;
		let overlapsY = spot.top < table.position.y + siblingHeight && table.position.y < spot.top + height;

		return overlapsX && overlapsY;
	});
}

function requireLayoutPosition(layout: {positions: ReadonlyMap<string, {x: number; y: number}>}, id: string): {x: number; y: number} {
	let position = layout.positions.get(id);

	if(!position) {
		throw new Error(`layoutTables did not return a position for ${id}`);
	}

	return position;
}

/**
 * "Rearrange Tables" (the diagram's own menu) - relays out EVERY table currently on the diagram from
 * scratch via layoutTables (ELK), using the real relationship graph (every relationship, same-schema or
 * cross-schema) rather than addTables' own within-batch-only edges. Unlike placeTables, nothing is
 * pinned here - that's the whole point of this command existing separately: an add near a related,
 * already-pinned table doesn't have to be perfect (see placeTables' own doc comment), because Rearrange
 * is always available afterward to fix the whole diagram up properly.
 *
 * A schema with no tables at all (every one of them removed, but the box itself never explicitly
 * removed) has no node in layoutTables' input and so no bounds come back for it - left untouched rather
 * than collapsed to nothing, since there's nothing to size it around.
 *
 * Returns undefined when there is nothing on the diagram to rearrange, or when a fresh layout happens to
 * come back identical to what's already there.
 */
export async function rearrangeTables(model: DiagramModel): Promise<DiagramModelEdit | undefined> {
	if(model.tables.length === 0) {
		return undefined;
	}

	let nodes: LayoutNode[] = model.tables.map(table => ({
		id: table.id,
		groupId: table.schemaId,
		width: TABLE_WIDTH,
		height: tableHeight(table.columns.length)
	}));
	let edges: LayoutEdge[] = model.relationships.map(relationship => ({fromId: relationship.fromTable, toId: relationship.toTable}));

	let layout = await layoutTables(nodes, edges);

	let tableChanges = model.tables
		.map(table => ({table: table, previous: table.position, next: requireLayoutPosition(layout, table.id)}))
		.filter(change => !positionEqual(change.previous, change.next));

	let schemaChanges = model.schemas
		.map(schema => ({schema: schema, previous: schema.bounds, next: layout.groupBounds.get(schema.id)}))
		.filter((change): change is {schema: DiagramSchemaGroup; previous: Bounds; next: Bounds} => change.next !== undefined)
		.filter(change => !boundsEqual(change.previous, change.next));

	if(tableChanges.length === 0 && schemaChanges.length === 0) {
		return undefined;
	}

	let apply = () => {
		for(let change of tableChanges) {
			change.table.position = change.next;
		}

		for(let change of schemaChanges) {
			change.schema.bounds = change.next;
		}
	};

	let revert = () => {
		for(let change of tableChanges) {
			change.table.position = change.previous;
		}

		for(let change of schemaChanges) {
			change.schema.bounds = change.previous;
		}
	};

	apply();

	return {label: 'Rearrange Tables', undo: revert, redo: apply};
}

function positionEqual(left: {x: number; y: number}, right: {x: number; y: number}): boolean {
	return left.x === right.x && left.y === right.y;
}

// The rectangle a schema box needs in order to contain these tables, title space included. An empty
// schema (a group whose tables were all filtered out of the batch as duplicates) contributes nothing,
// so the caller's union leaves its existing bounds alone.
function contentBounds(tables: DiagramTable[]): Bounds | undefined {
	if(tables.length === 0) {
		return undefined;
	}

	let left = Math.min(...tables.map(table => table.position.x));
	let top = Math.min(...tables.map(table => table.position.y));
	let right = Math.max(...tables.map(table => table.position.x + TABLE_WIDTH));
	let bottom = Math.max(...tables.map(table => table.position.y + tableHeight(table.columns.length)));

	return {
		x: left - SCHEMA_PADDING,
		y: top - SCHEMA_PADDING_TOP,
		width: right - left + SCHEMA_PADDING * 2,
		height: bottom - top + SCHEMA_PADDING_TOP + SCHEMA_PADDING
	};
}

function unionBounds(current: Bounds, addition: Bounds | undefined): Bounds {
	if(!addition) {
		return current;
	}

	// A brand-new schema group starts 0x0 (see createSchemaGroup), and a zero-size box has no meaningful
	// right/bottom edge to union against - it would drag the result back to its own origin corner.
	if(current.width === 0 || current.height === 0) {
		return addition;
	}

	let left = Math.min(current.x, addition.x);
	let top = Math.min(current.y, addition.y);
	let right = Math.max(current.x + current.width, addition.x + addition.width);
	let bottom = Math.max(current.y + current.height, addition.y + addition.height);

	return {x: left, y: top, width: right - left, height: bottom - top};
}

function boundsEqual(left: Bounds, right: Bounds): boolean {
	return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

// Draws an edge for every foreign key this add resolved, in BOTH directions:
//
//  - outbound: a new table's own keys, pointing at anything on the diagram (already there or part of
//    this same batch);
//  - inbound: keys declared by tables already on the diagram that point AT one of the new tables.
//
// The inbound pass is restricted to newly added targets on purpose. Widening it to every target would
// make an add quietly draw edges between tables that were both already sitting there, which isn't what
// the user asked for and would land in this edit's undo step.
//
// A key pointing at a table that still isn't on the diagram is silently skipped rather than drawn as a
// dangling edge - surfacing those is the missing-FK-target marker flow (see diagram-missing-targets.ts).
// Relationships already present are skipped too, so re-adding a table next to its existing partner
// can't double up an edge.
function buildRelationships(
	model: DiagramModel,
	newTables: ResolvedTable[],
	allTables: DiagramTable[],
	existingForeignKeysByTableId: ReadonlyMap<string, ResolvedForeignKey[]>
): DiagramRelationship[] {
	let tablesById = new Map(allTables.map(table => [table.id, table]));
	let newTableIds = new Set(newTables.map(table => diagramTableId(table.schema, table.table)));
	let takenIds = new Set(model.relationships.map(relationship => relationship.id));
	let relationships: DiagramRelationship[] = [];

	let collect = (fromTableId: string, foreignKeys: readonly ResolvedForeignKey[], onlyNewTargets: boolean) => {
		let fromTable = tablesById.get(fromTableId);

		for(let foreignKey of foreignKeys) {
			let toTableId = diagramTableId(foreignKey.toSchema, foreignKey.toTable);
			let toTable = tablesById.get(toTableId);

			if(onlyNewTargets && !newTableIds.has(toTableId)) {
				continue;
			}

			if(!fromTable || !toTable) {
				continue;
			}

			// Both ends have to resolve to a real, rendered column: an edge anchors to a specific column cell
			// (see diagram-xml.ts), so one naming a column that isn't there would have nothing to attach to.
			// Resolved through every name form each column answers to rather than compared against its
			// identity, because a foreign key doesn't have to name a column the same way the column is keyed -
			// an imported one never does (imports carry DB2's short names; identity is the long one). What
			// gets stored is always the identity, whichever form arrived.
			let fromColumn = findColumnIdentity(fromTable.columns, foreignKey.fromColumn);
			let toColumn = findColumnIdentity(toTable.columns, foreignKey.toColumn);

			if(!fromColumn || !toColumn) {
				continue;
			}

			let id = `${fromTableId}.${fromColumn}->${toTableId}.${toColumn}`;

			if(takenIds.has(id)) {
				continue;
			}

			takenIds.add(id);
			relationships.push({
				id: id,
				fromTable: fromTableId,
				fromColumn: fromColumn,
				toTable: toTableId,
				toColumn: toColumn
			});
		}
	};

	for(let table of newTables) {
		collect(diagramTableId(table.schema, table.table), table.foreignKeys, false);
	}

	for(let table of model.tables) {
		collect(table.id, existingForeignKeysByTableId.get(table.id) ?? [], true);
	}

	return relationships;
}

/**
 * Refreshes the columns of tables ALREADY on the diagram against their current resolved definition, and
 * draws any new relationship an import introduces between two tables that are both already here. The
 * counterpart to addTables for the one thing it doesn't cover: an import landing (or changing) for a
 * table that's already on the diagram - a table added AFTER that already gets fresh data through the
 * normal add path (loadTables -> toDiagramTable in DiagramEditorProvider), since that always resolves
 * against whatever is currently imported.
 *
 * Geometry is untouched on purpose: a table's rendered height is always computed live from its column
 * count (see layout-constants.ts/diagram-xml.ts), never stored on the model, so a box that gains or loses
 * columns here simply grows or shrinks on the next render with no separate update needed. Neighboring
 * tables are not reflowed to make room - the same tradeoff addTables' own placement makes for a fresh
 * add, just without a layout pass to begin with; the user can always drag a table clear of one that grew.
 *
 * `updates` is every table the caller has fresh data for (typically every table currently on the
 * diagram, the same set postMissingTargets already resolves) - entries that aren't already on the
 * diagram are silently ignored (bringing a new table in is addTables' job, not this one's), and entries
 * whose resolved columns are unchanged contribute nothing beyond a relationship check.
 */
export function updateTables(model: DiagramModel, updates: ResolvedTable[]): DiagramModelEdit | undefined {
	let tableById = new Map(model.tables.map(table => [table.id, table]));
	let nextColumnsById = new Map<string, DiagramColumn[]>();
	let changes: {
		table: DiagramTable;
		previousColumns: DiagramColumn[]; nextColumns: DiagramColumn[];
		previousImportStatus: DiagramTable['importStatus']; nextImportStatus: DiagramTable['importStatus'];
		previousUniqueKeys: DiagramTable['uniqueKeys']; nextUniqueKeys: DiagramTable['uniqueKeys'];
		previousIndexes: DiagramTable['indexes']; nextIndexes: DiagramTable['indexes'];
	}[] = [];

	for(let update of updates) {
		let id = diagramTableId(update.schema, update.table);
		let table = tableById.get(id);

		if(!table) {
			continue;
		}

		nextColumnsById.set(id, update.columns);

		if(
			!columnsEqual(table.columns, update.columns) || table.importStatus !== update.importStatus
			|| !arraysEqual(table.uniqueKeys, update.uniqueKeys) || !arraysEqual(table.indexes, update.indexes)
		) {
			changes.push({
				table: table,
				previousColumns: table.columns, nextColumns: update.columns,
				previousImportStatus: table.importStatus, nextImportStatus: update.importStatus,
				previousUniqueKeys: table.uniqueKeys, nextUniqueKeys: update.uniqueKeys,
				previousIndexes: table.indexes, nextIndexes: update.indexes
			});
		}
	}

	// Resolved from the UPDATED columns (nextColumnsById), not whatever is still stored on the table, so
	// a foreign key an import just introduced resolves against the column it actually names even when
	// this same update is what just added that column in the first place.
	let addedRelationships = buildUpdateRelationships(model, updates, tableById, nextColumnsById);

	if(changes.length === 0 && addedRelationships.length === 0) {
		return undefined;
	}

	let apply = () => {
		for(let change of changes) {
			change.table.columns = change.nextColumns;
			setImportStatus(change.table, change.nextImportStatus);
			setUniqueKeys(change.table, change.nextUniqueKeys);
			setIndexes(change.table, change.nextIndexes);
		}

		model.relationships.push(...addedRelationships);
	};

	let revert = () => {
		for(let change of changes) {
			change.table.columns = change.previousColumns;
			setImportStatus(change.table, change.previousImportStatus);
			setUniqueKeys(change.table, change.previousUniqueKeys);
			setIndexes(change.table, change.previousIndexes);
		}

		model.relationships = model.relationships.filter(relationship => !addedRelationships.includes(relationship));
	};

	apply();

	return {
		label: 'Update Imported Data',
		undo: revert,
		redo: apply
	};
}

// A missing importStatus/uniqueKeys/indexes has to actually be an ABSENT key, not one set to undefined -
// deleted rather than assigned, so a table losing its last import contribution (or its last unique
// constraint/index) round-trips back to exactly the shape it had before, and so a later JSON/deep-equal
// comparison, including this file's own undo tests, can't tell the two apart. Shared by updateTables and
// syncTables, the only two places that ever refresh a table already on the diagram.
function setImportStatus(table: DiagramTable, status: DiagramTable['importStatus']): void {
	if(status) {
		table.importStatus = status;
	} else {
		delete table.importStatus;
	}
}

function setUniqueKeys(table: DiagramTable, uniqueKeys: DiagramTable['uniqueKeys']): void {
	if(uniqueKeys?.length) {
		table.uniqueKeys = uniqueKeys;
	} else {
		delete table.uniqueKeys;
	}
}

function setIndexes(table: DiagramTable, indexes: DiagramTable['indexes']): void {
	if(indexes?.length) {
		table.indexes = indexes;
	} else {
		delete table.indexes;
	}
}

// Order-sensitive (unlike columnsEqual's own comparison, which is fine with that too) - good enough for
// uniqueKeys/indexes, since both are always rebuilt from the same stable DB2 catalog order on every
// resolve, so a real difference always shows up as more than just reordering.
function arraysEqual(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
	return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function columnsEqual(a: DiagramColumn[], b: DiagramColumn[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Guards "Sync with Database" against the same trap `DiagramEditorProvider.refreshImportedData` already
 * guards its own narrower auto-refresh against: `SchemaTrees`' imported-tables cache is in-memory and
 * session-scoped, so a table already marked Imported/Enhanced on the diagram, whose source file simply
 * hasn't been re-imported THIS session, resolves with an empty import list - identical to what a resolve
 * looks like when the import genuinely no longer backs that table. Without this filter, Sync would
 * silently flatten every un-reimported Imported/Enhanced table back to plain DB2 truth (or, for a wholly
 * import-sourced one, offer to remove it as an orphan) for no reason but that nobody reopened its source
 * file yet this session.
 *
 * `hasAnyImportThisSession` (the connection-wide `SchemaTrees.getImportedTables(configId).length > 0`
 * check, same one `refreshImportedData` already uses) is the signal that distinguishes the two cases:
 * with NOTHING imported this session, absence-of-import can't be trusted for ANY table, so every table
 * already carrying `importStatus` is left out of `updates` and `orphanTargets` entirely - untouched, not
 * even re-checked against live DB2 columns, since there's nothing new to learn about it either way. Once
 * at least one import has actually been loaded THIS session, a specific table's continued absence from it
 * is real information again - Sync applies normally, so re-importing a source that genuinely dropped a
 * table (or a foreign key) is exactly how you make Sync pick that change up.
 */
export function filterSyncResolve(
	model: DiagramModel,
	updates: ResolvedTable[],
	orphanTargets: { schema: string; table: string }[],
	hasAnyImportThisSession: boolean
): { updates: ResolvedTable[]; orphanTargets: { schema: string; table: string }[] } {
	if(hasAnyImportThisSession) {
		return { updates: updates, orphanTargets: orphanTargets };
	}

	let existingById = new Map(model.tables.map(table => [table.id, table]));
	let alreadyImportFlagged = (target: { schema: string; table: string }) =>
		!!existingById.get(diagramTableId(target.schema, target.table))?.importStatus;

	return {
		updates: updates.filter(update => !alreadyImportFlagged(update)),
		orphanTargets: orphanTargets.filter(target => !alreadyImportFlagged(target))
	};
}

// A single row of the post-sync summary dialog (see DiagramEditorProvider.applySync) - what happened to
// one table as a RESULT of the sync, not a status the diagram keeps around afterward the way
// DiagramTable.importStatus does. 'updated' covers both a plain column refresh and an import contribution
// changing; 'orphaned' is specifically a KEPT orphan (see syncTables' own doc) - a removed one is
// 'removed', not both.
export interface SyncResultTable {
	tableId: string;
	schema: string;
	table: string;
	status: 'updated' | 'removed' | 'orphaned';
}

export interface SyncResult {
	edit: DiagramModelEdit | undefined;
	// Empty exactly when edit is undefined (nothing changed) - a newly-drawn relationship alone still
	// produces a row (see relationshipOnlyIds below), so `changedTables` being non-empty and `edit` being
	// defined agree in every case. The caller (DiagramEditorProvider.applySync) falls back to its plain
	// toast whenever this is empty, rather than opening a dialog with nothing in it.
	changedTables: SyncResultTable[];
}

/**
 * "Sync with Database" (see DiagramEditorProvider.handleSyncDiagram): the counterpart to updateTables
 * that also handles the case updateTables deliberately ignores - a table that resolves against NEITHER
 * a connected row NOR any current import at all. One edit for the whole sync (refreshed tables, newly
 * drawn relationships, kept-as-orphan flags, and confirmed removals together), so a single Ctrl+Z undoes
 * it as a unit. Alongside the edit, returns which tables actually changed and how - what the post-sync
 * summary dialog lists.
 *
 * `updates` is exactly updateTables' own parameter - every table the caller successfully resolved.
 * `orphanTableIds` is every table ALREADY on the diagram that didn't resolve at all (the caller's
 * loadTables onMissing callback). `removeTableIds` is the subset of those the user chose to remove in the
 * Keep/Remove confirmation dialog; defaulting to Keep is what makes it a subset rather than the whole set.
 * A kept orphan (in orphanTableIds but not removeTableIds) gets importStatus 'orphaned' - the diagram's
 * own "New" badge (see ImportBadgeKind), not a separate alarming label - so it doesn't keep reading as
 * confirmed live data. An orphan that was already 'orphaned' from a PRIOR sync produces no redundant
 * change entry, so a sync that finds nothing new doesn't dirty the document for no reason.
 *
 * `reconcileRelationshipsFor` names tables whose relationships should additionally be reduced to
 * exactly what this resolve justifies, rather than only added to (see findStrandedRelationships).
 * Empty for Sync itself, deliberately: a sync RETAINS imported data, so a foreign key an import
 * contributed must survive one. "Remove Imported Change" (see DiagramEditorProvider.applyImportRemoval)
 * is the caller that passes a table here, since discarding an import has to take the relationships that
 * import drew with it.
 */
export function syncTables(
	model: DiagramModel,
	updates: ResolvedTable[],
	orphanTableIds: readonly string[],
	removeTableIds: readonly string[],
	reconcileRelationshipsFor: readonly string[] = []
): SyncResult {
	let tableById = new Map(model.tables.map(table => [table.id, table]));
	let nextColumnsById = new Map<string, DiagramColumn[]>();
	// `kind` distinguishes a real resolved-table update from a kept-orphan flag flip, purely for the
	// summary row's status - both apply/revert identically either way.
	let changes: {
		table: DiagramTable; kind: 'updated' | 'orphaned';
		previousColumns: DiagramColumn[]; nextColumns: DiagramColumn[];
		previousImportStatus: DiagramTable['importStatus']; nextImportStatus: DiagramTable['importStatus'];
		previousUniqueKeys: DiagramTable['uniqueKeys']; nextUniqueKeys: DiagramTable['uniqueKeys'];
		previousIndexes: DiagramTable['indexes']; nextIndexes: DiagramTable['indexes'];
	}[] = [];

	for(let update of updates) {
		let id = diagramTableId(update.schema, update.table);
		let table = tableById.get(id);

		if(!table) {
			continue;
		}

		nextColumnsById.set(id, update.columns);

		if(
			!columnsEqual(table.columns, update.columns) || table.importStatus !== update.importStatus
			|| !arraysEqual(table.uniqueKeys, update.uniqueKeys) || !arraysEqual(table.indexes, update.indexes)
		) {
			changes.push({
				table: table, kind: 'updated',
				previousColumns: table.columns, nextColumns: update.columns,
				previousImportStatus: table.importStatus, nextImportStatus: update.importStatus,
				previousUniqueKeys: table.uniqueKeys, nextUniqueKeys: update.uniqueKeys,
				previousIndexes: table.indexes, nextIndexes: update.indexes
			});
		}
	}

	let removeIdSet = new Set(removeTableIds);
	let keptOrphanIds = orphanTableIds.filter(id => !removeIdSet.has(id));

	for(let id of keptOrphanIds) {
		let table = tableById.get(id);

		if(!table || table.importStatus === 'orphaned') {
			continue;
		}

		changes.push({
			table: table, kind: 'orphaned',
			previousColumns: table.columns, nextColumns: table.columns,
			previousImportStatus: table.importStatus, nextImportStatus: 'orphaned',
			previousUniqueKeys: table.uniqueKeys, nextUniqueKeys: table.uniqueKeys,
			previousIndexes: table.indexes, nextIndexes: table.indexes
		});
	}

	// Resolved from the UPDATED columns, same reasoning as updateTables' own addedRelationships.
	let addedRelationships = buildUpdateRelationships(model, updates, tableById, nextColumnsById);

	// Captured before apply() touches anything, same as removeTables' own removedRelationships.
	let removedEntries = model.tables
		.map((table, index) => ({table, index}))
		.filter(entry => removeIdSet.has(entry.table.id));
	let removedIds = new Set(removedEntries.map(entry => entry.table.id));
	let removedRelationships = model.relationships.filter(relationship => removedIds.has(relationship.fromTable) || removedIds.has(relationship.toTable));
	// Relationships this resolve says should no longer be drawn at all, for whichever tables the caller
	// asked to have reconciled (see reconcileRelationshipsFor). Captured before apply(), same as
	// removedRelationships, and put back by revert() alongside it.
	let strandedRelationships = findStrandedRelationships(model, updates, nextColumnsById, reconcileRelationshipsFor, removedIds);
	let strandedIds = new Set(strandedRelationships.map(relationship => relationship.id));

	if(changes.length === 0 && addedRelationships.length === 0 && removedEntries.length === 0 && strandedRelationships.length === 0) {
		return { edit: undefined, changedTables: [] };
	}

	let apply = () => {
		if(strandedIds.size > 0) {
			model.relationships = model.relationships.filter(relationship => !strandedIds.has(relationship.id));
		}

		if(removedEntries.length > 0) {
			model.tables = model.tables.filter(table => !removedIds.has(table.id));
			model.relationships = model.relationships.filter(relationship => !removedIds.has(relationship.fromTable) && !removedIds.has(relationship.toTable));
		}

		for(let change of changes) {
			change.table.columns = change.nextColumns;
			setImportStatus(change.table, change.nextImportStatus);
			setUniqueKeys(change.table, change.nextUniqueKeys);
			setIndexes(change.table, change.nextIndexes);
		}

		model.relationships.push(...addedRelationships);
	};

	let revert = () => {
		for(let change of changes) {
			change.table.columns = change.previousColumns;
			setImportStatus(change.table, change.previousImportStatus);
			setUniqueKeys(change.table, change.previousUniqueKeys);
			setIndexes(change.table, change.previousIndexes);
		}

		model.relationships = model.relationships.filter(relationship => !addedRelationships.includes(relationship));

		if(strandedRelationships.length > 0) {
			model.relationships = [...model.relationships, ...strandedRelationships];
		}

		if(removedEntries.length > 0) {
			// Same lowest-index-first reinsertion as removeTables' own unapply.
			let restored = [...model.tables];

			for(let entry of [...removedEntries].sort((a, b) => a.index - b.index)) {
				restored.splice(Math.min(entry.index, restored.length), 0, entry.table);
			}

			model.tables = restored;
			model.relationships = [...model.relationships, ...removedRelationships];
		}
	};

	apply();

	// A table can gain a newly-drawn relationship with no column/importStatus diff of its own - two
	// already-resolved tables that simply weren't connected yet (the missing-FK-target flow's own premise,
	// just reached through Sync instead of a marker click). That's still a real change to flag: only the
	// FK-declaring end (relationship.fromTable, the "many" side - see diagram-cardinality.ts) counts as
	// having gained something, not the table it now points at, which hasn't changed at all. Skipped for a
	// table already covered by `changes` or `removedEntries`, so it's never listed twice.
	let alreadyListedIds = new Set([...changes.map(change => change.table.id), ...removedEntries.map(entry => entry.table.id)]);
	let relationshipOnlyIds = new Set(addedRelationships.map(relationship => relationship.fromTable).filter(id => !alreadyListedIds.has(id)));

	let changedTables: SyncResultTable[] = [
		...changes.map(change => ({ tableId: change.table.id, schema: change.table.schemaId, table: change.table.name, status: change.kind })),
		...removedEntries.map(entry => ({ tableId: entry.table.id, schema: entry.table.schemaId, table: entry.table.name, status: 'removed' as const })),
		...[...relationshipOnlyIds].flatMap(id => {
			let table = tableById.get(id);
			return table ? [{ tableId: table.id, schema: table.schemaId, table: table.name, status: 'updated' as const }] : [];
		})
	];

	return {
		edit: { label: 'Sync with Database', undo: revert, redo: apply },
		changedTables: changedTables
	};
}

/**
 * Relationships that should come OFF the diagram for one of `tableIds`, given what that table just
 * resolved to. buildUpdateRelationships is the additive half of the same question; this is the
 * subtractive half, and only a caller that asks for it gets it (see syncTables' `reconcileRelationshipsFor`
 * for why Sync itself never does).
 *
 * Two ways a relationship goes stale for table T:
 * - T declares it (T is the foreign-key end) and the resolve no longer lists that foreign key. This is
 *   what removing an import does to a foreign key the import introduced: the columns at both ends can
 *   still exist, so nothing about the line looks broken - it simply is not a relationship this table has
 *   any more.
 * - It points AT a column of T that the resolve no longer has. Another table declares it, so the first
 *   rule cannot see it, but the handle it anchors to is gone (see table-node.tsx's tableNodeHandles).
 *
 * A table in `removedIds` is skipped: every relationship touching it already comes off with the table
 * itself, and listing the same relationship twice would make revert() restore a duplicate. A table with
 * no resolve at all (a kept orphan) is skipped too - there's no authority to reconcile against, the same
 * reason a kept orphan keeps its columns.
 */
function findStrandedRelationships(
	model: DiagramModel,
	updates: ResolvedTable[],
	nextColumnsById: ReadonlyMap<string, DiagramColumn[]>,
	tableIds: readonly string[],
	removedIds: ReadonlySet<string>
): DiagramRelationship[] {
	let updateById = new Map(updates.map(update => [diagramTableId(update.schema, update.table), update]));
	let stranded: DiagramRelationship[] = [];

	for(let tableId of tableIds) {
		let update = updateById.get(tableId);

		if(!update || removedIds.has(tableId)) {
			continue;
		}

		let columns = nextColumnsById.get(tableId) ?? update.columns;
		let columnNames = new Set(columns.map(column => column.name));
		// The ids the resolve DOES justify, built exactly the way buildUpdateRelationships builds the ones it
		// draws - so a foreign key that survived the removal matches the line already on the diagram instead
		// of being pruned here and redrawn in the same edit.
		let keptIds = new Set<string>();

		for(let foreignKey of update.foreignKeys) {
			let toTableId = diagramTableId(foreignKey.toSchema, foreignKey.toTable);
			let toColumns = nextColumnsById.get(toTableId) ?? model.tables.find(table => table.id === toTableId)?.columns ?? [];
			let fromColumn = findColumnIdentity(columns, foreignKey.fromColumn);
			let toColumn = findColumnIdentity(toColumns, foreignKey.toColumn);

			if(fromColumn && toColumn) {
				keptIds.add(`${tableId}.${fromColumn}->${toTableId}.${toColumn}`);
			}
		}

		for(let relationship of model.relationships) {
			if(removedIds.has(relationship.fromTable) || removedIds.has(relationship.toTable) || stranded.includes(relationship)) {
				continue;
			}

			let declaredHere = relationship.fromTable === tableId && !keptIds.has(relationship.id);
			let pointsAtMissingColumn = relationship.toTable === tableId && !columnNames.has(relationship.toColumn);

			if(declaredHere || pointsAtMissingColumn) {
				stranded.push(relationship);
			}
		}
	}

	return stranded;
}

// Same relationship-id scheme and dedupe-by-id as buildRelationships above, but simpler: every table
// involved is already on the diagram (never a newly-added one), so there's no inbound/outbound
// distinction to make - just draw whatever this update's own foreign keys resolve to that isn't already
// drawn. A key pointing at a table that isn't on the diagram is silently skipped, same as buildRelationships -
// that's the missing-FK-target marker flow's job, not this one's.
function buildUpdateRelationships(
	model: DiagramModel,
	updates: ResolvedTable[],
	tableById: ReadonlyMap<string, DiagramTable>,
	nextColumnsById: ReadonlyMap<string, DiagramColumn[]>
): DiagramRelationship[] {
	let takenIds = new Set(model.relationships.map(relationship => relationship.id));
	let relationships: DiagramRelationship[] = [];
	let columnsFor = (tableId: string) => nextColumnsById.get(tableId) ?? tableById.get(tableId)?.columns ?? [];

	for(let update of updates) {
		let fromTableId = diagramTableId(update.schema, update.table);

		if(!tableById.has(fromTableId)) {
			continue;
		}

		let fromColumns = columnsFor(fromTableId);

		for(let foreignKey of update.foreignKeys) {
			let toTableId = diagramTableId(foreignKey.toSchema, foreignKey.toTable);

			if(!tableById.has(toTableId)) {
				continue;
			}

			let fromColumn = findColumnIdentity(fromColumns, foreignKey.fromColumn);
			let toColumn = findColumnIdentity(columnsFor(toTableId), foreignKey.toColumn);

			if(!fromColumn || !toColumn) {
				continue;
			}

			let id = `${fromTableId}.${fromColumn}->${toTableId}.${toColumn}`;

			if(takenIds.has(id)) {
				continue;
			}

			takenIds.add(id);
			relationships.push({id: id, fromTable: fromTableId, fromColumn: fromColumn, toTable: toTableId, toColumn: toColumn});
		}
	}

	return relationships;
}

