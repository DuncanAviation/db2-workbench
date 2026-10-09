import { StringUtils } from '../utils/string-utils.js';

// Which schemas a tree build has to query qsys2.systables for by name, on top of the one eager scan that
// already covers the connection's library list. Pulled out of SchemaTrees.buildTreeState so the rules can
// be unit tested without an extension host - the build itself needs vscode, this decision doesn't.
//
// Two kinds of schema end up here:
//
// - ones the user added by name ("Edit Schema List"), which have always been fetched this way, and
// - ones that only exist because an import named them. An import naming a schema the library list doesn't
//   carry is still very often a REAL schema on this system, so its live tables belong in the tree next to
//   the imported rows rather than the bucket showing imports alone. A name that turns out not to exist
//   comes back with no rows - listTables filters qsys2.systables by name rather than joining the library
//   list - so there is nothing to fail on and nothing to report for a purely external schema name.
//
// Hidden schemas are left out: nothing renders them, so querying them buys nothing until they are unhidden
// (which rebuilds the tree, and fetches them then).
export function findSchemasToFetch(options: SchemaFetchTargets.Options): string[] {
	let candidates = new Set([...options.addedSchemaNames, ...options.importedSchemaNames]
		.filter(name => StringUtils.isNotBlank(name))
		.map(name => name.toUpperCase()));

	return [...candidates]
		.filter(name => !options.libraryListSchemaNames.some(libraryName => StringUtils.equalsIgnoreCase(libraryName, name)))
		.filter(name => !options.hiddenSchemaNames.some(hidden => StringUtils.equalsIgnoreCase(hidden, name)));
}

export namespace SchemaFetchTargets {
	export interface Options {
		/** Schemas the eager, library-list-joined scan already returned tables for. */
		libraryListSchemaNames: string[];
		/** GlobalStates.SchemaListOverrides.added. */
		addedSchemaNames: string[];
		/** Real schema names from this session's APPLIED imports - never the NO_SCHEMA_BUCKET sentinel. */
		importedSchemaNames: string[];
		/** GlobalStates.SchemaListOverrides.hidden. */
		hiddenSchemaNames: string[];
	}
}
