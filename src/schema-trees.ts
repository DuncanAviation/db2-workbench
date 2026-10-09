import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Extension } from './extension.js';
import { GlobalStates } from './global-states.js';
import { ConnectionInfo } from './interfaces/connection-info.js';
import { SystemTable } from './models/system-table.js';
import { ImportedTableSchema, ImportProvenance, PASTED_SOURCE_LABEL, SchemaFormatId } from './schema-conversion/schema-format-converter.js';
import { groupImports, importedTableKey, importEntryKey, importEntryKeyOf } from './schema-conversion/import-groups.js';
import { mergeSqlImportFragments } from './schema-conversion/sql-import-fragments.js';
import { findSchemasToFetch } from './schema-conversion/schema-fetch-targets.js';
import { sqlImportTableKey } from './schema-conversion/sql-import-converter.js';
import { ArrayUtils } from './utils/array-utils.js';
import { Nullable } from './utils/nullable.js';
import { SqlImportTableRef } from './utils/sql-import-statement.js';
import { findSchemaFormatByFileName, SCHEMA_FORMATS } from './schema-conversion/schema-formats.js';
import { Event } from './events/event.js';
import { SchemaTreeChangedEvent } from './events/schema-tree-changed-event.js';
import { AlertUtils } from './utils/alert-utils.js';
import { StringUtils } from './utils/string-utils.js';
import { NO_SCHEMA_BUCKET, SchemaImportEntry, SchemaImportReport, SchemaImportSummary, SchemasSchemaListEntry, SchemasSystemRoutine, SchemasSystemTable, SchemasSystemView, TreeTableEntry } from './webview-messages/schemas-messages.js';
import { DbConnections } from './database/db-connections.js';
import { MemoryCache } from './memory-cache.js';
import { RoutineUtils } from './utils/routine-utils.js';

// The schema tree every panel that shows one is built from, plus the session's accumulated schema
// imports. Extracted out of SchemasProvider once the diagram editor's table picker needed the same
// "Edit Schema List"/"Import" menu: the schema-list overrides were already shared (they live in
// GlobalStates, keyed by connection config), but the imported tables were per-provider in-memory state,
// so an import done from a diagram would have been invisible to the schema browser and vice versa.
//
// Panel-facing concerns deliberately stay with the providers - this service returns state and outcomes,
// never posts a message. Each provider knows its own message union (SchemasInboundMessage vs
// DiagramInboundMessage) and, in the diagram's case, needs a different shape of the same data.
export class SchemaTrees {
	// Accumulates every table imported so far this session, per connection - not persisted to disk
	// (cross-restart persistence is still an open question), but survives closing/reopening a panel
	// since it lives on this service, which lives as long as the extension. Appended to, never
	// replaced, by an import - see [[imported-schema-tree-integration-plan]] for why imports accumulate.
	private _importedTablesByConnectionId?: Map<string, ImportedTableSchema[]>;

	// Which of those tables are currently switched OFF, per connection, as importEntryKey strings.
	// Disabling is how every "remove an import" action in the product now works: the rows stay put and
	// every consumer stops seeing them, so the View Imports dialog can switch them back on. Deliberately
	// not persisted and deliberately keyed per connection config - disabling is a temporary, this-session,
	// this-connection state, and re-running an import clears its keys (see mergeImportedTables), so a saved
	// SQL import comes back fully applied on the next connect.
	private _disabledEntriesByConnectionId?: Map<string, Set<string>>;

	constructor(private extension: Extension) {}

	private get importedTablesByConnectionId(): Map<string, ImportedTableSchema[]> {
		return this._importedTablesByConnectionId ??= new Map();
	}

	private get disabledEntriesByConnectionId(): Map<string, Set<string>> {
		return this._disabledEntriesByConnectionId ??= new Map();
	}

	private getDisabledKeys(configId: string): Set<string> {
		let existing = this.disabledEntriesByConnectionId.get(configId);

		if(!existing) {
			existing = new Set();
			this.disabledEntriesByConnectionId.set(configId, existing);
		}

		return existing;
	}

