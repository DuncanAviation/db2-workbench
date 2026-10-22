import { ArrayUtils } from '../../../utils/array-utils.js';
import { StringUtils } from '../../../utils/string-utils.js';

/**
 * The declarative description of a database a test wants to run against - schemas, tables, columns,
 * keys, indexes, advice, triggers, procedures, functions and row data - which FakeDriver serves through CatalogResponder.
 *
 * Declaring the database rather than canned per-query rows is what keeps a fixture maintainable: a
 * test says "MYLIB.ORDERS has these three columns and a primary key on ORDNO", and every catalog
 * query the extension runs (Columns tab, Table Keys tab, autocomplete, a diagram load) is answered
 * from that one statement. Writing one canned response per catalog query instead would mean
 * rewriting the fixture every time a query's SELECT list changed.
 *
 * Everything but the names has a default, so a fixture only states what the test actually cares
 * about - see defineFakeDatabase().
 */
export interface FakeDatabase {
	/** Reported by the two connection-time lookups every session makes (see CatalogResponder). */
	job: FakeJob;
	schemas: FakeSchema[];
	/** IFS files a program's source can be read from (QSYS2.IFS_READ), by absolute path. */
	streamFiles: FakeStreamFile[];
}

export interface FakeJob {
	jobName: string;
	ip: string;
	createdDate: string;
	sortSequence: string;
	sortSequenceLibrary: string;
	languageId: string;
}

export interface FakeSchema {
	name: string;
	description: string;
	/** 'User' or 'System', as CatalogQueries.listSchemas classifies them. */
	type: string;
	/** Whether this schema is on the connection's library list, as QSYS2.LIBRARY_LIST_INFO reports it.
	 * A session lists its eager tables, views and routines from that list, so a schema that isn't on it
	 * is only reachable by asking for it by name, exactly as on a real system. */
	onLibraryList: boolean;
	tables: FakeTable[];
	/** Answered from QSYS2.SYSVIEWS, and by every per-table lookup a view shares with a table (columns,
	 * a SELECT of its rows). */
	views: FakeView[];
	procedures: FakeProcedure[];
	functions: FakeFunction[];
	/** Native programs in this library - what an external trigger runs. */
	programs: FakeProgram[];
	/** Source file members in this library, readable through a QTEMP alias the way a real one is. */
	sourceMembers: FakeSourceMember[];
}

export interface FakeTable {
	name: string;
	description: string;
	remarks: string;
	columns: FakeColumn[];
	keys: FakeKey[];
	foreignKeys: FakeForeignKey[];
	indexes: FakeIndex[];
	advisedIndexes: FakeAdvisedIndex[];
	triggers: FakeTrigger[];
	/** The table's data, as row objects keyed by column system name - what a SELECT against this
	 * table returns (see FakeDriver's table-select handling). */
	rows: Record<string, unknown>[];
	/** Set only for a materialized query table: SYSTABLES.MQTDEF, the select it was created from. Its
	 * presence is what makes the table's SYSTABLES row type 'M'. */
	mqtDefinition?: string;
}

/**
 * A view is declared like a table - it has columns and rows a SELECT returns - plus the SQL it was
 * created from. Its keys/foreign keys/indexes stay empty, as a real view's do.
 */
export interface FakeView extends FakeTable {
	/** SYSVIEWS.TEXT - the CREATE VIEW's select statement. */
	definition: string;
}

/**
 * DB2 for i gives a column two names - the short "system" name and the long SQL name (EMNO vs
 * ACCT_EMPLOYEENO). Both are declared here because several features turn on the difference, and a
 * fixture that collapsed them would hide exactly the bugs those features had.
 */
export interface FakeColumn {
	systemName: string;
	sqlName: string;
	/** The DB2 type name as SYSCOLUMNS2.COLTYPE reports it - CHAR, VARCHAR, DECIMAL, INTEGER, DATE... */
	dataType: string;
	length: number;
	scale: number;
	precision: number;
	/** 'Y' or 'N', as SYSCOLUMNS2.NULLS reports it. */
	nulls: string;
	/** Column heading (SYSCOLUMNS2.LABEL) and descriptive text (LABELTEXT). */
	heading: string;
	text: string;
}

export interface FakeKey {
	name: string;
	/** 'PRIMARY KEY' or 'UNIQUE' - listTableKeys only returns these two. */
	type: string;
	/** Column system names, in key order. */
	columns: string[];
}

