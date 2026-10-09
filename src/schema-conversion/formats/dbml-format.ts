import { ImportedTableSchema, ResolvedColumn, ResolvedForeignKey, ResolvedTable, ResolvedTableKey, SchemaFormatConverter } from '../schema-format-converter.js';
import { ColumnNameUtils } from '../../utils/column-name-utils.js';
import { groupByConstraint } from './key-grouping.js';

function quote(identifier: string): string {
	return `"${identifier.replace(/"/g, '\\"')}"`;
}

function dbmlString(value: string): string {
	return `'${value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;
}

// QSYS2.SYSPARTITIONINDEXSTAT.COLUMN_NAMES appends " DESC" after a descending key column's name (e.g.
// "COL1, COL2 DESC") - strip it before treating the token as a column identifier, or it gets quoted
// together with the column name into something like "COL2 DESC" that no declared field actually matches.
function stripSortDirection(columnToken: string): string {
	return columnToken.replace(/\s+(ASC|DESC)$/i, '').trim();
}

// IndexQueries.describeIndexUniqueness maps DB2's UNIQUE_CODE to one of five display strings - "Unique"
// (code 0) and "Unique Where Not Null" (code 1, uniqueness enforced except among NULLs) both mean this
// index enforces a real uniqueness rule and should round-trip as DBML's `unique` flag; the three
// "Non-Unique (...)" strings (codes 2-4) and an imported-only row's plain "Not Unique" should not.
// Exported so diagram-resolved-table.ts can classify a resolved index the same way, rather than
// re-deriving the "starts with 'Unique'" rule a second time - see [[feedback_consolidate-duplicated-keyword-data]].
export function isUniqueIndex(uniqueness: string): boolean {
	return uniqueness.startsWith('Unique');
}

function columnTypeText(column: ResolvedColumn): string {
	// Truthy, not `!== undefined` - QSYS2.SYSCOLUMNS2's PRECISION/SCALE come back as 0 (not null) on a
	// CHAR/VARCHAR column, not undefined, since LENGTH is the dual-purpose field there (see
	// TableQueries.listColumns' comment) - a `!== undefined` check would wrongly take this branch for
	// every character column and render "VARCHAR(0,0)" instead of falling through to the real length.
	if(column.precision) {
		return `${column.dataType}(${column.precision},${column.scale ?? 0})`;
	}

	if(column.length) {
		return `${column.dataType}(${column.length})`;
	}

	return column.dataType;
}

// DBML's `default:` setting is typed (bare number, quoted string, or a backtick-wrapped "expression"
// that's stored verbatim with no SQL validation - confirmed empirically against @dbml/core's parser).
// QSYS2.SYSCOLUMNS2's DFTVALUE already comes back pre-quoted for a string literal default (e.g. "'N'")
// and bare for a numeric one, so those two forms pass through unchanged; anything else (a special
// register like CURRENT TIMESTAMP, a function call, ...) has no bare/quoted DBML form, so it's carried
// as an expression instead of being dropped.
function defaultSettingText(defaultValue: string): string | undefined {
	let trimmed = defaultValue.trim();

	if(trimmed.length === 0) {
		return undefined;
	}

	if(/^'.*'$/s.test(trimmed) || /^-?\d+(\.\d+)?$/.test(trimmed)) {
		return `default: ${trimmed}`;
	}

	return `default: \`${trimmed.replace(/`/g, '')}\``;
}

// Identity/generated-column metadata (start value, increment step, min/max, cycle, cache) has no DBML
// settings-level home beyond the bare `increment` flag - captured here as a human-readable note instead
// of being silently dropped, the same way `text` already is. Not meant to round-trip back into these
// fields on import (ImportedColumn has no identity concept) - purely so a reviewer/diagramming tool sees
// that the column is generated and how, instead of it vanishing from the export entirely.
function identityNoteText(column: ResolvedColumn): string | undefined {
	if(column.identity !== 'YES') {
		return undefined;
	}

	let details = [
		column.generated ? `generated ${column.generated.toLowerCase()}` : undefined,
		column.identityStart !== undefined ? `start ${column.identityStart}` : undefined,
		column.increment !== undefined ? `increment ${column.increment}` : undefined,
		column.minValue !== undefined ? `min ${column.minValue}` : undefined,
		column.maxValue !== undefined ? `max ${column.maxValue}` : undefined,
		column.cycle === 'YES' ? 'cycle' : undefined,
		column.cache !== undefined ? `cache ${column.cache}` : undefined
	].filter((part): part is string => !!part);

	return details.length > 0 ? `Identity (${details.join(', ')})` : 'Identity';
}

