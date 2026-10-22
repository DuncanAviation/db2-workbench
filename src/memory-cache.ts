import { lastValueFrom } from 'rxjs';
import { DbConnections } from './database/db-connections.js';
import { CatalogLookupError } from './database/queries/catalog-lookup.js';
import { CatalogQueries } from './database/queries/catalog-queries.js';
import { IndexQueries } from './database/queries/index-queries.js';
import { SourceMember } from './database/queries/program-source.js';
import { RoutineQueries } from './database/queries/routine-queries.js';
import { TableQueries } from './database/queries/table-queries.js';
import { TableTarget, tableTargetKey, toTableTargets } from './database/queries/table-predicates.js';
import { Extension } from './extension.js';
import { SystemColumn } from './models/system-column.js';
import { SystemForeignKey } from './models/system-foreign-key.js';
import { SystemIndexAdvice } from './models/system-index-advice.js';
import { SystemIndex } from './models/system-index.js';
import { SystemProcedureParam } from './models/system-procedure-param.js';
import { SystemRelation } from './models/system-relation.js';
import { SystemRoutineDetail } from './models/system-routine-detail.js';
import { SystemRoutineParam } from './models/system-routine-param.js';
import { SystemRoutine } from './models/system-routine.js';
import { SystemSchema } from './models/system-schema.js';
import { SystemTableKey } from './models/system-table-key.js';
import { SystemTable } from './models/system-table.js';
import { SystemTrigger } from './models/system-trigger.js';
import { SystemView } from './models/system-view.js';

import { ArrayUtils } from './utils/array-utils.js';
import { Nullable } from './utils/nullable.js';
import { ProcedureUtils } from './utils/procedure-utils.js';
import { StringUtils } from './utils/string-utils.js';
import { Sync } from './utils/sync.js';

export class MemoryCache {
	private _cacheMap: Nullable<Map<string, unknown>>;

	constructor(private extension: Extension) { }

	private get cacheMap(): Map<string, unknown> {
		return this._cacheMap ??= new Map();
	}

	private async get<V>(key: string, supplier?: (() => Promise<V>) | (() => V)): Promise<V> {
		let value = <V>this.cacheMap.get(key);

		if(value == null
		&& supplier != null) {
			value = await supplier();
			this.cacheMap.set(key, value);
		}

		return value;
	}

	private set(key: string, value: unknown) {
		this.cacheMap.set(key, value);
	}

	async getSchemas(options: CatalogQueries.ListSchemasOptions): Promise<SystemSchema[]> {
		let key = await this.getCacheKey(options, MemoryCache.Keys.SYSTEM_SCHEMAS);

		return this.load({
			key: key,
			load: async () => {
				let schemas = <SystemSchema[]>await this.get(key, () => []);

				if(schemas.length === 0) {
					schemas = await this.extension.catalogQueries.listSchemas(options);
					this.set(key, schemas);
				}

				return <SystemSchema[]>schemas;
			}
		});
	}

	// Every table on the session's library list, in list order. Nothing here is cached as a whole list:
	// the list differs between sessions on the same connection (and changes while one is open), so it is
	// composed per call from the per-schema slots getTablesForSchemas keeps, which hold only what is in each
	// schema and so can be shared by every session. A schema none of them has seen yet costs one batched
	// query, the first time.
	async getTables(options: CatalogQueries.ListTablesOptions): Promise<SystemTable[]> {
		return this.getTablesForSchemas(options, await this.getSchemaNames(options));
	}

	// Fetches tables for several schemas that aren't already cached individually, in one query - used
	// for the library list (getTables) and the schemas tree's "Edit Schema List" additions alike, so asking
	// about N schemas costs one query, not N. Same "check each entity's own cache slot, batch only the
	// misses" pattern as getIndexAdvice.
	async getTablesForSchemas(options: CatalogQueries.ListTablesOptions, schemas: string[]): Promise<SystemTable[]> {
		return this.loadSchemaEntities<SystemTable>({
			options: options,
			schemas: schemas,
			cacheKey: MemoryCache.Keys.SYSTEM_TABLES,
			fetch: missingSchemas => this.extension.catalogQueries.listTables({ ...options, schema: undefined, schemas: missingSchemas })
		});
	}

	// The schemas a list with no `schemas` covers: the request's own schema when it names one, otherwise the
	// session's library list, in order, read from its ConnectionInfo - never from a cache slot.
	private async getSchemaNames(options: CatalogQueries.SchemaListOptions): Promise<string[]> {
		if(StringUtils.isNotBlank(options.schema)) {
			return [<string>options.schema];
		}

		let connectionInfo = await this.extension.connections.getConnectionInfo({key: options.key, configId: options.configId});
		return connectionInfo?.schemas.map(schema => schema.name) ?? [];
	}

