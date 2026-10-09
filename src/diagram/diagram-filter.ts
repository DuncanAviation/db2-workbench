import { DiagramColumn, DiagramModel, DiagramTable } from '../webview-messages/diagram-messages.js';

// The diagram's filter field dims (rather than hides) whatever doesn't match - a search stays purely
// visual, nothing re-layouts or jumps around, and clearing the filter can never lose your place. Matches
// against whatever's actually visible somewhere in the diagram for a table - its own name/description,
// its owning schema's name, and its column names - so "does this look like it should match what I typed"
// is never surprising. Case-insensitive substring match, not a fuzzy search - the dataset (a database
// schema's own object names) is exact-vocabulary enough that substring matching is the more predictable
// choice here.
//
// Split into a table-identity check (name/schema/description) and a column check (below) so app.tsx can
// tell "this table itself matches" apart from "only one of its columns matches" - the former keeps every
// column at full weight, the latter dims just the non-matching columns instead of the whole table.
export function tableNameMatchesFilter(table: DiagramTable, schemaName: string, filterText: string): boolean {
	let needle = filterText.trim().toLowerCase();

	if(!needle) {
		return true;
	}

	if(table.name.toLowerCase().includes(needle)) {
		return true;
	}

	if(schemaName.toLowerCase().includes(needle)) {
		return true;
	}

	if(table.description && table.description.toLowerCase().includes(needle)) {
		return true;
	}

	return false;
}

// Checks every name form a column might be showing (its identity, DB2's short/long names, and its
// description/heading) - not just `name`, which is the relationship-anchoring identity and, for a real
// DB2 column, is always the LONG name (see DiagramColumn.name). A column labelled with the short name on
// screen (per the user's resultHeadingLabels setting) has to match on that short name too, or a filter
// that visibly matches what's on screen would silently fail to match it.
export function columnMatchesFilter(column: DiagramColumn, filterText: string): boolean {
	let needle = filterText.trim().toLowerCase();

	if(!needle) {
		return true;
	}

	if(column.name.toLowerCase().includes(needle)) {
		return true;
	}

	if(column.shortName && column.shortName.toLowerCase().includes(needle)) {
		return true;
	}

	if(column.longName && column.longName.toLowerCase().includes(needle)) {
		return true;
	}

	if(column.description && column.description.toLowerCase().includes(needle)) {
		return true;
	}

	return false;
}

export function tableMatchesFilter(table: DiagramTable, schemaName: string, filterText: string): boolean {
	if(tableNameMatchesFilter(table, schemaName, filterText)) {
		return true;
	}

	return table.columns.some(column => columnMatchesFilter(column, filterText));
}

// The "Filtered Tables Only" export scope (see ExportTablesDialog) - unlike the canvas, which only DIMS
// non-matching tables so the filter never loses your place, an exported file has to be a self-contained,
// valid model: every relationship it carries must reference a table that's actually in it. So a
// relationship survives only when BOTH endpoints match, not the canvas's more permissive "at least one
// endpoint matches" rule (see app.tsx's dimmedByFilter) - keeping a dangling reference to a table that
// isn't there would either break the mxGraph import or silently draw against nothing. A blank filter
// exports the whole model, tables/relationships/schemas untouched (including a schema with no tables of
// its own, which the canvas can produce and this deliberately doesn't second-guess).
export function filterDiagramModel(model: DiagramModel, filterText: string): DiagramModel {
	if(!filterText.trim()) {
		return model;
	}

	let schemaNameById = new Map(model.schemas.map(schema => [schema.id, schema.name]));
	let matchingTableIds = new Set(
		model.tables.filter(table => tableMatchesFilter(table, schemaNameById.get(table.schemaId) ?? '', filterText)).map(table => table.id)
	);

	return {
		schemas: model.schemas.filter(schema => model.tables.some(table => table.schemaId === schema.id && matchingTableIds.has(table.id))),
		tables: model.tables.filter(table => matchingTableIds.has(table.id)),
		relationships: model.relationships.filter(relationship => matchingTableIds.has(relationship.fromTable) && matchingTableIds.has(relationship.toTable))
	};
}

// Backs a table's own "Export..." context menu item (ExportTablesMessage) - the same restriction rule
// filterDiagramModel applies for a text match, applied instead to an explicit set of table ids (the
// right-clicked table, or the whole multi-selection it was part of). A relationship survives only when
// BOTH endpoints are in the set, for the same self-contained-export reason filterDiagramModel's own
// comment gives.
export function restrictDiagramModelToTables(model: DiagramModel, tableIds: readonly string[]): DiagramModel {
	let selectedTableIds = new Set(tableIds);

	return {
		schemas: model.schemas.filter(schema => model.tables.some(table => table.schemaId === schema.id && selectedTableIds.has(table.id))),
		tables: model.tables.filter(table => selectedTableIds.has(table.id)),
		relationships: model.relationships.filter(relationship => selectedTableIds.has(relationship.fromTable) && selectedTableIds.has(relationship.toTable))
	};
}
