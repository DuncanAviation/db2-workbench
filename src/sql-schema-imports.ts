import { randomUUID } from 'node:crypto';
import { Extension } from './extension.js';
import { ConnectionConfig } from './models/connection-config.js';
import {
	getSqlImportSection,
	getSqlImportSectionConfig,
	SqlImportConfig,
	SqlImportRow,
	SqlImportSectionId,
	SqlImportTarget,
	SQL_IMPORT_SECTIONS
} from './models/sql-import-config.js';
import {
	checkSqlImportMappingDrift,
	convertSqlImportColumnRows,
	convertSqlImportRelationshipRows,
	convertSqlImportTableRows,
	invertSqlImportMapping,
	SqlImportSectionStats,
	SqlImportTable,
	SqlImportSectionSummary,
	sqlImportTableKey
} from './schema-conversion/sql-import-converter.js';
import { getSqlImportFilterColumns, SqlImportTableFragment, sqlImportFragmentKey } from './schema-conversion/sql-import-fragments.js';
import { buildSqlImportConfig, linkSqlImportToConnections } from './schema-conversion/sql-import-persistence.js';
import { ImportedColumn, ImportedForeignKey } from './schema-conversion/schema-format-converter.js';
import { buildSqlImportStatement, findDuplicateResultColumn, SqlImportTableRef } from './utils/sql-import-statement.js';
import { SqlImportValidator } from './utils/sql-import-validator.js';
import { AlertUtils } from './utils/alert-utils.js';
import { DbErrorUtils } from './utils/db-error-utils.js';
import { StringUtils } from './utils/string-utils.js';
import { TryUtils } from './utils/try-utils.js';
import { SqlImportConnectionTarget, SqlImportMappings, SqlImportOutcome, SqlImportRunResult, SqlImportRunSection, SqlImportStatementInput } from './webview-messages/schemas-messages.js';

// Runs a SQL schema import's statements and turns their rows into imported tables. Owns everything
// specific to the SQL source - read-only validation, statement wrapping, running on the worker
// connection, holding a run's rows between the dialog's two steps, and the per-table cache the lazily
// loaded Columns and Relationships sections are served from - while SchemaTrees stays the owner of the
// tree and of import provenance, exactly as it is for a DBML or Frictionless file.
//
// The dialog is two steps (run, then map), and the rows are what connects them: step 1 runs the
// statements and only the result column names, a row count and a handful of sample rows travel to the
// webview, while the rows themselves stay here under a run id. Sending 50,000 rows over postMessage so
// the webview could map them and send them straight back would be pointless.
//
// Columns and Relationships never land in the tree: a SQL-imported table is stored carrying only what
// the Tables statement said about it, and everything else is assembled on read out of the fragment
// cache here (see SchemaTrees.loadImportedTablesFor). That keeps View Imports' table list exactly what
// the Tables statement returned however much of the import has since been loaded, and keeps the
// imported rows separate from real DB2 data, which MemoryCache still owns alone.
export class SqlSchemaImports {
	private runs = new Map<string, SqlSchemaImports.Run>();

	// Keyed by host (see the plan's per-host identity): the same statement run against the same host
	// produces the same rows whichever connection config - or user name - asked for it.
	private registry = new Map<string, Map<string, SqlSchemaImports.RegisteredImport>>();

	// Keyed by sqlImportFragmentKey - one entry per (host, import, section, table). An entry is written
	// even when the section had nothing for that table, so a table with no imported columns costs one
	// query rather than one per time it is opened.
	private fragments = new Map<string, SqlSchemaImports.SectionFragment>();

	// One in-flight (or finished) run per (host, saved import). A saved import runs once for a host however
	// many connections link it, and a failed run is remembered as a failure rather than retried - see
	// applySavedImport.
	private hostRuns = new Map<string, Promise<SqlSchemaImports.HostRunOutcome>>();

	// `${importId}|${section}` for a section that has already reported a failure - see warnOnce.
	private warned = new Set<string>();

	constructor(private extension: Extension) {}

	// Step 1 of the import dialog: validate and run every statement the user filled in. The first
	// failure stops the whole run - a mapping step built on a partial result would be misleading, and
	// the dialog puts the error under the section that produced it.
	async run(options: SqlSchemaImports.RunOptions): Promise<SqlImportRunResult> {
		let sections: SqlImportRunSection[] = [];
		let rowsBySection = new Map<SqlImportSectionId, SqlImportRow[]>();
		let rowLimit = this.extension.configurations.sqlImportRowLimit;

		for(let statement of options.statements) {
			if(StringUtils.isBlank(statement.sql)) {
				continue;
			}

			let violation = SqlImportValidator.check(statement.sql);

			if(violation) {
				return {kind: 'error', section: statement.section, error: {message: violation.reason}};
			}

			let error: unknown;

			// One more row than the cap is asked for, so a result that hit the cap is detectable rather
			// than silently short.
			let result = await this.extension.connections.internalQuery({
				key: options.key,
				configId: options.configId,
				sql: buildSqlImportStatement(statement.sql, {rowLimit: rowLimit + 1}),
				progressMessage: `Running the ${getSqlImportSection(statement.section).label} statement...`,
				onError: caught => error = caught
			});

			if(error || !result) {
				return {kind: 'error', section: statement.section, error: DbErrorUtils.serialize(error ?? new Error('The statement returned no result.'))};
			}

			let resultColumns = (result.columns ?? []).map(column => column.name);
			let duplicate = findDuplicateResultColumn(resultColumns);

			// Caught here rather than left to DB2: the wrapper makes the user's statement a derived
			// table, which rejects duplicate column names with an error that says nothing about which
			// statement or which name caused it.
			if(duplicate) {
				return {
					kind: 'error',
					section: statement.section,
					error: {message: `This statement returns more than one column named "${duplicate}". Give each result column a distinct name (use AS).`}
				};
			}

			let rows = <SqlImportRow[]>Array.from(result);
			let truncated = rows.length > rowLimit;

			rowsBySection.set(statement.section, truncated ? rows.slice(0, rowLimit) : rows);

			sections.push({
				section: statement.section,
				resultColumns: resultColumns,
				rowCount: truncated ? rowLimit : rows.length,
				truncated: truncated,
				sampleRows: SqlSchemaImports.toSampleRows(rows, resultColumns)
			});
		}

		let runId = randomUUID();

		this.runs.set(runId, {
			key: options.key,
			configId: options.configId,
			statements: options.statements,
			rows: rowsBySection,
			// Recorded so a saved import carries the result column names its mapping was built against - that
			// is what lets a later run report drift (a mapped column the statement no longer returns) instead
			// of silently dropping the field.
			resultColumns: new Map(sections.map(section => [section.section, section.resultColumns]))
		});

		return {kind: 'ran', runId: runId, sections: sections};
	}

