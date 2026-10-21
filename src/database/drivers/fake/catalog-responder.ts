import { Parameter } from '../../../interfaces/parameter.js';
import { ArrayUtils } from '../../../utils/array-utils.js';
import { Nullable } from '../../../utils/nullable.js';
import { StringUtils } from '../../../utils/string-utils.js';
import { FakeDatabase, FakeFunction, FakeProcedure, FakeProcedureParameter, FakeSchema, FakeTable, FakeTrigger, FakeView } from './fake-database.js';

/**
 * Answers the QSYS2 catalog queries the extension runs, out of a declared FakeDatabase.
 *
 * This is not a SQL engine and never will be - it identifies which catalog object a statement reads
 * and which tables it asks about, then projects the fixture into rows under the column names that
 * statement's mapper reads. That is the same level of rigour the rest of the codebase applies to SQL
 * (see StatementParser), and it is deliberate: running real SQL would mean shimming DB2 syntax an
 * engine doesn't have, which is a second source of bugs that say nothing about this extension.
 *
 * Row keys are upper case because that is how the ODBC driver reports DB2 for i column labels, and
 * every mapper in src/database/queries/ reads them that way.
 *
 * The cost of this approach: when a catalog query's SELECT list changes, the matching builder here
 * has to change with it, or the tab it feeds goes quietly empty. That is why FakeDriver's own
 * response map stays available for tests that would rather pin exact rows.
 */
export class CatalogResponder {
	// QTEMP aliases created over a source member, by alias name - QTEMP belongs to the job, so these
	// live exactly as long as this driver's connections do.
	private aliases = new Map<string, { library: string; file: string; member: string }>();

	constructor(private database: FakeDatabase) { }

	/**
	 * The rows for `sql`, or undefined when this isn't a catalog statement the responder knows -
	 * which FakeDriver turns into a loud miss rather than an empty result.
	 */
	respond(sql: string, parameters?: Array<Parameter>): Nullable<Record<string, unknown>[]> {
		let normalized = CatalogResponder.normalize(sql);
		let values = <string[]>ArrayUtils.toArray(parameters).map(value => String(value));

		// Ordered most specific first: a foreign-key query reads SYSCST too, and an index query reads
		// both SYSPARTITIONINDEXSTAT and SYSINDEXES.
		if(normalized.includes('qsys2.get_job_info') || normalized.includes('qsys2.job_info')) {
			return this.buildJobDetails();
		}

		// Before the library list and SYSTABLES checks: the eager view list joins both.
		if(normalized.includes('qsys2.sysviews')) {
			return this.buildViews(normalized, values);
		}

		if(normalized.includes('qsys2.library_list_info') && !normalized.includes('qsys2.systables') && !normalized.includes('qsys2.sysroutines')) {
			return this.buildLibraryList();
		}

		// TriggerDispatchQueries.listExistingLibraries asks which of its bound names are libraries.
		if(normalized.includes('qsys2.sysschemas') && normalized.includes('where sys_name in')) {
			return this.buildSchemas().filter(schema => values.some(value => StringUtils.equalsIgnoreCase(value, <string>schema.SYS_NAME)));
		}

		if(normalized.includes('qsys2.sysschemas')) {
			return this.buildSchemas();
		}

		if(normalized.includes('qsys2.systables')) {
			return this.buildTables(normalized, values);
		}

		if(normalized.includes('qsys2.syscolumns2')) {
			return this.buildColumns(CatalogResponder.readTargets(normalized, values, 'dbname', 'tbname'));
		}

		if(normalized.includes('qsys2.sysrefcst')) {
			return this.buildForeignKeys(CatalogResponder.readTargets(normalized, values, 'system_table_schema', 'system_table_name'));
		}

		if(normalized.includes('qsys2.syscst')) {
			return this.buildTableKeys(CatalogResponder.readTargets(normalized, values, 'system_table_schema', 'system_table_name'));
		}

		if(normalized.includes('qsys2.syspartitionindexstat')) {
			return this.buildIndexes(CatalogResponder.readTargets(normalized, values, 'table_schema', 'table_name'));
		}

		if(normalized.includes('qsys2.sysixadv')) {
			// A DELETE against SYSIXADV is the Advised Indexes tab discarding one row of advice - it
			// reports success by returning no rows, same as the real thing.
			return normalized.startsWith('delete') ? [] : this.buildIndexAdvice(CatalogResponder.readTargets(normalized, values, 'table_schema', 'table_name'));
		}

		// ProgramQueries reads a source member through an alias it creates in QTEMP, then drops.
		if(normalized.includes('qtemp.')) {
			return this.respondToAlias(normalized);
		}

		if(normalized.includes('qsys2.generate_sql')) {
			return this.buildGeneratedSql(values);
		}

		if(normalized.includes('qsys2.object_statistics(\'*libl\'')) {
			return this.buildLibraryListObject(values);
		}

		if(normalized.includes('qsys2.object_statistics(?, \'*pgm *srvpgm\')')) {
			return this.buildLibraryPrograms(values);
		}

		if(normalized.includes('qsys2.sysprogramstmtstat')) {
			return (this.findProgramOfAnyType(values[0], values[1])?.statements ?? []).map(statement => ({ STATEMENT_TEXT: statement }));
		}

		if(normalized.includes('qsys2.program_export_import_info')) {
			return (this.findProgram(values)?.exports ?? []).map(symbol => ({ SYMBOL_NAME: symbol }));
		}

		if(normalized.includes('qsys2.object_statistics(\'*allusr\'')) {
			return this.buildUserLibraryObjects(values);
		}

		if(normalized.includes('qsys2.program_info')) {
			return this.buildPrograms(values);
		}

		if(normalized.includes('qsys2.bound_module_info')) {
			return this.buildBoundModules(values);
		}

		if(normalized.includes('qsys2.ifs_read')) {
			let file = this.database.streamFiles.find(candidate => candidate.path === values[0]);

			if(!file) {
				throw new Error(`FakeDriver: no stream file ${values[0]}`);
			}

			return file.lines.map((line, index) => ({ LINE_NUMBER: index + 1, LINE: line }));
		}

		if(normalized.includes('qsys2.syspartitionstat')) {
			return this.buildMembers(normalized, values);
		}

		if(normalized.includes('qsys2.systriggers')) {
			return this.buildTriggers(CatalogResponder.readTargets(normalized, values, 'sys_dname', 'sys_tname'));
		}

		if(normalized.includes('qsys2.sysroutines')) {
			return this.buildRoutines(normalized, values);
		}

		if(normalized.includes('qsys2.sysparms')) {
			return this.buildRoutineParameters(CatalogResponder.readTargets(normalized, values, 'specific_schema', 'specific_name'));
		}

		return undefined;
	}