	/**
	 * Every APPLIED imported table for this connection, in import order - disabled ones excluded. The one
	 * accessor every consumer of imported data goes through (the tree, the resolver, the diagram, export,
	 * the import counts), which is exactly why the disabled filter lives here rather than at each call
	 * site. Use getAllImportedTables when you need the disabled ones too.
	 */
	getImportedTables(configId: string): ImportedTableSchema[] {
		let disabled = this.disabledEntriesByConnectionId.get(configId);

		if(!disabled || disabled.size === 0) {
			return this.getAllImportedTables(configId);
		}

		return this.getAllImportedTables(configId).filter(table => !disabled.has(importedTableKey(table)));
	}

	/** Every imported table for this connection, applied or not - only the View Imports list needs this. */
	getAllImportedTables(configId: string): ImportedTableSchema[] {
		return this.importedTablesByConnectionId.get(configId) ?? [];
	}

	// The tables with at least one switched-off imported contribution, deduplicated to schema+table (an
	// entry per import would say the same thing several times over). Drives the "Enable Imported Changes"
	// action on the table tab header and the diagram node menu, which is only offered where there is
	// something switched off to bring back.
	//
	// `schema` is the TREE BUCKET name - an uppercased real schema, or the NO_SCHEMA_BUCKET sentinel
	// exactly as spelled (uppercasing the sentinel would stop it matching its own bucket), built the same
	// way buildTreeState's import loop builds it so the two line up.
	getDisabledImportedTables(configId: string): {schema: string; table: string}[] {
		let disabled = this.disabledEntriesByConnectionId.get(configId);

		if(!disabled || disabled.size === 0) {
			return [];
		}

		let byKey = new Map<string, {schema: string; table: string}>();

		for(let table of this.getAllImportedTables(configId)) {
			if(disabled.has(importedTableKey(table))) {
				let bucket = table.schema?.toUpperCase() ?? NO_SCHEMA_BUCKET;
				byKey.set(`${bucket}.${table.name.toUpperCase()}`, {schema: bucket, table: table.name});
			}
		}

		return [...byKey.values()];
	}

	/** This session's imports for this connection, newest last - what the "View Imports" dialog lists. */
	getImports(configId: string): SchemaImportSummary[] {
		// The saved flag and the linked connections are stamped on here rather than inside groupImports:
		// whether a settings entry stands behind an import (and what it is linked to) is SqlSchemaImports'
		// business, and the grouping itself stays a pure function of the tables it is given.
		//
		// Built from the UNFILTERED list: a disabled table still has to appear in the dialog, unchecked, or
		// there would be nothing to switch back on.
		return groupImports(this.getAllImportedTables(configId), this.getDisabledKeys(configId))
			.map(summary => ({
				...summary,
				saved: this.extension.sqlSchemaImports.isSaved(summary.importId),
				linkedConnections: this.extension.sqlSchemaImports.getLinkedConnections(summary.importId, configId)
			}));
	}

	// Matches by schema+name, case-insensitive - a table with no schema at all is only ever found under
	// the NO_SCHEMA_BUCKET sentinel, never fuzzily matched against a real schema.
	getImportedTablesFor(configId: string, schema: string, table: string): ImportedTableSchema[] {
		return this.getImportedTables(configId).filter(entry => {
			let entrySchema = entry.schema ?? NO_SCHEMA_BUCKET;
			return StringUtils.equalsIgnoreCase(entrySchema, schema) && StringUtils.equalsIgnoreCase(entry.name, table);
		});
	}