	// Step 2: apply a run's rows through the mapping the user just built. The Tables section lands in the
	// tree; Columns and Relationships are converted here too - their rows are already in hand, so making
	// the user wait for a per-table query to tell them what they just imported would be pointless - and
	// seeded straight into the fragment cache, table by table, which is where the tabs read them from.
	async import(options: SqlSchemaImports.ImportOptions): Promise<SqlImportOutcome> {
		let run = this.runs.get(options.runId);

		if(!run) {
			return {kind: 'error', error: {message: 'That import is no longer available - run the statements again.'}};
		}

		let missing = SqlSchemaImports.findUnmappedRequiredTargets(options.mappings, run.rows);

		if(missing.length > 0) {
			return {kind: 'error', error: {message: `Every required field must be mapped before importing: ${missing.join(', ')}.`}};
		}

		// The dialog checks this too, but invertSqlImportMapping resolves a duplicate by silently keeping
		// the last one - which would import data from a column the user didn't mean, so it's rejected here
		// rather than being left to whichever caller happens to be careful.
		let duplicates = SqlSchemaImports.findDuplicateTargets(options.mappings, run.rows);

		if(duplicates.length > 0) {
			return {kind: 'error', error: {message: `Each field can only be mapped once: ${duplicates.join(', ')}.`}};
		}

		let importId = randomUUID();
		let importedAt = new Date().toISOString();
		let tableRows = run.rows.get('tables') ?? [];
		let converted = convertSqlImportTableRows(tableRows, options.mappings.tables ?? {});
		let importTableKeys = new Set(converted.tables.map(table => sqlImportTableKey(table.schema, table.name)));

		// A Columns or Relationships row is allowed to name a table the Tables statement never returned,
		// as long as DB2 itself has it - a relationship whose child is a real, undeclared table is the
		// motivating case for the whole feature. Anything else has nowhere to land and is counted.
		let knownTables = await this.getKnownTables({key: run.key, configId: run.configId}, importTableKeys);

		let host = await this.getHost({key: run.key, configId: run.configId});
		let entry: SqlSchemaImports.RegisteredImport = {
			importId: importId,
			name: options.name,
			importedAt: importedAt,
			configIds: new Set([run.configId]),
			tableKeys: importTableKeys,
			sections: new Map(),
			seeded: new Set()
		};

		for(let section of ['columns', 'relationships'] as const) {
			let statement = run.statements.find(candidate => candidate.section === section);

			if(statement && StringUtils.isNotBlank(statement.sql)) {
				entry.sections.set(section, {sql: statement.sql, mapping: options.mappings[section] ?? {}});
			}
		}

		let stats: SqlImportSectionSummary[] = [{...converted.stats, applied: true}];

		stats.push(...this.seedFragments({
			host: host,
			entry: entry,
			rows: run.rows,
			mappings: options.mappings,
			knownTables: knownTables
		}));

		if(host) {
			let byImportId = this.registry.get(host) ?? new Map<string, SqlSchemaImports.RegisteredImport>();
			this.registry.set(host, byImportId);
			byImportId.set(importId, entry);
		}

		let report = await this.extension.schemaTrees.importFromSql({key: run.key, configId: run.configId}, {
			importId: importId,
			name: options.name,
			importedAt: importedAt,
			// Columns, keys and relationships stay empty on the stored table: they live in the fragment
			// cache and are merged in on read, so what View Imports lists stays exactly what the Tables
			// statement returned - see this class's own comment.
			tables: converted.tables.map(table => ({
				schema: table.schema,
				name: table.name,
				description: table.description,
				columns: [],
				primaryKeyColumns: [],
				uniqueKeys: [],
				foreignKeys: [],
				indexes: []
			}))
		});

		if(options.save) {
			await this.saveImport(SqlSchemaImports.toSavedConfig(importId, options.name, run, options.mappings), options.connectionIds ?? [run.configId]);

			// This session has already run everything this saved entry describes, so the auto-run guard is
			// marked satisfied for it here rather than letting the next ensureLoaded re-run the Tables
			// statement against the connection the user just imported from.
			if(host) {
				this.hostRuns.set(SqlSchemaImports.hostRunKey(host, importId), Promise.resolve({ran: true, tables: converted.tables, importedAt: importedAt}));
			}
		}

		this.discardRun(options.runId);

		return {kind: 'imported', report: {...report, sections: stats}};
	}

	/** Every saved import, from USER settings only - see Configurations.sqlImports. */
	getSavedImports(): SqlImportConfig[] {
		return this.extension.configurations.sqlImports.filter(entry => entry?.id != null && entry?.tables?.sql != null);
	}

	// The import dialog's connection checkbox list. Built from the configured connections rather than the
	// open ones: a saved import is linked to a connection, not to a session, and linking it to one that
	// happens to be closed right now is perfectly reasonable - it runs the next time that one opens.
	getConnectionTargets(currentConfigId?: string): SqlImportConnectionTarget[] {
		return this.extension.configurations.connections.map(connection => ({
			id: connection.id,
			name: connection.name,
			current: connection.id === currentConfigId,
			sqlImportIds: connection.sqlImportIds ?? []
		}));
	}

