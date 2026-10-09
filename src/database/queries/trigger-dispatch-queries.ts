import { Extension } from '../../extension.js';
import { StringUtils } from '../../utils/string-utils.js';
import { DbConnections } from '../db-connections.js';
import { runCatalogLookup } from './catalog-lookup.js';
import {
	buildRoutingRowQuery,
	DispatchHandler,
	extractReadTables,
	extractRowConditions,
	findRoutingRows,
	findUnselectedCondition,
	FoundProgram,
	libraryCandidates,
	omitColumns,
	programNameCandidates,
	rankHandlers,
	rowValues,
	scoreHandler
} from './trigger-dispatch.js';

// The catalog side of finding a dispatching trigger program's real handler - see trigger-dispatch.ts for
// the approach. Never cached, like the source it leads to: a routing table is edited by hand, and the
// dialog reads it when it opens.
//
// Every step asks the catalog only about names it has already seen to exist, since a failed lookup is
// reported in the History tab: a routing row's values are checked as libraries before any is asked for
// its programs, and an unqualified table is resolved before its columns or rows are read.
export class TriggerDispatchQueries {
	constructor(private extension: Extension) {}

	/**
	 * The programs the trigger's program hands this table's work to, most certain first. Empty when the
	 * program reads no table that names this one next to a real program - which is every ordinary trigger
	 * program, and the answer this almost always gives.
	 */
	async findHandlers(options: TriggerDispatchQueries.FindHandlersOptions): Promise<TriggerDispatchQueries.Handler[]> {
		let tableName = options.table.toUpperCase();
		let dispatcher = options.programName.toUpperCase();
		let statements = await this.listStatementTexts(options, options.programLibrary, dispatcher);
		let handlers: TriggerDispatchQueries.Handler[] = [];

		for(let candidate of extractReadTables(statements)) {
			let schema = candidate.schema ?? await this.resolveOnLibraryList(options, '*FILE', candidate.table);

			if(schema == null || (StringUtils.equalsIgnoreCase(schema, options.schema) && candidate.table === tableName)) {
				continue;
			}

			let via = {schema: schema, table: candidate.table};
			let conditions = extractRowConditions(statements, candidate);
			let conditionColumns = [...new Set(conditions.flat().map(condition => condition.column))];

			for(let row of await this.readRoutingRows(options, via, tableName, conditionColumns)) {
				let values = rowValues(omitColumns(row, conditionColumns));
				let unselected = findUnselectedCondition(row, conditions);
				let programs = await this.findPrograms(options, libraryCandidates(values), programNameCandidates(values, [tableName, dispatcher]));

				for(let program of programs) {
					let exports = program.objectType === '*SRVPGM' ? await this.listProcedureExports(options, program) : undefined;
					let handler = scoreHandler(program, values, exports, options.schema);

					if(handler != null) {
						handlers.push({...handler, via: via, ...(unselected == null ? {} : {unselected: unselected})});
					}
				}
			}
		}

		return rankHandlers(handlers);
	}

	/** The program's static SQL statements, as SYSPROGRAMSTMTSTAT records them at compile time. The text is a
	 * LOB, cast to a VARCHAR here the way a routine's body is (a LOB column hangs node-odbc). */
	async listStatementTexts(options: DbConnections.CommonListOptions, library: string, program: string): Promise<string[]> {
		let rows = await runCatalogLookup(this.extension, {
			key: options.key,
			configId: options.configId,
			sql: `select cast(substring(statement_text, 1, 8000) as varchar(32000)) as statement_text ` +
				`from qsys2.sysprogramstmtstat ` +
				`where program_schema = ? and program_name = ?`,
			parameters: [library.toUpperCase(), program.toUpperCase()],
			progressMessage: 'Finding the trigger program\'s tables...'
		});

		return [...new Set(rows.map(row => StringUtils.trim(<string>row['STATEMENT_TEXT'], {toUndefined: true})).filter(text => text != null))];
	}

	/** The first library on the connection's library list holding an object of this type and name. */
	async resolveOnLibraryList(options: DbConnections.CommonListOptions, objectTypes: string, name: string): Promise<string | undefined> {
		let rows = await runCatalogLookup(this.extension, {
			key: options.key,
			configId: options.configId,
			sql: `select objlib, objname, objtype from table(qsys2.object_statistics('*LIBL', ?, ?)) x`,
			parameters: [objectTypes, name.toUpperCase()],
			progressMessage: 'Finding the trigger program\'s tables...'
		});

		return StringUtils.trim(<string>rows[0]?.['OBJLIB'], {toUndefined: true});
	}

