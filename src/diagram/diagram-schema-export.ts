import { DiagramColumn, DiagramModel, DiagramTable } from '../webview-messages/diagram-messages.js';
import { ResolvedColumn, ResolvedForeignKey, ResolvedIndex, ResolvedTable, ResolvedTableKey } from '../schema-conversion/schema-format-converter.js';

// Best-effort mapping from the diagram's own lightweight model to the schema-conversion package's
// ResolvedTable shape, so "Export as DBML"/"Export as Frictionless" can reuse the exact same converters
// (dbml-format.ts/frictionless-format.ts) the schema browser's own Export already does - one export
// implementation per format, not two that could drift.
//
// The diagram model still carries less than a live-resolved TableSchema: no identity detail beyond a
// boolean (no start/increment/min/max/cycle/cache), and no composite-FK grouping (a DiagramRelationship is
// always exactly one column each side - see [[diagram-add-tables.ts]]'s ResolvedRelationship, deliberately
// out of scope for now). Nullability, UNIQUE constraints (including composite), and indexes ARE carried
// (DiagramColumn.notNull/unique/indexed, DiagramTable.uniqueKeys/indexes - see diagram-resolved-table.ts)
// and mapped through below. This fills every field the diagram genuinely has and leaves the rest at its
// honest default (undefined, or the least consequential assumption - see existsInDatabase below) rather
// than fabricating DB2 facts the diagram was never told, per the user's own framing: export what we can,
// not everything the formats could in principle hold.

// The inverse of ColumnDetailsUtils.formatType ("CHAR(10)", "DECIMAL(7,2)", or a bare
// "INTEGER") - needed because the format converters branch on the DECOMPOSED fields (mapColumnType's
// exact-match switch in frictionless-format.ts, columnTypeText's precision-then-length fallback in
// dbml-format.ts), not on the combined display string. Passing the combined string through as `dataType`
// unparsed would silently misclassify every numeric/date/time column as a Frictionless "string" and skip
// DBML's length-aware indexes-block matching, since neither converter's own logic ever compares against
// anything but the bare type name.
const COLUMN_TYPE_PATTERN = /^([A-Za-z0-9_]+)(?:\((\d+)(?:,(\d+))?\))?$/;

function parseColumnType(type: string): { dataType: string; length?: number; precision?: number; scale?: number } {
	let match = COLUMN_TYPE_PATTERN.exec(type.trim());

	if(!match) {
		return { dataType: type };
	}

	let [, dataType, first, second] = match;

	if(!dataType) {
		return { dataType: type };
	}

	if(second !== undefined) {
		return { dataType: dataType, precision: Number(first), scale: Number(second) };
	}

	return first !== undefined ? { dataType: dataType, length: Number(first) } : { dataType: dataType };
}

// Both converters key every reference (a column's own field name, an FK's local/referenced columns, a
// PK's column list) by this - the same short "system" name the diagram's own column identity already
// prefers when one exists (see DiagramColumn.shortName's own comment), falling back to the diagram
// identity itself for an imported-only column that never had one.
function systemNameOf(column: DiagramColumn): string {
	return column.shortName ?? column.name;
}

// A relationship's fromColumn/toColumn are the diagram's own column IDENTITY (DiagramColumn.name, long
// SQL name when known) - not necessarily the system name systemNameOf resolves everything else to - so
// the actual column has to be looked up by identity first.
function findColumn(table: DiagramTable, identity: string): DiagramColumn | undefined {
	return table.columns.find(column => column.name === identity);
}

function toResolvedColumn(column: DiagramColumn): ResolvedColumn {
	let { dataType, length, precision, scale } = parseColumnType(column.type);

	return {
		systemName: systemNameOf(column),
		...(column.longName ? { sqlName: column.longName } : {}),
		dataType: dataType,
		...(length !== undefined ? { length: length } : {}),
		...(precision !== undefined ? { precision: precision } : {}),
		...(scale !== undefined ? { scale: scale } : {}),
		nulls: column.notNull ? 'N' : 'Y',
		...(column.description ? { text: column.description } : {}),
		identity: column.identity ? 'YES' : 'NO',
		isNew: !!column.imported,
		importedFields: []
	};
}

// One row per PK column, all sharing the SAME constraintName - table-resolver.ts's own synthetic name
// for an import-sourced primary key with no real one to preserve (see its own comment). Reusing that
// exact literal here is both honest (the diagram doesn't know DB2's actual constraint name either, same
// as an import never does) and load-bearing: groupByConstraint (shared by both converters) groups PK
// rows by constraintName, and it only ever sees one table's own `keys` array at a time, so a composite
// PK's columns still group into one constraint correctly - and isSyntheticConstraintName already treats
// this literal as "nothing worth naming", so it round-trips through DBML/Frictionless exactly like any
// other unnamed PK.
const SYNTHETIC_PRIMARY_KEY_NAME = 'imported-pk';