	getSavedImport(importId: string): SqlImportConfig | undefined {
		return this.getSavedImports().find(entry => entry.id === importId);
	}

	// Runs every saved import linked to this connection that hasn't run yet for its host, and applies the
	// result to this connection. Called from DbConnections once a connection is open (fire-and-forget), so
	// the tree already carries a saved import's tables the first time any panel opens.
	//
	// Deduped per (host, import): a second config on the same system - or the same one under a different
	// user name - reuses the rows rather than re-running the statement, and only the apply step repeats.
	// A failure is NOT retried; the user refreshes manually.
	async ensureLoaded(options: SqlSchemaImports.LoadOptions): Promise<void> {
		let config = await this.extension.connections.getConnectionConfig({key: options.key, configId: options.configId});

		if(!config || !config.sqlImportIds?.length) {
			return;
		}

		for(let importId of config.sqlImportIds ?? []) {
			let saved = this.getSavedImport(importId);

			if(!saved) {
				// An id with no entry behind it is ignored rather than reported: a settings file edited by
				// hand, or an entry deleted while a connection that linked it was closed, is not an error
				// anyone can act on from here.
				continue;
			}

			await this.applySavedImport(options, config.host, saved);
		}
	}

	// A connection's settings changed while it was open. Two things here matter: its host (the identity the
	// rows are cached under) and which imports it links. Everything else about a connection is none of this
	// service's business.
	applyConnectionChange(options: SqlSchemaImports.LoadOptions, previous: ConnectionConfig, current: ConnectionConfig): void {
		if(!StringUtils.equalsIgnoreCase(previous.host, current.host)) {
			// The rows describe the OLD system. Dropped explicitly here rather than left to close(), which
			// runs after the config has already been updated in place and would drop the new host's cache.
			this.deleteHostCache(previous.host);
		}

		let previousIds = previous.sqlImportIds ?? [];
		let currentIds = current.sqlImportIds ?? [];

		for(let importId of previousIds.filter(id => !currentIds.includes(id))) {
			this.dropImport(current.id, importId);
		}

		// Newly linked imports run now rather than on the next connect - the user just asked for them.
		TryUtils.forgetPromise({
			context: 'sql-schema-imports applyConnectionChange()',
			promise: () => this.ensureLoaded(options),
			onError: error => AlertUtils.onError(error)
		});
	}

	// "Refresh SQL Import": runs every one of an import's sections again. The Tables statement runs now; the
	// lazy sections' cached rows are dropped rather than re-queried here, so each table re-reads them the
	// next time it is opened - the same shape of work a first connect does, not a scan of every table the
	// import has ever touched.
	async refreshImport(options: SqlSchemaImports.LoadOptions, importId: string): Promise<void> {
		let saved = this.getSavedImport(importId);
		let host = await this.getHost(options);

		if(!saved || !host) {
			return;
		}

		this.hostRuns.delete(SqlSchemaImports.hostRunKey(host, importId));
		await this.applySavedImport(options, host, saved);
	}

	// The edit dialog's Save. Writes the settings entry and the connection links, then forgets everything
	// loaded for this import - its statements or its mapping may have just changed, so every cached row
	// describes a question that is no longer being asked. `rerun` decides whether the Tables statement runs
	// again right now or on the next connection.
	async saveSavedImport(options: SqlSchemaImports.LoadOptions, request: SqlSchemaImports.SaveRequest): Promise<SqlSchemaImports.SaveOutcome> {
		for(let statement of request.statements) {
			let violation = SqlImportValidator.check(statement.sql);

			if(violation) {
				return {saved: false, message: `The ${getSqlImportSection(statement.section).label} statement ${violation.reason}`};
			}
		}

		let config = buildSqlImportConfig({
			importId: request.importId,
			name: request.name,
			statements: request.statements,
			mappings: request.mappings,
			resultColumns: request.resultColumns
		});

		if(StringUtils.isBlank(config.tables.sql)) {
			return {saved: false, message: 'A Tables statement is required.'};
		}

		await this.saveImport(config, request.connectionIds);

		let host = await this.getHost(options);

		if(host) {
			this.hostRuns.delete(SqlSchemaImports.hostRunKey(host, request.importId));
			this.registry.get(host)?.get(request.importId)?.sections.clear();
		}

		this.resetImport(request.importId);

		if(request.rerun) {
			await this.applySavedImport(options, <string>host, config);
		}

		return {saved: true};
	}

	// Deleting a saved import, as opposed to removing the data it produced: the settings entry goes, every
	// connection that linked it is unlinked, and the data it put in the tree goes with it. The only way
	// back is to import it again, which is why every caller confirms first.
	async deleteSavedImport(importId: string): Promise<void> {
		await this.extension.configurations.setSqlImports(this.extension.configurations.sqlImports.filter(entry => entry.id !== importId));
		await this.extension.configurations.setConnections(linkSqlImportToConnections(this.extension.configurations.connections, importId, []));

		for(let byImportId of this.registry.values()) {
			let entry = byImportId.get(importId);

			for(let configId of entry?.configIds ?? []) {
				this.extension.schemaTrees.removeImport(configId, importId);
			}

			byImportId.delete(importId);
		}

		for(let key of Array.from(this.hostRuns.keys())) {
			if(key.endsWith(`|${importId}`)) {
				this.hostRuns.delete(key);
			}
		}

		this.resetImport(importId);
	}

	/** True when this import has a settings entry behind it - what makes it editable, refreshable, and
	 * deletable rather than a one-off that only exists until the window closes. */
	isSaved(importId: string): boolean {
		return !!this.getSavedImport(importId);
	}

