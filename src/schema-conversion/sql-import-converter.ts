import {
	getSqlImportSection,
	SqlImportRow,
	SqlImportSectionId,
	SqlImportTarget
} from '../models/sql-import-config.js';
import { ImportedColumn, ImportedForeignKey, ImportedTableSchema } from './schema-format-converter.js';

// Turns a SQL import's result rows plus its column->target mapping into the same ImportedTableSchema
// fragments a DBML or Frictionless file produces, so everything downstream (table-resolver, the tree,
// export) treats a SQL import exactly like any other import.
//
// A pure module with no VS Code or database-driver dependency, like table-resolver.ts and import-groups.ts - the
// service that actually runs the queries (SqlSchemaImports) hands rows in and gets fragments out.
//
// The data comes from tables this extension does not control, so bad data is expected and is never
// fatal: a row that can't be used is skipped and counted, and every count surfaces in the import
// summary. Nothing here throws on data.

export interface SqlImportTable {
	schema: string;
	name: string;
	sqlName?: string;
	description?: string;
}

// Aggregated per (kind, detail) rather than one entry per bad row - a view whose every row is missing
// the same required column would otherwise produce 50,000 identical messages.
export interface SqlImportIssue {
	kind: 'missingRequired' | 'unknownTable' | 'duplicate' | 'invalidValue';
	detail: string;
	count: number;
}

export interface SqlImportSectionStats {
	section: SqlImportSectionId;
	/** Rows the statement returned. */
	rowCount: number;
	/** Rows that produced something - a table, a column, or one column of a foreign key. */
	importedCount: number;
	issues: SqlImportIssue[];
}

// One section's outcome as the import summary dialog shows it. `applied` is false for a section whose
// rows were read but not yet turned into tree data - Columns and Relationships load lazily, per table,
// so the summary says what was read rather than implying nothing came back.
export interface SqlImportSectionSummary extends SqlImportSectionStats {
	applied: boolean;
}

export interface SqlImportMappingDrift {
	/** A required target whose mapped result column is no longer in the result set. The import fails -
	 * data already loaded is left alone. */
	missingRequired: string[];
	/** An optional target's column vanished: that fact is dropped and reported, the import still runs. */
	missingOptional: string[];
}

export function sqlImportTableKey(schema: string, name: string): string {
	return `${schema.toUpperCase()}.${name.toUpperCase()}`;
}

// Mapping is stored result column -> target because that's the direction the dialog edits it in, but
// every read here wants the other direction. A target may be used at most once per section, so the
// inverse is a plain map; a duplicate target is rejected at mapping time, and the last one wins here.
export function invertSqlImportMapping(mapping: Record<string, SqlImportTarget>): Map<SqlImportTarget, string> {
	let inverted = new Map<SqlImportTarget, string>();

	for(let [resultColumn, target] of Object.entries(mapping)) {
		inverted.set(target, resultColumn);
	}

	return inverted;
}

// A saved mapping can go stale when the underlying view changes. A result column that's new (absent
// from the mapping) is simply ignored with no warning; a mapped column that has vanished is what this
// reports on.
export function checkSqlImportMappingDrift(section: SqlImportSectionId, mapping: Record<string, SqlImportTarget>, resultColumns: string[]): SqlImportMappingDrift {
	let present = new Set(resultColumns.map(column => column.toUpperCase()));
	let inverted = invertSqlImportMapping(mapping);
	let drift: SqlImportMappingDrift = {missingRequired: [], missingOptional: []};

	for(let target of getSqlImportSection(section).targets) {
		let resultColumn = inverted.get(target.id);

		if(!resultColumn || present.has(resultColumn.toUpperCase())) {
			continue;
		}

		(target.required ? drift.missingRequired : drift.missingOptional).push(resultColumn);
	}

	return drift;
}

export interface SqlImportTablesResult {
	tables: SqlImportTable[];
	stats: SqlImportSectionStats;
}

export function convertSqlImportTableRows(rows: SqlImportRow[], mapping: Record<string, SqlImportTarget>): SqlImportTablesResult {
	let reader = new RowReader('tables', mapping, rows.length);
	let byKey = new Map<string, SqlImportTable>();

	for(let row of rows) {
		let schema = reader.requiredText(row, 'schema');
		let name = reader.requiredText(row, 'tableSystemName');

		if(!schema || !name) {
			continue;
		}

		let key = sqlImportTableKey(schema, name);

		if(byKey.has(key)) {
			reader.duplicate(`table ${key}`);
			continue;
		}

		byKey.set(key, {
			schema: schema,
			name: name,
			sqlName: reader.text(row, 'tableSqlName'),
			description: reader.text(row, 'tableDescription')
		});

		reader.imported();
	}

	return {tables: Array.from(byKey.values()), stats: reader.stats()};
}

