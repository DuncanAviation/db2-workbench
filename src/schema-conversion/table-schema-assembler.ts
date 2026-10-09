import { DbConnections } from '../database/db-connections.js';
import { Extension } from '../extension.js';
import { TableSchema } from '../models/table-schema.js';

import { StringUtils } from '../utils/string-utils.js';

export namespace TableSchemaAssembler {
	export interface Options extends DbConnections.CommonListOptions {
		schema: string;
		table: string;
	}
}

// Composes MemoryCache's existing per-entity getters (already cached by connection identity) into one
// TableSchema - no new queries. A plain function rather than a stateful service class since it holds no
// state of its own, just fans out to extension.memoryCache. Returns undefined (rather than throwing)
// when the table doesn't exist in DB2 at all - a table-resolver caller (see table-resolver.ts) needs to
// tell "no connected table" apart from a genuine query failure, since an imported-only table is
// expected to resolve to undefined here, not an error.
export async function assembleTableSchema(extension: Extension, options: TableSchemaAssembler.Options): Promise<TableSchema | undefined> {
	let {schema, table} = options;

	let target = {schema: schema, table: table};

	let [tables, columns, keys, foreignKeys, indexes] = await Promise.all([
		extension.memoryCache.getTables({...options, schema}),
		extension.memoryCache.getColumns({...options, tables: target}),
		extension.memoryCache.getTableKeys({...options, tables: target}),
		extension.memoryCache.getForeignKeys({...options, tables: target}),
		extension.memoryCache.getIndexes({...options, tables: target})
	]);

	let systemTable = tables.find(candidate => StringUtils.equalsIgnoreCase(candidate.name, table));

	if(!systemTable) {
		return undefined;
	}

	return {table: systemTable, columns: columns, keys: keys, foreignKeys: foreignKeys, indexes: indexes};
}