	// Every connection this saved import is linked to, for the View Imports confirmation: unlinking it
	// from one connection has to be able to say what it stays linked to, and deleting it outright has to
	// say what else it unlinks from. Configured connections rather than open ones, same reasoning as
	// getConnectionTargets - a link is to a connection, not to a session. Empty for an unsaved import,
	// which has no settings entry for anything to link to.
	getLinkedConnections(importId: string, currentConfigId?: string): {id: string; name: string; current: boolean}[] {
		if(!this.isSaved(importId)) {
			return [];
		}

		return this.extension.configurations.connections
			.filter(connection => (connection.sqlImportIds ?? []).includes(importId))
			.map(connection => ({id: connection.id, name: connection.name, current: connection.id === currentConfigId}));
	}

	// Unlinking a saved import from ONE connection, as the View Imports confirmation offers it: the
	// settings entry survives for whatever other connections it is linked to, and only this connection's
	// copy of its data goes. dropImport does the in-memory half; the settings write is the difference
	// between this and dropImport on its own, which is what an unlink means as opposed to a disable.
	async unlinkSavedImport(configId: string, importId: string): Promise<void> {
		let remaining = this.getLinkedConnections(importId).map(connection => connection.id).filter(id => id !== configId);

		await this.extension.configurations.setConnections(linkSqlImportToConnections(this.extension.configurations.connections, importId, remaining));
		this.dropImport(configId, importId);
	}

	// Unlinking an import from a connection (or removing it outright): this connection's copy of its data
	// goes, the settings entry does not. The rows stay cached under the host, so re-linking it costs no
	// query - only the apply step runs again.
	dropImport(configId: string, importId: string): void {
		this.extension.schemaTrees.removeImport(configId, importId);

		for(let byImportId of this.registry.values()) {
			byImportId.get(importId)?.configIds.delete(configId);
		}
	}

	// Runs one saved import for a host (once), then applies its tables to this connection. The run and the
	// apply are deliberately separate: the rows belong to the host, the tree entry belongs to the config.
	private async applySavedImport(options: SqlSchemaImports.LoadOptions, host: string, saved: SqlImportConfig): Promise<void> {
		let key = SqlSchemaImports.hostRunKey(host, saved.id);
		let pending = this.hostRuns.get(key);

		if(!pending) {
			pending = this.runSavedImport(options, host, saved);
			this.hostRuns.set(key, pending);
		}

		let outcome = await pending;

		// A skipped run is not a failed one, so it must not stand in hostRuns as this host's answer: every
		// later connection to the host would reuse it and never run the import. Only this run's own entry
		// is removed - another session may already have started a fresh one under the same key.
		if(!outcome.ran && outcome.skipped && this.hostRuns.get(key) === pending) {
			this.hostRuns.delete(key);
		}

		if(!outcome.ran) {
			return;
		}

		this.registry.get(host)?.get(saved.id)?.configIds.add(options.configId);

		// Every table this run produced, unfiltered. A table the user switched off is held as a disabled
		// entry on SchemaTrees (per connection, cleared by any re-merge) rather than as a removal marker
		// here, so re-applying a run is free to hand over the whole list - applying it is exactly the
		// "genuine re-run" that is meant to bring a disabled table back.
		let tables = outcome.tables;

		await this.extension.schemaTrees.importFromSql({key: options.key, configId: options.configId}, {
			importId: saved.id,
			name: saved.name,
			importedAt: outcome.importedAt,
			tables: tables.map(table => ({
				schema: table.schema,
				name: table.name,
				description: table.description,
				columns: [],
				primaryKeyColumns: [],
				uniqueKeys: [],
				foreignKeys: [],
				indexes: []
			}))
		});
	}

	// The Tables statement of a saved import, run once per host. Only Tables runs here: it defines the
	// universe of tables the import touches and is what the tree needs immediately, while Columns and
	// Relationships stay lazy, per table, exactly as they are for an import made through the dialog.
	//
	// A failure leaves whatever is already loaded alone and warns - the connection is perfectly usable
	// without the import, and re-running a statement that just failed on every subsequent connect would
	// turn one bad entry into a notification on a loop.
	private async runSavedImport(options: SqlSchemaImports.LoadOptions, host: string, saved: SqlImportConfig): Promise<SqlSchemaImports.HostRunOutcome> {
		let violation = SqlImportValidator.check(saved.tables.sql);

		if(violation) {
			// The read-only check runs again here, not just when the import was saved: settings.json can
			// have been edited by hand since, and this statement is about to run with the user's credentials.
			AlertUtils.onWarning(`The "${saved.name}" SQL import was not run: its Tables statement ${violation.reason} Fix it in db2-workbench.sqlImports.`);
			return {ran: false};
		}

		let rowLimit = this.extension.configurations.sqlImportRowLimit;
		let error: unknown;

		let result = await this.extension.connections.internalQuery({
			key: options.key,
			configId: options.configId,
			sql: buildSqlImportStatement(saved.tables.sql, {rowLimit: rowLimit + 1}),
			progressMessage: `Running the "${saved.name}" schema import...`,
			onError: caught => error = caught
		});

		// Nothing ran: the session closed while this was waiting its turn, and DbConnections declines to
		// reopen a closed session (see its closedKeys). Not a failure, so no warning - there is nothing in
		// the History tab to point at - and no remembered outcome (see applySavedImport).
		if(!error && !result && !this.extension.connections.hasActiveConnection(options.key)) {
			return {ran: false, skipped: true};
		}

		if(error || !result) {
			// Deliberately short: the failing statement, its full driver error and its SQL are all in the
			// History tab already (every internal query fires a RESULT/ERROR event - see
			// DbConnections.internalQuery), and a driver message pasted into a notification is unreadable.
			AlertUtils.onWarning(`The "${saved.name}" SQL import failed. See the History tab for details.`);
			return {ran: false};
		}

		let resultColumns = (result.columns ?? []).map(column => column.name);
		let drift = checkSqlImportMappingDrift('tables', saved.tables.mapping, resultColumns);

		// A required field whose column has vanished makes the whole import wrong, not merely thinner, so it
		// is not applied at all and whatever was already loaded stays as it was. An optional one is dropped
		// and reported.
		if(drift.missingRequired.length > 0) {
			AlertUtils.onWarning(`The "${saved.name}" SQL import was not applied: its Tables statement no longer returns ${drift.missingRequired.join(', ')}. Edit the import to remap it.`);
			return {ran: false};
		}

		if(drift.missingOptional.length > 0) {
			AlertUtils.onWarning(`The "${saved.name}" SQL import no longer returns ${drift.missingOptional.join(', ')}, so those fields were left empty. Edit the import to remap them.`);
		}

		let rows = <SqlImportRow[]>Array.from(result);

		if(rows.length > rowLimit) {
			AlertUtils.onWarning(`The "${saved.name}" SQL import returned more than ${rowLimit} tables, so only the first ${rowLimit} were kept. Narrow the statement, or raise db2-workbench.sqlImportRowLimit.`);
			rows = rows.slice(0, rowLimit);
		}

		let converted = convertSqlImportTableRows(rows, saved.tables.mapping);
		let importedAt = new Date().toISOString();

		// A re-run replaces this import's own rows: its previously cached per-table sections describe the
		// old result.
		this.resetImport(saved.id);
		this.register(host, {
			importId: saved.id,
			name: saved.name,
			importedAt: importedAt,
			configIds: new Set(),
			tableKeys: new Set(converted.tables.map(table => sqlImportTableKey(table.schema, table.name))),
			sections: SqlSchemaImports.toRegisteredSections(saved),
			seeded: new Set()
		});

		return {ran: true, tables: converted.tables, importedAt: importedAt};
	}