	// What a table actually carries from every import, once the lazily loaded parts of a SQL import have
	// been fetched - this is what every consumer that resolves a table should call, rather than the
	// synchronous getImportedTablesFor above (which only ever sees what a SQL import's Tables statement
	// returned, since Columns and Relationships are loaded per table on demand - see SqlSchemaImports).
	//
	// Batched: the diagram resolves a whole canvas at once, and the per-section queries behind this are
	// batched across every table asked for in one call.
	async loadImportedTablesFor(options: SchemaTrees.Options, targets: SqlImportTableRef[]): Promise<Map<string, ImportedTableSchema[]>> {
		let fragments = await this.extension.sqlSchemaImports.getTableFragments({key: options.key, configId: options.configId}, targets);
		let disabled = this.getDisabledKeys(options.configId);
		let byTableKey = new Map<string, ImportedTableSchema[]>();

		for(let target of targets) {
			let key = sqlImportTableKey(target.schema, target.table);
			let stored = this.getImportedTablesFor(options.configId, target.schema, target.table);

			// The fragments need the same disabled filter the stored rows already got from
			// getImportedTablesFor. Disabling deliberately leaves the fragment cache alone (so re-enabling
			// needs no connection), and mergeSqlImportFragments turns a fragment with no stored entry to land
			// on into a transient table of its own - so without this, disabling a SQL import's table would
			// simply resurrect it from its own cached columns and relationships.
			let applicable = (fragments.get(key) ?? []).filter(fragment => !disabled.has(importEntryKey(fragment.importId, fragment.schema, fragment.table)));

			byTableKey.set(key, mergeSqlImportFragments(stored, applicable));
		}

		return byTableKey;
	}

	/** loadImportedTablesFor for a single table - what the schema browser's tabs use, one table at a time. */
	async loadImportedTablesForTable(options: SchemaTrees.Options, schema: string, table: string): Promise<ImportedTableSchema[]> {
		let byTableKey = await this.loadImportedTablesFor(options, [{schema: schema, table: table}]);
		return byTableKey.get(sqlImportTableKey(schema, table)) ?? [];
	}