function buildColumnLine(column: ResolvedColumn, isSinglePk: boolean, isSingleUnique: boolean): string {
	let settings: string[] = [];

	if(isSinglePk) {
		settings.push('pk');
	}

	if(isSingleUnique) {
		settings.push('unique');
	}

	if(column.nulls === 'N') {
		settings.push('not null');
	}

	if(column.identity === 'YES') {
		settings.push('increment');
	}

	if(column.defaultValue) {
		let defaultSetting = defaultSettingText(column.defaultValue);

		if(defaultSetting) {
			settings.push(defaultSetting);
		}
	}

	let noteParts = [
		column.sqlName ? `Long name: ${column.sqlName}` : undefined,
		column.heading && column.heading !== column.text ? `Heading: ${column.heading}` : undefined,
		column.text,
		identityNoteText(column)
	].filter((part): part is string => !!part && part.trim().length > 0);

	if(noteParts.length > 0) {
		settings.push(`note: ${dbmlString(noteParts.join(' - '))}`);
	}

	let settingsText = settings.length > 0 ? ` [${settings.join(', ')}]` : '';
	return `  ${quote(column.systemName)} ${quote(columnTypeText(column))}${settingsText}`;
}

// A real DB2 constraint always has a name (DB2 auto-generates one even when the DDL didn't specify one).
// The synthetic names table-resolver.ts fabricates for imported-only rows (`imported-pk`, the
// `__ungrouped_N` fallback groupByConstraint uses for a row with no constraintName at all) aren't real
// constraint identifiers and would be actively misleading if emitted into a file meant to carry names.
function isSyntheticConstraintName(name: string | undefined): name is undefined {
	return !name || name.startsWith('__ungrouped_') || name.startsWith('imported-');
}

// DBML has no field-level slot for a constraint's name - only an indexes-block entry accepts `name:` -
// so a single-column pk/unique constraint's name can only be captured by *also* emitting an
// indexes-block entry alongside the inline field flag (buildColumnLine), redundant but the only
// spec-compliant way to preserve it. `pk`/`unique` is included on that entry (confirmed accepted by
// @dbml/core alongside a `name:` setting) so import() can tell it apart from a plain physical index.
function constraintNameSetting(name: string | undefined): string | undefined {
	return isSyntheticConstraintName(name) ? undefined : `name: ${dbmlString(name)}`;
}

