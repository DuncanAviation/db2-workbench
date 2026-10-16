import { ResolvedColumn, ResolvedForeignKey as SchemaResolvedForeignKey, ResolvedTable as SchemaResolvedTable, ResolvedTableKey } from '../schema-conversion/schema-format-converter.js';
import { groupByConstraint } from '../schema-conversion/formats/key-grouping.js';
import { isUniqueIndex } from '../schema-conversion/formats/dbml-format.js';
import { ColumnDetailsUtils } from '../utils/column-details.js';
import { StringUtils } from '../utils/string-utils.js';
import { DiagramColumn, DiagramTable } from '../webview-messages/diagram-messages.js';
import { ResolvedForeignKey, ResolvedTable } from './diagram-add-tables.js';
import { matchesColumnName } from './diagram-column-labels.js';

// Maps a table-resolver ResolvedTable (live DB2 data reconciled with whatever this session's schema
// imports contributed - see src/schema-conversion/table-resolver.ts) into the ResolvedTable shape
// diagram-add-tables.ts consumes. Split out from the provider so it can be unit tested - everything it
// depends on is a plain interface with no vscode import, unlike DiagramEditorProvider itself.
//
// This is the one path every add takes. It replaced a mapping straight off the raw catalog rows once
// imports could reach the diagram's table picker: going through the resolver instead is what lets an
// imported-only table become a real box, and an "enhanced" one bring its imported extras (most usefully
// foreign keys that don't exist in DB2 at all) along with its real columns.
//
// Two ResolvedTable/ResolvedForeignKey types are in play here and they are NOT the same thing: the
// schema-conversion ones (aliased Schema* below) are catalog-shaped rows with every DB2-only field
// optional, while the diagram's own are the minimal {columns, foreignKeys} definition addTables lays
// out. This file is the only place the two meet.
//
// Every DiagramColumn produced here carries all three of DB2's name forms, not just the one it's keyed
// by (see DiagramColumn's own comment). That is what lets a foreign key naming a column the short way -
// which an imported one always does, since imports carry short names - resolve to the right column,
// whether it's matched during this add or against a table already on the diagram and read back from the
// file. It's also what lets the row be LABELLED per the user's resultHeadingLabels setting without any
// of that touching identity: see diagram-column-labels.ts.

/**
 * Long SQL name where there is one, short system name otherwise. An imported column has only the
 * latter, so this is what keeps a wholly-imported table internally consistent rather than half-named -
 * and it deliberately doesn't consult the display setting, since it becomes the column's identity.
 */
function columnIdentity(column: ResolvedColumn): string {
	return StringUtils.isNotBlank(column.sqlName) ? column.sqlName : column.systemName;
}

// SYSCST.CONSTRAINT_TYPE carries 'UNIQUE' as well as 'PRIMARY KEY' (see SystemTableKey), and only the
// latter is a primary key for cardinality purposes - see diagram-cardinality.ts, which reads a 1:1
// relationship off a column being the table's sole primary key.
function isPrimaryKey(key: ResolvedTableKey): boolean {
	return (key.constraintType ?? '').toUpperCase() === 'PRIMARY KEY';
}

function isUniqueKey(key: ResolvedTableKey): boolean {
	return (key.constraintType ?? '').toUpperCase() === 'UNIQUE';
}

// One entry per UNIQUE constraint (not per column) - groupByConstraint is the same grouping
// table-resolver.ts's own resolveTableKeys already applies to these rows, reused here rather than
// re-deriving "what counts as one constraint" a second time. `name` is the real constraint name, or
// table-resolver's own synthetic one for an import-only constraint with none to preserve - either way,
// exactly what a tooltip or an export should call it. undefined (not []) when the table has none, so
// DiagramTable.uniqueKeys round-trips absent rather than an empty array.
function toDiagramUniqueKeys(resolved: SchemaResolvedTable, columns: DiagramColumn[]): DiagramTable['uniqueKeys'] {
	let groups = groupByConstraint(resolved.keys.filter(isUniqueKey));

	if(groups.length === 0) {
		return undefined;
	}

	return groups.map(group => ({
		name: group[0]?.constraintName ?? '',
		columns: group.map(key => resolveColumnName(columns, key.columnName, key.systemColumnName))
	}));
}