	// Tables and views together - everything a query can select from - for the callers that only need a
	// name to resolve or offer (content assist, and findSchemaForTable behind every bare-name column
	// lookup). Built from getTables()/getViews() and their per-schema forms, so it adds no cache slot or
	// query of its own. Tables come first, so a table and a view sharing a name in one schema (which DB2
	// doesn't allow for the same *FILE, but the two lists don't know that) resolve to the table.
	async getRelations(options: CatalogQueries.ListTablesOptions): Promise<SystemRelation[]> {
		let [tables, views] = await Promise.all([
			this.getTables(options),
			this.getViews(options)
		]);

		return [
			...tables.map(table => MemoryCache.toRelation(table, 'table')),
			...views.map(view => MemoryCache.toRelation(view, 'view'))
		];
	}

	private static toRelation(source: SystemTable | SystemView, kind: SystemRelation.Kind): SystemRelation {
		return {schema: source.schema, name: source.name, description: source.description, kind: kind};
	}

	// Every view on the session's library list - composed from per-schema slots the same way as getTables().
	// Views aren't warmed up at connect time; the schema tree and getRelations() load them on first use.
	async getViews(options: CatalogQueries.ListViewsOptions): Promise<SystemView[]> {
		return this.getViewsForSchemas(options, await this.getSchemaNames(options));
	}

	// Same per-schema slots and batching as getTablesForSchemas.
	async getViewsForSchemas(options: CatalogQueries.ListViewsOptions, schemas: string[]): Promise<SystemView[]> {
		return this.loadSchemaEntities<SystemView>({
			options: options,
			schemas: schemas,
			cacheKey: MemoryCache.Keys.SYSTEM_VIEWS,
			fetch: missingSchemas => this.extension.catalogQueries.listViews({ ...options, schema: undefined, schemas: missingSchemas })
		});
	}

	// Cached per view. `undefined` from the query (no such view) is cached as '' so it isn't re-queried,
	// and a failed lookup caches nothing (see load()). forceRefresh is the Definition tab's Refresh.
	async getViewDefinition(options: CatalogQueries.GetViewDefinitionOptions & {forceRefresh?: boolean}): Promise<string> {
		return this.loadDefinition(options, `${MemoryCache.Keys.SYSTEM_VIEW_DEFINITIONS}.${options.schema}.${options.view}`, () => this.extension.catalogQueries.getViewDefinition(options));
	}

	// A materialized query table's select statement, cached the same way as a view's.
	async getMqtDefinition(options: CatalogQueries.GetMqtDefinitionOptions & {forceRefresh?: boolean}): Promise<string> {
		return this.loadDefinition(options, `${MemoryCache.Keys.SYSTEM_MQT_DEFINITIONS}.${options.schema}.${options.table}`, () => this.extension.catalogQueries.getMqtDefinition(options));
	}

	private async loadDefinition(options: DbConnections.CommonListOptions & {forceRefresh?: boolean}, cacheKey: string, fetch: () => Promise<string | undefined>): Promise<string> {
		let key = await this.getCacheKey(options, cacheKey.toLowerCase());

		if(options.forceRefresh) {
			this.cacheMap.delete(key);
		}

		let loaded = await this.load({
			key: key,
			load: async () => {
				let definition = <string | undefined>await this.get(key);

				if(definition == null) {
					definition = await fetch() ?? '';
					this.set(key, definition);
				}

				return [definition];
			}
		});

		return loaded[0] ?? '';
	}

	// Fetches the rows for several schemas that aren't already cached individually, in one query. Each
	// schema keeps its own `<cacheKey>.<schema>` slot (the suffix form deleteSchemaCache matches), so a
	// schema cached as "nothing in it" is a hit, and only the misses reach the query. Same "check each
	// entity's own cache slot, batch only the misses" pattern as loadTableEntities. Rows come back grouped
	// by schema in the order the schemas were asked for, which for a library list is the list's own order.
	private async loadSchemaEntities<T extends {schema: string}>(options: MemoryCache.LoadSchemaEntitiesOptions<T>): Promise<T[]> {
		if(options.schemas.length === 0) {
			return [];
		}

		let bySchema = new Map<string, T[]>();
		let missingSchemas: string[] = [];

		for(let schema of options.schemas) {
			let cached = <T[]>await this.get(await this.getSchemaEntitiesKey(options.options, options.cacheKey, schema));

			if(cached != null) {
				bySchema.set(schema.toUpperCase(), cached);
			} else {
				missingSchemas.push(schema);
			}
		}

		if(missingSchemas.length > 0) {
			let key = await this.getCacheKey(options.options, `${options.cacheKey}.batch.${missingSchemas.map(schema => schema.toLowerCase()).sort().join(',')}`);

			let fetched = await this.load({
				key: key,
				load: async () => {
					let rows = await options.fetch(missingSchemas);

					for(let schema of missingSchemas) {
						let schemaRows = rows.filter(row => StringUtils.equalsIgnoreCase(row.schema, schema));
						this.set(await this.getSchemaEntitiesKey(options.options, options.cacheKey, schema), schemaRows);
					}

					return rows;
				}
			});

			for(let [schema, rows] of ArrayUtils.toMapOfArrays(fetched, row => row.schema.toUpperCase(), row => row)) {
				bySchema.set(schema, rows);
			}
		}

		return [...new Set(options.schemas.map(schema => schema.toUpperCase()))].flatMap(schema => bySchema.get(schema) ?? []);
	}