	/** A candidate table's rows naming the trigger's table in any of its character columns, with the
	 * character columns the dispatcher's conditions name (`alsoSelect`), however short. */
	async readRoutingRows(options: DbConnections.CommonListOptions, table: {schema: string; table: string}, tableName: string, alsoSelect: string[] = []): Promise<Record<string, unknown>[]> {
		let columns = await this.extension.memoryCache.getColumns({key: options.key, configId: options.configId, tables: table});
		let characterColumns = columns.filter(column => ['CHAR', 'VARCHAR'].includes(column.dataType.toUpperCase())).map(column => ({name: column.systemName, length: column.length}));
		let query = buildRoutingRowQuery(table, characterColumns, tableName, alsoSelect);

		if(query == null) {
			return [];
		}

		let rows = await runCatalogLookup(this.extension, {
			key: options.key,
			configId: options.configId,
			sql: query.sql,
			parameters: query.parameters,
			progressMessage: 'Reading the trigger program\'s tables...'
		});

		return findRoutingRows(rows, tableName);
	}

	/**
	 * Every program or service program named by a pair of a routing row's values - one a library (or
	 * `*LIBL`), the other an object in it. The libraries are confirmed first, in one statement, so no
	 * value that only happens to look like a library name (a user profile, a flag) is asked for its
	 * objects.
	 */
	async findPrograms(options: DbConnections.CommonListOptions, libraries: string[], names: string[]): Promise<FoundProgram[]> {
		if(names.length === 0 || libraries.length === 0) {
			return [];
		}

		let programs: FoundProgram[] = [];
		let named = libraries.filter(library => library !== '*LIBL');

		for(let library of await this.listExistingLibraries(options, named)) {
			let rows = await runCatalogLookup(this.extension, {
				key: options.key,
				configId: options.configId,
				sql: `select objlib, objname, objtype from table(qsys2.object_statistics(?, '*PGM *SRVPGM')) x ` +
					`where objname in (${names.map(() => '?').join(', ')})`,
				parameters: [library, ...names],
				progressMessage: 'Finding the trigger\'s handler program...'
			});

			programs.push(...rows.map(TriggerDispatchQueries.toProgram).filter(program => program != null));
		}

		if(libraries.includes('*LIBL')) {
			for(let name of names) {
				let rows = await runCatalogLookup(this.extension, {
					key: options.key,
					configId: options.configId,
					sql: `select objlib, objname, objtype from table(qsys2.object_statistics('*LIBL', ?, ?)) x`,
					parameters: ['*PGM *SRVPGM', name],
					progressMessage: 'Finding the trigger\'s handler program...'
				});

				// The first of each type is the one a *LIBL activation would find.
				for(let objectType of ['*PGM', '*SRVPGM']) {
					let first = rows.map(TriggerDispatchQueries.toProgram).find(program => program?.objectType === objectType);

					if(first != null) {
						programs.push(first);
					}
				}
			}
		}

		return programs;
	}

	/** Which of these names are libraries on the system. Every library is a schema to SYSSCHEMAS; the
	 * OBJECT_STATISTICS('QSYS', '*LIB') form lists none of them on a real system, with no error. */
	async listExistingLibraries(options: DbConnections.CommonListOptions, libraries: string[]): Promise<string[]> {
		if(libraries.length === 0) {
			return [];
		}

		let rows = await runCatalogLookup(this.extension, {
			key: options.key,
			configId: options.configId,
			sql: `select sys_name from qsys2.sysschemas ` +
				`where sys_name in (${libraries.map(() => '?').join(', ')})`,
			parameters: libraries,
			progressMessage: 'Finding the trigger\'s handler program...'
		});

		return rows.map(row => StringUtils.trim(<string>row['SYS_NAME'], {toUndefined: true})).filter(name => name != null);
	}

	/** A service program's exported procedures - one of them is what the dispatcher calls. */
	async listProcedureExports(options: DbConnections.CommonListOptions, program: FoundProgram): Promise<string[]> {
		let rows = await runCatalogLookup(this.extension, {
			key: options.key,
			configId: options.configId,
			sql: `select symbol_name from qsys2.program_export_import_info ` +
				`where program_library = ? and program_name = ? and object_type = ? and symbol_usage = '*PROCEXP'`,
			parameters: [program.library, program.object, program.objectType],
			progressMessage: 'Finding the trigger\'s handler program...'
		});

		return rows.map(row => StringUtils.trim(<string>row['SYMBOL_NAME'], {toUndefined: true})).filter(name => name != null);
	}

	private static toProgram(row: Record<string, unknown>): FoundProgram | undefined {
		let library = StringUtils.trim(<string>row['OBJLIB'], {toUndefined: true});
		let object = StringUtils.trim(<string>row['OBJNAME'], {toUndefined: true});
		let objectType = StringUtils.trim(<string>row['OBJTYPE'], {toUndefined: true})?.toUpperCase();

		if(library == null || object == null || (objectType !== '*PGM' && objectType !== '*SRVPGM')) {
			return undefined;
		}

		return {library: library, object: object, objectType: objectType};
	}
}

export namespace TriggerDispatchQueries {
	export interface FindHandlersOptions extends DbConnections.CommonListOptions {
		/** The trigger's table, by system name. */
		schema: string;
		table: string;
		/** The program the trigger runs. */
		programLibrary: string;
		programName: string;
	}

	export interface Handler extends DispatchHandler {
		/** The table whose row named this handler. */
		via: {schema: string; table: string};
	}
}