// One entry per physical DB2 index (QSYS2.SYSPARTITIONINDEXSTAT already returns one row per index, its
// key columns already together in `keyColumns` - unlike keys/foreign keys, there's no per-column-row
// grouping step needed here). ASC/DESC suffixes are stripped the same way table-resolver.ts's own
// indexSignature does, so a descending key column still resolves to a real column name instead of
// carrying " DESC" into it. undefined (not []) when the table has none, same reasoning as
// toDiagramUniqueKeys above.
function toDiagramIndexes(resolved: SchemaResolvedTable, columns: DiagramColumn[]): DiagramTable['indexes'] {
	if(resolved.indexes.length === 0) {
		return undefined;
	}

	return resolved.indexes.map(index => ({
		name: index.indexName ?? '',
		columns: (index.keyColumns ?? '')
			.split(',')
			.map(name => name.trim().replace(/\s+(ASC|DESC)$/i, ''))
			.filter(name => name.length > 0)
			.map(name => resolveColumnName(columns, name)),
		unique: isUniqueIndex(index.uniqueness ?? '')
	}));
}

// A key or foreign-key row names its column in whichever form its source had: DB2's catalog fills both,
// an import only ever fills the short one. Resolved against the mapped columns (which carry every form)
// so it lands on the identity the diagram actually keys that column by.
function resolveColumnName(columns: DiagramColumn[], ...candidates: (string | undefined)[]): string {
	for(let candidate of candidates) {
		if(candidate && StringUtils.isNotBlank(candidate)) {
			return columns.find(column => matchesColumnName(column, candidate))?.name ?? candidate;
		}
	}

	return '';
}

export function toDiagramTable(resolved: SchemaResolvedTable): ResolvedTable {
	// Connected rows carry colNo and come back in catalog order; a row that exists only in an import has
	// none at all, so those keep the order the resolver appended them in (after every real column) rather
	// than being shuffled to the front by a missing sort key. Array.sort is stable, so that holds.
	let sorted = [...resolved.columns].sort((left, right) => (left.colNo ?? Number.MAX_SAFE_INTEGER) - (right.colNo ?? Number.MAX_SAFE_INTEGER));
	let columns = sorted.map(column => toDiagramColumn(column));

	let primaryKeyColumns = new Set(resolved.keys
		.filter(key => isPrimaryKey(key))
		.map(key => resolveColumnName(columns, key.columnName, key.systemColumnName)));

	let uniqueKeys = toDiagramUniqueKeys(resolved, columns);
	let indexes = toDiagramIndexes(resolved, columns);
	let uniqueColumns = new Set(uniqueKeys?.flatMap(group => group.columns) ?? []);
	let indexedColumns = new Set(indexes?.flatMap(index => index.columns) ?? []);

	let foreignKeys = resolved.foreignKeys.map(foreignKey => toResolvedForeignKey(foreignKey, resolved.schema, columns));
	let foreignKeyColumns = new Set(foreignKeys.map(foreignKey => foreignKey.fromColumn));

	// Zipped by index against resolved.foreignKeys (same order, same length - both come from that one
	// .map above) rather than re-deriving isNew from the mapped foreignKeys, which no longer carries it
	// (toResolvedForeignKey drops it, same as it drops everything else DB2-only). A column can be a real,
	// unmodified column and STILL be "enhanced" this way: an import can add a foreign key that references
	// an existing column without changing anything about the column itself, and the column-level `isNew`/
	// `importedFields` flags toDiagramColumn already checked have nothing to say about that case.
	let importedForeignKeyColumns = new Set(
		foreignKeys.filter((foreignKey, index) => resolved.foreignKeys[index]?.isNew).map(foreignKey => foreignKey.fromColumn)
	);

	return {
		schema: resolved.schema,
		table: resolved.name,
		...(StringUtils.isNotBlank(resolved.description) ? {description: resolved.description} : {}),
		...tableImportStatus(resolved, columns),
		...(uniqueKeys ? {uniqueKeys: uniqueKeys} : {}),
		...(indexes ? {indexes: indexes} : {}),
		// The key/unique/index flags are applied here rather than inside toDiagramColumn, since resolving a
		// key's column name needs the mapped columns to match against in the first place - same reasoning
		// now applies to folding in importedForeignKeyColumns.
		columns: columns.map(column => ({
			...column,
			primaryKey: primaryKeyColumns.has(column.name),
			foreignKey: foreignKeyColumns.has(column.name),
			unique: uniqueColumns.has(column.name),
			indexed: indexedColumns.has(column.name),
			...((column.imported || importedForeignKeyColumns.has(column.name)) ? {imported: true} : {})
		})),
		foreignKeys: foreignKeys
	};
}

