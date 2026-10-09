import { SystemColumn } from '../models/system-column.js';
import { SystemForeignKey } from '../models/system-foreign-key.js';
import { SystemIndex } from '../models/system-index.js';
import { SystemTableKey } from '../models/system-table-key.js';
import { TableSchema } from '../models/table-schema.js';
import { ColumnNames, ColumnNameUtils } from '../utils/column-name-utils.js';
import { StringUtils } from '../utils/string-utils.js';
import { groupByConstraint } from './formats/key-grouping.js';
import { ImportedColumn, ImportedTableSchema, ResolvedColumn, ResolvedForeignKey, ResolvedIndex, ResolvedTable, ResolvedTableKey } from './schema-format-converter.js';

// The one place connected-vs-imported reconciliation happens - every consumer (tab data fetch,
// export, the future create/update-in-database step) calls these instead of reading System*/
// ImportedTableSchema data directly, so none of them need to know reconciliation exists at all. Plain
// functions, not a stateful/lazily-resolving object: this extension is two separate JS processes
// (extension host / webview) talking only through postMessage+JSON, so a live object with resolving
// getters could never cross that boundary as behavior - only the already-resolved plain data can. See
// [[imported-schema-tree-integration-plan]] for the design discussion this came out of.
//
// Precedence: connected/live DB2 data always wins. Among multiple imports, the *first*-imported one
// wins on a conflict, not the most recent - a "discard/retract an import" feature is planned future
// work for fixing a bad first import, not built yet.
//
// Phase 1 scope: when a connected TABLE exists, its data is returned unchanged and every import is
// ignored - the enhanced-case merge (surfacing imported extras alongside real DB2 data) is deliberately
// a no-op until later phases improve these functions' internals. When no connected table exists, there's
// nothing to reconcile against, so imported data is resolved directly (first-imported-wins across
// multiple imports of the same new row) and every row is flagged `isNew`.
//
// Every function below takes `connected` as `T[] | undefined`, not just `T[]` - `undefined` means "no
// connected table at all", an empty array means "a real, connected table that just happens to have zero
// of this kind of row" (e.g. no real foreign keys - the exact scenario this feature exists for). Using
// `.length > 0` as the branch condition would conflate those two completely different situations and
// silently let imported data leak into a real table's supposedly-authoritative-and-empty result.

// Matching rule (see [[imported-schema-tree-integration-plan]]): exact, case-insensitive match on any NAME
// form either side carries (ColumnNameUtils's matching rule) - the connected column's short systemName and
// long sqlName against the imported column's declared name and any long name its file carried. An
// external catalog of logical relationships/labels is far more likely to use the long business name than
// DB2's short one. First-imported-wins across multiple imports, same precedence as everywhere else here.
function findImportedColumn(column: SystemColumn, imported: ImportedTableSchema[]): ImportedColumn | undefined {
	let aliases = ColumnNameUtils.aliases(ColumnNameUtils.fromSystemColumn(column));

	for(let table of imported) {
		let match = table.columns.find(candidate => aliases.some(alias => ColumnNameUtils.matches(ColumnNameUtils.fromImportedColumn(candidate), alias)));

		if(match) {
			return match;
		}
	}

	return undefined;
}

// Phase 2 (Columns tab) reconciliation for the enhanced case: gap-fill only - an imported column's
// description only ever fills in `text` when DB2's own is blank, never overrides a real DB2 value that's
// already there. Explicitly decided this way (not "import wins, flagged") when phase 2 was scoped -
// reviewing/choosing between a real and an imported value where both exist is future work, not this
// phase. `text` is the only field worth gap-filling at all: DB2 always authoritatively knows
// systemName/sqlName/dataType/nulls for a connected column, so there's never a real gap in those for an
// import to fill.
function mergeConnectedColumn(column: SystemColumn, imported: ImportedTableSchema[]): ResolvedColumn {
	let resolved: ResolvedColumn = {...column, isNew: false, importedFields: []};

	if(imported.length === 0) {
		return resolved;
	}

	let match = findImportedColumn(column, imported);

	if(match && StringUtils.isBlank(column.text) && StringUtils.isNotBlank(match.description)) {
		resolved.text = match.description;
		resolved.importedFields = ['text'];
	}

	return resolved;
}

