import { NO_SCHEMA_BUCKET, TreeTableEntry } from '../../src/webview-messages/schemas-messages';

// Re-exported so this bundle's existing `./table-key` imports keep resolving unchanged now that the
// schema-agnostic half moved to webviews/shared/table-key.ts for the diagram editor to share.
export { buildTableKey, tableKeysEqual, tableKeyToString } from '../shared/table-key';
export type { TableKey } from '../shared/table-key';

import type { TableKey } from '../shared/table-key';

// Every consumer of a TreeTableEntry needs a display schema/name regardless of which side (connected/
// imported) actually has data - connected always wins (it's the real DB2 identity when both exist),
// falling back to the first imported contribution's own schema/name. A schema-less imported entry uses
// the same NO_SCHEMA_BUCKET sentinel the host bucketed it under, so a `loadColumns`-style request built
// from this key matches what SchemasProvider.getImportedTablesFor expects.
//
// Stays here rather than moving to shared/: connected-vs-imported is a schema-browser concept, and the
// shared tree takes a flat SchemaTreeEntry instead so it never has to know about it.
export function getEntryKey(entry: TreeTableEntry): TableKey {
	if(entry.connected) {
		return { schema: entry.connected.schema, table: entry.connected.name };
	}

	let imported = entry.imported?.[0];
	return { schema: imported?.schema ?? NO_SCHEMA_BUCKET, table: imported?.name ?? '' };
}