function buildTableBlock(table: ResolvedTable): string {
	let {columns, keys} = table;
	let keyGroups = groupByConstraint(keys);
	let primaryKeyGroup = keyGroups.find(group => group[0].constraintType === 'PRIMARY KEY');
	let uniqueGroups = keyGroups.filter(group => group[0].constraintType === 'UNIQUE');
	let singleUniqueColumnNames = new Set(uniqueGroups.filter(group => group.length === 1).map(group => group[0].systemColumnName));

	let singlePkColumnName = primaryKeyGroup?.length === 1 ? primaryKeyGroup[0].systemColumnName : undefined;

	let lines: string[] = [];
	let header = table.description ? `Table ${quote(table.schema)}.${quote(table.name)} [note: ${dbmlString(table.description)}] {` : `Table ${quote(table.schema)}.${quote(table.name)} {`;
	lines.push(header);

	for(let column of columns) {
		lines.push(buildColumnLine(column, column.systemName === singlePkColumnName, singleUniqueColumnNames.has(column.systemName)));
	}

	let indexLines: string[] = [];

	// Composite primary key, or a single-column one whose real constraint name would otherwise be lost -
	// a single-column pk with no name to preserve is already fully represented by the inline field flag.
	if(primaryKeyGroup) {
		let nameSetting = constraintNameSetting(primaryKeyGroup[0].constraintName);

		if(primaryKeyGroup.length > 1 || nameSetting) {
			let settings = ['pk', nameSetting].filter((setting): setting is string => !!setting).join(', ');
			indexLines.push(`    (${primaryKeyGroup.map(row => quote(row.systemColumnName)).join(', ')}) [${settings}]`);
		}
	}

	// Composite unique constraints, or a single-column one whose name would otherwise be lost - same
	// reasoning as the primary key above.
	for(let group of uniqueGroups) {
		let nameSetting = constraintNameSetting(group[0].constraintName);

		if(group.length > 1 || nameSetting) {
			let settings = ['unique', nameSetting].filter((setting): setting is string => !!setting).join(', ');
			indexLines.push(`    (${group.map(row => quote(row.systemColumnName)).join(', ')}) [${settings}]`);
		}
	}

	// SYSPARTITIONINDEXSTAT.COLUMN_NAMES can list either the short or long name depending on how the
	// index was created, and appends " DESC" after a descending key column's name - resolving through
	// both name variants (after stripping any sort-direction suffix) means either form lands on the
	// short name this table's fields are declared with (ColumnNameUtils's matching rule).
	let resolveColumn = ColumnNameUtils.buildResolver(columns, ColumnNameUtils.fromSystemColumn);

	let alreadyIndexedColumnSets = new Set(keyGroups.map(group => group.map(row => row.systemColumnName).sort().join('|')));

	for(let index of table.indexes) {
		let indexColumns = index.keyColumns.split(',').map(name => stripSortDirection(name)).filter(name => name.length > 0)
			.map(name => resolveColumn(name)?.systemName ?? name);
		let columnSetKey = indexColumns.slice().sort().join('|');

		// Skip an index that duplicates a PK/unique constraint already emitted above.
		if(alreadyIndexedColumnSets.has(columnSetKey)) {
			continue;
		}

		// Most indexes on a table just repeat the table's own DB2 comment verbatim (e.g. every index here
		// commented "Users", same as the table) - only worth a note when it actually says something the
		// table-level note doesn't already, e.g. "Index generated from Index Advisor".
		let indexComment = index.comment && index.comment.trim().length > 0 && index.comment !== table.description ? index.comment : undefined;

		let settings = [
			isUniqueIndex(index.uniqueness) ? 'unique' : undefined,
			index.indexName ? `name: ${dbmlString(index.indexName)}` : undefined,
			indexComment ? `note: ${dbmlString(indexComment)}` : undefined
		].filter((setting): setting is string => !!setting);
		let settingsText = settings.length > 0 ? ` [${settings.join(', ')}]` : '';
		indexLines.push(`    (${indexColumns.map(quote).join(', ')})${settingsText}`);
	}

	if(indexLines.length > 0) {
		lines.push('');
		lines.push('  indexes {');
		lines.push(...indexLines);
		lines.push('  }');
	}

	lines.push('}');
	return lines.join('\n');
}

// A DB2 foreign key constraint is inherently many-to-one (child -> parent) unless its own column set is
// also one of the child table's own keys, in which case it's one-to-one - there's no separate
// cardinality concept to preserve or lose here, it's fully derivable from the constraint data itself.
function isOneToOne(foreignKeyGroup: ResolvedForeignKey[], tableKeys: ResolvedTableKey[]): boolean {
	let fkColumnSet = foreignKeyGroup.map(row => row.systemColumnName).sort().join('|');
	let keyGroups = groupByConstraint(tableKeys);
	return keyGroups.some(group => group.map(row => row.systemColumnName).sort().join('|') === fkColumnSet);
}

// DBML validates `update:`/`delete:` settings against exactly these five keywords (confirmed empirically
// against @dbml/core's parser - anything else is a parse error) - the same five SQL standard referential
// actions DB2's REFERENTIAL_CONSTRAINTS-sourced updateRule/deleteRule values already use, just upper-cased.
// An unrecognized value is omitted rather than risk emitting something the parser would reject outright.
const DBML_REFERENTIAL_ACTIONS = new Set(['CASCADE', 'RESTRICT', 'SET NULL', 'SET DEFAULT', 'NO ACTION']);

function referentialActionSetting(keyword: 'update' | 'delete', rule: string | undefined): string | undefined {
	let normalized = rule?.trim().toUpperCase();
	return normalized && DBML_REFERENTIAL_ACTIONS.has(normalized) ? `${keyword}: ${normalized.toLowerCase()}` : undefined;
}

function buildRefLines(table: ResolvedTable): string[] {
	let {keys, foreignKeys} = table;
	let foreignKeyGroups = groupByConstraint(foreignKeys);

	return foreignKeyGroups.map(group => {
		let localColumns = group.map(row => quote(row.systemColumnName)).join(', ');
		let referencedColumns = group.map(row => quote(row.referencedSystemColumnName)).join(', ');
		let operator = isOneToOne(group, keys) ? '-' : '>';
		// A real constraint name (as opposed to table-resolver's synthetic `imported-fk-N` placeholder)
		// gets its own DBML "Ref <name>:" prefix - the only place in Ref syntax a name can go.
		let refPrefix = isSyntheticConstraintName(group[0].constraintName) ? 'Ref:' : `Ref ${quote(group[0].constraintName)}:`;

		let settings = [referentialActionSetting('update', group[0].updateRule), referentialActionSetting('delete', group[0].deleteRule)]
			.filter((setting): setting is string => !!setting);
		let settingsText = settings.length > 0 ? ` [${settings.join(', ')}]` : '';

		return `${refPrefix} ${quote(table.schema)}.${quote(table.name)}.(${localColumns}) ${operator} ${quote(group[0].referencedSchema ?? '')}.${quote(group[0].referencedTable)}.(${referencedColumns})${settingsText}`;
	});
}

