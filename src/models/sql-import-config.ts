// The user-authored definition of a SQL schema import: up to three statements, each with its own
// result set and its own mapping of result columns onto internal fields. Kept in src/models (not
// src/schema-conversion) because it's a persisted settings shape - db2-workbench.sqlImports stores
// exactly this, so package.json's contributes.configuration schema has to stay in sync with it, the
// same way it does for ConnectionConfig.
//
// The three sections are deliberately independent: a result column can only ever be mapped to a target
// belonging to its own section, and the same target name in two sections is unrelated. There is no
// inferred "row kind".

export type SqlImportSectionId = 'tables' | 'columns' | 'relationships';

// Short (system) names are the only thing ever matched against DB2 catalog data - an SQL/long name is
// accepted as a fact but never used as a matching key, which is why every section requires both the
// system name and the schema.
export type SqlImportTablesTarget = 'schema' | 'tableSystemName' | 'tableSqlName' | 'tableDescription';

export type SqlImportColumnsTarget =
	'schema' | 'tableSystemName' | 'columnSystemName' | 'columnSqlName' | 'columnDescription' |
	'dataType' | 'length' | 'scale' | 'nullable' | 'primaryKey' | 'defaultValue' | 'columnPosition';

// Parent/Child wording, not the internal model's referenced*, because that's the wording most people
// use when describing a relationship out loud. The conversion module translates.
export type SqlImportRelationshipsTarget =
	'childSchema' | 'childTableSystemName' | 'childColumnSystemName' |
	'parentSchema' | 'parentTableSystemName' | 'parentColumnSystemName' |
	'foreignKeyName' | 'keyPosition' | 'updateRule' | 'deleteRule';

export type SqlImportTarget = SqlImportTablesTarget | SqlImportColumnsTarget | SqlImportRelationshipsTarget;

// What an unmapped result column is shown as in the mapping dropdown. Never stored: a column mapped to
// this is simply absent from SqlImportSectionConfig.mapping.
export const SQL_IMPORT_IGNORE_TARGET = '(ignore)';

export interface SqlImportTargetDefinition {
	id: SqlImportTarget;
	label: string;
	required: boolean;
	// How the raw result value is interpreted. Anything a parser rejects is a counted data warning and
	// the value is dropped, never fatal - this data comes from tables the extension doesn't control.
	kind: 'text' | 'number' | 'boolean' | 'referentialAction';
}

export interface SqlImportSectionDefinition {
	id: SqlImportSectionId;
	label: string;
	// Only Tables is required - it defines the universe of tables the import touches, and is the only
	// section that can introduce a table the tree didn't already have.
	required: boolean;
	targets: SqlImportTargetDefinition[];
}

export const SQL_IMPORT_SECTIONS: SqlImportSectionDefinition[] = [
	{
		id: 'tables',
		label: 'Tables',
		required: true,
		targets: [
			{id: 'schema', label: 'Schema', required: true, kind: 'text'},
			{id: 'tableSystemName', label: 'Table System Name', required: true, kind: 'text'},
			{id: 'tableSqlName', label: 'Table SQL Name', required: false, kind: 'text'},
			{id: 'tableDescription', label: 'Table Description', required: false, kind: 'text'}
		]
	},
	{
		id: 'columns',
		label: 'Columns',
		required: false,
		targets: [
			{id: 'schema', label: 'Schema', required: true, kind: 'text'},
			{id: 'tableSystemName', label: 'Table System Name', required: true, kind: 'text'},
			{id: 'columnSystemName', label: 'Column System Name', required: true, kind: 'text'},
			{id: 'columnSqlName', label: 'Column SQL Name', required: false, kind: 'text'},
			{id: 'columnDescription', label: 'Column Description', required: false, kind: 'text'},
			{id: 'dataType', label: 'Data Type', required: false, kind: 'text'},
			{id: 'length', label: 'Length', required: false, kind: 'number'},
			{id: 'scale', label: 'Scale', required: false, kind: 'number'},
			{id: 'nullable', label: 'Nullable', required: false, kind: 'boolean'},
			{id: 'primaryKey', label: 'Primary Key', required: false, kind: 'boolean'},
			{id: 'defaultValue', label: 'Default Value', required: false, kind: 'text'},
			{id: 'columnPosition', label: 'Column Position', required: false, kind: 'number'}
		]
	},
	{
		id: 'relationships',
		label: 'Relationships',
		required: false,
		targets: [
			{id: 'childSchema', label: 'Child Schema', required: true, kind: 'text'},
			{id: 'childTableSystemName', label: 'Child Table System Name', required: true, kind: 'text'},
			{id: 'childColumnSystemName', label: 'Child Column System Name', required: true, kind: 'text'},
			{id: 'parentSchema', label: 'Parent Schema', required: true, kind: 'text'},
			{id: 'parentTableSystemName', label: 'Parent Table System Name', required: true, kind: 'text'},
			{id: 'parentColumnSystemName', label: 'Parent Column System Name', required: true, kind: 'text'},
			{id: 'foreignKeyName', label: 'Foreign Key Name', required: false, kind: 'text'},
			{id: 'keyPosition', label: 'Key Position', required: false, kind: 'number'},
			{id: 'updateRule', label: 'Update Rule', required: false, kind: 'referentialAction'},
			{id: 'deleteRule', label: 'Delete Rule', required: false, kind: 'referentialAction'}
		]
	}
];

export function getSqlImportSection(id: SqlImportSectionId): SqlImportSectionDefinition {
	let section = SQL_IMPORT_SECTIONS.find(candidate => candidate.id === id);

	if(!section) {
		throw new Error(`Unknown SQL import section: ${id}`);
	}

	return section;
}

export interface SqlImportSectionConfig {
	sql: string;
	// Result column name -> target id. A result column absent from this map is ignored, which is also
	// what a new column appearing in a changed underlying view gets (no warning).
	mapping: Record<string, SqlImportTarget>;
	// The result column names seen the last time this statement ran, in result-set order. Recorded so
	// the edit dialog can show a previous mapping before re-running, and so mapping drift (a column that
	// has since vanished) can be reported against something.
	resultColumns?: string[];
}

export interface SqlImportConfig {
	// Stable for a saved import: a re-run replaces that import's rows in place rather than adding a
	// second View Imports entry. A one-off, unsaved import gets a random one, like a file import.
	id: string;
	name: string;
	tables: SqlImportSectionConfig;
	columns?: SqlImportSectionConfig;
	relationships?: SqlImportSectionConfig;
}

export function getSqlImportSectionConfig(config: SqlImportConfig, section: SqlImportSectionId): SqlImportSectionConfig | undefined {
	return section === 'tables' ? config.tables : config[section];
}

// One result-set row as the driver hands it back. Values are whatever the driver produced for the column's
// DB2 type, so every consumer has to coerce rather than assume string.
export type SqlImportRow = Record<string, unknown>;