	private buildJobDetails(): Record<string, unknown>[] {
		let job = this.database.job;

		return [{
			JOB_NAME: job.jobName,
			V_CLIENT_IP_ADDRESS: job.ip,
			JOB_ENTERED_SYSTEM_TIME: job.createdDate,
			SORT_SEQUENCE_NAME: job.sortSequence,
			SORT_SEQUENCE_LIBRARY: job.sortSequenceLibrary,
			LANGUAGE_ID: job.languageId
		}];
	}

	private buildLibraryList(): Record<string, unknown>[] {
		return this.database.schemas
			.filter(schema => schema.onLibraryList)
			.map((schema, index) => ({
				ORDINAL_POSITION: index + 1,
				SYSTEM_SCHEMA_NAME: schema.name,
				TYPE: schema.type === 'System' ? 'SYSTEM' : 'USER',
				TEXT_DESCRIPTION: schema.description
			}));
	}

	private buildSchemas(): Record<string, unknown>[] {
		return this.database.schemas.map(schema => ({
			SYS_NAME: schema.name,
			LABEL: schema.description,
			SCHEMA_TYPE: schema.type
		}));
	}

	/**
	 * CatalogQueries.listTables has two shapes: an eager one joined to LIBRARY_LIST_INFO (every table
	 * on the library list) and a targeted one filtered by `sys_dname in (?, ...)`. The parameters are
	 * schema names in the second case, so they're matched by name rather than through readTargets.
	 * Both list materialized query tables along with the tables. CatalogQueries.getMqtDefinition selects
	 * MQTDEF alone for one MQT, bound [schema, table].
	 */
	private buildTables(normalized: string, values: string[]): Record<string, unknown>[] {
		if(normalized.startsWith('select mqtdef from')) {
			let table = this.database.schemas.find(candidate => StringUtils.equalsIgnoreCase(candidate.name, values[0]))
				?.tables.find(candidate => StringUtils.equalsIgnoreCase(candidate.name, values[1]));
			return table?.mqtDefinition != null ? [{ MQTDEF: table.mqtDefinition }] : [];
		}

		let schemas = normalized.includes('library_list_info')
			? this.database.schemas.filter(schema => schema.onLibraryList)
			: this.database.schemas.filter(schema => values.some(value => StringUtils.equalsIgnoreCase(value, schema.name)));

		return schemas.flatMap(schema => schema.tables.map(table => CatalogResponder.buildTableRow(schema, table)));
	}

	// The MQT columns are null for anything else, as SYSTABLES' are.
	private static buildTableRow(schema: FakeSchema, table: FakeTable): Record<string, unknown> {
		let isMqt = table.mqtDefinition != null;

		return {
			SYS_DNAME: schema.name,
			SYS_TNAME: table.name,
			TYPE: isMqt ? 'M' : 'T',
			LABEL: table.description,
			REMARKS: table.remarks,
			DBNAME: schema.name,
			ALTEREDTS: '2026-01-01 08:00:00.000000',
			FILETYPE: 'D',
			LOCATION: '',
			TBDBNAME: schema.name,
			TBNAME: table.name,
			TBMEMBER: table.name,
			SYSTABLE: 'N',
			SELECTOMIT: 'N',
			INSERTABLE: 'Y',
			IASPNUMBER: 0,
			ENABLED: isMqt ? 'YES' : null,
			MAINTAIN: isMqt ? 'USER' : null,
			REFRESH: isMqt ? 'DEFERRED' : null,
			REFRESHDTS: isMqt ? '2026-01-02 06:00:00.000000' : null,
			ISOLATION: isMqt ? 'CS' : null,
			PART_TABLE: 'NO',
			DEFINER: 'QSECOFR',
			MQTRSTDFR: isMqt ? 'N' : null,
			DECFLTRND: '',
			CONTROL: '',
			TEMPORALTY: '',
			DROPRULE: ''
		};
	}