	// Writes the settings entry and points the chosen connections at it. Both halves are settings writes,
	// and the link deliberately lives on the connection (see ConnectionConfig.sqlImportIds) so "which
	// connections use this import" is always derived rather than stored twice.
	private async saveImport(config: SqlImportConfig, connectionIds: string[]): Promise<void> {
		let saved = this.extension.configurations.sqlImports.filter(entry => entry.id !== config.id);
		await this.extension.configurations.setSqlImports([...saved, config]);

		await this.extension.configurations.setConnections(linkSqlImportToConnections(this.extension.configurations.connections, config.id, connectionIds));
	}

	private register(host: string, entry: SqlSchemaImports.RegisteredImport): void {
		let byImportId = this.registry.get(host) ?? new Map<string, SqlSchemaImports.RegisteredImport>();

		this.registry.set(host, byImportId);

		// A re-run replaces what the import CONTAINS, never which connections it reached: those were linked
		// by the user, and a second connection on this host that already applied the previous run would
		// otherwise stop being served by it.
		for(let configId of byImportId.get(entry.importId)?.configIds ?? []) {
			entry.configIds.add(configId);
		}

		byImportId.set(entry.importId, entry);
	}

	/** Forgets everything loaded for one import, on every host - what a re-run replaces. */
	private resetImport(importId: string): void {
		this.deleteFragmentsMatching(key => key.includes(`|${importId}|`));

		for(let marker of Array.from(this.warned)) {
			if(marker.startsWith(`${importId}|`)) {
				this.warned.delete(marker);
			}
		}
	}

	// What a table carries from every SQL import linked to this connection - the read side of the
	// fragment cache. Batched on purpose: the diagram resolves a whole canvas of tables at once, and one
	// query per table would be one query per box.
	async getTableFragments(options: SqlSchemaImports.LoadOptions, tables: SqlImportTableRef[]): Promise<Map<string, SqlImportTableFragment[]>> {
		let byTableKey = new Map<string, SqlImportTableFragment[]>();

		if(tables.length === 0 || this.registry.size === 0) {
			return byTableKey;
		}

		let host = await this.getHost(options);
		let entries = host ? Array.from(this.registry.get(host)?.values() ?? []).filter(entry => entry.configIds.has(options.configId)) : [];

		if(entries.length === 0) {
			return byTableKey;
		}

		for(let entry of entries) {
			await this.ensureSectionsLoaded(options, <string>host, entry, tables);

			for(let table of tables) {
				let fragment = this.readFragment(<string>host, entry, table);

				if(fragment) {
					let existing = byTableKey.get(sqlImportTableKey(table.schema, table.table)) ?? [];
					existing.push(fragment);
					byTableKey.set(sqlImportTableKey(table.schema, table.table), existing);
				}
			}
		}

		return byTableKey;
	}

	// A run's rows are only needed between the dialog's two steps, so they're dropped as soon as the
	// import lands or the dialog is closed - nothing here is a cache.
	discardRun(runId: string): void {
		this.runs.delete(runId);
	}

	// Everything cached for one host, dropped when its last session closes - the same rule
	// MemoryCache.deleteConnectionCache follows, so a reconnect re-runs rather than showing rows from a
	// database that may have changed underneath. Takes the host rather than a connection, because the
	// caller (DbConnections.close) has already torn the connection down by the time it gets here.
	deleteHostCache(host: string): void {
		this.deleteFragmentsMatching(key => key.startsWith(`${host.toUpperCase()}|`));

		// The auto-run guard goes with the rows it stands for, so the next connection to this host runs the
		// saved imports again rather than reusing a result from a session that has since ended.
		for(let key of Array.from(this.hostRuns.keys())) {
			if(key.startsWith(`${host.toUpperCase()}|`)) {
				this.hostRuns.delete(key);
			}
		}

		// The rows go, the definitions stay. SchemaTrees keeps this session's imported tables across a
		// disconnect, so an import whose definition was dropped here would come back as a table that has
		// lost its columns and relationships for good; keeping it means the next connection loads them
		// again, per table, like any import that has never been loaded. `seeded` is cleared for the same
		// reason - the rows it stood for are gone, so those sections are queryable again.
		for(let entry of this.registry.get(host)?.values() ?? []) {
			entry.seeded.clear();
		}
	}

