import { DiagramModel, DiagramRelationship, DiagramTable } from '../webview-messages/diagram-messages.js';

// Which end of a relationship gets a crow's foot ("many") and which gets a single bar ("one"). Nothing
// about this is stored in the file - a DiagramRelationship is always foreign-key-to-primary-key (see its
// own comment in diagram-messages.ts), so cardinality is derived from the columns' own key flags, and a
// diagram authored anywhere else (or by an older version of this extension) still renders correctly
// without needing a migration.
//
// Lives here rather than in webviews/diagram/ so it's unit-testable through the existing .spec.ts/mocha
// convention, same as diagram-edge-routing/diagram-filter/diagram-schema-links - the webview imports it
// directly and esbuild bundles across that boundary.

export type DiagramCardinality = 'one' | 'many';

export interface RelationshipCardinality {
	// The foreign-key side (relationship.fromTable/fromColumn).
	from: DiagramCardinality;
	// The referenced side (relationship.toTable/toColumn).
	to: DiagramCardinality;
}

// The referenced end is always "one": a foreign key points at a primary (or otherwise unique) key, so a
// given child row can only ever match a single parent row. That's an invariant of the relationship type
// itself, not something worth re-deriving from the target table's flags - a target column that somehow
// isn't flagged primaryKey (a unique-constraint reference, say) is still "one".
//
// The foreign-key end is "many" unless that column is by itself the whole primary key of its own table,
// which makes the relationship 1:1 rather than 1:N - a shared-primary-key extension/subtype table, a
// common enough DB2 pattern to be worth distinguishing. Being *part* of a composite primary key doesn't
// qualify: the column's own value can then still repeat across rows, so the "many" foot is still correct.
export function relationshipCardinality(relationship: DiagramRelationship, fromTable: DiagramTable | undefined): RelationshipCardinality {
	return {
		from: fromTable && isSolePrimaryKey(fromTable, relationship.fromColumn) ? 'one' : 'many',
		to: 'one'
	};
}

export function cardinalitiesByRelationshipId(model: DiagramModel): Map<string, RelationshipCardinality> {
	let tablesById = new Map(model.tables.map(table => [table.id, table]));

	return new Map(model.relationships.map(relationship => [relationship.id, relationshipCardinality(relationship, tablesById.get(relationship.fromTable))]));
}

function isSolePrimaryKey(table: DiagramTable, columnName: string): boolean {
	let primaryKeyNames = table.columns.filter(column => column.primaryKey).map(column => column.name);

	return primaryKeyNames.length === 1 && primaryKeyNames[0] === columnName;
}