	// `overrides` is accepted (rather than always read from GlobalStates here) because a caller
	// sometimes has to build the tree from overrides it has only just computed and not yet re-read -
	// see SchemasProvider.ensureSchemaVisible, which unhides a schema and immediately rebuilds.
	async buildTreeState(options: SchemaTrees.Options): Promise<SchemaTrees.TreeState> {
		let {key, configId} = options;
		let overrides = options.overrides ?? this.extension.globalStates.getSchemaListOverrides(configId);

		// The eager (no `schema`) branch of getTables() - returns every table in the connection's
		// library list in one call. No listSchemas call, no lazy per-schema fetch - see the "Data layer"
		// section of the schemas-browser plan for why.
		let libraryTables = await this.extension.memoryCache.getTables({key: key, configId: configId});
		let connectionInfo = await this.extension.connections.getConnectionInfo({key: key, configId: configId});
		let libraryListSchemaNames = connectionInfo?.schemas.map(schema => schema.name) ?? [];

		// A schema that only exists because of an import (no live table, never manually added) still needs
		// to show up in the Edit Schema List - otherwise it can never be hidden from there, even though it
		// already has its own bucket in tablesBySchema below. Schema-less imports (NO_SCHEMA_BUCKET) are
		// deliberately excluded - that's a placeholder grouping, not a real schema name to list. Read off
		// the FILTERED accessor, so a schema whose only import has been disabled drops out of this list the
		// same way it drops out of the tree.
		let importedSchemaNames = this.getImportedTables(configId)
			.map(table => table.schema)
			.filter((schema): schema is string => StringUtils.isNotBlank(schema));

		// Everything the eager scan above didn't cover - user-added schemas, and schemas that only exist
		// because an import named them - queried by name in one batch, however many there are. See
		// findSchemasToFetch for why an import's schema is worth a query even when nothing on this system
		// answers to it. The per-schema cache slots this primes are the same ones the table tabs' own
		// lookups read (see MemoryCache.getTablesForSchema), so this costs one query, not one per surface.
		let fetchSchemaNames = findSchemasToFetch({
			libraryListSchemaNames: libraryListSchemaNames,
			addedSchemaNames: overrides.added,
			importedSchemaNames: importedSchemaNames,
			hiddenSchemaNames: overrides.hidden
		});

		let fetchedTables = fetchSchemaNames.length > 0
			? await this.extension.memoryCache.getTablesForSchemas({key: key, configId: configId}, fetchSchemaNames)
			: [];

		let groupedTables = ArrayUtils.toMapOfArrays([...libraryTables, ...fetchedTables], table => table.schema.toUpperCase(), table => SchemaTrees.toSchemasSystemTable(table));

		// Views come from the same two sources as tables - the library-list scan plus one batch for every
		// other schema - so a schema added by name shows its views as well as its tables.
		let libraryViews = await this.extension.memoryCache.getViews({key: key, configId: configId});
		let fetchedViews = fetchSchemaNames.length > 0
			? await this.extension.memoryCache.getViewsForSchemas({key: key, configId: configId}, fetchSchemaNames)
			: [];

		let groupedViews = ArrayUtils.toMapOfArrays([...libraryViews, ...fetchedViews], view => view.schema.toUpperCase(), view => view);

		// Functions and procedures too, the same two sources again, both filtered out of the one routine
		// list - which is also what function and CALL completion read, so this primes those as well.
		let libraryRoutines = await this.extension.memoryCache.getRoutines({key: key, configId: configId});
		let fetchedRoutines = fetchSchemaNames.length > 0
			? await this.extension.memoryCache.getRoutinesForSchemas({key: key, configId: configId}, fetchSchemaNames)
			: [];

		let allRoutines = [...libraryRoutines, ...fetchedRoutines];
		let groupRoutines = (routines: SchemasSystemRoutine[]) => ArrayUtils.toMapOfArrays(routines, routine => routine.schema.toUpperCase(), routine => <SchemasSystemRoutine>{...routine});
		let groupedFunctions = groupRoutines(allRoutines.filter(MemoryCache.isListedFunction));
		let groupedProcedures = groupRoutines(allRoutines.filter(routine => routine.routineType === 'PROCEDURE'));

		let allSchemaNames = Array.from(new Set([...libraryListSchemaNames, ...overrides.added, ...overrides.hidden, ...importedSchemaNames].map(name => name.toUpperCase()))).sort();

		let schemaList: SchemasSchemaListEntry[] = allSchemaNames.map(name => ({
			name: name,
			hidden: overrides.hidden.some(hidden => StringUtils.equalsIgnoreCase(hidden, name)),
			added: overrides.added.some(added => StringUtils.equalsIgnoreCase(added, name))
		}));

		// Every visible schema gets an entry even with zero tables (e.g. a newly added, empty schema) -
		// otherwise it would silently vanish from the tree instead of showing as an empty node.
		let tablesBySchema: Record<string, TreeTableEntry[]> = {};
		let viewsBySchema: Record<string, SchemasSystemView[]> = {};
		let functionsBySchema: Record<string, SchemasSystemRoutine[]> = {};
		let proceduresBySchema: Record<string, SchemasSystemRoutine[]> = {};

		for(let entry of schemaList) {
			if(!entry.hidden) {
				tablesBySchema[entry.name] = (groupedTables.get(entry.name) ?? []).map(table => ({connected: table}));
				viewsBySchema[entry.name] = groupedViews.get(entry.name) ?? [];
				functionsBySchema[entry.name] = groupedFunctions.get(entry.name) ?? [];
				proceduresBySchema[entry.name] = groupedProcedures.get(entry.name) ?? [];
			}
		}

		// Overloads are per kind: a function and a procedure sharing a name are not overloads of each other.
		await this.labelOverloads({key: key, configId: configId}, [
			...RoutineUtils.overloaded(Object.values(functionsBySchema).flat()),
			...RoutineUtils.overloaded(Object.values(proceduresBySchema).flat())
		]);

		// Merge in every table imported so far this session - matched by schema+name (case-insensitive)
		// against what's already in the tree; unmatched imports become new, imported-only entries.
		// Schema-less imports always land in NO_SCHEMA_BUCKET rather than being matched against
		// anything, since matching a bare name against every schema risks a false-positive collision.
		for(let importedTable of this.getImportedTables(configId)) {
			let bucketName = importedTable.schema?.toUpperCase() ?? NO_SCHEMA_BUCKET;

			// "Hide" simply hides it - an imported-only schema respects the exact same hidden flag a real
			// one does, rather than always forcing its own bucket into the tree regardless.
			if(overrides.hidden.some(hidden => StringUtils.equalsIgnoreCase(hidden, bucketName))) {
				continue;
			}

			let bucket = tablesBySchema[bucketName] ?? (tablesBySchema[bucketName] = []);

			let matched = importedTable.schema
				? bucket.find(entry => entry.connected && StringUtils.equalsIgnoreCase(entry.connected.name, importedTable.name))
				: undefined;

			if(matched) {
				matched.imported = [...(matched.imported ?? []), importedTable];
			} else {
				bucket.push({imported: [importedTable]});
			}
		}

		// Flags the tables with something switched off, so the table tab header can offer "Enable Imported
		// Changes". Only ever marks an entry the loops above already produced - it never adds a row of its
		// own, so a wholly-imported table whose every import is disabled stays out of the tree (the View
		// Imports dialog is where that one comes back from), while a real DB2 table or a partly-disabled
		// imported one keeps its row and gains the flag.
		for(let disabled of this.getDisabledImportedTables(configId)) {
			let entry = (tablesBySchema[disabled.schema] ?? [])
				.find(candidate => StringUtils.equalsIgnoreCase(candidate.connected?.name ?? candidate.imported?.[0]?.name ?? '', disabled.table));

			if(entry) {
				entry.hasDisabledImports = true;
			}
		}

		return {tablesBySchema: tablesBySchema, viewsBySchema: viewsBySchema, functionsBySchema: functionsBySchema, proceduresBySchema: proceduresBySchema, schemaList: schemaList, connectionInfo: connectionInfo};
	}