export interface FakeForeignKey {
	name: string;
	/** Column system names on this table, in key order. */
	columns: string[];
	referencedSchema: string;
	referencedTable: string;
	/** Column system names on the referenced table, positionally matched to `columns`. */
	referencedColumns: string[];
	updateRule: string;
	deleteRule: string;
}

export interface FakeIndex {
	name: string;
	schema: string;
	/** As SYSPARTITIONINDEXSTAT.INDEX_TYPE reports it - e.g. 'INDEX', 'LOGICAL', 'PRIMARY KEY'. */
	indexType: string;
	/** SYSPARTITIONINDEXSTAT's numeric uniqueness code - 0 unique, 1 unique where not null, 2-4
	 * non-unique. IndexQueries.describeIndexUniqueness turns it into display text. */
	unique: number;
	/** Pre-built ordered key column list, exactly as the catalog carries it ("ORDNO, LINENO"). */
	columnNames: string;
	owner: string;
	comment: string;
}

export interface FakeAdvisedIndex {
	id: number;
	keyColumnsAdvised: string;
	indexType: string;
	reasonAdvised: string;
	timesAdvised: number;
	lastAdvised: string;
	sortSequence: string;
	sortSequenceLibrary: string;
}

/** A QSYS2.SYSTRIGGERS row. An external trigger names a program and has no body; an SQL trigger has a body. */
export interface FakeTrigger {
	name: string;
	schema: string;
	/** As SYSTRIGGERS.TRIGEVENT reports it - INSERT, UPDATE, DELETE, READ or MULTI. */
	event: string;
	/** For a MULTI trigger, the events EVENT_I/EVENT_U/EVENT_D flag. */
	events: string[];
	timing: string;
	orientation: string;
	mode: string;
	actionOrder: number;
	condition: string;
	/** SYSTRIGGERS.TEXT - the trigger body, blank for an external trigger. */
	text: string;
	program: string;
	programLibrary: string;
	enabled: string;
	operative: string;
	updateCondition: string;
	created: string;
	description: string;
}

/** A *PGM, as QSYS2.PROGRAM_INFO and (for ILE) QSYS2.BOUND_MODULE_INFO report it. */
export interface FakeProgram {
	name: string;
	/** '*PGM' or '*SRVPGM'. */
	objectType: string;
	/** 'ILE' or 'OPM'. */
	type: string;
	/** An OPM program's one source location - ignored for ILE, whose sources are per module. */
	sourceLibrary: string;
	sourceFile: string;
	sourceMember: string;
	modules: FakeProgramModule[];
	/** Its static SQL statements' text, as QSYS2.SYSPROGRAMSTMTSTAT records them - normalized by the
	 * precompiler, so a fixture writes them the way IBM i does ("FROM LIB . TABLE", ": H"). */
	statements: string[];
	/** A service program's exported procedures, as QSYS2.PROGRAM_EXPORT_IMPORT_INFO lists them (*PROCEXP). */
	exports: string[];
}

export interface FakeProgramModule {
	name: string;
	sourceLibrary: string;
	sourceFile: string;
	sourceMember: string;
	/** Set instead of the member fields for a module compiled from the IFS. */
	streamFile: string;
	/** BOUND_MODULE_INFO.MODULE_CREATE_TIMESTAMP. */
	created: string;
}

export interface FakeSourceMember {
	file: string;
	member: string;
	lines: string[];
	/** SYSPARTITIONSTAT.LAST_CHANGE_TIMESTAMP. */
	lastChanged: string;
}

export interface FakeStreamFile {
	path: string;
	lines: string[];
}

export interface FakeProcedure {
	name: string;
	/** Defaults to the name - give two overloads of one name distinct ones. */
	specificName: string;
	/** 'SQL' or 'EXTERNAL'. */
	body: string;
	language: string;
	/** For an external procedure, the program it runs. */
	externalName: string;
	description: string;
	/** ROUTINE_DEFINITION - the SQL body. */
	definition: string;
	/** MAX_DYNAMIC_RESULT_SETS. */
	resultSets: number;
	parameters: FakeProcedureParameter[];
}

/**
 * A user-defined function, answered from QSYS2.SYSROUTINES alongside the procedures, and from SYSPARMS
 * for its parameters and results.
 */
export interface FakeFunction {
	name: string;
	/** Defaults to the name - give two overloads of one name distinct ones. */
	specificName: string;
	/** 'S' scalar, 'T' table or 'C' aggregate. */
	functionType: string;
	/** 'SQL' or 'EXTERNAL'. */
	body: string;
	language: string;
	/** For an external function, the program it runs. */
	externalName: string;
	description: string;
	/** ROUTINE_DEFINITION - the SQL body. */
	definition: string;
	parameters: FakeProcedureParameter[];
	/** A scalar function's result type. */
	returns: FakeProcedureParameter;
	/** A table function's result columns. */
	resultColumns: FakeProcedureParameter[];
}