export interface SqlImportColumnsResult {
	/** Keyed by sqlImportTableKey. */
	columns: Map<string, ImportedColumn[]>;
	primaryKeyColumns: Map<string, string[]>;
	stats: SqlImportSectionStats;
}

// knownTables is every table the import's own Tables statement returned plus every table DB2 itself
// has - a row naming anything else has nowhere to land, so it's skipped and counted. A parent table
// that exists in DB2 is fine even when the Tables statement didn't list it, which is why the caller
// unions the two rather than passing only its own tables.
export function convertSqlImportColumnRows(rows: SqlImportRow[], mapping: Record<string, SqlImportTarget>, knownTables: Set<string>): SqlImportColumnsResult {
	let reader = new RowReader('columns', mapping, rows.length);
	let columns = new Map<string, ImportedColumn[]>();
	let primaryKeyColumns = new Map<string, string[]>();
	let seen = new Set<string>();

	for(let row of rows) {
		let schema = reader.requiredText(row, 'schema');
		let tableName = reader.requiredText(row, 'tableSystemName');
		let columnName = reader.requiredText(row, 'columnSystemName');

		if(!schema || !tableName || !columnName) {
			continue;
		}

		let key = sqlImportTableKey(schema, tableName);

		if(!reader.isKnownTable(key, knownTables)) {
			continue;
		}

		let columnKey = `${key}.${columnName.toUpperCase()}`;

		if(seen.has(columnKey)) {
			reader.duplicate(`column ${columnKey}`);
			continue;
		}

		seen.add(columnKey);

		let nullable = reader.boolean(row, 'nullable');

		pushTo(columns, key, {
			name: columnName,
			// A source that doesn't carry a type leaves it blank rather than claiming one - the Columns
			// tab shows what the import actually said, nothing more.
			type: reader.text(row, 'dataType') ?? '',
			// Unknown nullability reads as nullable: the less assertive of the two claims.
			nullable: nullable ?? true,
			sqlName: reader.text(row, 'columnSqlName'),
			description: reader.text(row, 'columnDescription'),
			length: reader.number(row, 'length'),
			scale: reader.number(row, 'scale'),
			defaultValue: reader.text(row, 'defaultValue'),
			colNo: reader.number(row, 'columnPosition')
		});

		if(reader.boolean(row, 'primaryKey')) {
			pushTo(primaryKeyColumns, key, columnName);
		}

		reader.imported();
	}

	sortColumnsByPosition(columns);

	return {columns: columns, primaryKeyColumns: primaryKeyColumns, stats: reader.stats()};
}

export interface SqlImportRelationshipsResult {
	/** Keyed by sqlImportTableKey of the CHILD table - the side a foreign key belongs to, and the side
	 * getForeignKeys already filters on for real DB2 data. */
	foreignKeys: Map<string, ImportedForeignKey[]>;
	stats: SqlImportSectionStats;
}

interface ForeignKeyAccumulator {
	name?: string;
	referencedSchema: string;
	referencedTable: string;
	updateRule?: string;
	deleteRule?: string;
	columns: Array<{position: number; column: string; referencedColumn: string}>;
}

export function convertSqlImportRelationshipRows(rows: SqlImportRow[], mapping: Record<string, SqlImportTarget>, knownTables: Set<string>): SqlImportRelationshipsResult {
	let reader = new RowReader('relationships', mapping, rows.length);
	let hasKeyName = invertSqlImportMapping(mapping).has('foreignKeyName');
	let accumulators = new Map<string, Map<string, ForeignKeyAccumulator>>();
	let seenPositions = new Set<string>();
	let nextUnnamedId = 0;

	for(let row of rows) {
		let childSchema = reader.requiredText(row, 'childSchema');
		let childTable = reader.requiredText(row, 'childTableSystemName');
		let childColumn = reader.requiredText(row, 'childColumnSystemName');
		let parentSchema = reader.requiredText(row, 'parentSchema');
		let parentTable = reader.requiredText(row, 'parentTableSystemName');
		let parentColumn = reader.requiredText(row, 'parentColumnSystemName');

		if(!childSchema || !childTable || !childColumn || !parentSchema || !parentTable || !parentColumn) {
			continue;
		}

		let childKey = sqlImportTableKey(childSchema, childTable);
		let parentKey = sqlImportTableKey(parentSchema, parentTable);

		if(!reader.isKnownTable(childKey, knownTables) || !reader.isKnownTable(parentKey, knownTables)) {
			continue;
		}

		let keyName = reader.text(row, 'foreignKeyName');
		// Composite keys only group when a Foreign Key Name is mapped. Without one, every row is its own
		// single-column relationship, and the group id here is internal only - ImportedForeignKey.name
		// stays undefined so it can never be mistaken for a real constraint name.
		let groupId = hasKeyName && keyName ? `NAME:${keyName.toUpperCase()}` : `ROW:${nextUnnamedId++}`;
		// Row order is the fallback ordering when Key Position isn't mapped - the dialog notes that this
		// needs an ORDER BY in the statement to be stable.
		let position = reader.number(row, 'keyPosition') ?? reader.rowNumber;

		if(hasKeyName && keyName) {
			let positionKey = `${childKey}|${groupId}|${position}`;

			if(seenPositions.has(positionKey)) {
				reader.duplicate(`foreign key ${keyName} position ${position}`);
				continue;
			}

			seenPositions.add(positionKey);
		}

		let byGroup = accumulators.get(childKey) ?? new Map<string, ForeignKeyAccumulator>();
		accumulators.set(childKey, byGroup);

		let accumulator = byGroup.get(groupId);

		if(!accumulator) {
			accumulator = {
				name: hasKeyName ? keyName : undefined,
				referencedSchema: parentSchema,
				referencedTable: parentTable,
				updateRule: reader.referentialAction(row, 'updateRule'),
				deleteRule: reader.referentialAction(row, 'deleteRule'),
				columns: []
			};

			byGroup.set(groupId, accumulator);
		}

		accumulator.columns.push({position: position, column: childColumn, referencedColumn: parentColumn});
		reader.imported();
	}

	return {foreignKeys: buildForeignKeys(accumulators, reader), stats: reader.stats()};
}

