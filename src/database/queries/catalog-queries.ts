import { Extension } from '../../extension.js';
import { Parameter } from '../../interfaces/parameter.js';
import { SystemRoutine } from '../../models/system-routine.js';
import { SystemSchema } from '../../models/system-schema.js';
import { SystemTable } from '../../models/system-table.js';
import { SystemView } from '../../models/system-view.js';
import { StringUtils } from '../../utils/string-utils.js';
import { DbConnections } from '../db-connections.js';
import { runCatalogLookup } from './catalog-lookup.js';

// "What objects of kind X exist in this schema" - the schema tree's and autocomplete's object
// lists. Grows to new object kinds without needing a new class - unlike
// TableQueries/IndexQueries/RoutineQueries, which each own everything about one already-identified
// object of their kind, this one deliberately spans every object type.
export class CatalogQueries {
	constructor(private extension: Extension) {}

	async listSchemas(options: CatalogQueries.ListSchemasOptions): Promise<SystemSchema[]> {
		let sql =
			`SELECT sys_name, label, ` +
				`case when sys_name like 'SYS%' or sys_name like 'Q%' then 'System' ` +
				`else 'User' ` +
				`end as schema_type ` +
			`from qsys2.sysschemas  ` +
			`order by name`;

		let results = await runCatalogLookup(this.extension, {
			key: options.key,
			configId: options.configId,
			sql: sql
		});

		return results.map(row => {
			return <SystemSchema>{
				name: StringUtils.trim(<string>row['SYS_NAME'], {removeDuplicateWhiteSpace: true}),
				description: StringUtils.trim(<string>row['LABEL'], {removeDuplicateWhiteSpace: true}),
				type: StringUtils.trim(<string>row['SCHEMA_TYPE'], {removeDuplicateWhiteSpace: true})
			};
		});
	}