function toKeys(table: DiagramTable): ResolvedTableKey[] {
	let primaryKeyRows: ResolvedTableKey[] = table.columns
		.filter(column => column.primaryKey)
		.map((column, index) => ({
			constraintType: 'PRIMARY KEY',
			constraintName: SYNTHETIC_PRIMARY_KEY_NAME,
			systemColumnName: systemNameOf(column),
			ordinalPosition: index + 1,
			isNew: !!column.imported
		}));

	// One row per column per uniqueKeys GROUP (not per unique column) - table.uniqueKeys already has the
	// real (or table-resolver's own synthetic) constraint name and the composite grouping worked out (see
	// diagram-resolved-table.ts), so this just re-flattens it back to the one-row-per-column shape
	// groupByConstraint expects to regroup from, the same shape SYSCST/SYSKEYCST rows come in as.
	let uniqueKeyRows: ResolvedTableKey[] = (table.uniqueKeys ?? []).flatMap(group =>
		group.columns.flatMap((identity, index) => {
			let column = findColumn(table, identity);

			return column ? [{
				constraintType: 'UNIQUE',
				constraintName: group.name,
				systemColumnName: systemNameOf(column),
				ordinalPosition: index + 1,
				isNew: !!column.imported
			}] : [];
		})
	);

	return [...primaryKeyRows, ...uniqueKeyRows];
}

function toIndexes(table: DiagramTable): ResolvedIndex[] {
	return (table.indexes ?? []).map(index => ({
		indexName: index.name,
		uniqueness: index.unique ? 'Unique' : 'Not Unique',
		// Falls back to the raw identity for a column that somehow isn't found (shouldn't happen - every
		// identity here came from resolving this same table's own columns in diagram-resolved-table.ts -
		// but an index is still worth exporting with an honest column name over dropping it entirely).
		keyColumns: index.columns.map(identity => {
			let column = findColumn(table, identity);
			return column ? systemNameOf(column) : identity;
		}).join(', '),
		isNew: false
	}));
}

function toForeignKeys(model: DiagramModel, table: DiagramTable, tableById: ReadonlyMap<string, DiagramTable>, schemaNameById: ReadonlyMap<string, string>): ResolvedForeignKey[] {
	return model.relationships
		.filter(relationship => relationship.fromTable === table.id)
		.flatMap(relationship => {
			let fromColumn = findColumn(table, relationship.fromColumn);
			let toTable = tableById.get(relationship.toTable);
			let toColumn = toTable && findColumn(toTable, relationship.toColumn);

			// Both ends have to resolve to a real column on their own table - shouldn't happen on a
			// well-formed diagram (a relationship only ever anchors to columns that exist), but skipped
			// rather than exported with a fabricated identifier if it somehow doesn't.
			if(!fromColumn || !toTable || !toColumn) {
				return [];
			}

			return [{
				// No constraintName: a diagram relationship is always exactly one column each side (there is
				// no composite-FK concept in the model at all), so leaving it undefined and letting
				// groupByConstraint's per-row fallback apply is correct - there is no composite grouping to
				// preserve, not a gap in this mapping.
				systemColumnName: systemNameOf(fromColumn),
				ordinalPosition: 1,
				referencedSchema: schemaNameById.get(toTable.schemaId) ?? toTable.schemaId,
				referencedTable: toTable.name,
				referencedSystemColumnName: systemNameOf(toColumn),
				isNew: !!fromColumn.imported
			}];
		});
}

export function diagramModelToResolvedTables(model: DiagramModel): ResolvedTable[] {
	let schemaNameById = new Map(model.schemas.map(schema => [schema.id, schema.name]));
	let tableById = new Map(model.tables.map(table => [table.id, table]));

	return model.tables.map(table => ({
		schema: schemaNameById.get(table.schemaId) ?? table.schemaId,
		name: table.name,
		...(table.description ? { description: table.description } : {}),
		// 'orphaned' doesn't retain which of the other two it used to be - true is the safer default (a
		// real, once-connected table Sync just couldn't re-resolve last time), since claiming a table
		// doesn't exist in DB2 at all is the stronger, more consequential claim to get wrong.
		existsInDatabase: table.importStatus !== 'imported',
		columns: table.columns.map(toResolvedColumn),
		keys: toKeys(table),
		foreignKeys: toForeignKeys(model, table, tableById, schemaNameById),
		indexes: toIndexes(table)
	}));
}