	/**
	 * CatalogQueries has two SYSVIEWS statements. getViewDefinition selects TEXT alone for one view,
	 * bound [schema, view]. listViews has the same two shapes listTables does - joined to LIBRARY_LIST_INFO
	 * or filtered by `sys_vdname in (?, ...)`.
	 */
	private buildViews(normalized: string, values: string[]): Record<string, unknown>[] {
		if(normalized.startsWith('select text from')) {
			let schema = this.database.schemas.find(candidate => StringUtils.equalsIgnoreCase(candidate.name, values[0]));
			let view = schema?.views.find(candidate => StringUtils.equalsIgnoreCase(candidate.name, values[1]));
			return view ? [{ TEXT: view.definition }] : [];
		}

		let schemas = normalized.includes('library_list_info')
			? this.database.schemas.filter(schema => schema.onLibraryList)
			: this.database.schemas.filter(schema => values.some(value => StringUtils.equalsIgnoreCase(value, schema.name)));

		return schemas.flatMap(schema => schema.views.map(view => CatalogResponder.buildViewRow(schema, view)));
	}

	private static buildViewRow(schema: FakeSchema, view: FakeView): Record<string, unknown> {
		return {
			SYS_VDNAME: schema.name,
			SYS_VNAME: view.name,
			DBNAME: schema.name,
			NAME: view.name,
			CREATOR: 'QSECOFR',
			DEFINER: 'QSECOFR',
			SEQNO: 1,
			CHECK_OPTION: 'N',
			IASPNUMBER: 0,
			INSERTABLE: 'NO',
			UPDATES: 'N',
			DELETES: 'N',
			DECFLTRND: '',
			LABEL: view.description,
			REMARKS: view.remarks
		};
	}

	private buildColumns(targets: CatalogResponder.Target[]): Record<string, unknown>[] {
		return this.eachTable(targets, (schema, table) => table.columns.map((column, index) => ({
			DBNAME: schema.name,
			TBNAME: table.name,
			COLNO: index + 1,
			SYS_CNAME: column.systemName,
			NAME: column.sqlName,
			LABEL: column.heading,
			LABELTEXT: column.text,
			COLTYPE: column.dataType,
			LENGTH: column.length,
			SCALE: column.scale,
			PRECISION: column.precision,
			NULLS: column.nulls,
			IDENTITY: 'N',
			GENERATED: '',
			START: 0,
			INCREMENT: 0,
			MINVALUE: 0,
			MAXVALUE: 0,
			CYCLE: 'N',
			CACHE: 0,
			CCSID: 37,
			DFTVALUE: '',
			HAS_DEFAULT: 'N',
			HIDDEN: 'N',
			UPDATES: 'Y'
		})));
	}

	private buildTableKeys(targets: CatalogResponder.Target[]): Record<string, unknown>[] {
		return this.eachTable(targets, (schema, table) => table.keys.flatMap(key => key.columns.map((columnName, position) => ({
			SYSTEM_TABLE_SCHEMA: schema.name,
			SYSTEM_TABLE_NAME: table.name,
			CONSTRAINT_NAME: key.name,
			CONSTRAINT_TYPE: key.type,
			COLUMN_NAME: CatalogResponder.sqlNameOf(table, columnName),
			SYSTEM_COLUMN_NAME: columnName,
			ORDINAL_POSITION: position + 1
		}))));
	}

	private buildForeignKeys(targets: CatalogResponder.Target[]): Record<string, unknown>[] {
		return this.eachTable(targets, (schema, table) => table.foreignKeys.flatMap(foreignKey => {
			let referenced = this.database.schemas
				.find(candidate => StringUtils.equalsIgnoreCase(candidate.name, foreignKey.referencedSchema))
				?.tables.find(candidate => StringUtils.equalsIgnoreCase(candidate.name, foreignKey.referencedTable));

			return foreignKey.columns.map((columnName, position) => {
				let referencedColumn = StringUtils.default(foreignKey.referencedColumns[position], () => '');

				return {
					OWNING_SCHEMA: schema.name,
					OWNING_TABLE: table.name,
					CONSTRAINT_NAME: foreignKey.name,
					COLUMN_NAME: CatalogResponder.sqlNameOf(table, columnName),
					SYSTEM_COLUMN_NAME: columnName,
					ORDINAL_POSITION: position + 1,
					UPDATE_RULE: foreignKey.updateRule,
					DELETE_RULE: foreignKey.deleteRule,
					REFERENCED_SCHEMA: foreignKey.referencedSchema,
					REFERENCED_TABLE: foreignKey.referencedTable,
					REFERENCED_COLUMN_NAME: referenced ? CatalogResponder.sqlNameOf(referenced, referencedColumn) : referencedColumn,
					REFERENCED_SYSTEM_COLUMN_NAME: referencedColumn
				};
			});
		}));
	}

