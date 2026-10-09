import { Extension } from '../../extension.js';
import { SystemRoutineDetail } from '../../models/system-routine-detail.js';
import { SystemRoutineParam } from '../../models/system-routine-param.js';
import { SystemRoutine } from '../../models/system-routine.js';
import { StringUtils } from '../../utils/string-utils.js';
import { DbConnections } from '../db-connections.js';
import { runCatalogLookup } from './catalog-lookup.js';
import { queryByTableTargets, TableTarget } from './table-predicates.js';

// Structural detail for already-identified routines (procedures and functions) - same role for routines
// as TableQueries.listColumns plays for tables. Listing which routines exist (CatalogQueries.listRoutines)
// is a separate concept (browsing), which is why it lives there instead of here.
export class RoutineQueries {
	constructor(private extension: Extension) {}

	// Batched like the per-table lookups: a target's `table` is the routine's SPECIFIC_NAME, since that,
	// not the routine name an overload shares, is what SYSPARMS is keyed by. Every row type comes back
	// (parameters and a function's results) - callers split them with SystemRoutineParam's helpers.
	//
	// A larger chunk than the table lookups use: the schema tree labels every overloaded routine on the
	// library list in one go (QSYS2 alone has dozens), and the chunks run one after another while the tree
	// waits. A plain single-catalog select with an IN list per schema stays small even at this size.
	async listRoutineParams(options: RoutineQueries.ListRoutineParamsOptions): Promise<SystemRoutineParam[]> {
		return queryByTableTargets({
			tables: options?.tables,
			chunkSize: RoutineQueries.MAX_ROUTINES_PER_QUERY,
			columns: {schema: 'specific_schema', table: 'specific_name'},
			run: predicate => runCatalogLookup(this.extension, {
				key: options.key,
				configId: options.configId,
				sql: `select specific_schema, specific_name, row_type, ordinal_position, parameter_mode, parameter_name, data_type, numeric_scale, numeric_precision, character_maximum_length, long_comment, default ` +
					`from qsys2.sysparms ` +
					`where (${predicate.clause}) ` +
					`order by specific_schema, specific_name, row_type, ordinal_position `,
				parameters: predicate.parameters
			}),
			map: row => <SystemRoutineParam>{
				schema: StringUtils.trim(<string>row['SPECIFIC_SCHEMA'], {removeDuplicateWhiteSpace: true}),
				specificName: StringUtils.trim(<string>row['SPECIFIC_NAME'], {removeDuplicateWhiteSpace: true}),
				rowType: StringUtils.default(<string>row['ROW_TYPE'], () => 'P'),
				position: <number>row['ORDINAL_POSITION'],
				parameterMode: StringUtils.trim(<string>row['PARAMETER_MODE'], {removeDuplicateWhiteSpace: true}),
				name: StringUtils.trim(<string>row['PARAMETER_NAME'], {removeDuplicateWhiteSpace: true}),
				dataType: StringUtils.trim(<string>row['DATA_TYPE'], {removeDuplicateWhiteSpace: true}),
				scale: <number>row['NUMERIC_SCALE'],
				precision: <number>row['NUMERIC_PRECISION'],
				length: <number>row['CHARACTER_MAXIMUM_LENGTH'],
				description: StringUtils.trim(<string>row['LONG_COMMENT'], {removeDuplicateWhiteSpace: true}),
				default: <string>row['DEFAULT']
			}
		});
	}