export interface FakeProcedureParameter {
	name: string;
	/** 'IN', 'OUT' or 'INOUT'. */
	mode: string;
	dataType: string;
	length: number;
	scale: number;
	precision: number;
	description: string;
}

/** The same shapes with everything but the identifying names optional - what a fixture actually writes. */
export type FakeDatabaseInput = DeepPartialExcept<FakeDatabase>;

type DeepPartialExcept<T> = T extends (infer E)[] ? DeepPartialExcept<E>[] : T extends object ? { [K in keyof T]?: DeepPartialExcept<T[K]> } : T;

const DEFAULT_JOB: FakeJob = {
	jobName: '123456/QUSER/QZDASOINIT',
	ip: '10.0.0.1',
	createdDate: '2026-01-01 08:00:00.000000',
	sortSequence: '*HEX',
	sortSequenceLibrary: '',
	languageId: 'ENU'
};

/**
 * Fills in every default a fixture left out, so the rest of the fake driver can read a fully
 * populated FakeDatabase without optional-chaining through it. Names are uppercased the way DB2 for
 * i reports them, since that is what the extension's own normalization (toTableTargets, the readName
 * helpers) compares against.
 *
 * A column declared with only a systemName gets an sqlName equal to it - which is the common case on
 * a real system, and keeps a fixture that doesn't care about the short/long name distinction short.
 */
export function defineFakeDatabase(input: FakeDatabaseInput): FakeDatabase {
	return {
		job: { ...DEFAULT_JOB, ...<Partial<FakeJob>>input.job ?? ({}) },
		schemas: ArrayUtils.toArray(input.schemas).map(schema => defineSchema(<Partial<FakeSchema>>schema)),
		streamFiles: ArrayUtils.toArray(input.streamFiles).map(file => ({ path: StringUtils.default(file?.path, () => ''), lines: <string[]>ArrayUtils.toArray(file?.lines) }))
	};
}

function defineSchema(input: Partial<FakeSchema>): FakeSchema {
	let name = upper(input.name);

	return {
		name: name,
		description: StringUtils.default(input.description, () => ''),
		type: StringUtils.default(input.type, () => (name.startsWith('Q') || name.startsWith('SYS') ? 'System' : 'User')),
		onLibraryList: input.onLibraryList !== false,
		tables: ArrayUtils.toArray(input.tables).map(table => defineTable(<Partial<FakeTable>>table)),
		views: ArrayUtils.toArray(input.views).map(view => defineView(<Partial<FakeView>>view)),
		procedures: ArrayUtils.toArray(input.procedures).map(procedure => defineProcedure(<Partial<FakeProcedure>>procedure)),
		functions: ArrayUtils.toArray(input.functions).map(fakeFunction => defineFunction(<Partial<FakeFunction>>fakeFunction)),
		programs: ArrayUtils.toArray(input.programs).map(program => defineProgram(<Partial<FakeProgram>>program)),
		sourceMembers: ArrayUtils.toArray(input.sourceMembers).map(member => ({
			file: upper(member.file),
			member: upper(member.member),
			lines: <string[]>ArrayUtils.toArray(member.lines),
			lastChanged: StringUtils.default(member.lastChanged, () => '2025-01-01 08:00:00.000000')
		}))
	};
}

function defineTable(input: Partial<FakeTable>): FakeTable {
	return {
		name: upper(input.name),
		description: StringUtils.default(input.description, () => ''),
		remarks: StringUtils.default(input.remarks, () => ''),
		columns: ArrayUtils.toArray(input.columns).map(column => defineColumn(<Partial<FakeColumn>>column)),
		keys: ArrayUtils.toArray(input.keys).map(key => defineKey(<Partial<FakeKey>>key)),
		foreignKeys: ArrayUtils.toArray(input.foreignKeys).map(foreignKey => defineForeignKey(<Partial<FakeForeignKey>>foreignKey)),
		indexes: ArrayUtils.toArray(input.indexes).map(index => defineIndex(<Partial<FakeIndex>>index)),
		advisedIndexes: ArrayUtils.toArray(input.advisedIndexes).map((advice, position) => defineAdvisedIndex(<Partial<FakeAdvisedIndex>>advice, position)),
		triggers: ArrayUtils.toArray(input.triggers).map((trigger, position) => defineTrigger(<Partial<FakeTrigger>>trigger, position)),
		rows: <Record<string, unknown>[]>ArrayUtils.toArray(input.rows),
		...(input.mqtDefinition != null ? { mqtDefinition: input.mqtDefinition } : {})
	};
}