// Builds ResolvedColumn rows purely from imported data - first-imported-wins across multiple imports of
// the same new column, matched by name (case-insensitive). Used both when there's no connected table at
// all, and (via excludeNames) to surface an imported column that has no DB2 counterpart alongside an
// otherwise-connected table's own columns - see resolveColumns. Explicitly revisited from the original
// phase-1 "nothing net-new appears for columns" plan once real testing showed a genuinely new imported
// column silently vanishing on an Enhanced table was surprising, not useful.
// The facts only a site-specific source (today, a SQL import) can supply. Spread in rather than
// assigned directly so a fact the import did not carry stays absent from the resolved row instead of
// becoming a present-but-undefined field - consumers distinguish the two.
function importedColumnFacts(column: ImportedColumn): Partial<ResolvedColumn> {
	let facts: Partial<ResolvedColumn> = {};

	if(column.length !== undefined) {
		facts.length = column.length;
	}

	if(column.scale !== undefined) {
		facts.scale = column.scale;
	}

	if(column.defaultValue !== undefined) {
		facts.defaultValue = column.defaultValue;
	}

	if(column.colNo !== undefined) {
		facts.colNo = column.colNo;
	}

	return facts;
}

// Seen/excluded by every name form (declared name and long name), not just the declared one - two imports
// naming the same column differently (one short, one long) still describe one column.
function resolveNewColumns(imported: ImportedTableSchema[], excludeNames: Set<string> = new Set()): ResolvedColumn[] {
	let resolved: ResolvedColumn[] = [];
	let seenNames = new Set(excludeNames);

	for(let table of imported) {
		for(let column of table.columns) {
			let aliases = ColumnNameUtils.aliases(ColumnNameUtils.fromImportedColumn(column)).map(alias => alias.toUpperCase());

			if(aliases.some(alias => seenNames.has(alias))) {
				continue;
			}

			aliases.forEach(alias => seenNames.add(alias));
			resolved.push({
				systemName: column.name,
				sqlName: column.sqlName,
				dataType: column.type,
				nulls: column.nullable ? 'Y' : 'N',
				text: column.description,
				isNew: true,
				importedFields: [],
				...importedColumnFacts(column)
			});
		}
	}

	return resolved;
}

export function resolveColumns(connected: SystemColumn[] | undefined, imported: ImportedTableSchema[]): ResolvedColumn[] {
	if(connected !== undefined) {
		let matchedNames = new Set(connected.flatMap(column => ColumnNameUtils.aliases(ColumnNameUtils.fromSystemColumn(column)).map(alias => alias.toUpperCase())));
		return [...connected.map(column => mergeConnectedColumn(column, imported)), ...resolveNewColumns(imported, matchedNames)];
	}

	return resolveNewColumns(imported);
}