	private buildIndexes(targets: CatalogResponder.Target[]): Record<string, unknown>[] {
		return this.eachTable(targets, (schema, table) => table.indexes.map(index => ({
			TABLE_SCHEMA: schema.name,
			TABLE_NAME: table.name,
			TABLE_PARTITION: table.name,
			INDEX_SCHEMA: StringUtils.isNotBlank(index.schema) ? index.schema : schema.name,
			INDEX_NAME: index.name,
			INDEX_TYPE: index.indexType,
			UNIQUE_CODE: index.unique,
			COLUMN_NAMES: index.columnNames,
			INDEX_SIZE: 8192,
			CREATE_TIMESTAMP: '2026-01-01 08:00:00.000000',
			LAST_BUILD_TIMESTAMP: '2026-01-01 08:00:00.000000',
			LAST_QUERY_USE: null,
			QUERY_USE_COUNT: 0,
			QUERY_STATISTICS_COUNT: 0,
			LAST_USED_TIMESTAMP: null,
			INDEX_OWNER: StringUtils.isNotBlank(index.owner) ? index.owner : null,
			INDEX_TEXT: StringUtils.isNotBlank(index.comment) ? index.comment : null
		})));
	}

	private buildIndexAdvice(targets: CatalogResponder.Target[]): Record<string, unknown>[] {
		return this.eachTable(targets, (schema, table) => table.advisedIndexes.map(advice => ({
			ID: advice.id,
			TABLE_SCHEMA: schema.name,
			TABLE_NAME: table.name,
			KEY_COLUMNS_ADVISED: advice.keyColumnsAdvised,
			INDEX_TYPE: advice.indexType,
			REASON_ADVISED: advice.reasonAdvised,
			TIMES_ADVISED: advice.timesAdvised,
			LAST_ADVISED: advice.lastAdvised,
			NLSSNAME: advice.sortSequence,
			NLSSDBNAME: advice.sortSequenceLibrary
		})));
	}

	private buildTriggers(targets: CatalogResponder.Target[]): Record<string, unknown>[] {
		let flag = (trigger: FakeTrigger, event: string) => trigger.event === event || trigger.events.includes(event) ? 'Y' : 'N';

		return this.eachTable(targets, (schema, table) => table.triggers.map(trigger => ({
			SYS_DNAME: schema.name,
			SYS_TNAME: table.name,
			TRIGSCHEMA: StringUtils.isNotBlank(trigger.schema) ? trigger.schema : schema.name,
			TRIGNAME: trigger.name,
			TRIGEVENT: trigger.event,
			EVENT_I: flag(trigger, 'INSERT'),
			EVENT_U: flag(trigger, 'UPDATE'),
			EVENT_D: flag(trigger, 'DELETE'),
			TRIGTIME: trigger.timing,
			GRANULAR: trigger.orientation,
			TRIGMODE: trigger.mode,
			ORDERSEQNO: trigger.actionOrder,
			CONDITION: StringUtils.isNotBlank(trigger.condition) ? trigger.condition : null,
			TEXT: StringUtils.isNotBlank(trigger.text) ? trigger.text : null,
			OLD_ROW: null,
			NEW_ROW: null,
			OLD_TABLE: null,
			NEW_TABLE: null,
			TRIGPGMLIB: StringUtils.isNotBlank(trigger.programLibrary) ? trigger.programLibrary : schema.name,
			TRIGPGM: StringUtils.isNotBlank(trigger.program) ? trigger.program : trigger.name,
			OPERATIVE: trigger.operative,
			ENABLED: trigger.enabled,
			THDSAFE: 'UNKNOWN',
			MLTTHDACN: 'SYSVAL',
			ALWREPCHG: 'YES',
			TRGUPDCND: StringUtils.isNotBlank(trigger.updateCondition) ? trigger.updateCondition : null,
			SECURE: 'N',
			DEFINER: 'QSECOFR',
			CREATE_DTS: trigger.created,
			ALTEREDTS: null,
			LABEL: StringUtils.isNotBlank(trigger.description) ? trigger.description : null,
			REMARKS: null
		})));
	}

	/** ProgramQueries binds [library, program, object type]. */
	private buildPrograms(values: string[]): Record<string, unknown>[] {
		let program = this.findProgram(values);

		return program == null ? [] : [{
			PROGRAM_TYPE: program.type,
			SOURCE_FILE_LIBRARY: program.type === 'ILE' || StringUtils.isBlank(program.sourceLibrary) ? null : program.sourceLibrary,
			SOURCE_FILE: program.type === 'ILE' || StringUtils.isBlank(program.sourceFile) ? null : program.sourceFile,
			SOURCE_FILE_MEMBER: program.type === 'ILE' || StringUtils.isBlank(program.sourceMember) ? null : program.sourceMember
		}];
	}

