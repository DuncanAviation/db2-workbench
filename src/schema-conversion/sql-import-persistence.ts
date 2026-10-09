import { ConnectionConfig } from '../models/connection-config.js';
import { SqlImportConfig, SqlImportSectionId, SqlImportTarget, SQL_IMPORT_SECTIONS } from '../models/sql-import-config.js';

import { StringUtils } from '../utils/string-utils.js';

// Turning a finished import into what actually gets written to settings, and pointing connections at it.
// A pure module with no VS Code dependency, like the rest of schema-conversion - SqlSchemaImports owns
// the writes themselves.

export interface SqlImportStatementSource {
	section: SqlImportSectionId;
	sql: string;
}

export interface BuildSqlImportConfigOptions {
	/** The settings entry's id IS the import's id: that is what makes a re-run replace its own rows in
	 * place rather than adding a second View Imports entry every time a connection opens. */
	importId: string;
	name: string;
	statements: SqlImportStatementSource[];
	mappings: Partial<Record<SqlImportSectionId, Record<string, SqlImportTarget>>>;
	/** Each section's result column names as the statement actually returned them. */
	resultColumns: Partial<Record<SqlImportSectionId, string[]>>;
}

// A section the user left empty is left out entirely rather than saved as a blank statement, so a saved
// import describes exactly the sections it has. Tables is always present - the dialog can't get this far
// without it - but is still written through the same loop rather than special-cased.
export function buildSqlImportConfig(options: BuildSqlImportConfigOptions): SqlImportConfig {
	let config: SqlImportConfig = {
		id: options.importId,
		name: options.name,
		tables: {sql: '', mapping: {}}
	};

	for(let section of SQL_IMPORT_SECTIONS) {
		let sql = options.statements.find(statement => statement.section === section.id)?.sql;

		if(StringUtils.isBlank(sql)) {
			continue;
		}

		config[section.id] = {
			sql: <string>sql,
			mapping: options.mappings[section.id] ?? {},
			resultColumns: options.resultColumns[section.id] ?? []
		};
	}

	return config;
}

// Applies one import's connection checkbox list to every configured connection at once. Every connection
// is rewritten, not just the checked ones: unchecking is how an import is unlinked, and that only shows up
// as an id MISSING from the list. Other imports' links are left exactly as they were.
export function linkSqlImportToConnections(connections: ConnectionConfig[], importId: string, connectionIds: string[]): ConnectionConfig[] {
	return connections.map(connection => {
		let others = (connection.sqlImportIds ?? []).filter(id => id !== importId);
		let linked = connectionIds.includes(connection.id) ? [...others, importId] : others;

		// An empty list is written as undefined rather than [], so a connection that has never been linked
		// to anything doesn't gain an empty array in settings.json just because some other connection was.
		return linked.length > 0 ? {...connection, sqlImportIds: linked} : {...connection, sqlImportIds: undefined};
	});
}