	private async getSchemaEntitiesKey(options: DbConnections.CommonListOptions, cacheKey: MemoryCache.Keys, schema: string): Promise<string> {
		return this.getCacheKey(options, `${cacheKey}.${schema}`.toLowerCase());
	}

	// Columns/keys/foreign keys/indexes all cache the same way, so they all go through
	// loadTableEntities(): each requested table is served from its own cache slot, and only the tables
	// missing from cache are queried - in ONE statement rather than one per table. That is what keeps
	// opening a diagram of twenty tables to one query per catalog instead of twenty, while a table the
	// schema browser already looked at still costs nothing. Options take `tables: TableTarget[] |
	// TableTarget` (see table-predicates.ts), so a single table is just a one-element batch.
	async getColumns(options: TableQueries.ListColumnsOptions): Promise<SystemColumn[]> {
		return this.loadTableEntities<SystemColumn>({
			options: options,
			tables: options?.tables,
			cacheKey: MemoryCache.Keys.SYSTEM_COLUMNS,
			resolveSchema: true,
			identity: column => ({schema: column.schema, table: column.tableName}),
			fetch: tables => this.extension.tableQueries.listColumns({...options, tables: tables})
		});
	}

	async deleteColumnsCache(options: TableQueries.ListColumnsOptions): Promise<void> {
		await this.deleteTableEntitiesCache(options, options?.tables, MemoryCache.Keys.SYSTEM_COLUMNS);
	}

	async getTableKeys(options: TableQueries.ListTableKeysOptions): Promise<SystemTableKey[]> {
		return this.loadTableEntities<SystemTableKey>({
			options: options,
			tables: options?.tables,
			cacheKey: MemoryCache.Keys.SYSTEM_TABLE_KEYS,
			resolveSchema: true,
			identity: tableKey => ({schema: tableKey.schema, table: tableKey.tableName}),
			fetch: tables => this.extension.tableQueries.listTableKeys({...options, tables: tables})
		});
	}

	async deleteTableKeysCache(options: TableQueries.ListTableKeysOptions): Promise<void> {
		await this.deleteTableEntitiesCache(options, options?.tables, MemoryCache.Keys.SYSTEM_TABLE_KEYS);
	}

	async getForeignKeys(options: TableQueries.ListForeignKeysOptions): Promise<SystemForeignKey[]> {
		return this.loadTableEntities<SystemForeignKey>({
			options: options,
			tables: options?.tables,
			cacheKey: MemoryCache.Keys.SYSTEM_FOREIGN_KEYS,
			resolveSchema: true,
			identity: foreignKey => ({schema: foreignKey.schema, table: foreignKey.tableName}),
			fetch: tables => this.extension.tableQueries.listForeignKeys({...options, tables: tables})
		});
	}

	async deleteForeignKeysCache(options: TableQueries.ListForeignKeysOptions): Promise<void> {
		await this.deleteTableEntitiesCache(options, options?.tables, MemoryCache.Keys.SYSTEM_FOREIGN_KEYS);
	}

	async getIndexes(options: IndexQueries.ListIndexesOptions): Promise<SystemIndex[]> {
		return this.loadTableEntities<SystemIndex>({
			options: options,
			tables: options?.tables,
			cacheKey: MemoryCache.Keys.SYSTEM_INDEXES,
			resolveSchema: true,
			identity: index => ({schema: index.schema, table: index.tableName}),
			fetch: tables => this.extension.indexQueries.listIndexes({...options, tables: tables})
		});
	}

	// Clears whatever's cached for these tables so the Indexes tab lazy-reloads next time it's mounted,
	// rather than pushing a live refresh the way getIndexAdvice's forceRefresh does.
	async deleteIndexesCache(options: IndexQueries.ListIndexesOptions): Promise<void> {
		await this.deleteTableEntitiesCache(options, options?.tables, MemoryCache.Keys.SYSTEM_INDEXES);
	}

	async getTriggers(options: TableQueries.ListTriggersOptions): Promise<SystemTrigger[]> {
		return this.loadTableEntities<SystemTrigger>({
			options: options,
			tables: options?.tables,
			cacheKey: MemoryCache.Keys.SYSTEM_TRIGGERS,
			resolveSchema: true,
			identity: trigger => ({schema: trigger.schema, table: trigger.tableName}),
			fetch: tables => this.extension.tableQueries.listTriggers({...options, tables: tables})
		});
	}