export interface SqlImportFragments {
	tables: SqlImportTable[];
	columns?: Map<string, ImportedColumn[]>;
	primaryKeyColumns?: Map<string, string[]>;
	foreignKeys?: Map<string, ImportedForeignKey[]>;
}

// Assembles the per-section results into the fragments the host stamps provenance onto. Columns and
// Relationships load lazily, per table, so both are optional here and a table simply carries nothing
// from a section that hasn't loaded yet. uniqueKeys/indexes stay empty: a SQL import has no section
// that could supply them.
export function buildSqlImportedTables(fragments: SqlImportFragments): Omit<ImportedTableSchema, 'provenance'>[] {
	return fragments.tables.map(table => {
		let key = sqlImportTableKey(table.schema, table.name);

		return {
			schema: table.schema,
			name: table.name,
			description: table.description,
			columns: fragments.columns?.get(key) ?? [],
			primaryKeyColumns: fragments.primaryKeyColumns?.get(key) ?? [],
			uniqueKeys: [],
			foreignKeys: fragments.foreignKeys?.get(key) ?? [],
			indexes: []
		};
	});
}

function buildForeignKeys(accumulators: Map<string, Map<string, ForeignKeyAccumulator>>, reader: RowReader): Map<string, ImportedForeignKey[]> {
	let foreignKeys = new Map<string, ImportedForeignKey[]>();

	for(let [childKey, byGroup] of accumulators) {
		let seenSignatures = new Set<string>();

		for(let accumulator of byGroup.values()) {
			let ordered = [...accumulator.columns].sort((left, right) => left.position - right.position);
			let foreignKey: ImportedForeignKey = {
				name: accumulator.name,
				columns: ordered.map(entry => entry.column),
				referencedSchema: accumulator.referencedSchema,
				referencedTable: accumulator.referencedTable,
				referencedColumns: ordered.map(entry => entry.referencedColumn),
				updateRule: accumulator.updateRule,
				deleteRule: accumulator.deleteRule
			};

			// An unnamed relationship has no key to dedupe on, so the whole relationship is its own
			// identity - two identical rows in the result set are one relationship, not two.
			let signature = [
				foreignKey.columns.join(',').toUpperCase(),
				accumulator.referencedSchema.toUpperCase(),
				accumulator.referencedTable.toUpperCase(),
				foreignKey.referencedColumns.join(',').toUpperCase()
			].join('|');

			if(seenSignatures.has(signature)) {
				reader.duplicate(`relationship ${childKey} -> ${accumulator.referencedSchema}.${accumulator.referencedTable}`);
				continue;
			}

			seenSignatures.add(signature);
			pushTo(foreignKeys, childKey, foreignKey);
		}
	}

	return foreignKeys;
}

// Column Position orders the column list when it's mapped. A table whose rows carry no position keeps
// result-set order, which is why a table with even one unpositioned column is left alone entirely -
// mixing the two orderings would be worse than either.
function sortColumnsByPosition(columns: Map<string, ImportedColumn[]>): void {
	for(let list of columns.values()) {
		if(list.every(column => column.colNo !== undefined)) {
			list.sort((left, right) => (left.colNo ?? 0) - (right.colNo ?? 0));
		}
	}
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
	let list = map.get(key);

	if(list) {
		list.push(value);
		return;
	}

	map.set(key, [value]);
}

