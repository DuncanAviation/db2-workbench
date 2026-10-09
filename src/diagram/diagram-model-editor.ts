import { DiagramModel } from '../webview-messages/diagram-messages.js';

// Pure edit-application logic for a DiagramModel - deliberately has no VS Code dependency (no
// vscode.Uri, no vscode.EventEmitter) so it's unit-testable directly, unlike DiagramDocument itself
// (src/diagram/diagram-document.ts), which wraps this in the thin vscode.CustomDocument/file-I/O glue
// that isn't practical to unit test. Each function mutates the given model in place (the one edit
// currently applied) and returns undo/redo closures over that same mutation, matching the shape
// vscode.CustomDocumentEditEvent needs.

export interface DiagramModelEdit {
	label: string;
	undo(): void;
	redo(): void;
}

export function moveTable(model: DiagramModel, tableId: string, position: {x: number; y: number}): DiagramModelEdit | undefined {
	let table = model.tables.find(candidate => candidate.id === tableId);

	// A click on a table's header (the drag handle) that React Flow classifies as a below-threshold drag
	// still fires onNodeDragStop with the table's unchanged position - without this guard that produced a
	// no-op edit anyway: a bogus Ctrl+Z entry, a dirtied document, and a modelUpdated round-trip that could
	// race the same click's own selection state and wipe it back out (the "click a table header a few
	// times before it shows selected" bug).
	if(!table || (table.position.x === position.x && table.position.y === position.y)) {
		return undefined;
	}

	let previousPosition = table.position;
	table.position = position;

	return {
		label: 'Move Table',
		undo: () => {
			table.position = previousPosition;
		},
		redo: () => {
			table.position = position;
		}
	};
}

// Ending a multi-select drag (ctrl+click several tables, then drag any one of them) moves every table
// that was part of that drag, not just the one the pointer was actually on - React Flow itself already
// repositioned all of them in the webview's local node state, so this is what makes the OTHER tables'
// new positions reach the model at all. Applied as one edit (like addTables' whole-batch edit) so a
// single Ctrl+Z undoes the whole drag rather than requiring one per table, and so the host only pushes
// one modelUpdated - not one per table - back to every open webview. A tableId this diagram doesn't
// have is silently skipped rather than failing the whole batch, the same as moveTable returning
// undefined for one it can't find.
export function moveTables(model: DiagramModel, moves: {tableId: string; position: {x: number; y: number}}[]): DiagramModelEdit | undefined {
	let tablesById = new Map(model.tables.map(table => [table.id, table]));
	// Same no-op guard as moveTable, per table in the batch - a multi-select drag where every table
	// genuinely moved keeps its normal single edit, but a batch that resolves to zero real moves (or a
	// tableId this diagram doesn't have) produces no edit at all rather than a bogus one.
	let matched = moves.filter(move => {
		let table = tablesById.get(move.tableId);
		return !!table && (table.position.x !== move.position.x || table.position.y !== move.position.y);
	});

	if(matched.length === 0) {
		return undefined;
	}

	let previousPositions = new Map(matched.map(move => [move.tableId, tablesById.get(move.tableId)?.position ?? move.position]));
	let newPositions = new Map(matched.map(move => [move.tableId, move.position]));

	let apply = (positions: Map<string, {x: number; y: number}>) => {
		for(let [tableId, position] of positions) {
			let table = tablesById.get(tableId);

			if(table) {
				table.position = position;
			}
		}
	};

	apply(newPositions);

	return {
		label: matched.length === 1 ? 'Move Table' : 'Move Tables',
		undo: () => apply(previousPositions),
		redo: () => apply(newPositions)
	};
}

// A resize keeps every table fixed in absolute space while the boundary changes around them - that's
// the whole point of resizing a container rather than moving it. Only called from an actual resize
// handle drag; a plain move (drag the title tab) goes through moveSchema instead, which does the
// opposite (shifts tables along with the schema) - see its own comment for why these can't share one
// implementation despite both ultimately just writing schema.bounds.
export function resizeSchema(model: DiagramModel, schemaId: string, bounds: {x: number; y: number; width: number; height: number}): DiagramModelEdit | undefined {
	let schema = model.schemas.find(candidate => candidate.id === schemaId);

	if(!schema) {
		return undefined;
	}

	let previousBounds = schema.bounds;
	schema.bounds = bounds;

	return {
		label: 'Resize Schema',
		undo: () => {
			schema.bounds = previousBounds;
		},
		redo: () => {
			schema.bounds = bounds;
		}
	};
}

// Removes one table and, with it, every relationship that touched it - a relationship left pointing at
// a table no longer on the diagram would have nothing to anchor its handle to (see table-node.tsx's
// tableNodeHandles). tableIndex is captured so undo puts the table back in the same position in the
// array it came from, rather than just appending it at the end.
export function removeTable(model: DiagramModel, tableId: string): DiagramModelEdit | undefined {
	let tableIndex = model.tables.findIndex(candidate => candidate.id === tableId);

	if(tableIndex < 0) {
		return undefined;
	}

	let table = model.tables[tableIndex];
	let removedRelationships = model.relationships.filter(relationship => relationship.fromTable === tableId || relationship.toTable === tableId);

	let apply = () => {
		model.tables = model.tables.filter(candidate => candidate.id !== tableId);
		model.relationships = model.relationships.filter(relationship => relationship.fromTable !== tableId && relationship.toTable !== tableId);
	};

	let unapply = () => {
		model.tables = [...model.tables.slice(0, tableIndex), table, ...model.tables.slice(tableIndex)];
		model.relationships = [...model.relationships, ...removedRelationships];
	};

	apply();

	return {
		label: 'Remove Table',
		undo: unapply,
		redo: apply
	};
}