	async listTables(options: CatalogQueries.ListTablesOptions): Promise<SystemTable[]> {
		let sql: string;
		let parameters: (Parameter)[];

		// Materialized query tables ('M') are listed with the tables: an MQT is a physical file with columns,
		// keys, indexes and rows like any table, so every per-table tab and lookup serves it unchanged. TYPE
		// tells them apart for the tree, which shows MQTs under a node of their own. MQTDEF (a DBCLOB of up to
		// 2M characters) is left out - it is only ever read one MQT at a time (see getMqtDefinition).
		// TYPE is qualified because LIBRARY_LIST_INFO, joined below, has a TYPE column of its own.
		let columns = `select sys_dname, sys_tname, systables.type, label, remarks, dbname, alteredts, filetype, location, tbdbname, ` +
			`tbname, tbmember, systable, selectomit, insertable, iaspnumber, enabled, maintain, refresh, ` +
			`refreshdts, isolation, part_table, definer, mqtrstdfr, decfltrnd, control, temporalty, ` +
			`droprule `;

		let schemas: string[] = options?.schemas?.length ? <string[]>options.schemas : (StringUtils.isNotBlank(options?.schema) ? [<string>options.schema] : []);

		if(schemas.length === 0) {
			sql = columns +
				`from qsys2.systables ` +
				`join qsys2.library_list_info on system_schema_name = sys_dname ` +
				`and systables.type in ('T', 'P', 'M') `;

			parameters = [];
		} else {
			// Deliberately not joined to qsys2.library_list_info (unlike the eager branch above) - a
			// caller asking for a specific schema's tables wants that schema's tables regardless of
			// whether it's currently on the connection's library list (e.g. a manually added schema in
			// the schemas tree's "Edit Schema List" feature).
			sql = columns +
				`from qsys2.systables ` +
				`where sys_dname in (${schemas.map(() => '?').join(', ')}) ` +
				`and systables.type in ('T', 'P', 'M') `;

			parameters = schemas.map(schema => schema.toUpperCase());
		}

		let results = await runCatalogLookup(this.extension, {
			key: options.key,
			configId: options.configId,
			sql: sql,
			parameters: parameters
		});

		return results.map(row => {
			return <SystemTable>{
				schema: StringUtils.trim(<string>row['SYS_DNAME'], {removeDuplicateWhiteSpace: true}),
				name: StringUtils.trim(<string>row['SYS_TNAME'], {removeDuplicateWhiteSpace: true}),
				tableType: StringUtils.trim(<string>row['TYPE'], {removeDuplicateWhiteSpace: true}),
				description: StringUtils.trim(<string>row['LABEL'], {removeDuplicateWhiteSpace: true}),
				remarks: StringUtils.trim(<string>row['REMARKS'], {removeDuplicateWhiteSpace: true}),
				dbName: StringUtils.trim(<string>row['DBNAME'], {removeDuplicateWhiteSpace: true}),
				alteredTimestamp: new Date(<string>row['ALTEREDTS']),
				fileType: StringUtils.trim(<string>row['FILETYPE'], {removeDuplicateWhiteSpace: true}),
				location: StringUtils.trim(<string>row['LOCATION'], {removeDuplicateWhiteSpace: true}),
				tbDbName: StringUtils.trim(<string>row['TBDBNAME'], {removeDuplicateWhiteSpace: true}),
				tbName: StringUtils.trim(<string>row['TBNAME'], {removeDuplicateWhiteSpace: true}),
				tbMember: StringUtils.trim(<string>row['TBMEMBER'], {removeDuplicateWhiteSpace: true}),
				sysTable: StringUtils.trim(<string>row['SYSTABLE'], {removeDuplicateWhiteSpace: true}),
				selectOmit: StringUtils.trim(<string>row['SELECTOMIT'], {removeDuplicateWhiteSpace: true}),
				insertable: StringUtils.trim(<string>row['INSERTABLE'], {removeDuplicateWhiteSpace: true}),
				iaspNumber: <number>row['IASPNUMBER'],
				enabled: StringUtils.trim(<string>row['ENABLED'], {removeDuplicateWhiteSpace: true}),
				maintain: StringUtils.trim(<string>row['MAINTAIN'], {removeDuplicateWhiteSpace: true}),
				refresh: StringUtils.trim(<string>row['REFRESH'], {removeDuplicateWhiteSpace: true}),
				// new Date(null) would be 1970, not "never refreshed".
				refreshTimestamp: row['REFRESHDTS'] == null ? undefined : new Date(<string>row['REFRESHDTS']),
				isolation: StringUtils.trim(<string>row['ISOLATION'], {removeDuplicateWhiteSpace: true}),
				partTable: StringUtils.trim(<string>row['PART_TABLE'], {removeDuplicateWhiteSpace: true}),
				definer: StringUtils.trim(<string>row['DEFINER'], {removeDuplicateWhiteSpace: true}),
				mqtRstDfr: StringUtils.trim(<string>row['MQTRSTDFR'], {removeDuplicateWhiteSpace: true}),
				decFltRnd: StringUtils.trim(<string>row['DECFLTRND'], {removeDuplicateWhiteSpace: true}),
				control: StringUtils.trim(<string>row['CONTROL'], {removeDuplicateWhiteSpace: true}),
				temporalType: StringUtils.trim(<string>row['TEMPORALTY'], {removeDuplicateWhiteSpace: true}),
				dropRule: StringUtils.trim(<string>row['DROPRULE'], {removeDuplicateWhiteSpace: true})
			};
		});
	}