	// An overload's tree row needs its parameter types to be told from its siblings, so the overloads -
	// and only they - have their SYSPARMS rows read, in one batch. Those rows land in the same per-routine
	// cache slots the Parameters tab reads, so opening one of them afterwards costs nothing.
	private async labelOverloads(options: DbConnections.CommonListOptions, overloads: SchemasSystemRoutine[]): Promise<void> {
		if(overloads.length === 0) {
			return;
		}

		let params = await this.extension.memoryCache.getRoutineParams({
			...options,
			tables: overloads.map(overload => ({schema: overload.schema, table: overload.specificName}))
		});

		let signatures = RoutineUtils.signatures(overloads, params);

		for(let overload of overloads) {
			overload.signature = signatures.get(RoutineUtils.key(overload.schema, overload.specificName));
		}
	}

	// The Edit Schema List dialog's OK button: persists the new hidden/added sets and forgets everything
	// about a deleted schema. Every panel showing this connection's tree - including the one the dialog
	// was opened from - repaints off the event, not off a return value.
	async updateSchemaList(options: SchemaTrees.Options, update: SchemaTrees.SchemaListUpdate): Promise<void> {
		let {key, configId} = options;
		let currentOverrides = this.extension.globalStates.getSchemaListOverrides(configId);
		let newlyAdded = update.newSchemas.map(schema => schema.trim().toUpperCase()).filter(schema => StringUtils.isNotBlank(schema));
		let deletedSchemas = update.deletedSchemas.map(schema => schema.toUpperCase());

		let updatedOverrides: GlobalStates.SchemaListOverrides = {
			added: Array.from(new Set([...currentOverrides.added, ...newlyAdded])).filter(schema => !deletedSchemas.some(deleted => StringUtils.equalsIgnoreCase(deleted, schema))),
			hidden: update.hiddenSchemas.map(schema => schema.toUpperCase()).filter(schema => !deletedSchemas.some(deleted => StringUtils.equalsIgnoreCase(deleted, schema)))
		};

		this.extension.globalStates.setSchemaListOverrides(configId, updatedOverrides);

		// Deleting is only offered for a schema the user added by name (see SchemasSchemaListEntry.added),
		// and it means exactly one thing hiding can't: take the name back out of the overrides above so it
		// stops appearing in the list at all. The cache goes with it so a re-added schema of the same name
		// starts fresh rather than resurfacing stale tables.
		//
		// It deliberately does NOT touch imported data any more. An import is switched off through the View
		// Imports dialog (or "Disable Imported Changes"), reversibly, and an import-only schema disappears
		// from this list on its own once its import is disabled - see buildTreeState, which derives those
		// names from the filtered getImportedTables.
		for(let schema of deletedSchemas) {
			await this.extension.memoryCache.deleteSchemaCache({key: key, configId: configId}, schema);
		}

		this.fireChanged(configId);
	}