// @dbml/core's parser rejects a Ref pointing at a table not defined in the same document - it doesn't
// tolerate dangling refs the way some diagramming tools do. Since export() only ever receives the
// table(s) the user explicitly asked for, an FK's target is very often outside that set. Rather than
// dropping the relationship (losing information a future diagram feature would want), emit a minimal
// stub Table block - just enough for the parser to resolve the Ref - for every FK target not already
// present in `tables`.
function buildStubTableBlocks(tables: ResolvedTable[]): string[] {
	let includedTableNames = new Set(tables.map(table => `${table.schema}.${table.name}`.toUpperCase()));

	// Keyed by "SCHEMA.TABLE" (uppercased) -> {schema, table, columns} - a stub needs a placeholder
	// field for every distinct referenced column across all FKs targeting it (a composite FK references
	// more than one), or the Ref's column list won't fully resolve against the stub.
	let stubsByName = new Map<string, {schema: string; table: string; columns: Set<string>}>();

	for(let table of tables) {
		for(let foreignKey of table.foreignKeys) {
			let referencedSchema = foreignKey.referencedSchema ?? '';
			let stubKey = `${referencedSchema}.${foreignKey.referencedTable}`.toUpperCase();

			if(includedTableNames.has(stubKey)) {
				continue;
			}

			let stub = stubsByName.get(stubKey) ?? {schema: referencedSchema, table: foreignKey.referencedTable, columns: new Set<string>()};
			stub.columns.add(foreignKey.referencedSystemColumnName);
			stubsByName.set(stubKey, stub);
		}
	}

	// A bare Table block with no fields isn't valid DBML - these placeholder fields (just the columns
	// the Refs below actually reference) keep each stub minimal but parseable.
	return Array.from(stubsByName.values()).map(stub => {
		let fieldLines = Array.from(stub.columns).map(column => `  ${quote(column)} "unknown"`);
		return `Table ${quote(stub.schema)}.${quote(stub.table)} [note: 'Referenced table - not included in this export'] {\n${fieldLines.join('\n')}\n}`;
	});
}

// Inverse of buildColumnLine's noteParts: a note of "Long name: X" or "Long name: X - description" gets
// the long name pulled back out into its own field, so it round-trips onto ResolvedColumn.sqlName rather
// than showing up verbatim (prefix and all) as description text in the Columns tab. A note that doesn't
// match the convention (e.g. a hand-authored file with an ordinary note) is left alone as description.
function parseColumnNote(note: string | undefined): {sqlName?: string; description?: string} {
	if(!note) {
		return {};
	}

	let match = /^Long name:\s*(\S+)(?:\s+-\s+([\s\S]*))?$/.exec(note);

	if(!match) {
		return { description: note };
	}

	return { sqlName: match[1], description: match[2] || undefined };
}

function toImportedColumnType(field: {type: unknown}): string {
	let type = field.type as {type_name?: string; args?: string | null} | string | undefined;

	if(typeof type === 'string') {
		return type;
	}

	if(!type?.type_name) {
		return 'unknown';
	}

	// @dbml/core splits "varchar(500)" into {type_name: "varchar", args: "500"} - args was previously
	// dropped here, silently losing length/precision on every imported column.
	return type.args ? `${type.type_name}(${type.args})` : type.type_name;
}

