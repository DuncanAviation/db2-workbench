import { DiagramModel, MissingRelationshipTarget, MissingTargetTable } from '../webview-messages/diagram-messages.js';
import { diagramTableId, ResolvedForeignKey } from './diagram-add-tables.js';

// Finds the foreign keys that addTables deliberately DIDN'T draw: those whose referenced table isn't on
// the diagram. They become one marker per column (see table-node.tsx) offering to bring those tables in,
// which is the whole point of not drawing a dangling edge for them in the first place.
//
// Pure, so the "which keys are unresolved" rule is unit-testable on its own - the caller
// (DiagramEditorProvider) supplies the foreign keys it read through MemoryCache.

/** Keys a target by the column it belongs to, so the webview can look one up per rendered row. */
export function missingTargetKey(tableId: string, columnName: string): string {
	return `${tableId}.${columnName}`;
}

export function findMissingTargets(model: DiagramModel, foreignKeysByTableId: Map<string, ResolvedForeignKey[]>): MissingRelationshipTarget[] {
	let presentTableIds = new Set(model.tables.map(table => table.id));
	let byColumn = new Map<string, MissingRelationshipTarget>();
	let missing: MissingRelationshipTarget[] = [];

	for(let table of model.tables) {
		let columnNames = new Set(table.columns.map(column => column.name));

		for(let foreignKey of foreignKeysByTableId.get(table.id) ?? []) {
			// Only the target TABLE's absence counts. A key pointing at a table that IS on the diagram but
			// whose referenced column isn't among its rendered columns is a different (and much stranger)
			// situation - offering to "add" a table already sitting on the canvas would be nonsense.
			if(presentTableIds.has(diagramTableId(foreignKey.toSchema, foreignKey.toTable))) {
				continue;
			}

			// The marker is drawn on a column row, so a key naming a column this table doesn't render has
			// nowhere to go. Shouldn't happen (both come from the same catalog), but it would otherwise be
			// an invisible, unreachable entry in the list.
			if(!columnNames.has(foreignKey.fromColumn)) {
				continue;
			}

			// One marker per column, carrying every table that column can bring in. A composite foreign key
			// reports a row per column and so gets a marker per column, which is right - but two keys
			// leaving the SAME column (which DB2 permits) would otherwise draw two markers on one row.
			let key = missingTargetKey(table.id, foreignKey.fromColumn);
			let target = byColumn.get(key);

			if(!target) {
				target = {tableId: table.id, columnName: foreignKey.fromColumn, targets: []};
				byColumn.set(key, target);
				missing.push(target);
			}

			// The same target table twice on one column is one entry, not two identical checkboxes: a
			// composite key reports a row per column pair, so a two-column key pointing at one table shows
			// up here twice for whichever of its columns is being collected.
			if(target.targets.some(existing => existing.targetSchema === foreignKey.toSchema && existing.targetTable === foreignKey.toTable)) {
				continue;
			}

			target.targets.push(<MissingTargetTable>{
				targetSchema: foreignKey.toSchema,
				targetTable: foreignKey.toTable,
				targetColumn: foreignKey.toColumn
			});
		}
	}

	return missing;
}
