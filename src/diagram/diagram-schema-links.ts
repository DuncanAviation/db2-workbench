import { DiagramModel } from '../webview-messages/diagram-messages.js';

// At the most-zoomed-out ("cluster") tier, individual tables and their column-level relationship lines
// are hidden entirely and only the schema boxes themselves are visible (see diagram-zoom-tiers.ts) - this
// still surfaces that two schemas ARE related by drawing one line between their boxes. A relationship
// only produces a link when its two tables belong to different schemas (a same-schema relationship has
// nothing to draw a line between - both ends are already inside the one visible box), and multiple
// relationships between the same two schemas collapse into a single link, deduplicated by unordered pair.

export interface SchemaLink {
	id: string;
	schemaA: string;
	schemaB: string;
}

export function schemaLinks(model: DiagramModel): SchemaLink[] {
	let schemaIdByTableId = new Map(model.tables.map(table => [table.id, table.schemaId]));
	let seenPairIds = new Set<string>();
	let links: SchemaLink[] = [];

	for(let relationship of model.relationships) {
		let fromSchemaId = schemaIdByTableId.get(relationship.fromTable);
		let toSchemaId = schemaIdByTableId.get(relationship.toTable);

		if(!fromSchemaId || !toSchemaId || fromSchemaId === toSchemaId) {
			continue;
		}

		let [schemaA, schemaB] = [fromSchemaId, toSchemaId].sort();
		let id = `${schemaA}--${schemaB}`;

		if(seenPairIds.has(id)) {
			continue;
		}

		seenPairIds.add(id);
		links.push({id, schemaA, schemaB});
	}

	return links;
}