	/** Every SQL import currently registered for a connection - what a caller with only a config id (the
	 * tree store's own key) needs before it can name import ids. */
	getImportIds(configId: string): string[] {
		let importIds: string[] = [];

		for(let byImportId of this.registry.values()) {
			for(let entry of byImportId.values()) {
				if(entry.configIds.has(configId)) {
					importIds.push(entry.importId);
				}
			}
		}

		return importIds;
	}

	// Runs whichever of an import's lazy sections still have tables nobody has loaded yet. A section
	// whose rows were converted in full at import time is already complete, so a table missing from it
	// genuinely has nothing - it's cached empty rather than queried.
	private async ensureSectionsLoaded(options: SqlSchemaImports.LoadOptions, host: string, entry: SqlSchemaImports.RegisteredImport, tables: SqlImportTableRef[]): Promise<void> {
		for(let [section, config] of entry.sections) {
			let pending = tables.filter(table => !this.fragments.has(sqlImportFragmentKey(host, entry.importId, section, table.schema, table.table)));

			if(pending.length === 0) {
				continue;
			}

			if(entry.seeded.has(section)) {
				pending.forEach(table => this.writeFragment(host, entry.importId, section, table, {columns: [], primaryKeyColumns: [], foreignKeys: []}));
				continue;
			}

			await this.loadSection(options, host, entry, section, config, pending);
		}
	}

	// One section's rows for however many tables are missing, in a single query - the user statement
	// wrapped as a derived table and filtered with an OR chain on schema + table (see
	// buildSqlImportStatement). Relationships filter on the child side only, matching how
	// MemoryCache.getForeignKeys works for real DB2 data.
	//
	// A failure here never clears what is already loaded and never fails the tab: the table still has
	// everything DB2 says about it, and the import simply contributes nothing this time. Nothing is
	// cached either, so the next open retries.
	private async loadSection(
		options: SqlSchemaImports.LoadOptions,
		host: string,
		entry: SqlSchemaImports.RegisteredImport,
		section: SqlImportSectionId,
		config: SqlSchemaImports.RegisteredSection,
		tables: SqlImportTableRef[]
	): Promise<void> {
		let filterColumns = getSqlImportFilterColumns(section, config.mapping);

		if(!filterColumns) {
			return;
		}

		// Re-validated at run time, not just when the statement was first entered - a saved import's SQL
		// can have been hand-edited in settings.json since (see the plan's read-only enforcement).
		let violation = SqlImportValidator.check(config.sql);

		if(violation) {
			this.warnOnce(entry, section, `The ${getSqlImportSection(section).label} statement for the "${entry.name}" import was rejected: ${violation.reason}`);
			return;
		}

		let rowLimit = this.extension.configurations.sqlImportRowLimit;
		let error: unknown;

		let result = await this.extension.connections.internalQuery({
			key: options.key,
			configId: options.configId,
			sql: buildSqlImportStatement(config.sql, {
				filter: {schemaColumn: filterColumns.schemaColumn, tableColumn: filterColumns.tableColumn, tables: tables},
				rowLimit: rowLimit + 1
			}),
			progressMessage: `Loading imported ${getSqlImportSection(section).label.toLowerCase()}...`,
			onError: caught => error = caught
		});

		if(error || !result) {
			// Same reasoning as runSavedImport's failure warning - the detail is in the History tab.
			this.warnOnce(entry, section, `The ${getSqlImportSection(section).label} statement for the "${entry.name}" import failed. See the History tab for details.`);
			return;
		}

		let rows = <SqlImportRow[]>Array.from(result);

		if(rows.length > rowLimit) {
			this.warnOnce(entry, section, `The ${getSqlImportSection(section).label} statement for the "${entry.name}" import returned more than ${rowLimit} rows for one batch of tables - some imported data was dropped.`);
			rows = rows.slice(0, rowLimit);
		}

		let requestedKeys = new Set(tables.map(table => sqlImportTableKey(table.schema, table.table)));
		let knownTables = await this.getKnownTables(options, new Set([...entry.tableKeys, ...requestedKeys]));

		// Every requested table is written, including the ones the rows said nothing about - an entry
		// that stays absent would be re-queried on every open.
		for(let table of tables) {
			this.writeFragment(host, entry.importId, section, table, {columns: [], primaryKeyColumns: [], foreignKeys: []});
		}

		if(section === 'columns') {
			let columnRows = convertSqlImportColumnRows(rows, config.mapping, knownTables);

			for(let table of tables) {
				let key = sqlImportTableKey(table.schema, table.table);

				this.writeFragment(host, entry.importId, section, table, {
					columns: columnRows.columns.get(key) ?? [],
					primaryKeyColumns: columnRows.primaryKeyColumns.get(key) ?? [],
					foreignKeys: []
				});
			}

			return;
		}

		let relationshipRows = convertSqlImportRelationshipRows(rows, config.mapping, knownTables);

		for(let table of tables) {
			this.writeFragment(host, entry.importId, section, table, {
				columns: [],
				primaryKeyColumns: [],
				foreignKeys: relationshipRows.foreignKeys.get(sqlImportTableKey(table.schema, table.table)) ?? []
			});
		}
	}