	async deleteTriggersCache(options: TableQueries.ListTriggersOptions): Promise<void> {
		await this.deleteTableEntitiesCache(options, options?.tables, MemoryCache.Keys.SYSTEM_TRIGGERS);
	}

	// Every routine - procedures and functions both - on the session's library list, composed from per-schema
	// slots the same way as getTables() and loaded on first use (the schema tree, content assist, a CALL's
	// schema resolution).
	async getRoutines(options: CatalogQueries.ListRoutinesOptions): Promise<SystemRoutine[]> {
		return this.getRoutinesForSchemas(options, await this.getSchemaNames(options));
	}

	// Same per-schema slots and batching as getViewsForSchemas.
	async getRoutinesForSchemas(options: CatalogQueries.ListRoutinesOptions, schemas: string[]): Promise<SystemRoutine[]> {
		return this.loadSchemaEntities<SystemRoutine>({
			options: options,
			schemas: schemas,
			cacheKey: MemoryCache.Keys.SYSTEM_ROUTINES,
			fetch: missingSchemas => this.extension.catalogQueries.listRoutines({ ...options, schema: undefined, schemas: missingSchemas })
		});
	}

	// Procedures and functions are two filters over getRoutines(), the same way getRelations() is built from
	// tables and views - neither adds a cache slot or a query of its own.
	async getProcedures(options: CatalogQueries.ListRoutinesOptions): Promise<SystemRoutine[]> {
		return (await this.getRoutines(options)).filter(routine => routine.routineType === 'PROCEDURE');
	}

	// The cast functions DB2 generates for every distinct type are left out: there are several per type,
	// nobody wrote them, and they would crowd the tree and content assist.
	async getFunctions(options: CatalogQueries.ListRoutinesOptions): Promise<SystemRoutine[]> {
		return (await this.getRoutines(options)).filter(MemoryCache.isListedFunction);
	}

	static isListedFunction(routine: SystemRoutine): boolean {
		return routine.routineType === 'FUNCTION' && routine.functionOrigin !== SystemRoutine.FunctionOrigin.SYSTEM_GENERATED;
	}

	// SYSPARMS rows - parameters and a function's results - cached per routine like getColumns caches per
	// table, with the routine's specific name as the target's `table`. forceRefresh is the Parameters tab's Refresh.
	async getRoutineParams(options: RoutineQueries.ListRoutineParamsOptions & {forceRefresh?: boolean}): Promise<SystemRoutineParam[]> {
		return this.loadTableEntities<SystemRoutineParam>({
			options: options,
			tables: options?.tables,
			cacheKey: MemoryCache.Keys.SYSTEM_ROUTINE_PARAMETERS,
			forceRefresh: options?.forceRefresh,
			identity: param => ({schema: param.schema, table: param.specificName}),
			fetch: tables => this.extension.routineQueries.listRoutineParams({...options, tables: tables})
		});
	}

	// Cached per routine, like getViewDefinition. A routine that no longer exists is cached as such (an
	// empty holder) so it isn't re-queried, and a failed lookup caches nothing (see load()).
	async getRoutineDetail(options: RoutineQueries.GetRoutineDetailOptions & {forceRefresh?: boolean}): Promise<Nullable<SystemRoutineDetail>> {
		let key = await this.getCacheKey(options, `${MemoryCache.Keys.SYSTEM_ROUTINE_DETAILS}.${options.schema}.${options.specificName}`.toLowerCase());

		if(options.forceRefresh) {
			this.cacheMap.delete(key);
		}

		let loaded = await this.load({
			key: key,
			load: async () => {
				let holder = <{detail: Nullable<SystemRoutineDetail>} | undefined>await this.get(key);

				if(holder == null) {
					holder = {detail: await this.extension.routineQueries.getRoutineDetail(options)};
					this.set(key, holder);
				}

				return [holder];
			}
		});

		return loaded[0]?.detail;
	}

	// The routine's generated CREATE statement, cached per routine like its detail. A GENERATE_SQL that
	// fails (an older release, no authority to the object) throws and caches nothing, so the Definition
	// tab can fall back to the body and a later Refresh tries again.
	async getRoutineDdl(options: RoutineQueries.GenerateDdlOptions & {forceRefresh?: boolean}): Promise<string> {
		let key = await this.getCacheKey(options, `${MemoryCache.Keys.SYSTEM_ROUTINE_DDL}.${options.schema}.${options.specificName}`.toLowerCase());

		if(options.forceRefresh) {
			this.cacheMap.delete(key);
		}

		// Not through load(): that turns a failed lookup into "no rows", and here the failure is the answer
		// the tab needs.
		return lastValueFrom(Sync.get(`memory-cach-${key}`, async () => {
			let ddl = <string | undefined>await this.get(key);

			if(ddl == null) {
				ddl = await this.extension.routineQueries.generateDdl(options);
				this.set(key, ddl);
			}

			return ddl;
		}));
	}