export const dbmlFormat: SchemaFormatConverter = {
	id: 'dbml',
	label: 'DBML',
	fileExtension: 'dbml',

	export(tables: ResolvedTable[]): string {
		let tableBlocks = tables.map(buildTableBlock);
		let stubTableBlocks = buildStubTableBlocks(tables);
		let refLines = tables.flatMap(buildRefLines);
		return [...tableBlocks, ...stubTableBlocks, ...refLines].join('\n\n');
	},

	async import(content: string): Promise<Omit<ImportedTableSchema, 'provenance'>[]> {
		// Loaded here rather than at the top of the file: @dbml/core is most of the extension's code by size
		// (about 15 MB bundled, against well under 1 MB of our own), and only importing a DBML file needs it.
		// esbuild-extension.mjs splits it into its own chunk, so activation never reads or parses it.
		let { Parser } = await import('@dbml/core');
		let database = Parser.parse(content, 'dbml');
		let imported: Omit<ImportedTableSchema, 'provenance'>[] = [];

		for(let schema of database.schemas) {
			// Endpoint.relation is '1' on the referenced (one) side and '*' on the referencing (many) side -
			// see @dbml/core's Endpoint model. A ref with any other shape (self-refs, missing sides) is
			// skipped rather than guessed at.
			let manyToOneRefs = schema.refs
				.map(ref => ({
					many: ref.endpoints.find(endpoint => endpoint.relation === '*'),
					one: ref.endpoints.find(endpoint => endpoint.relation === '1'),
					name: ref.name || undefined,
					updateRule: ref.onUpdate || undefined,
					deleteRule: ref.onDelete || undefined
				}))
				.filter((pair): pair is {many: NonNullable<typeof pair.many>; one: NonNullable<typeof pair.one>; name: string | undefined; updateRule: string | undefined; deleteRule: string | undefined} => !!pair.many && !!pair.one);

			for(let table of schema.tables) {
				// A pk/unique-flagged indexes-block entry (see constraintNameSetting) represents the same
				// constraint a field's own `pk`/`unique` flag does, just with a name attached - it must not
				// also surface as a plain physical index, or every named single-column constraint would
				// duplicate itself into the Indexes tab.
				let pkIndexEntries = table.indexes.filter(index => index.pk);
				let uniqueIndexEntries = table.indexes.filter(index => index.unique && !index.pk);
				let plainIndexEntries = table.indexes.filter(index => !index.pk && !index.unique);

				// An indexes-block pk entry (composite, or single-column with a name to preserve - see
				// constraintNameSetting) fully restates the primary key on its own; falling back to the
				// field-level `pk` flags only when there's no such entry avoids double-listing a column that
				// carries both (every single-column named pk does, by construction of buildTableBlock).
				let pkColumnsFromIndex = pkIndexEntries.flatMap(index => index.columns.map(column => String(column.value)));
				let namedPkIndex = pkIndexEntries.find(index => index.name);

				// A single-column field-level `unique` flag has no indexes-block counterpart at all when
				// there's no name to preserve (see buildTableBlock) - captured directly from the field here,
				// alongside whatever indexes-block entries did carry a name or a composite column set.
				let indexBackedUniqueColumnSets = new Set(uniqueIndexEntries.map(index => index.columns.map(column => String(column.value)).map(name => name.toUpperCase()).sort().join('|')));
				let fieldLevelUniqueColumns = table.fields
					.filter(field => field.unique)
					.map(field => field.name)
					.filter(name => !indexBackedUniqueColumnSets.has(name.toUpperCase()));

				imported.push({
					schema: schema.name,
					name: table.name,
					columns: table.fields.map(field => ({
						name: field.name,
						type: toImportedColumnType(field),
						nullable: !field.not_null,
						...parseColumnNote(field.note || undefined)
					})),
					primaryKeyColumns: pkColumnsFromIndex.length > 0 ? pkColumnsFromIndex : table.fields.filter(field => field.pk).map(field => field.name),
					primaryKeyName: namedPkIndex?.name || undefined,
					uniqueKeys: [
						...uniqueIndexEntries.map(index => ({
							name: index.name || undefined,
							columns: index.columns.map(column => String(column.value))
						})),
						...fieldLevelUniqueColumns.map(name => ({columns: [name]}))
					],
					foreignKeys: manyToOneRefs
						.filter(({many}) => many.tableName === table.name && (many.schemaName ?? schema.name) === schema.name)
						.map(({many, one, name, updateRule, deleteRule}) => ({
							name,
							columns: many.fieldNames,
							referencedSchema: one.schemaName ?? undefined,
							referencedTable: one.tableName,
							referencedColumns: one.fieldNames,
							updateRule: updateRule?.toUpperCase(),
							deleteRule: deleteRule?.toUpperCase()
						})),
					indexes: plainIndexEntries.map(index => ({
						name: index.name || undefined,
						columns: index.columns.map(column => String(column.value)),
						unique: false,
						comment: index.note || undefined
					}))
				});
			}
		}

		return imported;
	}
};
