import {
	getSqlImportSection,
	SqlImportRelationshipsTarget,
	SqlImportSectionId,
	SqlImportTarget
} from '../models/sql-import-config.js';

// The mapping step's opening guess: which result column probably belongs to which target. Purely a
// convenience - every mapping it produces is shown in the dialog's dropdowns and can be changed before
// anything is imported, so a wrong guess costs a click, not data.
//
// Name-shape matching only, deliberately: the values aren't looked at at all. A site's metadata table
// names its columns whatever it likes, and a value-sniffing heuristic ("this column looks like a schema
// name") would be confidently wrong far more often than a name match is.
//
// Pure, with no VS Code or webview dependency, so the dialog and the (future) saved-import edit flow
// share one heuristic and it can be unit tested - same reasoning as table-resolver.ts.

// Compared against the normalized column name (uppercased, everything but letters and digits removed),
// so TABLE_NAME, tableName and "Table Name" all reduce to TABLENAME.
function normalize(name: string): string {
	return name.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const TABLES_PATTERNS: Partial<Record<SqlImportTarget, RegExp>> = {
	schema: /^(TABLE|TBL|TAB|FILE)?(SCHEMA|SCHEMANAME|LIB|LIBRARY|LIBNAME|DBNAME)$/,
	tableSystemName: /^((SYS|SYSTEM)?(TABLE|TBL|TAB|FILE)(NAME|SYSNAME|SYSTEMNAME)?|NAME|SYSNAME|SYSTEMNAME|TBNAME)$/,
	tableSqlName: /^((TABLE|TBL|TAB|FILE)?(LONG|SQL)(NAME)?)$/,
	tableDescription: /^(TABLE|TBL|TAB|FILE)?(DESC|DESCRIPTION|TEXT|LABEL|REMARK|REMARKS|COMMENT|HEADING)$/
};

const COLUMNS_PATTERNS: Partial<Record<SqlImportTarget, RegExp>> = {
	schema: TABLES_PATTERNS.schema,
	tableSystemName: TABLES_PATTERNS.tableSystemName,
	columnSystemName: /^((SYS|SYSTEM)?(COL|COLUMN|FLD|FIELD)(NAME|SYSNAME|SYSTEMNAME)?)$/,
	columnSqlName: /^((COL|COLUMN|FLD|FIELD)?(LONG|SQL)(NAME)?)$/,
	columnDescription: /^(COL|COLUMN|FLD|FIELD)?(DESC|DESCRIPTION|TEXT|LABEL|REMARK|REMARKS|COMMENT|HEADING)$/,
	dataType: /^(COL|COLUMN|DATA|FLD|FIELD)?(TYPE|DATATYPE|COLTYPE)$/,
	length: /^(COL|COLUMN|DATA|FLD|FIELD)?(LEN|LENGTH|SIZE)$/,
	scale: /^(COL|COLUMN|DATA)?(SCALE|DEC|DECIMALS|DECIMALDIGITS)$/,
	nullable: /^(IS|ALLOW)?(NULL|NULLS|NULLABLE|NULLABLES)$/,
	primaryKey: /^(IS)?(PK|PRIMARY|PRIMARYKEY|KEYFLAG|ISKEY)$/,
	defaultValue: /^(COL|COLUMN|FLD|FIELD)?(DEFAULT|DEFAULTVALUE|DFT|DFTVALUE)$/,
	columnPosition: /^(COL|COLUMN|ORDINAL|FLD|FIELD)?(NO|NUM|NUMBER|POS|POSITION|ORDER|SEQ|SEQUENCE)$/
};

// Unsided targets - the rest of a relationship row is matched by side + kind, below.
const RELATIONSHIP_PATTERNS: Partial<Record<SqlImportRelationshipsTarget, RegExp>> = {
	foreignKeyName: /^(FK|FOREIGNKEY|CONSTRAINT|RELATION|RELATIONSHIP|KEY)(NAME|ID)?$/,
	keyPosition: /^(KEY|COL|COLUMN|ORDINAL)?(POS|POSITION|NO|NUM|ORDER|SEQ|SEQUENCE)$/,
	updateRule: /^(ON)?UPDATE(RULE|ACTION)?$/,
	deleteRule: /^(ON)?DELETE(RULE|ACTION)?$/
};

const CHILD_WORDS = /^(CHILD|FROM|SOURCE|DEPENDENT|FK|FOREIGN)/;
const PARENT_WORDS = /^(PARENT|TO|TARGET|REFERENCED|REFERENCE|REF|PK)/;

// A relationship statement names both sides of the same three things, so the side has to be read off
// the column name before its kind means anything. Two conventions are recognized: a leading word
// (CHILD_SCHEMA / PARENT_SCHEMA) and a trailing 1/2 (SCHEMA1 / SCHEMA2), which is what the metadata
// tables this feature was built for actually use.
function splitRelationshipSide(normalized: string): {side?: 'child' | 'parent'; rest: string} {
	let childWord = normalized.match(CHILD_WORDS);

	if(childWord) {
		return {side: 'child', rest: normalized.substring(childWord[0].length)};
	}

	let parentWord = normalized.match(PARENT_WORDS);

	if(parentWord) {
		return {side: 'parent', rest: normalized.substring(parentWord[0].length)};
	}

	if(normalized.endsWith('1')) {
		return {side: 'child', rest: normalized.slice(0, -1)};
	}

	if(normalized.endsWith('2')) {
		return {side: 'parent', rest: normalized.slice(0, -1)};
	}

	return {rest: normalized};
}

const RELATIONSHIP_KIND_PATTERNS: {kind: 'Schema' | 'TableSystemName' | 'ColumnSystemName'; pattern: RegExp}[] = [
	// Column before table: COLNAME would otherwise be taken by the table pattern's NAME alternative.
	{kind: 'ColumnSystemName', pattern: /^((SYS|SYSTEM)?(COL|COLUMN|FLD|FIELD)(NAME|SYSNAME)?)$/},
	{kind: 'Schema', pattern: /^(TABLE|TBL|TAB|FILE)?(SCHEMA|SCHEMANAME|LIB|LIBRARY|LIBNAME|DBNAME)$/},
	{kind: 'TableSystemName', pattern: /^((SYS|SYSTEM)?(TABLE|TBL|TAB|FILE)(NAME|SYSNAME)?|NAME|SYSNAME|TBNAME)$/}
];

function matchRelationshipTarget(name: string): SqlImportRelationshipsTarget | undefined {
	let normalized = normalize(name);

	for(let [target, pattern] of Object.entries(RELATIONSHIP_PATTERNS)) {
		if(pattern.test(normalized)) {
			return <SqlImportRelationshipsTarget>target;
		}
	}

	let {side, rest} = splitRelationshipSide(normalized);

	if(!side) {
		return undefined;
	}

	let kind = RELATIONSHIP_KIND_PATTERNS.find(candidate => candidate.pattern.test(rest));

	return kind ? <SqlImportRelationshipsTarget>`${side}${kind.kind}` : undefined;
}

function matchTarget(section: SqlImportSectionId, name: string): SqlImportTarget | undefined {
	if(section === 'relationships') {
		return matchRelationshipTarget(name);
	}

	let patterns = section === 'tables' ? TABLES_PATTERNS : COLUMNS_PATTERNS;
	let normalized = normalize(name);

	for(let [target, pattern] of Object.entries(patterns)) {
		if(pattern.test(normalized)) {
			return <SqlImportTarget>target;
		}
	}

	return undefined;
}

// Result columns are walked in result-set order and the first one to claim a target keeps it, so a
// statement that returns two plausible matches for the same target maps the one the user wrote first
// and leaves the other on "(ignore)" - rather than silently overwriting.
export function autoMapSqlImportColumns(section: SqlImportSectionId, resultColumns: string[]): Record<string, SqlImportTarget> {
	let valid = new Set<string>(getSqlImportSection(section).targets.map(target => target.id));
	let mapping: Record<string, SqlImportTarget> = {};
	let claimed = new Set<SqlImportTarget>();

	for(let resultColumn of resultColumns) {
		let target = matchTarget(section, resultColumn);

		if(target && valid.has(target) && !claimed.has(target)) {
			mapping[resultColumn] = target;
			claimed.add(target);
		}
	}

	return mapping;
}