function defineView(input: Partial<FakeView>): FakeView {
	return {
		...defineTable(input),
		definition: StringUtils.default(input.definition, () => '')
	};
}

function defineColumn(input: Partial<FakeColumn>): FakeColumn {
	let systemName = upper(input.systemName);

	return {
		systemName: systemName,
		sqlName: StringUtils.isNotBlank(input.sqlName) ? upper(input.sqlName) : systemName,
		dataType: StringUtils.default(input.dataType, () => 'CHAR').toUpperCase(),
		length: input.length ?? 10,
		scale: input.scale ?? 0,
		precision: input.precision ?? 0,
		nulls: StringUtils.default(input.nulls, () => 'Y'),
		heading: StringUtils.default(input.heading, () => ''),
		text: StringUtils.default(input.text, () => '')
	};
}

function defineKey(input: Partial<FakeKey>): FakeKey {
	return {
		name: upper(input.name),
		type: StringUtils.default(input.type, () => 'PRIMARY KEY').toUpperCase(),
		columns: ArrayUtils.toArray(<string[]>input.columns).map(column => upper(column))
	};
}

function defineForeignKey(input: Partial<FakeForeignKey>): FakeForeignKey {
	return {
		name: upper(input.name),
		columns: ArrayUtils.toArray(<string[]>input.columns).map(column => upper(column)),
		referencedSchema: upper(input.referencedSchema),
		referencedTable: upper(input.referencedTable),
		referencedColumns: ArrayUtils.toArray(<string[]>input.referencedColumns).map(column => upper(column)),
		updateRule: StringUtils.default(input.updateRule, () => 'NO ACTION'),
		deleteRule: StringUtils.default(input.deleteRule, () => 'NO ACTION')
	};
}

function defineIndex(input: Partial<FakeIndex>): FakeIndex {
	return {
		name: upper(input.name),
		schema: upper(input.schema),
		indexType: StringUtils.default(input.indexType, () => 'INDEX'),
		unique: input.unique ?? 2,
		columnNames: StringUtils.default(input.columnNames, () => ''),
		owner: StringUtils.default(input.owner, () => ''),
		comment: StringUtils.default(input.comment, () => '')
	};
}

function defineAdvisedIndex(input: Partial<FakeAdvisedIndex>, position: number): FakeAdvisedIndex {
	return {
		// RRN(SYSIXADV) on a real system - just has to be stable and unique per row here, since the
		// Advised Indexes tab uses it to identify which advice a row action applies to.
		id: input.id ?? position + 1,
		keyColumnsAdvised: StringUtils.default(input.keyColumnsAdvised, () => ''),
		indexType: StringUtils.default(input.indexType, () => 'RADIX'),
		reasonAdvised: StringUtils.default(input.reasonAdvised, () => 'Row selection'),
		timesAdvised: input.timesAdvised ?? 1,
		lastAdvised: StringUtils.default(input.lastAdvised, () => '2026-01-01 08:00:00.000000'),
		sortSequence: StringUtils.default(input.sortSequence, () => '*HEX'),
		sortSequenceLibrary: StringUtils.default(input.sortSequenceLibrary, () => '')
	};
}

function defineTrigger(input: Partial<FakeTrigger>, position: number): FakeTrigger {
	return {
		name: upper(input.name),
		schema: upper(input.schema),
		event: StringUtils.default(input.event, () => 'INSERT').toUpperCase(),
		events: ArrayUtils.toArray(<string[]>input.events).map(event => upper(event)),
		timing: StringUtils.default(input.timing, () => 'AFTER'),
		orientation: StringUtils.default(input.orientation, () => 'ROW'),
		mode: StringUtils.default(input.mode, () => 'DB2ROW'),
		actionOrder: input.actionOrder ?? position + 1,
		condition: StringUtils.default(input.condition, () => ''),
		text: StringUtils.default(input.text, () => ''),
		program: upper(input.program),
		programLibrary: upper(input.programLibrary),
		enabled: StringUtils.default(input.enabled, () => 'Y'),
		operative: StringUtils.default(input.operative, () => 'Y'),
		updateCondition: StringUtils.default(input.updateCondition, () => ''),
		created: StringUtils.default(input.created, () => '2026-01-01 08:00:00.000000'),
		description: StringUtils.default(input.description, () => '')
	};
}