	// Converts a whole run's Columns and Relationships rows at import time and writes one cache entry per
	// table they mention, so nothing has to be queried again for an import made through the dialog. The
	// section is then marked seeded: a table it never mentioned has nothing, rather than being unloaded.
	private seedFragments(options: SqlSchemaImports.SeedOptions): SqlImportSectionSummary[] {
		let summaries: SqlImportSectionSummary[] = [];

		for(let section of SQL_IMPORT_SECTIONS) {
			if(section.id === 'tables' || !options.rows.has(section.id)) {
				continue;
			}

			let rows = options.rows.get(section.id) ?? [];
			let mapping = options.mappings[section.id] ?? {};
			let stats: SqlImportSectionStats;

			if(section.id === 'columns') {
				let converted = convertSqlImportColumnRows(rows, mapping, options.knownTables);
				stats = converted.stats;

				for(let [tableKey, columns] of converted.columns) {
					this.seedFragment(options, section.id, tableKey, {columns: columns, primaryKeyColumns: converted.primaryKeyColumns.get(tableKey) ?? [], foreignKeys: []});
				}
			} else {
				let converted = convertSqlImportRelationshipRows(rows, mapping, options.knownTables);
				stats = converted.stats;

				for(let [tableKey, foreignKeys] of converted.foreignKeys) {
					this.seedFragment(options, section.id, tableKey, {columns: [], primaryKeyColumns: [], foreignKeys: foreignKeys});
				}
			}

			options.entry.seeded.add(section.id);
			summaries.push({...stats, applied: true});
		}

		return summaries;
	}

	// A seeded fragment is keyed by the table key the converter produced, which is all a converted result
	// carries - the schema and table are split back out of it so the cache key is built the same way a
	// lazily loaded one is.
	private seedFragment(options: SqlSchemaImports.SeedOptions, section: SqlImportSectionId, tableKey: string, fragment: SqlSchemaImports.SectionFragment): void {
		if(!options.host) {
			return;
		}

		let separator = tableKey.indexOf('.');

		if(separator === -1) {
			return;
		}

		this.writeFragment(options.host, options.entry.importId, section, {schema: tableKey.substring(0, separator), table: tableKey.substring(separator + 1)}, fragment);
	}

	private writeFragment(host: string, importId: string, section: SqlImportSectionId, table: SqlImportTableRef, fragment: SqlSchemaImports.SectionFragment): void {
		this.fragments.set(sqlImportFragmentKey(host, importId, section, table.schema, table.table), fragment);
	}

	// One import's whole contribution to one table, assembled from its per-section cache entries. Returns
	// undefined when neither section has anything for it, so a table with nothing imported doesn't get an
	// empty fragment (which mergeSqlImportFragments would have to filter out again).
	private readFragment(host: string, entry: SqlSchemaImports.RegisteredImport, table: SqlImportTableRef): SqlImportTableFragment | undefined {
		let columns = this.fragments.get(sqlImportFragmentKey(host, entry.importId, 'columns', table.schema, table.table));
		let relationships = this.fragments.get(sqlImportFragmentKey(host, entry.importId, 'relationships', table.schema, table.table));

		if(!columns && !relationships) {
			return undefined;
		}

		return {
			importId: entry.importId,
			importName: entry.name,
			importedAt: entry.importedAt,
			schema: table.schema,
			table: table.table,
			columns: columns?.columns ?? [],
			primaryKeyColumns: columns?.primaryKeyColumns ?? [],
			foreignKeys: relationships?.foreignKeys ?? []
		};
	}

	// Every table the converter is allowed to attach a row to: the import's own Tables statement plus
	// whatever DB2 itself has. getTables() is the eager, already-cached library-list scan the schema tree
	// is built from, so this costs nothing beyond the first call for a connection.
	private async getKnownTables(options: SqlSchemaImports.LoadOptions, importTableKeys: Set<string>): Promise<Set<string>> {
		let known = new Set(importTableKeys);
		let tables = await this.extension.memoryCache.getTables({key: options.key, configId: options.configId});

		for(let table of tables) {
			known.add(sqlImportTableKey(table.schema, table.name));
		}

		return known;
	}

	private async getHost(options: SqlSchemaImports.LoadOptions): Promise<string | undefined> {
		let config = await this.extension.connections.getConnectionConfig({key: options.key, configId: options.configId});
		return StringUtils.isNotBlank(config?.host) ? <string>config?.host : undefined;
	}

	private deleteFragmentsMatching(matches: (key: string) => boolean): void {
		for(let key of Array.from(this.fragments.keys())) {
			if(matches(key)) {
				this.fragments.delete(key);
			}
		}
	}

	// Once per import per section: a statement that fails for one table almost always fails for the next
	// one too, and the tabs keep working regardless, so repeating the same notification every time a table
	// is opened would be noise rather than news.
	private warnOnce(entry: SqlSchemaImports.RegisteredImport, section: SqlImportSectionId, message: string): void {
		let key = `${entry.importId}|${section}`;

		if(this.warned.has(key)) {
			return;
		}

		this.warned.add(key);
		AlertUtils.onWarning(message);
	}

	private static hostRunKey(host: string, importId: string): string {
		return `${host.toUpperCase()}|${importId}`;
	}

	// What a run's statements and the mapping the user built become as a settings entry. The recorded
	// result columns come from the run itself, so a later run can report a mapped column that has since
	// vanished rather than silently dropping the field it fed.
	private static toSavedConfig(importId: string, name: string, run: SqlSchemaImports.Run, mappings: SqlImportMappings): SqlImportConfig {
		return buildSqlImportConfig({
			importId: importId,
			name: name,
			statements: run.statements,
			mappings: mappings,
			resultColumns: Object.fromEntries(run.resultColumns)
		});
	}

	/** A saved import's lazily loaded sections, in the shape the per-table loader takes. */
	private static toRegisteredSections(saved: SqlImportConfig): Map<SqlImportSectionId, SqlSchemaImports.RegisteredSection> {
		let sections = new Map<SqlImportSectionId, SqlSchemaImports.RegisteredSection>();

		for(let section of (['columns', 'relationships'] as const)) {
			let config = getSqlImportSectionConfig(saved, section);

			if(config && StringUtils.isNotBlank(config.sql)) {
				sections.set(section, {sql: config.sql, mapping: config.mapping});
			}
		}

		return sections;
	}

	private static importIdOf(fragmentKey: string): string {
		return fragmentKey.split('|')[1] ?? '';
	}