	// ImportSchemaDialog's "File" tab - reads a schema file, detecting format by extension.
	async importFromFile(options: SchemaTrees.Options): Promise<SchemaTrees.ImportResult> {
		let sourceUri = await vscode.window.showOpenDialog({
			canSelectMany: false,
			// The dialog only ever shows one filter group's extensions at a time, defaulting to whichever
			// is listed first - "All Supported Files" first means both extensions are visible by default,
			// with the single-format options still available for anyone who wants to narrow the list.
			filters: {'All Supported Files': ['dbml', 'json'], 'DBML': ['dbml'], 'Frictionless Schema': ['json']}
		});

		if(!sourceUri || sourceUri.length === 0) {
			return {kind: 'cancelled'};
		}

		let fileName = sourceUri[0].fsPath;
		let converter = findSchemaFormatByFileName(fileName);

		if(!converter) {
			AlertUtils.onError('Unsupported file type - expected .dbml or .json.');
			return {kind: 'cancelled'};
		}

		let content = '';

		try {
			let bytes = await vscode.workspace.fs.readFile(sourceUri[0]);
			content = Buffer.from(bytes).toString('utf8');
			let parsed = await converter.import(content);

			let provenance: ImportProvenance = {
				importId: randomUUID(),
				sourceFormat: converter.id,
				sourceLabel: path.basename(fileName),
				importedAt: new Date().toISOString()
			};

			return {kind: 'imported', report: await this.mergeImportedTables(options, parsed, provenance)};
		} catch(error) {
			return {kind: 'error', error: error, content: content};
		}
	}

	// ImportSchemaDialog's "Paste" tab - same parse/merge as the file path, but the format can't be
	// sniffed from a filename since there isn't one, so the webview sends it explicitly.
	async importFromText(options: SchemaTrees.Options, format: SchemaFormatId, content: string): Promise<SchemaTrees.ImportResult> {
		try {
			let converter = SCHEMA_FORMATS[format];
			let parsed = await converter.import(content);

			let provenance: ImportProvenance = {
				importId: randomUUID(),
				sourceFormat: format,
				sourceLabel: PASTED_SOURCE_LABEL,
				importedAt: new Date().toISOString()
			};

			return {kind: 'imported', report: await this.mergeImportedTables(options, parsed, provenance)};
		} catch(error) {
			return {kind: 'error', error: error, content: content};
		}
	}

	// The SQL import source (see SqlSchemaImports, which owns running the statements and converting their
	// rows). Everything past that point is identical to a file import - the tables are stamped with this
	// import's provenance and accumulated into the same per-connection store - so the tree, the resolver,
	// View Imports and export need to know nothing about where a table came from. sourceLabel is the
	// import's name rather than a file name, since there is no file.
	async importFromSql(options: SchemaTrees.Options, request: SchemaTrees.SqlImportRequest): Promise<SchemaImportReport> {
		let provenance: ImportProvenance = {
			importId: request.importId,
			sourceFormat: 'sql',
			sourceLabel: request.name,
			// Supplied by the caller rather than stamped here: the same timestamp identifies this import in
			// the fragment cache, and a transient table built out of that cache has to carry provenance
			// indistinguishable from the stored entry's.
			importedAt: request.importedAt
		};

		return this.mergeImportedTables(options, request.tables, provenance);
	}

	// Table tab header's (and the diagram node menu's) "Disable Imported Changes" action - switches off
	// every imported contribution for one specific table, regardless of how many separate imports
	// contributed to it. Same schema+name matching as getImportedTablesFor, including the NO_SCHEMA_BUCKET
	// sentinel for a schema-less import.
	//
	// Reversible, like every other disable: the rows stay in the store and the View Imports dialog lists
	// the table unchecked under each import that contributed it.
	disableImportedTableData(configId: string, schema: string, table: string): void {
		this.disableEntries(configId, this.allEntriesForTable(configId, schema, table));
	}

	/** The exact inverse - "Enable Imported Changes", offered wherever getDisabledImportedTables lists a
	 * table. Switches every import that touched it back on, whichever of them were off. */
	enableImportedTableData(configId: string, schema: string, table: string): void {
		this.enableEntries(configId, this.allEntriesForTable(configId, schema, table));
	}