function defineProgram(input: Partial<FakeProgram>): FakeProgram {
	return {
		name: upper(input.name),
		objectType: StringUtils.default(input.objectType, () => '*PGM').toUpperCase(),
		type: StringUtils.default(input.type, () => 'ILE').toUpperCase(),
		sourceLibrary: upper(input.sourceLibrary),
		sourceFile: upper(input.sourceFile),
		sourceMember: upper(input.sourceMember),
		modules: ArrayUtils.toArray(input.modules).map(module => ({
			name: upper(module?.name),
			sourceLibrary: upper(module?.sourceLibrary),
			sourceFile: upper(module?.sourceFile),
			sourceMember: upper(module?.sourceMember),
			streamFile: StringUtils.default(module?.streamFile, () => ''),
			created: StringUtils.default(module?.created, () => '2026-01-01 08:00:00.000000')
		})),
		statements: <string[]>ArrayUtils.toArray(input.statements),
		exports: <string[]>ArrayUtils.toArray(input.exports)
	};
}

function defineProcedure(input: Partial<FakeProcedure>): FakeProcedure {
	return {
		name: upper(input.name),
		specificName: StringUtils.isNotBlank(input.specificName) ? upper(input.specificName) : upper(input.name),
		body: StringUtils.default(input.body, () => 'SQL').toUpperCase(),
		language: StringUtils.default(input.language, () => 'SQL'),
		externalName: StringUtils.default(input.externalName, () => ''),
		description: StringUtils.default(input.description, () => ''),
		definition: StringUtils.default(input.definition, () => ''),
		resultSets: input.resultSets ?? 0,
		parameters: ArrayUtils.toArray(input.parameters).map(parameter => defineProcedureParameter(<Partial<FakeProcedureParameter>>parameter))
	};
}

function defineFunction(input: Partial<FakeFunction>): FakeFunction {
	return {
		name: upper(input.name),
		specificName: StringUtils.isNotBlank(input.specificName) ? upper(input.specificName) : upper(input.name),
		functionType: StringUtils.default(input.functionType, () => 'S').toUpperCase(),
		body: StringUtils.default(input.body, () => 'SQL').toUpperCase(),
		language: StringUtils.default(input.language, () => 'SQL'),
		externalName: StringUtils.default(input.externalName, () => ''),
		description: StringUtils.default(input.description, () => ''),
		definition: StringUtils.default(input.definition, () => ''),
		parameters: ArrayUtils.toArray(input.parameters).map(parameter => defineProcedureParameter(<Partial<FakeProcedureParameter>>parameter)),
		returns: defineProcedureParameter({ mode: 'OUT', ...<Partial<FakeProcedureParameter>>input.returns }),
		resultColumns: ArrayUtils.toArray(input.resultColumns).map(column => defineProcedureParameter({ mode: 'OUT', ...<Partial<FakeProcedureParameter>>column }))
	};
}

function defineProcedureParameter(input: Partial<FakeProcedureParameter>): FakeProcedureParameter {
	return {
		name: upper(input.name),
		mode: StringUtils.default(input.mode, () => 'IN').toUpperCase(),
		dataType: StringUtils.default(input.dataType, () => 'CHAR').toUpperCase(),
		length: input.length ?? 10,
		scale: input.scale ?? 0,
		precision: input.precision ?? 0,
		description: StringUtils.default(input.description, () => '')
	};
}

function upper(value: string | undefined): string {
	return StringUtils.default(value, () => '').trim().toUpperCase();
}

/** The schema and table a target names, as the fake driver looks them up. A view answers too - `isView`
 * tells the two apart where the real system would. */
export function findTable(database: FakeDatabase, schema: string | undefined, table: string): { schema: FakeSchema; table: FakeTable; isView: boolean } | undefined {
	for(let fakeSchema of database.schemas) {
		if(StringUtils.isNotBlank(schema) && !StringUtils.equalsIgnoreCase(fakeSchema.name, schema)) {
			continue;
		}

		let fakeTable = fakeSchema.tables.find(candidate => StringUtils.equalsIgnoreCase(candidate.name, table));

		if(fakeTable) {
			return { schema: fakeSchema, table: fakeTable, isView: false };
		}

		let fakeView = fakeSchema.views.find(candidate => StringUtils.equalsIgnoreCase(candidate.name, table));

		if(fakeView) {
			return { schema: fakeSchema, table: fakeView, isView: true };
		}
	}

	return undefined;
}