	// Every required target of every section that actually ran has to be mapped. Reported by label
	// ("Tables: Schema") rather than as a disabled button with no explanation - see the plan's UI notes.
	private static findUnmappedRequiredTargets(mappings: SqlImportMappings, rows: Map<SqlImportSectionId, SqlImportRow[]>): string[] {
		let missing: string[] = [];

		for(let section of SQL_IMPORT_SECTIONS) {
			if(!rows.has(section.id)) {
				continue;
			}

			let mapped = invertSqlImportMapping(mappings[section.id] ?? {});

			for(let target of section.targets) {
				if(target.required && !mapped.has(target.id)) {
					missing.push(`${section.label}: ${target.label}`);
				}
			}
		}

		return missing;
	}

	// Two result columns mapped to the same target, reported by label the same way an unmapped required
	// field is. Only sections that actually ran are checked - a mapping left over for a statement the
	// user has since emptied says nothing about what is being imported.
	private static findDuplicateTargets(mappings: SqlImportMappings, rows: Map<SqlImportSectionId, SqlImportRow[]>): string[] {
		let duplicates: string[] = [];

		for(let section of SQL_IMPORT_SECTIONS) {
			if(!rows.has(section.id)) {
				continue;
			}

			let seen = new Set<string>();

			for(let target of Object.values(mappings[section.id] ?? {})) {
				if(seen.has(target)) {
					let label = section.targets.find(candidate => candidate.id === target)?.label ?? target;
					duplicates.push(`${section.label}: ${label}`);
				}

				seen.add(target);
			}
		}

		return duplicates;
	}

	// The mapping step shows a few real rows so a reversed child/parent mapping is obvious before the
	// import runs. Values are stringified here rather than in the webview: a raw row can carry a Date or
	// a Buffer, neither of which survives postMessage as anything a table cell can render.
	private static toSampleRows(rows: SqlImportRow[], resultColumns: string[]): Record<string, string>[] {
		return rows.slice(0, SqlSchemaImports.SAMPLE_ROW_COUNT).map(row => {
			let sample: Record<string, string> = {};

			for(let column of resultColumns) {
				let value = row[column];
				sample[column] = value === null || value === undefined ? '' : String(value).trim();
			}

			return sample;
		});
	}

	private static readonly SAMPLE_ROW_COUNT = 5;
}

export namespace SqlSchemaImports {
	// A run's rows, held between the dialog's two steps and nothing more - see discardRun.
	export interface Run {
		key: string;
		configId: string;
		statements: SqlImportStatementInput[];
		rows: Map<SqlImportSectionId, SqlImportRow[]>;
		/** Each section's result column names, in result-set order - see Run's use in toSavedConfig. */
		resultColumns: Map<SqlImportSectionId, string[]>;
	}

	// What one saved import's Tables statement produced for one host. A failed run is a value, not a
	// rejection: it is remembered so the statement isn't re-run on every connection to the same host.
	// A skipped run - the session closed before the statement could run - is the exception, and is not
	// remembered (see applySavedImport).
	export type HostRunOutcome =
		| {ran: false; skipped?: boolean}
		| {ran: true; tables: SqlImportTable[]; importedAt: string};

	export interface RunOptions {
		key: string;
		configId: string;
		statements: SqlImportStatementInput[];
	}

	export interface ImportOptions {
		runId: string;
		name: string;
		mappings: SqlImportMappings;
		/** Writes this import to db2-workbench.sqlImports so it re-runs on connect. Its settings entry id
		 * IS its importId, which is what makes a re-run replace its own rows in place. */
		save?: boolean;
		/** Which connections the saved import is linked to. Defaults to the one it was imported from. */
		connectionIds?: string[];
	}

	export interface LoadOptions {
		key: string;
		configId: string;
	}

	// The edit dialog's Save. `resultColumns` is what the statements returned the last time they ran - the
	// dialog sends back whatever it has (the recorded set when nothing was re-run, the fresh set when it
	// was), so a saved mapping always has something to be reported as drifted against.
	export interface SaveRequest {
		importId: string;
		name: string;
		statements: SqlImportStatementInput[];
		mappings: SqlImportMappings;
		resultColumns: Partial<Record<SqlImportSectionId, string[]>>;
		connectionIds: string[];
		/** Run the Tables statement now rather than on the next connection - "Save & Re-run". */
		rerun: boolean;
	}

	export type SaveOutcome = {saved: true} | {saved: false; message: string};

	/** One lazily loaded section's statement and mapping, kept so it can be re-run for a table nobody has
	 * asked for yet. */
	export interface RegisteredSection {
		sql: string;
		mapping: Record<string, SqlImportTarget>;
	}

	// What an import is once it has landed: enough to run its lazy sections again, and to know which
	// connections it applies to. P4 adds saved imports to this same registry on connect; the shape is the
	// same whether an import came from the dialog or from settings.
	export interface RegisteredImport {
		importId: string;
		name: string;
		importedAt: string;
		configIds: Set<string>;
		/** Keyed by sqlImportTableKey - the tables the import's own Tables statement returned. */
		tableKeys: Set<string>;
		sections: Map<SqlImportSectionId, RegisteredSection>;
		/** Sections whose rows were converted in full at import time, so nothing is left to query. */
		seeded: Set<SqlImportSectionId>;
	}

	// One (import, section, table) cache entry. Both shapes share one type rather than being a union: the
	// section is already in the key, and a reader wants a table's whole contribution anyway.
	export interface SectionFragment {
		columns: ImportedColumn[];
		primaryKeyColumns: string[];
		foreignKeys: ImportedForeignKey[];
	}

	export interface SeedOptions {
		host: string | undefined;
		entry: RegisteredImport;
		rows: Map<SqlImportSectionId, SqlImportRow[]>;
		mappings: SqlImportMappings;
		knownTables: Set<string>;
	}
}