	private buildBoundModules(values: string[]): Record<string, unknown>[] {
		let program = this.findProgram(values);
		let blankAsNull = (value: string) => StringUtils.isNotBlank(value) ? value : null;

		return (program?.modules ?? []).map(module => ({
			BOUND_MODULE: module.name,
			SOURCE_FILE_LIBRARY: blankAsNull(module.sourceLibrary),
			SOURCE_FILE: blankAsNull(module.sourceFile),
			SOURCE_FILE_MEMBER: blankAsNull(module.sourceMember),
			SOURCE_STREAM_FILE_PATH: blankAsNull(module.streamFile),
			MODULE_CREATE_TIMESTAMP: module.created
		}));
	}

	private findProgram(values: string[]) {
		let schema = this.database.schemas.find(candidate => StringUtils.equalsIgnoreCase(candidate.name, values[0]));
		return schema?.programs.find(candidate => StringUtils.equalsIgnoreCase(candidate.name, values[1]) && StringUtils.equalsIgnoreCase(candidate.objectType, values[2]));
	}

	/**
	 * A '*LIBL' lookup binds [object types, name] - the types a space-separated list, as OBJECT_STATISTICS
	 * takes them. One row per library-list schema holding a match, in list order, so the first is the one
	 * the system would resolve. *FILE is answered from the tables and views.
	 */
	private buildLibraryListObject(values: string[]): Record<string, unknown>[] {
		let types = values[0].toUpperCase().split(/\s+/);

		return this.database.schemas.filter(schema => schema.onLibraryList).flatMap(schema => [
			...schema.programs.filter(program => types.includes(program.objectType) && StringUtils.equalsIgnoreCase(program.name, values[1]))
				.map(program => ({ OBJLIB: schema.name, OBJNAME: program.name, OBJTYPE: program.objectType })),
			...(types.includes('*FILE') ? [...schema.tables, ...schema.views] : []).filter(table => StringUtils.equalsIgnoreCase(table.name, values[1]))
				.map(table => ({ OBJLIB: schema.name, OBJNAME: table.name, OBJTYPE: '*FILE' }))
		]);
	}

	/** TriggerDispatchQueries.findPrograms binds [library, ...names] - that library's programs and service programs by those names. */
	private buildLibraryPrograms(values: string[]): Record<string, unknown>[] {
		let [library, ...names] = values;
		let schema = this.database.schemas.find(candidate => StringUtils.equalsIgnoreCase(candidate.name, library));

		return (schema?.programs ?? [])
			.filter(program => names.some(name => StringUtils.equalsIgnoreCase(name, program.name)))
			.map(program => ({ OBJLIB: schema?.name, OBJNAME: program.name, OBJTYPE: program.objectType }));
	}

	/** SYSPROGRAMSTMTSTAT is bound [library, program] with no object type - a *PGM's or a *SRVPGM's statements alike. */
	private findProgramOfAnyType(library: string, name: string) {
		let schema = this.database.schemas.find(candidate => StringUtils.equalsIgnoreCase(candidate.name, library));
		return schema?.programs.find(candidate => StringUtils.equalsIgnoreCase(candidate.name, name));
	}

	/**
	 * A '*ALLUSR' lookup binds [object type, name] - every schema holding it, on the library list or not.
	 * ProgramQueries asks for several source files in one statement, a union of these, so the bound
	 * values are read in pairs. A *FILE is a source file any of the schema's members are in.
	 */
	private buildUserLibraryObjects(values: string[]): Record<string, unknown>[] {
		let rows: Record<string, unknown>[] = [];

		for(let index = 0; index + 1 < values.length; index += 2) {
			let [type, name] = [values[index], values[index + 1]];

			for(let schema of this.database.schemas) {
				let holds = StringUtils.equalsIgnoreCase(type, '*FILE')
					? schema.sourceMembers.some(member => StringUtils.equalsIgnoreCase(member.file, name))
					: schema.programs.some(program => StringUtils.equalsIgnoreCase(program.objectType, type) && StringUtils.equalsIgnoreCase(program.name, name));

				if(holds) {
					rows.push({ OBJLIB: schema.name, OBJNAME: name.toUpperCase() });
				}
			}
		}

		return rows;
	}

