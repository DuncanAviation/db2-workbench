import { SqlImportSectionId, SqlImportTarget } from '../models/sql-import-config.js';
import { invertSqlImportMapping, sqlImportTableKey } from './sql-import-converter.js';
import { ImportedColumn, ImportedForeignKey, ImportedTableSchema } from './schema-format-converter.js';

// The lazily-loaded half of a SQL import. A SQL import's Tables statement is what lands in the tree;
// its Columns and Relationships sections are loaded per table, so what a table carries from an import
// is assembled on read rather than stored - see SqlSchemaImports for the cache and SchemaTrees for the
// tree store this merges against.
//
// A pure module with no VS Code or database-driver dependency, like sql-import-converter.ts and table-resolver.ts.

export interface SqlImportTableFragment {
	importId: string;
	/** The import's name - what a synthesized table's provenance uses as its sourceLabel. */
	importName: string;
	/** ISO string, from the import's provenance. */
	importedAt: string;
	schema: string;
	table: string;
	columns: ImportedColumn[];
	primaryKeyColumns: string[];
	foreignKeys: ImportedForeignKey[];
}

export function isEmptySqlImportFragment(fragment: SqlImportTableFragment): boolean {
	return fragment.columns.length === 0 && fragment.primaryKeyColumns.length === 0 && fragment.foreignKeys.length === 0;
}

// The two result columns a section is filtered on when its statement is run for specific tables. Only
// the tables-side targets can be filtered on - a Relationships statement is filtered on its CHILD side
// only, matching how MemoryCache.getForeignKeys works for real DB2 data, so an edge appears when the
// child table is the one being looked at.
export interface SqlImportFilterColumns {
	schemaColumn: string;
	tableColumn: string;
}

export function getSqlImportFilterColumns(section: SqlImportSectionId, mapping: Record<string, SqlImportTarget>): SqlImportFilterColumns | undefined {
	let inverted = invertSqlImportMapping(mapping);
	let schemaColumn = inverted.get(section === 'relationships' ? 'childSchema' : 'schema');
	let tableColumn = inverted.get(section === 'relationships' ? 'childTableSystemName' : 'tableSystemName');

	// Both are required targets of their section, so a mapping that reaches here without them never
	// passed the dialog's own validation. Returning undefined (rather than throwing) lets the caller
	// treat it the same way it treats a section with no statement at all: nothing to load.
	return schemaColumn && tableColumn ? {schemaColumn: schemaColumn, tableColumn: tableColumn} : undefined;
}

// Folds each table's lazily-loaded fragments into the ImportedTableSchema entries the tree already
// holds for it. An entry is matched by importId: the Tables statement's entry for this table is the one
// that import's columns and relationships belong on, and it always carries empty lists of both (see
// SqlSchemaImports.import), so a fragment replaces rather than merges.
//
// A fragment with no entry to land on becomes its own transient table. That happens when the import's
// Columns or Relationships statement names a table its own Tables statement never returned but DB2 has
// - the converter accepts that case deliberately (see convertSqlImportColumnRows' knownTables), and a
// relationship whose child is a real, undeclared table is exactly the motivating case. Transient means
// transient: it is built on read and never stored, so View Imports keeps listing only the tables the
// Tables statement actually returned.
export function mergeSqlImportFragments(imported: ImportedTableSchema[], fragments: SqlImportTableFragment[]): ImportedTableSchema[] {
	if(fragments.length === 0) {
		return imported;
	}

	let byImportId = new Map(fragments.map(fragment => [fragment.importId, fragment]));
	let used = new Set<string>();

	let merged = imported.map(table => {
		let fragment = byImportId.get(table.provenance.importId);

		if(!fragment) {
			return table;
		}

		used.add(fragment.importId);

		return {
			...table,
			columns: fragment.columns,
			primaryKeyColumns: fragment.primaryKeyColumns,
			foreignKeys: fragment.foreignKeys
		};
	});

	for(let fragment of fragments) {
		if(used.has(fragment.importId) || isEmptySqlImportFragment(fragment)) {
			continue;
		}

		merged.push({
			schema: fragment.schema,
			name: fragment.table,
			columns: fragment.columns,
			primaryKeyColumns: fragment.primaryKeyColumns,
			uniqueKeys: [],
			foreignKeys: fragment.foreignKeys,
			indexes: [],
			provenance: {
				importId: fragment.importId,
				sourceFormat: 'sql',
				sourceLabel: fragment.importName,
				importedAt: fragment.importedAt
			}
		});
	}

	return merged;
}

/** Cache key for one import's one section's rows for one table - see the plan's `(host, importId,
 * section, table)` keying. Host rather than connection config because the same statement run against
 * the same host produces the same rows whichever config (or user name) asked for them. */
export function sqlImportFragmentKey(host: string, importId: string, section: SqlImportSectionId, schema: string, table: string): string {
	return `${host.toUpperCase()}|${importId}|${section}|${sqlImportTableKey(schema, table)}`;
}