	/**
	 * A source member's text, kept with the LAST_CHANGE_TIMESTAMP it was read at. The caller passes the
	 * member's current timestamp - ProgramQueries.readSources reads it anyway, to check the member still
	 * exists - and the text is read again whenever that differs, so an edited member shows straight away
	 * while an unchanged one costs no reads at all. A failed read throws and caches nothing.
	 */
	async getSourceText(options: DbConnections.CommonListOptions, member: SourceMember & {lastChanged: string}, read: () => Promise<string>): Promise<string> {
		let key = await this.getCacheKey(options, `${MemoryCache.Keys.SOURCE_TEXT}.${member.library}.${member.file}.${member.member}`.toLowerCase());

		// Not through load(), for the same reason as getRoutineDdl: the failure is what the caller shows.
		// The timestamp is part of the dedupe key, so a read of a newer version never waits on an older one.
		return lastValueFrom(Sync.get(`memory-cach-${key}-${member.lastChanged}`, async () => {
			let cached = <{lastChanged: string; text: string} | undefined>await this.get(key);

			if(cached?.lastChanged === member.lastChanged) {
				return cached.text;
			}

			let text = await read();
			this.set(key, {lastChanged: member.lastChanged, text: text});
			return text;
		}));
	}

	/**
	 * The schema an unqualified CALL of this procedure runs from - the first schema on the connection's
	 * library list, in list order, that holds it (see ProcedureUtils.resolveSchema). The driver has to be
	 * told this: left to itself it counts the parameters of every same-named procedure on the system.
	 */
	async resolveProcedureSchema(options: DbConnections.CommonListOptions & { procedure: string }): Promise<Nullable<string>> {
		let connectionInfo = await this.extension.connections.getConnectionInfo(options);
		let procedures = await this.getProcedures({ key: options.key, configId: options.configId });
		return ProcedureUtils.resolveSchema(connectionInfo?.schemas ?? [], procedures, options.procedure);
	}

	/**
	 * The procedures a CALL's schema holds under its name, and the overload its argument count runs. Read
	 * from the cached routine list (one statement for a schema it hasn't seen yet, none after), since
	 * node-odbc's callProcedure() can't run an overloaded name and DbConnections.execute has to know before
	 * it calls - see there.
	 */
	async resolveCallOverload(options: DbConnections.CommonListOptions & { schema: string; procedure: string; argumentCount: number }): Promise<ProcedureUtils.Overload<SystemRoutine>> {
		let candidates = await this.findProcedures(options, options.schema, options.procedure);
		return ProcedureUtils.resolveOverload(candidates, options.schema, options.procedure, options.argumentCount);
	}

	// A CALL names a procedure by its routine name, but SYSPARMS is keyed by specific name, and the two
	// differ for an overload or a generated specific name. So the name is looked up in the routine list
	// first. An overloaded procedure is chosen by argument count when the caller knows it (a CALL that
	// ran); otherwise (content assist, mid-typing) it prefers the overload whose specific name is the
	// routine name (the default when none was given). A name the list doesn't know is tried as a
	// specific name as-is.
	async getProcedureParams(options: MemoryCache.ProcedureParamsOptions): Promise<SystemProcedureParam[]> {
		if(options?.procedure == null) {
			return [];
		}

		let procedureName = options.procedure;
		let schema = options.schema ?? await this.resolveProcedureSchema({ ...options, procedure: procedureName });

		if(!schema) {
			return [];
		}

		let matches = await this.findProcedures(options, schema, procedureName);

		let procedure = (options.argumentCount != null && matches.length > 1 ? ProcedureUtils.resolveOverload(matches, schema, procedureName, options.argumentCount).procedure : undefined)
			?? matches.find(match => StringUtils.equalsIgnoreCase(match.specificName, procedureName))
			?? matches[0];

		let params = await this.getRoutineParams({
			key: options.key,
			configId: options.configId,
			tables: {schema: schema, table: procedure?.specificName ?? procedureName}
		});

		return SystemRoutineParam.parameters(params).map(param => ({...param, procedureName: procedure?.name ?? procedureName.toUpperCase()}));
	}

	// Read from the schema's own routine slot - the same slot the library-list composition reads, so a
	// schema on the list is already cached and one off it costs a lookup of its own.
	private async findProcedures(options: DbConnections.CommonListOptions, schema: string, procedureName: string): Promise<SystemRoutine[]> {
		return (await this.getProcedures({key: options.key, configId: options.configId, schema: schema}))
			.filter(candidate => StringUtils.equalsIgnoreCase(candidate.schema, schema) && StringUtils.equalsIgnoreCase(candidate.name, procedureName));
	}