// Builds ResolvedTableKey rows purely from imported data - used both when there's no connected table at
// all, and (via the exclude params) to surface an imported constraint that has no DB2 counterpart
// alongside an otherwise-connected table's own keys - see resolveTableKeys. A table can only ever have
// one real primary key, so an imported one is only ever shown when the connected table has none of its
// own at all (excludePrimaryKey); a unique constraint is its own independent thing, so each imported one
// is shown unless a connected constraint already covers the exact same column set.
function buildNewTableKeyRows(imported: ImportedTableSchema[], excludePrimaryKey: boolean, existingUniqueColumnSets: Set<string>, resolveColumnName: (name: string) => string): ResolvedTableKey[] {
	let rows: ResolvedTableKey[] = [];

	// Identity for a primary key, like a foreign key (see resolveForeignKeys below), is the whole column
	// group, not a single column - the first import that declares one wins outright, rather than merging
	// columns from multiple imports' partial PK definitions.
	let firstPrimaryKey = excludePrimaryKey ? undefined : imported.find(table => table.primaryKeyColumns.length > 0);

	if(firstPrimaryKey) {
		firstPrimaryKey.primaryKeyColumns.forEach((columnName, index) => {
			rows.push({
				// Real when the source format could name it (DBML); a synthetic, shared fallback otherwise -
				// not a real constraint, but every column of this composite PK still needs to land in the
				// same group wherever a consumer groups rows by constraintName (e.g. dbml-format's own
				// Ref/index-block building), the same way a real constraint name would.
				constraintName: firstPrimaryKey.primaryKeyName ?? 'imported-pk',
				constraintType: 'PRIMARY KEY',
				systemColumnName: columnName,
				ordinalPosition: index + 1,
				isNew: true
			});
		});
	}

	// Identity for a unique key is likewise the whole column set - first-imported-wins per distinct set,
	// same precedence rule as everything else in this file.
	let seenUniqueSignatures = new Set<string>(existingUniqueColumnSets);
	let nextSyntheticId = 0;

	for(let table of imported) {
		for(let group of table.uniqueKeys) {
			let signature = columnSetSignature(group.columns, resolveColumnName);

			if(seenUniqueSignatures.has(signature)) {
				continue;
			}

			seenUniqueSignatures.add(signature);
			let constraintName = group.name ?? `imported-unique-${nextSyntheticId++}`;

			group.columns.forEach((columnName, index) => {
				rows.push({
					constraintName,
					constraintType: 'UNIQUE',
					systemColumnName: columnName,
					ordinalPosition: index + 1,
					isNew: true
				});
			});
		}
	}

	return rows;
}

// connectedColumns is the connected table's own column list, as for resolveIndexes - see
// buildColumnNameResolver for why a key's columns are resolved through it before being compared.
export function resolveTableKeys(connected: SystemTableKey[] | undefined, imported: ImportedTableSchema[], connectedColumns?: SystemColumn[]): ResolvedTableKey[] {
	let resolveColumnName = buildColumnNameResolver(connectedColumns, imported);

	if(connected !== undefined) {
		let hasConnectedPrimaryKey = connected.some(key => key.constraintType === 'PRIMARY KEY');
		let connectedUniqueColumnSets = new Set(
			groupByConstraint(connected.filter(key => key.constraintType === 'UNIQUE'))
				.map(group => columnSetSignature(group.map(row => row.systemColumnName), resolveColumnName))
		);

		return [
			...connected.map(key => ({...key, isNew: false})),
			...buildNewTableKeyRows(imported, hasConnectedPrimaryKey, connectedUniqueColumnSets, resolveColumnName)
		];
	}

	return buildNewTableKeyRows(imported, false, new Set(), resolveColumnName);
}

// Identity for a unique key is its column SET - order doesn't matter, unlike an index's column list.
function columnSetSignature(columns: string[], resolveColumnName: (name: string) => string): string {
	return columns.map(resolveColumnName).sort().join('|');
}

// Identity for a foreign key is the whole relationship (columns + referenced table/columns), not a
// single field - see the two-tier reconciliation model in [[imported-schema-tree-integration-plan]]. The
// table's own columns resolve through its column list (see buildColumnNameResolver); the REFERENCED
// columns belong to another table, whose column list isn't in hand here, so they're compared as written.
function foreignKeySignature(columns: string[], referencedSchema: string | undefined, referencedTable: string, referencedColumns: string[], resolveColumnName: (name: string) => string): string {
	return [
		columns.map(resolveColumnName).join(','),
		(referencedSchema ?? '').toUpperCase(),
		referencedTable.toUpperCase(),
		referencedColumns.join(',').toUpperCase()
	].join('|');
}

