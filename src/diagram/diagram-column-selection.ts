import { DiagramRelationship } from '../webview-messages/diagram-messages.js';

// Pure column-selection/relationship-highlighting logic - kept here (not in webviews/diagram/) for the
// same reason as diagram-zoom-tiers.ts: unit-testable through this project's existing convention, which
// only compiles src/. The webview imports these directly.

export function columnKey(tableId: string, columnName: string): string {
	return `${tableId}.${columnName}`;
}

// A column key is "<schema>.<table>.<column>" - the table id itself already contains a dot, so this
// only strips the exact "<tableId>." prefix rather than splitting on every dot, which would otherwise
// misparse the table id's own dot as the column separator.
export function columnNameFromKey(key: string, tableId: string): string | null {
	let prefix = `${tableId}.`;
	return key.startsWith(prefix) ? key.slice(prefix.length) : null;
}

// Every column key connected to `selectedKey` (plus itself), by walking every relationship once. Returns
// null for no selection, which callers should treat as "nothing is highlighted/dimmed".
export function relatedColumnKeys(relationships: DiagramRelationship[], selectedKey: string | null): Set<string> | null {
	if(!selectedKey) {
		return null;
	}

	let related = new Set<string>([selectedKey]);

	for(let relationship of relationships) {
		let fromKey = columnKey(relationship.fromTable, relationship.fromColumn);
		let toKey = columnKey(relationship.toTable, relationship.toColumn);

		if(fromKey === selectedKey) {
			related.add(toKey);
		}

		if(toKey === selectedKey) {
			related.add(fromKey);
		}
	}

	return related;
}

// The subset of `keys` that belong to `tableId`, with the table-id prefix stripped down to just the
// column name - what a table node needs to know which of its own rows to highlight.
export function columnNamesForTable(keys: ReadonlySet<string>, tableId: string): Set<string> {
	let names = new Set<string>();

	for(let key of keys) {
		let name = columnNameFromKey(key, tableId);

		if(name !== null) {
			names.add(name);
		}
	}

	return names;
}