	// Drops one schema's routines so the next lookup re-reads them. For a routine list found to be out of
	// date (a procedure created or overloaded since it was cached); see DbConnections.execute.
	async deleteRoutinesCache(options: DbConnections.CommonListOptions, schema: string): Promise<void> {
		this.cacheMap.delete(await this.getSchemaEntitiesKey(options, MemoryCache.Keys.SYSTEM_ROUTINES, schema));
	}

	// Cached per table (like getColumns) rather than as one blob keyed by the whole request, since
	// the set of tables referenced in a document changes as the user types -- caching by the full
	// request would mean any change to the table list is a full cache miss for every table in it,
	// not just the newly-added one.
	//
	// Unlike the getters above, a table here is deliberately NOT resolved to a schema first: advice is
	// looked up by table name alone when the caller doesn't know the schema, which is how autocomplete
	// asks about a table it hasn't resolved yet.
	async getIndexAdvice(options: IndexQueries.ListIndexAdviceOptions): Promise<SystemIndexAdvice[]> {
		return this.loadTableEntities<SystemIndexAdvice>({
			options: options,
			tables: options?.tables,
			cacheKey: MemoryCache.Keys.SYSTEM_INDEX_ADVICE,
			forceRefresh: options?.forceRefresh,
			identity: advice => ({schema: advice.schema, table: advice.table}),
			fetch: tables => this.extension.indexQueries.listIndexAdvice({...options, tables: tables})
		});
	}

	// The one cache/fetch path behind getColumns/getTableKeys/getForeignKeys/getIndexes/getIndexAdvice/getTriggers.
	//
	// Every requested table keeps its OWN cache slot, so the set of tables asked about can change
	// freely without invalidating the ones already looked at, and a table cached as "no rows" (an empty
	// array - `[] != null`, unlike a never-fetched undefined) is a cache hit
	// rather than a re-query. Only the tables missing from cache reach the query layer, and they go in
	// ONE statement (chunked - see table-predicates.ts) rather than one statement per table: that is
	// what turns opening a diagram of twenty tables into one query per catalog instead of twenty.
	//
	// Rows are attributed back to their table by their own schema/table fields rather than by request
	// order, since a batched statement returns every table's rows interleaved.
	//
	// A failed fetch caches nothing for any table in the batch (see load()), and the tables already
	// served from cache still come back alongside the empty result.
	private async loadTableEntities<T>(options: MemoryCache.LoadTableEntitiesOptions<T>): Promise<T[]> {
		// Resolved once, up front, rather than per table and again after the fetch: resolving it goes
		// through getConnectionConfig(), and a session that closed while its fetch was in flight can no
		// longer answer it (see DbConnections.closedKeys) - the rows would land under a stand-in identity.
		let identity = await this.getCacheIdentity(options.options);
		let targets = await this.resolveTargets(options);

		if(targets.length === 0) {
			return [];
		}

		let results: T[] = [];
		let missingTables: TableTarget[] = [];

		for(let target of targets) {
			let cached = options.forceRefresh ? undefined : <T[]>await this.get(MemoryCache.tableEntityKey(identity, options.cacheKey, target));

			if(cached != null) {
				results.push(...cached);
			} else {
				missingTables.push(target);
			}
		}

		if(missingTables.length === 0) {
			return results;
		}

		// Every table in the batch key is prefixed with its own '.', not just separated by ',', so each one
		// reads as a `.<schema>.` segment - that's the form deleteSchemaCache matches on when it wipes a
		// schema, and without it only the first table in a batch key would be found.
		let key = `${identity}-${options.cacheKey}.batch${missingTables.map(target => `.${tableTargetKey(target.schema, target.table)}`).sort().join(',')}`;

		let fetched = await this.load({
			key: key,
			load: async () => {
				let rows = await options.fetch(missingTables);

				for(let target of missingTables) {
					let owned = rows.filter(row => MemoryCache.belongsTo(options.identity(row), target));
					this.set(MemoryCache.tableEntityKey(identity, options.cacheKey, target), owned);
				}

				return rows;
			}
		});

		results.push(...fetched);
		return results;
	}

	// Normalizes the request's tables and, for the getters that want it, pins each one to a concrete
	// schema the way the single-table getters always have: a table named with no schema resolves to the
	// first schema on the connection's list that actually has it, so it caches under the same key an
	// explicitly schema-qualified request for the same table would use. A table that resolves to no
	// schema at all is dropped rather than queried.
	private async resolveTargets<T>(options: MemoryCache.LoadTableEntitiesOptions<T>): Promise<TableTarget[]> {
		let targets = toTableTargets(options.tables);

		if(!options.resolveSchema || targets.every(target => StringUtils.isNotBlank(target.schema))) {
			return targets;
		}

		let resolved: TableTarget[] = [];

		for(let target of targets) {
			if(StringUtils.isNotBlank(target.schema)) {
				resolved.push(target);
				continue;
			}

			let schema = await this.findSchemaForTable(options.options, target.table);

			if(StringUtils.isNotBlank(schema)) {
				resolved.push({schema: (<string>schema).toUpperCase(), table: target.table});
			}
		}

		return resolved;
	}