	// The rest of one routine's SYSROUTINES row, for the schema browser's Info and Definition tabs.
	//
	// Never `select *`: the row carries LOBs of up to 16MB (ROUTINE_ENVIRONMENT, PARM_ARRAY, DEBUG_DATA...),
	// and fetching them through node-odbc hangs the worker connection outright. The one LOB wanted here,
	// the body (ROUTINE_DEFINITION, a DBCLOB of up to 2M characters), is read as VARCHAR in chunks instead:
	// the first chunk rides along with the row, and only a body longer than that costs further queries.
	async getRoutineDetail(options: RoutineQueries.GetRoutineDetailOptions): Promise<SystemRoutineDetail | undefined> {
		let schema = options.schema.toUpperCase();
		let specificName = options.specificName.toUpperCase();

		let results = await runCatalogLookup(this.extension, {
			key: options.key,
			configId: options.configId,
			sql: `select specific_schema, specific_name, external_name, parameter_style, is_deterministic, sql_data_access, is_null_call, ` +
				`in_parms, out_parms, inout_parms, max_dynamic_result_sets, routine_created, last_altered, routine_definer, ` +
				`length(routine_definition) as definition_length, ` +
				`${RoutineQueries.definitionChunk('1')} as definition_chunk ` +
				`from qsys2.sysroutines where specific_schema = ? and specific_name = ?`,
			parameters: [schema, specificName]
		});

		let row = results[0];

		if(row == null) {
			return undefined;
		}

		let text = (column: string) => StringUtils.default(<string>row[column], () => '');
		let count = (column: string) => row[column] == null ? 0 : Number(row[column]);

		let definition = <string | undefined>row['DEFINITION_CHUNK'] ?? '';
		let definitionLength = count('DEFINITION_LENGTH');

		for(let start = RoutineQueries.DEFINITION_CHUNK_LENGTH + 1; start <= definitionLength; start += RoutineQueries.DEFINITION_CHUNK_LENGTH) {
			let chunk = await runCatalogLookup(this.extension, {
				key: options.key,
				configId: options.configId,
				sql: `select ${RoutineQueries.definitionChunk('?')} as definition_chunk from qsys2.sysroutines where specific_schema = ? and specific_name = ?`,
				parameters: [start, schema, specificName]
			});

			definition += <string | undefined>chunk[0]?.['DEFINITION_CHUNK'] ?? '';
		}

		return {
			schema: text('SPECIFIC_SCHEMA'),
			specificName: text('SPECIFIC_NAME'),
			externalName: text('EXTERNAL_NAME'),
			parameterStyle: text('PARAMETER_STYLE'),
			deterministic: text('IS_DETERMINISTIC'),
			sqlDataAccess: text('SQL_DATA_ACCESS'),
			nullCall: text('IS_NULL_CALL'),
			inParms: count('IN_PARMS'),
			outParms: count('OUT_PARMS'),
			inoutParms: count('INOUT_PARMS'),
			resultSets: count('MAX_DYNAMIC_RESULT_SETS'),
			created: row['ROUTINE_CREATED'] == null ? '' : String(row['ROUTINE_CREATED']),
			lastAltered: row['LAST_ALTERED'] == null ? '' : String(row['LAST_ALTERED']),
			definer: text('ROUTINE_DEFINER'),
			definition: definition.trim()
		};
	}

	// The statement that would recreate one routine - CREATE OR REPLACE with its parameters, options and
	// body - as IBM i's own QSYS2.GENERATE_SQL writes it. Called with its default output (QTEMP/Q_GENSQL),
	// GENERATE_SQL returns the generated lines as a result set as well. The routine is named by specific
	// name, which is what tells two overloads apart. GRANTs are left out: the tab shows what the routine
	// is, not who may use it.
	async generateDdl(options: RoutineQueries.GenerateDdlOptions): Promise<string> {
		let lines = await runCatalogLookup(this.extension, {
			key: options.key,
			configId: options.configId,
			sql: `call qsys2.generate_sql(database_object_name => ?, database_object_library_name => ?, database_object_type => ?, ` +
				`create_or_replace_option => '1', privileges_option => '0')`,
			parameters: [options.specificName.toUpperCase(), options.schema.toUpperCase(), options.routineType],
			progressMessage: 'Generating SQL...'
		});

		return lines.map(line => String(line['SRCDTA'] ?? '').trimEnd()).join('\n').trim();
	}

	// Characters per chunk of the body. The VARCHAR it's cast to is sized at four bytes a character, so a
	// chunk fits whatever the job's CCSID needs to encode it. SUBSTRING rather than SUBSTR, since the last
	// chunk's length always runs past the end of the body, and SUBSTRING just returns what is left.
	static readonly DEFINITION_CHUNK_LENGTH = 8000;

	private static definitionChunk(start: string): string {
		return `cast(substring(routine_definition, ${start}, ${RoutineQueries.DEFINITION_CHUNK_LENGTH}) as varchar(${RoutineQueries.DEFINITION_CHUNK_LENGTH * 4}))`;
	}
}

export namespace RoutineQueries {
	export const MAX_ROUTINES_PER_QUERY = 200;

	export interface ListRoutineParamsOptions extends DbConnections.CommonListOptions {
		/** `table` is the routine's SPECIFIC_NAME. */
		tables: TableTarget[] | TableTarget | undefined;
	}

	export interface GetRoutineDetailOptions extends DbConnections.CommonListOptions {
		schema: string;
		specificName: string;
	}

	export interface GenerateDdlOptions extends GetRoutineDetailOptions {
		routineType: SystemRoutine.RoutineType;
	}
}