// Right-click "Remove" with 2+ tables selected (see app.tsx's confirm-then-batch flow) - one edit for
// the whole selection, so a single Ctrl+Z restores every removed table (and its relationships) together
// rather than requiring one undo per table. Same per-table index-preserving undo as removeTable, just
// applied to a set; an id this diagram doesn't have is silently skipped, same as removeTable returning
// undefined for one it can't find.
export function removeTables(model: DiagramModel, tableIds: string[]): DiagramModelEdit | undefined {
	let idSet = new Set(tableIds);
	let removedEntries = model.tables
		.map((table, index) => ({table, index}))
		.filter(entry => idSet.has(entry.table.id));

	if(removedEntries.length === 0) {
		return undefined;
	}

	let removedIds = new Set(removedEntries.map(entry => entry.table.id));
	let removedRelationships = model.relationships.filter(relationship => removedIds.has(relationship.fromTable) || removedIds.has(relationship.toTable));

	let apply = () => {
		model.tables = model.tables.filter(table => !removedIds.has(table.id));
		model.relationships = model.relationships.filter(relationship => !removedIds.has(relationship.fromTable) && !removedIds.has(relationship.toTable));
	};

	let unapply = () => {
		// Reinserted lowest original index first, so splicing one doesn't shift the target slot out from
		// under the next - restores the original array order rather than appending everything at the end.
		let restored = [...model.tables];

		for(let entry of [...removedEntries].sort((a, b) => a.index - b.index)) {
			restored.splice(Math.min(entry.index, restored.length), 0, entry.table);
		}

		model.tables = restored;
		model.relationships = [...model.relationships, ...removedRelationships];
	};

	apply();

	return {
		label: removedEntries.length === 1 ? 'Remove Table' : 'Remove Tables',
		undo: unapply,
		redo: apply
	};
}

// Removes a schema along with every table it contains and every relationship touching any of them
// (including one crossing into a DIFFERENT schema that's staying - the removed table is gone either
// way, so a relationship naming it can't be left behind). schemaIndex is captured for the same reason as
// removeTable's tableIndex.
export function removeSchema(model: DiagramModel, schemaId: string): DiagramModelEdit | undefined {
	let schemaIndex = model.schemas.findIndex(candidate => candidate.id === schemaId);

	if(schemaIndex < 0) {
		return undefined;
	}

	let schema = model.schemas[schemaIndex];
	let removedTableIds = new Set(model.tables.filter(table => table.schemaId === schemaId).map(table => table.id));
	let removedTables = model.tables.filter(table => removedTableIds.has(table.id));
	let removedRelationships = model.relationships.filter(relationship => removedTableIds.has(relationship.fromTable) || removedTableIds.has(relationship.toTable));

	let apply = () => {
		model.schemas = model.schemas.filter(candidate => candidate.id !== schemaId);
		model.tables = model.tables.filter(table => !removedTableIds.has(table.id));
		model.relationships = model.relationships.filter(relationship => !removedTableIds.has(relationship.fromTable) && !removedTableIds.has(relationship.toTable));
	};

	let unapply = () => {
		model.schemas = [...model.schemas.slice(0, schemaIndex), schema, ...model.schemas.slice(schemaIndex)];
		model.tables = [...model.tables, ...removedTables];
		model.relationships = [...model.relationships, ...removedRelationships];
	};

	apply();

	return {
		label: 'Remove Schema',
		undo: unapply,
		redo: apply
	};
}

// A plain drag of the schema group itself - unlike resizeSchema, this shifts every table belonging to
// the schema by the same delta, so they travel with it as a rigid unit instead of staying fixed in
// absolute space (which is what resizeSchema deliberately does, and which made a drag look like it
// "reverted" once the schema's new bounds round-tripped back through the document - table position is
// always derived from absolute position minus the *current* schema bounds at render time, so leaving
// table positions untouched here would make them visually snap back the moment the schema moved).
export function moveSchema(model: DiagramModel, schemaId: string, position: {x: number; y: number}): DiagramModelEdit | undefined {
	let schema = model.schemas.find(candidate => candidate.id === schemaId);

	if(!schema) {
		return undefined;
	}

	let dx = position.x - schema.bounds.x;
	let dy = position.y - schema.bounds.y;
	let affectedTables = model.tables.filter(table => table.schemaId === schemaId);

	let previousBounds = schema.bounds;
	let newBounds = {...schema.bounds, x: position.x, y: position.y};
	// Stored as absolute before/after positions (not deltas) so undo/redo stay correct no matter how
	// many times either is invoked, rather than accumulating a shift on every call.
	let previousPositions = new Map(affectedTables.map(table => [table.id, table.position]));
	let newPositions = new Map(affectedTables.map(table => [table.id, {x: table.position.x + dx, y: table.position.y + dy}]));

	// An arrow function, not a `function` declaration - TS doesn't carry the `if(!schema) return` guard's
	// narrowing (schema: DiagramSchemaGroup, not | undefined) into a nested function declaration, only
	// into an inline expression like this one.
	let apply = (bounds: typeof newBounds, positions: Map<string, {x: number; y: number}>) => {
		schema.bounds = bounds;

		for(let table of affectedTables) {
			table.position = positions.get(table.id) ?? table.position;
		}
	};

	apply(newBounds, newPositions);

	return {
		label: 'Move Schema',
		undo: () => apply(previousBounds, previousPositions),
		redo: () => apply(newBounds, newPositions)
	};
}