	/**
	 * ProgramQueries asks SYSPARTITIONSTAT two ways, in the exact shapes program-source.ts builds: which of
	 * some [library, file, member] triples exist, and where members by [file, member] are among a list of
	 * libraries. The second's IN lists vary in length, so the markers are counted off the statement.
	 */
	private buildMembers(normalized: string, values: string[]): Record<string, unknown>[] {
		let wanted: { libraries: string[]; file: string; member: string }[] = [];

		if(normalized.includes('system_table_schema = ?')) {
			for(let index = 0; index + 2 < values.length; index += 3) {
				wanted.push({ libraries: [values[index]], file: values[index + 1], member: values[index + 2] });
			}
		} else {
			let index = 0;

			for(let match of normalized.matchAll(/system_table_schema in \(((?:\s*\?\s*,)*\s*\?\s*)\)/g)) {
				let count = match[1].split(',').length;
				wanted.push({ file: values[index], member: values[index + 1], libraries: values.slice(index + 2, index + 2 + count) });
				index += 2 + count;
			}
		}

		return wanted.flatMap(search => this.database.schemas
			.filter(schema => search.libraries.some(library => StringUtils.equalsIgnoreCase(library, schema.name)))
			.flatMap(schema => schema.sourceMembers
				.filter(member => StringUtils.equalsIgnoreCase(member.file, search.file) && StringUtils.equalsIgnoreCase(member.member, search.member))
				.map(member => ({ SYSTEM_TABLE_SCHEMA: schema.name, SYSTEM_TABLE_NAME: member.file, SYSTEM_TABLE_MEMBER: member.member, LAST_CHANGE_TIMESTAMP: member.lastChanged }))));
	}

	/**
	 * RoutineQueries.generateDdl binds [specific name, library, 'PROCEDURE' | 'FUNCTION']. The statement is
	 * a plausible CREATE OR REPLACE built from the fixture, one line per row as GENERATE_SQL returns it - the
	 * exact text IBM i writes is not something a fixture can promise. An unknown routine fails the way
	 * GENERATE_SQL does, with SQLSTATE 42704.
	 */
	private buildGeneratedSql(values: string[]): Record<string, unknown>[] {
		let schema = this.database.schemas.find(candidate => StringUtils.equalsIgnoreCase(candidate.name, values[1]));
		let routine = schema == null ? undefined : CatalogResponder.routinesOf(schema).find(candidate => StringUtils.equalsIgnoreCase(candidate.specificName, values[0])
			&& (CatalogResponder.isFunction(candidate) ? 'FUNCTION' : 'PROCEDURE') === values[2]);

		if(schema == null || routine == null) {
			throw Object.assign(new Error(`${values[2]} ${values[1]}/${values[0]} not found`), {
				driverErrors: [{ code: -204, state: '42704', message: `${values[0]} in ${values[1]} type *N not found.` }]
			});
		}

		let parameters = routine.parameters.map((parameter, index) => `\t${parameter.name} ${parameter.dataType}${index < routine.parameters.length - 1 ? ',' : ''}`);
		let body = routine.body === 'EXTERNAL'
			? [`\tEXTERNAL NAME '${routine.externalName}'`, `\tLANGUAGE ${routine.language}`]
			: ['\tLANGUAGE SQL', routine.definition];

		return [
			`CREATE OR REPLACE ${values[2]} ${schema.name}.${routine.name} (`,
			...parameters,
			')',
			`\tSPECIFIC ${schema.name}.${routine.specificName}`,
			...body,
			';'
		].map((line, index) => ({ SRCSEQ: index + 1, SRCDTA: line }));
	}

	/**
	 * The three statements ProgramQueries.readSource runs against a member, in the exact shape
	 * buildMemberReadStatements produces. Selecting from an alias that was never created, or one over a
	 * member the fixture doesn't have, fails the way a real system would rather than returning nothing.
	 */
	private respondToAlias(normalized: string): Record<string, unknown>[] {
		let create = /^create alias qtemp\."([a-z0-9_$#@]+)" for "([a-z0-9_$#@]+)"\."([a-z0-9_$#@]+)" \("([a-z0-9_$#@]+)"\)$/.exec(normalized);

		if(create) {
			this.aliases.set(create[1], { library: create[2], file: create[3], member: create[4] });
			return [];
		}

		let drop = /^drop alias qtemp\."([a-z0-9_$#@]+)"$/.exec(normalized);

		if(drop) {
			this.aliases.delete(drop[1]);
			return [];
		}

		let select = /^select srcdta from qtemp\."([a-z0-9_$#@]+)" order by srcseq$/.exec(normalized);
		let alias = select ? this.aliases.get(select[1]) : undefined;

		if(!alias) {
			throw new Error(`FakeDriver: unrecognized QTEMP statement or unknown alias: ${normalized}`);
		}

		let schema = this.database.schemas.find(candidate => StringUtils.equalsIgnoreCase(candidate.name, alias.library));
		let member = schema?.sourceMembers.find(candidate => StringUtils.equalsIgnoreCase(candidate.file, alias.file) && StringUtils.equalsIgnoreCase(candidate.member, alias.member));

		if(!member) {
			throw Object.assign(new Error(`Member ${alias.member} not found in ${alias.library}/${alias.file}`), {
				driverErrors: [{ code: -204, state: '42704', message: `Member ${alias.member} not found.` }]
			});
		}

		return member.lines.map((line, index) => ({ SRCSEQ: index + 1, SRCDTA: line }));
	}