	// Every import entry for one table, applied or not - what the two whole-table actions above act on.
	// Reads the unfiltered store deliberately: an entry that is already switched off is exactly what
	// enabling has to name, and it is harmless for disabling to name it again.
	allEntriesForTable(configId: string, schema: string, table: string): SchemaImportEntry[] {
		return this.getAllImportedTables(configId)
			.filter(entry => StringUtils.equalsIgnoreCase(entry.schema ?? NO_SCHEMA_BUCKET, schema) && StringUtils.equalsIgnoreCase(entry.name, table))
			.map(entry => ({importId: entry.provenance.importId, schema: entry.schema ?? NO_SCHEMA_BUCKET, table: entry.name}));
	}

	// The View Imports dialog's Apply, disabling half - switches off specific tables of specific imports.
	// Unlike disableImportedTableData (which acts on a table across EVERY import), an entry only names its
	// own batch, so disabling one import leaves another import's copy of the same table applied. Everything
	// goes in one pass with a single event, since the dialog routinely disables a whole batch at once and
	// one event per table would repaint every panel once per table.
	//
	// Note what this deliberately does NOT do: it doesn't prune the SQL fragment cache. A disabled table's
	// fragments are filtered on read instead (see loadImportedTablesFor), so re-enabling is instant and
	// needs no connection - re-running the statements is what the Refresh button is for.
	disableEntries(configId: string, entries: SchemaImportEntry[]): void {
		if(entries.length === 0) {
			return;
		}

		let disabled = this.getDisabledKeys(configId);

		for(let entry of entries) {
			disabled.add(importEntryKeyOf(entry));
		}

		this.fireChanged(configId);
	}

	/** The View Imports dialog's Apply, re-enabling half - the exact inverse of disableEntries. */
	enableEntries(configId: string, entries: SchemaImportEntry[]): void {
		if(entries.length === 0) {
			return;
		}

		let disabled = this.getDisabledKeys(configId);

		for(let entry of entries) {
			disabled.delete(importEntryKeyOf(entry));
		}

		this.fireChanged(configId);
	}

	// Drops one whole import from one connection for real - the rows go, not just a flag. Two callers, both
	// of them an explicit "this import should stop existing here" rather than a disable: unlinking a saved
	// import from this connection (the settings entry survives for whatever else it is linked to), and
	// deleting one outright from the View Imports confirmation. SqlSchemaImports' own delete/unlink paths
	// call it for the same reason.
	removeImport(configId: string, importId: string): void {
		let existing = this.importedTablesByConnectionId.get(configId);
		let disabled = this.disabledEntriesByConnectionId.get(configId);

		if(existing) {
			this.importedTablesByConnectionId.set(configId, existing.filter(table => table.provenance.importId !== importId));
		}

		// Nothing left to disable once the rows are gone, and leaving stale keys behind would silently
		// disable the same tables again if this import id ever came back.
		if(disabled) {
			this.clearDisabledKeysFor(configId, importId);
		}

		this.fireChanged(configId);
	}

	// Drops every disabled key belonging to one import. Called on a real removal (above) and on any
	// re-merge (mergeImportedTables), which is what makes a disable temporary: re-running a saved SQL
	// import - on the next connect, from the Refresh button, or after an edit - brings it back fully
	// applied rather than silently keeping tables switched off against rows that have since been replaced.
	private clearDisabledKeysFor(configId: string, importId: string): void {
		let disabled = this.disabledEntriesByConnectionId.get(configId);

		if(!disabled) {
			return;
		}

		for(let key of [...disabled]) {
			if(key.startsWith(`${importId}|`)) {
				disabled.delete(key);
			}
		}
	}