	// Procedures and functions together, in one query - MemoryCache.getProcedures/getFunctions filter the
	// one cached list rather than each running its own. Same two shapes as listViews: joined to the library
	// list, or filtered to named schemas. The body (ROUTINE_DEFINITION) and the rest of the row are left
	// out - this runs for every schema in the tree at once, and those are only read one routine at a time
	// (RoutineQueries.getRoutineDetail).
	async listRoutines(options: CatalogQueries.ListRoutinesOptions): Promise<SystemRoutine[]> {
		let sql: string;
		let parameters: (Parameter)[];

		let columns = `select specific_schema, specific_name, routine_schema, routine_name, routine_type, function_type, function_origin, ` +
			`routine_body, external_language, routine_text, long_comment ` +
			`from qsys2.sysroutines `;

		let schemas: string[] = options?.schemas?.length ? <string[]>options.schemas : (StringUtils.isNotBlank(options?.schema) ? [<string>options.schema] : []);

		if(schemas.length === 0) {
			sql = columns +
				`join qsys2.library_list_info on system_schema_name = specific_schema `;

			parameters = [];
		} else {
			sql = columns +
				`where specific_schema in (${schemas.map(() => '?').join(', ')}) `;

			parameters = schemas.map(schema => schema.toUpperCase());
		}

		let results = await runCatalogLookup(this.extension, {
			key: options.key,
			configId: options.configId,
			sql: sql,
			parameters: parameters
		});

		return results.map(row => {
			return <SystemRoutine>{
				schema: StringUtils.trim(<string>row['SPECIFIC_SCHEMA'], {removeDuplicateWhiteSpace: true}),
				name: StringUtils.trim(<string>row['ROUTINE_NAME'], {removeDuplicateWhiteSpace: true}),
				specificName: StringUtils.trim(<string>row['SPECIFIC_NAME'], {removeDuplicateWhiteSpace: true}),
				sqlSchema: StringUtils.trim(<string>row['ROUTINE_SCHEMA'], {removeDuplicateWhiteSpace: true}),
				routineType: StringUtils.default(<string>row['ROUTINE_TYPE'], () => '').toUpperCase(),
				functionType: StringUtils.trim(<string>row['FUNCTION_TYPE'], {toUndefined: true}),
				functionOrigin: StringUtils.trim(<string>row['FUNCTION_ORIGIN'], {toUndefined: true}),
				body: StringUtils.trim(<string>row['ROUTINE_BODY'], {removeDuplicateWhiteSpace: true}),
				language: StringUtils.trim(<string>row['EXTERNAL_LANGUAGE'], {removeDuplicateWhiteSpace: true}),
				// The LABEL ON text, as a table's description is - falling back to the longer COMMENT ON text.
				description: StringUtils.trim(<string>row['ROUTINE_TEXT'], {removeDuplicateWhiteSpace: true, toUndefined: true})
					?? StringUtils.trim(<string>row['LONG_COMMENT'], {removeDuplicateWhiteSpace: true})
			};
		});
	}

	async listViews(options: CatalogQueries.ListViewsOptions): Promise<SystemView[]> {
		let sql: string;
		let parameters: (Parameter)[];

		// The definition (SYSVIEWS.TEXT, up to 10K characters a view) is deliberately left out - this runs
		// for every schema in the tree at once, and the definition is only ever read one view at a time
		// (see getViewDefinition). The description comes from the view's own SYSTABLES row (type 'V'),
		// which SYSVIEWS doesn't carry. CHECK is a reserved word, hence the quoted, aliased column.
		let columns = `select v.sys_vdname, v.sys_vname, v.dbname, v.name, v.creator, v.definer, v.seqno, ` +
			`v."CHECK" as check_option, v.iaspnumber, v.insertable, v.updates, v.deletes, v.decfltrnd, ` +
			`t.label, t.remarks ` +
			`from qsys2.sysviews v ` +
			`left join qsys2.systables t on t.sys_dname = v.sys_vdname and t.sys_tname = v.sys_vname `;

		let schemas: string[] = options?.schemas?.length ? <string[]>options.schemas : (StringUtils.isNotBlank(options?.schema) ? [<string>options.schema] : []);

		if(schemas.length === 0) {
			sql = columns +
				`join qsys2.library_list_info on system_schema_name = v.sys_vdname `;

			parameters = [];
		} else {
			// Not joined to the library list, same as listTables' named-schema branch.
			sql = columns +
				`where v.sys_vdname in (${schemas.map(() => '?').join(', ')}) `;

			parameters = schemas.map(schema => schema.toUpperCase());
		}

		let results = await runCatalogLookup(this.extension, {
			key: options.key,
			configId: options.configId,
			sql: sql,
			parameters: parameters
		});

		return results.map(row => {
			return <SystemView>{
				schema: StringUtils.trim(<string>row['SYS_VDNAME'], {removeDuplicateWhiteSpace: true}),
				name: StringUtils.trim(<string>row['SYS_VNAME'], {removeDuplicateWhiteSpace: true}),
				sqlSchema: StringUtils.trim(<string>row['DBNAME'], {removeDuplicateWhiteSpace: true}),
				sqlName: StringUtils.trim(<string>row['NAME'], {removeDuplicateWhiteSpace: true}),
				description: StringUtils.trim(<string>row['LABEL'], {removeDuplicateWhiteSpace: true}),
				remarks: StringUtils.trim(<string>row['REMARKS'], {removeDuplicateWhiteSpace: true}),
				owner: StringUtils.trim(<string>row['CREATOR'], {removeDuplicateWhiteSpace: true}),
				definer: StringUtils.trim(<string>row['DEFINER'], {removeDuplicateWhiteSpace: true}),
				sequenceNumber: <number>row['SEQNO'],
				checkOption: StringUtils.trim(<string>row['CHECK_OPTION'], {removeDuplicateWhiteSpace: true}),
				iaspNumber: <number>row['IASPNUMBER'],
				insertable: StringUtils.trim(<string>row['INSERTABLE'], {removeDuplicateWhiteSpace: true}),
				updatable: StringUtils.trim(<string>row['UPDATES'], {removeDuplicateWhiteSpace: true}),
				deletable: StringUtils.trim(<string>row['DELETES'], {removeDuplicateWhiteSpace: true}),
				decFltRnd: StringUtils.trim(<string>row['DECFLTRND'], {removeDuplicateWhiteSpace: true})
			};
		});
	}