// Builds ResolvedForeignKey rows purely from imported data - used both when there's no connected table
// at all, and (via existingSignatures) to surface an imported relationship that DB2 doesn't already
// report alongside an otherwise-connected table's own foreign keys - see resolveForeignKeys. This is the
// "whole-row flagging" half of the reconciliation model, and the one that actually delivers the
// motivating use case: this shop's DB2 tables have no real FK constraints at all, so an imported
// relationship is almost always new.
function buildNewForeignKeyRows(imported: ImportedTableSchema[], existingSignatures: Set<string>, resolveColumnName: (name: string) => string): ResolvedForeignKey[] {
	let bySignature = new Map<string, ResolvedForeignKey[]>();
	let nextSyntheticId = 0;

	for(let table of imported) {
		for(let foreignKey of table.foreignKeys) {
			let signature = foreignKeySignature(foreignKey.columns, foreignKey.referencedSchema, foreignKey.referencedTable, foreignKey.referencedColumns, resolveColumnName);

			if(bySignature.has(signature) || existingSignatures.has(signature)) {
				continue;
			}

			// Real when the source format could name it (DBML); a synthetic, shared fallback otherwise -
			// not a real constraint, but every column of this composite relationship still needs to land in
			// the same group wherever a consumer groups rows by constraintName (e.g. dbml-format's own
			// Ref-line building), the same way a real constraint name would.
			let constraintName = foreignKey.name ?? `imported-fk-${nextSyntheticId++}`;

			let rows: ResolvedForeignKey[] = foreignKey.columns.map((columnName, index) => ({
				constraintName,
				systemColumnName: columnName,
				ordinalPosition: index + 1,
				updateRule: foreignKey.updateRule,
				deleteRule: foreignKey.deleteRule,
				referencedSchema: foreignKey.referencedSchema,
				referencedTable: foreignKey.referencedTable,
				referencedSystemColumnName: foreignKey.referencedColumns[index],
				isNew: true
			}));

			bySignature.set(signature, rows);
		}
	}

	return Array.from(bySignature.values()).flat();
}

// connectedColumns: see resolveTableKeys.
export function resolveForeignKeys(connected: SystemForeignKey[] | undefined, imported: ImportedTableSchema[], connectedColumns?: SystemColumn[]): ResolvedForeignKey[] {
	let resolveColumnName = buildColumnNameResolver(connectedColumns, imported);

	if(connected !== undefined) {
		let existingSignatures = new Set(
			groupByConstraint(connected).map(group => foreignKeySignature(
				group.map(row => row.systemColumnName),
				group[0].referencedSchema,
				group[0].referencedTable,
				group.map(row => row.referencedSystemColumnName),
				resolveColumnName
			))
		);

		return [...connected.map(foreignKey => ({...foreignKey, isNew: false})), ...buildNewForeignKeyRows(imported, existingSignatures, resolveColumnName)];
	}

	return buildNewForeignKeyRows(imported, new Set(), resolveColumnName);
}

// Every constraint/index comparison in this file names its columns in whichever form its source had:
// SYSPARTITIONINDEXSTAT.COLUMN_NAMES reports short or long names depending on how the index was created
// (not consistent across shops, or even across indexes on one table), the constraint catalogs report
// short names, and an import uses whatever its source did - a DBML/Frictionless export writes short
// names, an external catalog is likely to use long ones. Comparing those raw would show every one of a
// table's keys or indexes as "new" on an import that names columns the other way. So each name is
// resolved first, through ColumnNameUtils's matching rule, to one canonical form: the connected column's
// short systemName, else (for a column only an import knows) the name the import declared it with.
// Connected columns come first, so they win a name both sides answer to. A name nothing recognizes
// falls back to itself, uppercased - no worse off than a raw comparison.
function buildColumnNameResolver(connectedColumns: SystemColumn[] | undefined, imported: ImportedTableSchema[]): (name: string) => string {
	let candidates: ColumnNames[] = [
		...(connectedColumns ?? []).map(ColumnNameUtils.fromSystemColumn),
		...imported.flatMap(table => table.columns.map(ColumnNameUtils.fromImportedColumn))
	];
	let resolve = ColumnNameUtils.buildResolver(candidates, names => names);

	return name => (resolve(name)?.identity ?? name).toUpperCase();
}