	// Shared by every import source (File/Paste/SQL) - stamps provenance onto each parsed table and
	// accumulates it into this connection's imported-tables store. Returns what landed rather than
	// raising a toast: the summary dialog each panel shows says more than a toast could, and a toast
	// on top of it would just repeat itself.
	private async mergeImportedTables(options: SchemaTrees.Options, parsed: Omit<ImportedTableSchema, 'provenance'>[], provenance: ImportProvenance): Promise<SchemaImportReport> {
		let tables: ImportedTableSchema[] = parsed.map(table => ({...table, provenance: provenance}));

		// Replaces its own previous batch rather than adding a second one. A file import always has a fresh
		// importId, so nothing matches and this is a plain append; a SAVED SQL import keeps one stable id
		// across every re-run (see SqlSchemaImports), and that is what makes a re-run update the tree in
		// place instead of leaving a second View Imports entry behind every time a connection opens.
		//
		// getAllImportedTables, not getImportedTables: the base here is what gets written back, so filtering
		// it would delete every OTHER import's disabled rows outright instead of leaving them switched off.
		let existing = this.getAllImportedTables(options.configId).filter(table => table.provenance.importId !== provenance.importId);
		this.importedTablesByConnectionId.set(options.configId, [...existing, ...tables]);

		// A re-run replaces this import's rows, so its disabled keys stop meaning anything - and keeping
		// them would silently switch off tables of a batch the user just asked to be refreshed. This is
		// what makes disabling temporary: the next connect, the Refresh button and an edit all bring a
		// saved SQL import back fully applied.
		this.clearDisabledKeysFor(options.configId, provenance.importId);
		this.fireChanged(options.configId);

		return {
			importId: provenance.importId,
			sourceLabel: provenance.sourceLabel,
			sourceFormat: provenance.sourceFormat,
			tableCount: tables.length,
			columnCount: tables.reduce((total, table) => total + table.columns.length, 0),
			foreignKeyCount: tables.reduce((total, table) => total + table.foreignKeys.length, 0),
			// A table the source gave no schema for is grouped under a placeholder rather than matched
			// against a real schema - worth saying out loud, since nothing else in the tree explains it.
			noSchemaCount: tables.filter(table => StringUtils.isBlank(table.schema)).length,
			noSchemaBucket: NO_SCHEMA_BUCKET
		};
	}

	// Every panel showing this connection's tree rebuilds off this - see SchemaTreeChangedEvent for why
	// it goes through the bus rather than this service pushing to panels it shouldn't know about.
	private fireChanged(configId: string): void {
		this.extension.eventManager.fire<SchemaTreeChangedEvent>({type: Event.Type.SCHEMA_TREE_CHANGED, configId: configId});
	}

	private static toSchemasSystemTable(table: SystemTable): SchemasSystemTable {
		return {
			...table,
			alteredTimestamp: table.alteredTimestamp?.toISOString(),
			refreshTimestamp: table.refreshTimestamp?.toISOString()
		};
	}
}

export namespace SchemaTrees {
	export interface Options {
		key: string;
		configId: string;
		/** Defaults to whatever GlobalStates currently holds for this connection. */
		overrides?: GlobalStates.SchemaListOverrides;
	}

	export interface TreeState {
		tablesBySchema: Record<string, TreeTableEntry[]>;
		/** Separate from tablesBySchema - see SchemasInitialState.viewsBySchema. */
		viewsBySchema: Record<string, SchemasSystemView[]>;
		/** Same - see SchemasInitialState.functionsBySchema. */
		functionsBySchema: Record<string, SchemasSystemRoutine[]>;
		proceduresBySchema: Record<string, SchemasSystemRoutine[]>;
		schemaList: SchemasSchemaListEntry[];
		connectionInfo: Nullable<ConnectionInfo>;
	}

	export interface SchemaListUpdate {
		hiddenSchemas: string[];
		newSchemas: string[];
		deletedSchemas: string[];
	}

	// What SqlSchemaImports hands over once it has run the statements and converted their rows - the same
	// merge every other source goes through, just with the tables already built.
	export interface SqlImportRequest {
		importId: string;
		name: string;
		/** ISO string - see importFromSql for why the caller owns it. */
		importedAt: string;
		tables: Omit<ImportedTableSchema, 'provenance'>[];
	}

	// 'cancelled' covers both a dismissed file dialog and an unsupported file type (which reports itself
	// via AlertUtils, since there is nothing for a panel to add). 'error' carries the parse failure and
	// the text it came from, which is what each panel's own import-error dialog needs. 'imported' carries
	// the summary its panel shows - the tree that resulted reaches every panel as a SchemaTreeChangedEvent
	// regardless, this one included.
	export type ImportResult =
		| {kind: 'cancelled'}
		| {kind: 'imported'; report: SchemaImportReport}
		| {kind: 'error'; error: unknown; content: string};
}