const REFERENTIAL_ACTIONS = ['NO ACTION', 'CASCADE', 'RESTRICT', 'SET NULL', 'SET DEFAULT'];
const TRUE_VALUES = ['Y', 'YES', '1', 'TRUE'];
const FALSE_VALUES = ['N', 'NO', '0', 'FALSE'];

// Reads one section's rows through its mapping, coercing values and tallying everything that went
// wrong. Stateful only in the counters - it holds no row state between calls beyond the row number,
// which is the fallback ordering for a composite key with no Key Position mapped.
class RowReader {
	rowNumber = 0;

	private readonly targets: Map<SqlImportTarget, string>;
	private readonly issues = new Map<string, SqlImportIssue>();
	private importedCount = 0;
	private currentRowCounted = false;
	private lastRow: SqlImportRow | undefined = undefined;

	constructor(private readonly section: SqlImportSectionId, mapping: Record<string, SqlImportTarget>, private readonly rowCount: number) {
		this.targets = invertSqlImportMapping(mapping);
	}

	text(row: SqlImportRow, target: SqlImportTarget): string | undefined {
		this.trackRow(row);

		let resultColumn = this.targets.get(target);

		if(!resultColumn) {
			return undefined;
		}

		let value = row[resultColumn];

		if(value === null || value === undefined) {
			return undefined;
		}

		// Trimmed the moment it leaves the result set: DB2 CHAR columns are blank-padded, and that
		// padding would otherwise break every in-memory name match downstream.
		let text = String(value).trim();

		return text.length === 0 ? undefined : text;
	}

	requiredText(row: SqlImportRow, target: SqlImportTarget): string | undefined {
		let value = this.text(row, target);

		if(value === undefined) {
			this.skip('missingRequired', `${this.label(target)} is empty`);
			return undefined;
		}

		return value;
	}

	number(row: SqlImportRow, target: SqlImportTarget): number | undefined {
		let value = this.text(row, target);

		if(value === undefined) {
			return undefined;
		}

		let parsed = Number(value);

		if(!Number.isFinite(parsed)) {
			this.addIssue('invalidValue', `${this.label(target)} is not a number ("${value}")`);
			return undefined;
		}

		return parsed;
	}

	boolean(row: SqlImportRow, target: SqlImportTarget): boolean | undefined {
		let value = this.text(row, target);

		if(value === undefined) {
			return undefined;
		}

		let upper = value.toUpperCase();

		if(TRUE_VALUES.includes(upper)) {
			return true;
		}

		if(FALSE_VALUES.includes(upper)) {
			return false;
		}

		this.addIssue('invalidValue', `${this.label(target)} is not a yes/no value ("${value}")`);

		return undefined;
	}

	referentialAction(row: SqlImportRow, target: SqlImportTarget): string | undefined {
		let value = this.text(row, target);

		if(value === undefined) {
			return undefined;
		}

		// Upper-cased to match DB2's own catalog casing, then checked against the five standard actions -
		// anything else is a data problem, not a rule this extension has never heard of.
		let upper = value.toUpperCase().replace(/\s+/g, ' ');

		if(!REFERENTIAL_ACTIONS.includes(upper)) {
			this.addIssue('invalidValue', `${this.label(target)} is not a referential action ("${value}")`);
			return undefined;
		}

		return upper;
	}

	isKnownTable(tableKey: string, knownTables: Set<string>): boolean {
		if(knownTables.has(tableKey)) {
			return true;
		}

		this.skip('unknownTable', `${tableKey} is not in this import's tables and does not exist in the database`);

		return false;
	}

	duplicate(detail: string): void {
		this.skip('duplicate', `duplicate ${detail}`);
	}

	imported(): void {
		this.importedCount++;
	}

	stats(): SqlImportSectionStats {
		return {
			section: this.section,
			rowCount: this.rowCount,
			importedCount: this.importedCount,
			issues: Array.from(this.issues.values())
		};
	}

	// A row can fail several required targets at once; it's still one skipped row, so only the first
	// reason for a given row is counted.
	private skip(kind: SqlImportIssue['kind'], detail: string): void {
		if(this.currentRowCounted) {
			return;
		}

		this.currentRowCounted = true;
		this.addIssue(kind, detail);
	}

	private addIssue(kind: SqlImportIssue['kind'], detail: string): void {
		let key = `${kind}|${detail}`;
		let issue = this.issues.get(key);

		if(issue) {
			issue.count++;
			return;
		}

		this.issues.set(key, {kind: kind, detail: detail, count: 1});
	}

	private trackRow(row: SqlImportRow): void {
		if(this.lastRow === row) {
			return;
		}

		this.lastRow = row;
		this.currentRowCounted = false;
		this.rowNumber++;
	}

	private label(target: SqlImportTarget): string {
		return getSqlImportSection(this.section).targets.find(candidate => candidate.id === target)?.label ?? target;
	}
}