	// One view's SQL, as DB2 stored it - read on demand by the schema browser's Definition tab rather than
	// carried in listViews. Only trimmed, never whitespace-collapsed: the raw text is shown as-is.
	async getViewDefinition(options: CatalogQueries.GetViewDefinitionOptions): Promise<string | undefined> {
		let results = await runCatalogLookup(this.extension, {
			key: options.key,
			configId: options.configId,
			sql: `select text from qsys2.sysviews where sys_vdname = ? and sys_vname = ?`,
			parameters: [options.schema.toUpperCase(), options.view.toUpperCase()]
		});

		let text = <string | undefined>results[0]?.['TEXT'];
		return text?.trim();
	}

	// One materialized query table's select statement (SYSTABLES.MQTDEF) - getViewDefinition's counterpart,
	// read on demand for the same reason.
	async getMqtDefinition(options: CatalogQueries.GetMqtDefinitionOptions): Promise<string | undefined> {
		let results = await runCatalogLookup(this.extension, {
			key: options.key,
			configId: options.configId,
			sql: `select mqtdef from qsys2.systables where sys_dname = ? and sys_tname = ? and type = 'M'`,
			parameters: [options.schema.toUpperCase(), options.table.toUpperCase()]
		});

		let text = <string | undefined>results[0]?.['MQTDEF'];
		return text?.trim();
	}
}

export namespace CatalogQueries {
	export interface ListSchemasOptions extends DbConnections.CommonListOptions {}

	export interface ListTablesOptions extends DbConnections.CommonListOptions {
		schema?: string;
		/** Fetch multiple schemas' tables in a single query - takes precedence over `schema` when set. */
		schemas?: string[];
	}

	export interface ListRoutinesOptions extends DbConnections.CommonListOptions {
		schema?: string;
		/** Fetch multiple schemas' routines in a single query - takes precedence over `schema` when set. */
		schemas?: string[];
	}

	export interface ListViewsOptions extends DbConnections.CommonListOptions {
		schema?: string;
		/** Fetch multiple schemas' views in a single query - takes precedence over `schema` when set. */
		schemas?: string[];
	}

	export interface GetViewDefinitionOptions extends DbConnections.CommonListOptions {
		schema: string;
		view: string;
	}

	export interface GetMqtDefinitionOptions extends DbConnections.CommonListOptions {
		schema: string;
		table: string;
	}
}