/**
 * 'imported' when the table doesn't exist in DB2 at all (every field came from an import); 'enhanced'
 * when a real, connected table has picked up at least one import-sourced column, key, or foreign key;
 * omitted for a plain connected table with no import touching it at all. Mirrors the schema browser's
 * own badge derivation (table-detail.tsx's `badge`), just computed from the already-resolved data here
 * (resolved.keys/foreignKeys still carry `isNew` at this point, before toResolvedForeignKey drops it)
 * instead of from raw connected/imported presence, since that's all this module has to work with.
 */
function tableImportStatus(resolved: SchemaResolvedTable, columns: DiagramColumn[]): {importStatus: 'imported' | 'enhanced'} | Record<string, never> {
	if(!resolved.existsInDatabase) {
		return {importStatus: 'imported'};
	}

	let hasImportedData = columns.some(column => column.imported)
		|| resolved.keys.some(key => key.isNew)
		|| resolved.foreignKeys.some(foreignKey => foreignKey.isNew);

	return hasImportedData ? {importStatus: 'enhanced'} : {};
}

// Undefined rather than '' for "no description at all", so the spread above omits the field entirely
// instead of storing a blank one that columnDisplayName would then have to skip.
function describe(column: ResolvedColumn): string | undefined {
	if(StringUtils.isNotBlank(column.heading)) {
		return column.heading;
	}

	return StringUtils.isNotBlank(column.text) ? column.text : undefined;
}

function toDiagramColumn(column: ResolvedColumn): DiagramColumn {
	let description = describe(column);

	return {
		name: columnIdentity(column),
		// Each is written even when it equals the identity: what matters downstream is which FORM a name
		// is, so an alias left out because it happened to match would defeat the point.
		...(StringUtils.isNotBlank(column.systemName) ? {shortName: column.systemName} : {}),
		...(StringUtils.isNotBlank(column.sqlName) ? {longName: column.sqlName} : {}),
		// SystemColumn.heading first - DB2's column heading is what the Columns tab and ColumnNameUtils
		// both show for "Description", so a diagram row labelled Description says the same thing a
		// results-grid header does. Falling back to the free-text `text` remark only when there's no
		// heading at all: that's the ONLY thing an import can supply here (table-resolver puts an imported
		// column description in `text`), so without the fallback an imported-only column would have no
		// description to label with whatever the user configured. Gap-fill, never an override - a real
		// heading always wins, exactly as table-resolver treats the same two fields.
		...(description ? {description: description} : {}),
		type: ColumnDetailsUtils.formatType(column),
		primaryKey: false,
		foreignKey: false,
		identity: (column.identity ?? '').toUpperCase() === 'YES',
		// 'Y' means nullable, 'N' means NOT NULL (SYSCOLUMNS2.NULLS / ImportedColumn.nullable, mapped to the
		// same 'Y'/'N' convention by table-resolver.ts) - required on ResolvedColumn regardless of source, so
		// this is never a guess the way diagram-schema-export.ts's own default has to be for the reverse
		// direction (a diagram round-tripping this back out with no live connection to ask).
		notNull: column.nulls.toUpperCase() !== 'Y',
		// unique/indexed are filled in below (toDiagramTable), same reasoning as primaryKey/foreignKey above.
		unique: false,
		indexed: false,
		// New (doesn't exist in DB2) or gap-filled from an import (see mergeConnectedColumn in
		// table-resolver.ts) - either way, something about THIS column, not just its owning table, came
		// from an import.
		...(column.isNew || column.importedFields.length > 0 ? {imported: true} : {})
	};
}

// referencedSchema is optional on a resolved row because an import needn't qualify its target - DBML
// has no schema concept at the reference site at all - so an unqualified target is read as pointing
// within the declaring table's own schema, which is what makes a single-schema DBML file resolve.
//
// The referenced COLUMN is deliberately left in whatever form it arrived: only the target table knows
// what its own columns are called, and addTables resolves both ends against the tables actually in play
// (see buildRelationships) rather than trusting a name resolved here against the wrong table's columns.
function toResolvedForeignKey(foreignKey: SchemaResolvedForeignKey, schema: string, columns: DiagramColumn[]): ResolvedForeignKey {
	return {
		fromColumn: resolveColumnName(columns, foreignKey.columnName, foreignKey.systemColumnName),
		toSchema: StringUtils.isNotBlank(foreignKey.referencedSchema) ? foreignKey.referencedSchema : schema,
		toTable: foreignKey.referencedTable,
		toColumn: foreignKey.referencedColumnName ?? foreignKey.referencedSystemColumnName
	};
}