	// The schema a bare table name resolves to: the first one on the session's library list, in that
	// list's own order, that has a table or view by this name - the one DB2 itself would pick under system
	// naming. Ranked by the session's ConnectionInfo rather than the schema catalog, which is ordered by
	// name and covers schemas a bare name never reaches. Views count because SYSCOLUMNS2 and the other
	// per-table catalogs answer for a view exactly as for a table - leaving them out here drops a view
	// before it is ever queried, so it gets no columns.
	private async findSchemaForTable(options: DbConnections.CommonListOptions, table: string): Promise<string | undefined> {
		// Only the session identity is passed on: a caller's options can carry a `schema` of their own
		// (content assist passes the connection's default table schema), and getRelations() would narrow
		// to that one schema, leaving a bare name that lives elsewhere on the list with no candidate.
		let session = {key: options.key, configId: options.configId};
		let libraryList = (await this.extension.connections.getConnectionInfo(session))?.schemas ?? [];
		let relations = await this.getRelations(session);

		let rank = (schema: string) => libraryList.findIndex(entry => StringUtils.equalsIgnoreCase(entry.name, schema));

		return relations
			.filter(candidate => StringUtils.equalsIgnoreCase(candidate.name, table) && rank(candidate.schema) >= 0)
			.sort((first, second) => rank(first.schema) - rank(second.schema))[0]?.schema;
	}

	// A row belongs to a target when their tables match and either the target named no schema (a
	// by-name-only lookup, which getIndexAdvice allows) or the schemas match too.
	private static belongsTo(identity: {schema?: string; table: string}, target: TableTarget): boolean {
		return StringUtils.equalsIgnoreCase(identity.table, target.table)
			&& (StringUtils.isBlank(target.schema) || StringUtils.equalsIgnoreCase(<string>identity.schema, <string>target.schema));
	}

	// Drops the cached rows for the requested tables, so the next request re-queries them. Unlike
	// loadTableEntities this doesn't resolve a bare table name to a schema - every caller deletes with
	// the same concrete schema/table it fetched with.
	private async deleteTableEntitiesCache(options: DbConnections.CommonListOptions, tables: TableTarget[] | TableTarget | undefined, cacheKey: MemoryCache.Keys): Promise<void> {
		for(let target of toTableTargets(tables)) {
			this.cacheMap.delete(await this.getTableEntityKey(options, cacheKey, target));
		}
	}

	private async getTableEntityKey(options: DbConnections.CommonListOptions, cacheKey: MemoryCache.Keys, target: TableTarget): Promise<string> {
		return MemoryCache.tableEntityKey(await this.getCacheIdentity(options), cacheKey, target);
	}

	// Same shape getCacheKey() produces, for a caller that has already resolved the identity.
	private static tableEntityKey(identity: string, cacheKey: MemoryCache.Keys, target: TableTarget): string {
		return `${identity}-${`${cacheKey}.${target.schema ?? ''}.${target.table}`.toLowerCase()}`;
	}

	// Cache is scoped to the underlying connection config rather than the caller's session key, so
	// two sessions pointed at the same connection (e.g. two open SQL tabs, or a SQL tab and the
	// schema browser) share one set of system-table lookups instead of each re-querying
	// SYSTABLES/SYSCOLUMNS2/etc. from scratch. Goes through getConnectionConfig() - which
	// establishes the connection if it isn't already open - rather than peeking at an
	// already-open one, so even the very first cache access for a brand-new session resolves to
	// the real config id instead of temporarily falling back to the raw session key.
	private async getCacheIdentity(options: DbConnections.CommonListOptions): Promise<string> {
		if(options.configId) {
			return options.configId;
		}

		let config = await this.extension.connections.getConnectionConfig(options);
		return config?.id ?? options.key;
	}

	private async getCacheKey(options: DbConnections.CommonListOptions, key: string): Promise<string> {
		return `${await this.getCacheIdentity(options)}-${key}`;
	}

	async deleteConnectionCache(options: DbConnections.CommonListOptions): Promise<void> {
		let identity = await this.getCacheIdentity(options);
		let keys = Array.from(this.cacheMap.keys());

		for(let key of keys) {
			if(key.startsWith(identity)) {
				this.cacheMap.delete(key);
			}
		}
	}