	/**
	 * CatalogQueries.listRoutines has the two shapes listViews does - joined to LIBRARY_LIST_INFO or
	 * filtered by `specific_schema in (?, ...)` - and lists procedures and functions together.
	 * RoutineQueries.getRoutineDetail reads one routine's row with the first chunk of its body, bound
	 * [schema, specific name], then any further chunks, bound [start, schema, specific name].
	 *
	 * `select *` is refused rather than answered: on a real system the row's LOB columns hang node-odbc,
	 * so a fake that answered it would pass exactly the statement that can't run.
	 */
	private buildRoutines(normalized: string, values: string[]): Record<string, unknown>[] {
		if(normalized.startsWith('select *')) {
			throw new Error('FakeDriver: select * from QSYS2.SYSROUTINES fetches its LOB columns, which hangs a real connection');
		}

		let chunk = normalized.match(/substring\(routine_definition, (\d+|\?), (\d+)\)/);

		if(chunk != null) {
			let isFollowUp = chunk[1] === '?';
			let [schemaName, specificName] = isFollowUp ? values.slice(1) : values;
			let schema = this.database.schemas.find(candidate => StringUtils.equalsIgnoreCase(candidate.name, schemaName));
			let routine = schema == null ? undefined : CatalogResponder.routinesOf(schema).find(candidate => StringUtils.equalsIgnoreCase(candidate.specificName, specificName));

			if(!schema || !routine) {
				return [];
			}

			let definition = routine.definition;
			let start = Number(isFollowUp ? values[0] : chunk[1]) - 1;
			let text = definition.length === 0 ? null : definition.substring(start, start + Number(chunk[2]));

			return isFollowUp
				? [{ DEFINITION_CHUNK: text }]
				: [{ ...CatalogResponder.buildRoutineRow(schema, routine, true), DEFINITION_LENGTH: definition.length === 0 ? null : definition.length, DEFINITION_CHUNK: text }];
		}

		let schemas = normalized.includes('library_list_info')
			? this.database.schemas.filter(schema => schema.onLibraryList)
			: this.database.schemas.filter(schema => values.some(value => StringUtils.equalsIgnoreCase(value, schema.name)));

		return schemas.flatMap(schema => CatalogResponder.routinesOf(schema).map(routine => CatalogResponder.buildRoutineRow(schema, routine, false)));
	}

	private static routinesOf(schema: FakeSchema): (FakeProcedure | FakeFunction)[] {
		return [...schema.procedures, ...schema.functions];
	}

	private static isFunction(routine: FakeProcedure | FakeFunction): routine is FakeFunction {
		return 'functionType' in routine;
	}

	private static buildRoutineRow(schema: FakeSchema, routine: FakeProcedure | FakeFunction, detail: boolean): Record<string, unknown> {
		let fakeFunction = CatalogResponder.isFunction(routine) ? routine : undefined;

		let row: Record<string, unknown> = {
			SPECIFIC_SCHEMA: schema.name,
			SPECIFIC_NAME: routine.specificName,
			ROUTINE_SCHEMA: schema.name,
			ROUTINE_NAME: routine.name,
			ROUTINE_TYPE: fakeFunction ? 'FUNCTION' : 'PROCEDURE',
			FUNCTION_TYPE: fakeFunction?.functionType ?? null,
			FUNCTION_ORIGIN: fakeFunction == null ? null : (fakeFunction.body === 'SQL' ? 'Q' : 'E'),
			ROUTINE_BODY: routine.body,
			EXTERNAL_LANGUAGE: routine.language,
			ROUTINE_TEXT: null,
			LONG_COMMENT: routine.description,
			IN_PARMS: routine.parameters.filter(parameter => parameter.mode === 'IN').length,
			OUT_PARMS: routine.parameters.filter(parameter => parameter.mode === 'OUT').length,
			INOUT_PARMS: routine.parameters.filter(parameter => parameter.mode === 'INOUT').length
		};

		if(!detail) {
			return row;
		}

		return {
			...row,
			EXTERNAL_NAME: routine.externalName,
			PARAMETER_STYLE: 'SQL',
			IS_DETERMINISTIC: 'NO',
			SQL_DATA_ACCESS: 'READS',
			// SYSROUTINES leaves the function-only columns null on a procedure's row.
			IS_NULL_CALL: fakeFunction == null ? null : 'YES',
			MAX_DYNAMIC_RESULT_SETS: CatalogResponder.isFunction(routine) ? 0 : routine.resultSets,
			ROUTINE_CREATED: '2026-01-01 08:00:00.000000',
			LAST_ALTERED: '2026-01-01 08:00:00.000000',
			ROUTINE_DEFINER: 'QSECOFR'
		};
	}