// Identity for a physical index is its column list, in order (unlike a table key/FK's column *set* -
// index column order genuinely matters for which queries an index actually serves, so (A,B) and (B,A)
// are different indexes, not duplicates of each other). SYSPARTITIONINDEXSTAT.COLUMN_NAMES appends
// " DESC" after a descending key column's name - stripped here so a connected index's column list
// compares cleanly against an imported one's plain column names. resolveColumnName then normalizes
// short/long name variants down to one identity - see buildColumnNameResolver above.
function indexSignature(columns: string[], resolveColumnName: (name: string) => string): string {
	return columns.map(name => name.trim().replace(/\s+(ASC|DESC)$/i, '')).filter(name => name.length > 0).map(resolveColumnName).join(',');
}

// Builds ResolvedIndex rows purely from imported data - used both when there's no connected table at
// all, and (via existingSignatures) to surface an imported index that doesn't already exist for real
// alongside an otherwise-connected table's own indexes - see resolveIndexes.
function buildNewIndexRows(imported: ImportedTableSchema[], existingSignatures: Set<string>, resolveColumnName: (name: string) => string): ResolvedIndex[] {
	let bySignature = new Map<string, ResolvedIndex>();

	for(let table of imported) {
		for(let index of table.indexes) {
			let signature = indexSignature(index.columns, resolveColumnName);

			if(bySignature.has(signature) || existingSignatures.has(signature)) {
				continue;
			}

			bySignature.set(signature, {
				indexName: index.name,
				uniqueness: index.unique ? 'Unique' : 'Not Unique',
				keyColumns: index.columns.join(', '),
				comment: index.comment,
				isNew: true
			});
		}
	}

	return Array.from(bySignature.values());
}

// connectedColumns is the connected table's own column list (undefined when there's no connected table
// at all) - passed through to buildColumnNameResolver so a connected index's keyColumns and an
// imported index's columns resolve to the same short/long-name identity before being compared. See
// buildColumnNameResolver.
export function resolveIndexes(connected: SystemIndex[] | undefined, imported: ImportedTableSchema[], connectedColumns?: SystemColumn[]): ResolvedIndex[] {
	let resolveColumnName = buildColumnNameResolver(connectedColumns, imported);

	if(connected !== undefined) {
		let existingSignatures = new Set(connected.map(index => indexSignature(index.keyColumns.split(','), resolveColumnName)));
		let resolvedConnected = connected.map(index => ({
			...index,
			created: index.created.toISOString(),
			lastBuild: index.lastBuild.toISOString(),
			lastQueryUsed: index.lastQueryUsed?.toISOString() ?? null,
			lastUsed: index.lastUsed?.toISOString() ?? null,
			isNew: false
		}));

		return [...resolvedConnected, ...buildNewIndexRows(imported, existingSignatures, resolveColumnName)];
	}

	return buildNewIndexRows(imported, new Set(), resolveColumnName);
}

// Gap-fill only, same rule as mergeConnectedColumn: an imported description fills in a blank, it never
// overrides a real DB2 comment. First-imported-wins among multiple imports, like everywhere else here.
function resolveDescription(connected: TableSchema | undefined, imported: ImportedTableSchema[]): string | undefined {
	if(StringUtils.isNotBlank(connected?.table.description)) {
		return connected?.table.description;
	}

	return imported.find(table => StringUtils.isNotBlank(table.description))?.description ?? connected?.table.description;
}

export function resolveTable(connected: TableSchema | undefined, imported: ImportedTableSchema[]): ResolvedTable {
	let firstImported = imported[0];
	let schema = connected?.table.schema ?? firstImported?.schema ?? '';
	let name = connected?.table.name ?? firstImported?.name ?? '';

	if(StringUtils.isBlank(name)) {
		throw new Error('Cannot resolve a table with no connected data and no imported name.');
	}

	return {
		schema: schema,
		name: name,
		description: resolveDescription(connected, imported),
		existsInDatabase: !!connected,
		columns: resolveColumns(connected?.columns, imported),
		keys: resolveTableKeys(connected?.keys, imported, connected?.columns),
		foreignKeys: resolveForeignKeys(connected?.foreignKeys, imported, connected?.columns),
		indexes: resolveIndexes(connected?.indexes, imported, connected?.columns)
	};
}