	// Wipes every cache entry for one schema under this connection - used when a manually added
	// schema is deleted outright from the schemas tree (unlike hiding, which deliberately keeps cache
	// around so re-showing it is free - see MemoryCache's per-schema key convention below), so a
	// schema re-added later with the same name starts completely fresh instead of resurfacing stale
	// data. Every per-schema/per-table cache key embeds the schema name as either a `.<schema>` suffix
	// (SYSTEM_TABLES) or a `.<schema>.` segment (SYSTEM_COLUMNS/SYSTEM_TABLE_KEYS/etc., including the
	// multi-table batch keys loadTableEntities builds, which embed it once per table they cover) - both
	// forms are covered here.
	async deleteSchemaCache(options: DbConnections.CommonListOptions, schema: string): Promise<void> {
		let identity = await this.getCacheIdentity(options);
		let normalizedSchema = schema.toLowerCase();
		let keys = Array.from(this.cacheMap.keys());

		for(let key of keys) {
			if(key.startsWith(identity) && (key.endsWith(`.${normalizedSchema}`) || key.includes(`.${normalizedSchema}.`))) {
				this.cacheMap.delete(key);
			}
		}
	}

	// Every fetch in this class runs inside load(), and every one writes its cache slot only after its query has
	// come back - so a failed lookup, which the query layer throws as a CatalogLookupError (see
	// catalog-lookup.ts), leaves the slot unwritten and the next request queries again. Only here is the
	// failure turned back into "no rows" for the caller: autocomplete, heading labels and the schema
	// browser all already treat an empty list as "nothing to show", and the failure itself has already
	// reached the user as an ERROR event in the History tab, so rejecting would only add a second error
	// surface. Anything else thrown is a real bug and still propagates.
	private async load<T>(options: LoadOptions<T[]>): Promise<T[]> {
		try {
			return await lastValueFrom(Sync.get(`memory-cach-${options.key}`, async () => {
				return options.load();
			}));
		} catch(error) {
			if(error instanceof CatalogLookupError) {
				return [];
			}

			throw error;
		}
	}
}

interface LoadOptions<R> {
	key: string;
	load: () => Promise<R>;
}

export namespace MemoryCache {
	export enum Keys {
		SYSTEM_COLUMNS = 'system-columns',
		SYSTEM_SCHEMAS = 'system-schemas',
		SYSTEM_TABLES = 'system-tables',
		SYSTEM_VIEWS = 'system-views',
		SYSTEM_VIEW_DEFINITIONS = 'system-view-definitions',
		SYSTEM_MQT_DEFINITIONS = 'system-mqt-definitions',
		SYSTEM_ROUTINES = 'system-routines',
		SYSTEM_ROUTINE_PARAMETERS = 'system-routine-parameters',
		SYSTEM_ROUTINE_DETAILS = 'system-routine-details',
		SYSTEM_ROUTINE_DDL = 'system-routine-ddl',
		SYSTEM_INDEX_ADVICE = 'system-index-advice',
		SYSTEM_TABLE_KEYS = 'system-table-keys',
		SYSTEM_FOREIGN_KEYS = 'system-foreign-keys',
		SYSTEM_INDEXES = 'system-indexes',
		SYSTEM_TRIGGERS = 'system-triggers',
		SOURCE_TEXT = 'source-text'
	}

	export interface ProcedureParamsOptions extends DbConnections.CommonListOptions {
		/** Resolved from the library list, the way an unqualified CALL is, when left out. */
		schema?: string;
		/** The name a CALL uses (ROUTINE_NAME). */
		procedure?: string;
		/** The CALL's argument count, which picks among overloads - left out where it isn't known yet. */
		argumentCount?: number;
	}

	/** What loadSchemaEntities needs to cache and fetch one kind of per-schema catalog row. */
	export interface LoadSchemaEntitiesOptions<T> {
		/** The request itself - carries the session key/config id every cache key is scoped to. */
		options: DbConnections.CommonListOptions;
		schemas: string[];
		cacheKey: MemoryCache.Keys;
		fetch: (schemas: string[]) => Promise<T[]>;
	}

	/** What loadTableEntities needs to cache and fetch one kind of per-table catalog row. */
	export interface LoadTableEntitiesOptions<T> {
		/** The request itself - carries the session key/config id every cache key is scoped to. */
		options: DbConnections.CommonListOptions;
		tables: TableTarget[] | TableTarget | undefined;
		cacheKey: MemoryCache.Keys;
		/** Pins a table named without a schema to a concrete one before caching it. Off for index advice,
		 * which is deliberately allowed to look a table up by name alone. */
		resolveSchema?: boolean;
		/** Ignores whatever is cached for these tables and re-queries them. */
		forceRefresh?: boolean;
		/** The schema/table a returned row belongs to, since a batched query interleaves every table's rows. */
		identity: (row: T) => {schema?: string; table: string};
		fetch: (tables: TableTarget[]) => Promise<T[]>;
	}
}