import { DiagramKeyColumn, DiagramModel, DiagramTableKey, DiagramTableKeys } from '../webview-messages/diagram-messages.js';
import { diagramTableId, ResolvedForeignKey } from './diagram-add-tables.js';

// Every foreign key that touches each table on the diagram, in both directions, grouped into one entry
// per key (a composite key arrives as a row per column). The webview uses them for the "add related
// tables" markers - on a column row for the keys that column is part of, in the header for all of the
// table's keys - and for the dialog those markers open, which lists every key, including those whose
// other table is already on the canvas.
//
// Pure, so the grouping rules are unit-testable on their own - the caller (DiagramEditorProvider)
// supplies the foreign keys it read through MemoryCache and SchemaTrees.

/** One foreign key in another table that references a diagram table, one row per column, as the caller read it. */
export interface ReferencingKeyColumn {
	/** The referencing (child) table. */
	schema: string;
	table: string;
	constraintName?: string;
	/** The key came only from an import. */
	isNew?: boolean;
	/** The diagram table's column the key lands on, by its identity (DiagramColumn.name). */
	column: string;
	/** The child's column, in whichever name forms the lookup gave. */
	childShortName?: string;
	childLongName?: string;
}

export function buildTableKeys(
	model: DiagramModel,
	foreignKeysByTableId: ReadonlyMap<string, ResolvedForeignKey[]>,
	referencingByTableId: ReadonlyMap<string, ReferencingKeyColumn[]>
): DiagramTableKeys[] {
	let result: DiagramTableKeys[] = [];

	for(let table of model.tables) {
		let keys = new KeyGrouper();

		for(let foreignKey of foreignKeysByTableId.get(table.id) ?? []) {
			keys.add('references', foreignKey.toSchema, foreignKey.toTable, foreignKey.constraintName, !!foreignKey.isNew, {
				column: foreignKey.fromColumn,
				otherShortName: foreignKey.toShortName,
				// An import's referenced column may be in either form; toColumn is whichever arrived.
				otherLongName: foreignKey.toLongName ?? (foreignKey.toShortName == null ? foreignKey.toColumn : undefined)
			});
		}

		for(let child of referencingByTableId.get(table.id) ?? []) {
			// A self-reference is already listed above as one of the table's own keys.
			if(diagramTableId(child.schema, child.table) === table.id) {
				continue;
			}

			keys.add('referencedBy', child.schema, child.table, child.constraintName, !!child.isNew, {
				column: child.column,
				otherShortName: child.childShortName,
				otherLongName: child.childLongName
			});
		}

		if(keys.size > 0) {
			result.push({tableId: table.id, keys: keys.values()});
		}
	}

	return result;
}

// table-resolver.ts names an imported key that came without one `imported-fk-N`, so its rows can be
// grouped like any other key's. Only an imported key can carry one.
function isSyntheticKeyName(name: string, isNew: boolean): boolean {
	return isNew && /^imported-fk-\d+$/i.test(name);
}

class KeyGrouper {
	private readonly byKey = new Map<string, DiagramTableKey>();

	get size(): number {
		return this.byKey.size;
	}

	add(direction: DiagramTableKey['direction'], otherSchema: string, otherTable: string, constraintName: string | undefined, isNew: boolean, column: DiagramKeyColumn): void {
		let name = constraintName ?? '';
		// An unnamed key can't be told apart from another unnamed key into the same table, so those share
		// an entry - still the right table to add, and the column pairs say what it joins on.
		let id = [direction, otherSchema, otherTable, name].map(part => part.toUpperCase()).join('|');
		let key = this.byKey.get(id);

		if(!key) {
			// The placeholder name stays in the grouping id above, so two unnamed imported keys into one table
			// stay apart, but isn't shown: it names nothing the user could look up.
			key = {direction: direction, constraintName: isSyntheticKeyName(name, isNew) ? '' : name, isNew: isNew, otherSchema: otherSchema, otherTable: otherTable, otherTableId: diagramTableId(otherSchema, otherTable), columns: []};
			this.byKey.set(id, key);
		}

		// The same pair twice (an import repeating a catalog row the resolver didn't recognize) is one pair.
		if(!key.columns.some(existing => existing.column === column.column && existing.otherShortName === column.otherShortName && existing.otherLongName === column.otherLongName)) {
			key.columns.push(column);
		}
	}

	values(): DiagramTableKey[] {
		return [...this.byKey.values()];
	}
}