	/**
	 * RoutineQueries.listRoutineParams batches its routines through buildTablePredicate, with the
	 * specific name in the table position. A function's rows carry its results too: one 'C' row for a
	 * scalar function's return type (as DB2 reports it), one 'R' row per column for a table function.
	 */
	private buildRoutineParameters(targets: CatalogResponder.Target[]): Record<string, unknown>[] {
		let rows: Record<string, unknown>[] = [];

		for(let target of targets) {
			for(let schema of this.database.schemas) {
				if(StringUtils.isNotBlank(target.schema) && !StringUtils.equalsIgnoreCase(schema.name, target.schema)) {
					continue;
				}

				for(let routine of CatalogResponder.routinesOf(schema).filter(candidate => StringUtils.equalsIgnoreCase(candidate.specificName, target.table))) {
					let isTableFunction = CatalogResponder.isFunction(routine) && routine.functionType === 'T';
					let results = !CatalogResponder.isFunction(routine) ? [] : (isTableFunction ? routine.resultColumns : [routine.returns]);

					rows.push(
						...routine.parameters.map((parameter, index) => CatalogResponder.buildParameterRow(schema, routine, 'P', index + 1, parameter)),
						...results.map((parameter, index) => CatalogResponder.buildParameterRow(schema, routine, isTableFunction ? 'R' : 'C', index + 1, parameter))
					);
				}
			}
		}

		return rows;
	}

	private static buildParameterRow(schema: FakeSchema, routine: FakeProcedure | FakeFunction, rowType: string, position: number, parameter: FakeProcedureParameter): Record<string, unknown> {
		return {
			SPECIFIC_SCHEMA: schema.name,
			SPECIFIC_NAME: routine.specificName,
			ROW_TYPE: rowType,
			ORDINAL_POSITION: position,
			PARAMETER_MODE: parameter.mode,
			PARAMETER_NAME: parameter.name,
			DATA_TYPE: parameter.dataType,
			NUMERIC_SCALE: parameter.scale,
			NUMERIC_PRECISION: parameter.precision,
			CHARACTER_MAXIMUM_LENGTH: parameter.length,
			LONG_COMMENT: parameter.description,
			DEFAULT: null
		};
	}

	/**
	 * Runs `build` for every table the targets resolve to and flattens the result, which is what makes
	 * a batched statement's interleaved rows fall out naturally: each row already carries its own
	 * schema/table, which is how the query classes attribute them back.
	 */
	private eachTable(targets: CatalogResponder.Target[], build: (schema: FakeSchema, table: FakeTable) => Record<string, unknown>[]): Record<string, unknown>[] {
		let rows: Record<string, unknown>[] = [];

		for(let target of targets) {
			for(let schema of this.database.schemas) {
				if(StringUtils.isNotBlank(target.schema) && !StringUtils.equalsIgnoreCase(schema.name, target.schema)) {
					continue;
				}

				// Views too: SYSCOLUMNS2 lists a view's columns exactly as it does a table's.
				for(let table of [...schema.tables, ...schema.views]) {
					if(StringUtils.equalsIgnoreCase(table.name, target.table)) {
						rows.push(...build(schema, table));
					}
				}
			}
		}

		return rows;
	}

	private static sqlNameOf(table: FakeTable, systemName: string): string {
		let column = table.columns.find(candidate => StringUtils.equalsIgnoreCase(candidate.systemName, systemName));
		return column ? column.sqlName : systemName;
	}

	/**
	 * Recovers which tables a batched predicate is asking about.
	 *
	 * buildTablePredicate emits `(schemaColumn = ? and tableColumn = ?)`, `(schemaColumn = ? and
	 * tableColumn in (?, ?))`, or either table test on its own, so the ordered list of columns compared
	 * to markers - with each IN list counted for as many markers as it holds - lines up exactly with the
	 * parameter array. Reading the columns rather than assuming a fixed stride is what handles the
	 * schema-less targets autocomplete produces, and a mix of both in one statement.
	 *
	 * Column names are compared after their alias prefix (`a.system_table_schema`), since the same
	 * predicate is built against aliased and unaliased catalogs.
	 */
	static readTargets(normalizedSql: string, values: string[], schemaColumn: string, tableColumn: string): CatalogResponder.Target[] {
		let comparisons = [...normalizedSql.matchAll(/([a-z0-9_."]+)\s*(?:=\s*\?|in\s*\(((?:\s*\?\s*,)*\s*\?\s*)\))/g)]
			.map(match => ({ column: CatalogResponder.unqualify(match[1]), markers: match[2] == null ? 1 : match[2].split(',').length }));

		let targets: CatalogResponder.Target[] = [];
		let pendingSchema: string | undefined;
		let index = 0;

		for(let comparison of comparisons) {
			if(index >= values.length) {
				break;
			}

			if(comparison.column === schemaColumn) {
				pendingSchema = values[index];
			} else if(comparison.column === tableColumn) {
				for(let table of values.slice(index, index + comparison.markers)) {
					targets.push({ schema: pendingSchema, table: table });
				}

				pendingSchema = undefined;
			}

			index += comparison.markers;
		}

		return targets;
	}

	private static unqualify(column: string): string {
		let bare = column.replace(/"/g, '');
		let separator = bare.lastIndexOf('.');
		return separator === -1 ? bare : bare.substring(separator + 1);
	}

	/** Lower cased with runs of whitespace collapsed, so fixture matching survives reformatting. */
	static normalize(sql: string): string {
		return StringUtils.default(sql, () => '').replace(/\s+/g, ' ').trim().toLowerCase();
	}
}

export namespace CatalogResponder {
	export interface Target {
		schema?: string;
		table: string;
	}
}
