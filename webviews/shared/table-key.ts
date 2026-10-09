// The schema/table identity a tree row, tab or detail panel is keyed by. Lives in shared/ because both
// the schema browser and the diagram editor's table picker need it - see shared/components/schema-tree.tsx.
// Deliberately free of any knowledge of where the table came from: getEntryKey (which resolves a
// connected-vs-imported TreeTableEntry) stays in webviews/schemas/table-key.ts, since imports are a
// schema-browser feature and nothing shared should have to know about them.

/** What a key can name besides a table. */
export type TableKeyKind = 'view' | 'function' | 'procedure';

const KIND_PREFIXES: Record<TableKeyKind, string> = {
	view: 'view:',
	function: 'function:',
	procedure: 'procedure:'
};

export interface TableKey {
	schema: string;
	/** For a function or procedure, its specific name - the one name that tells two overloads apart. */
	table: string;
	/** Set only for a view or a routine - any of them can share a name with a table in one schema, and the
	 * schema browser opens each as its own tab, so the kind is part of the identity. Absent means a table,
	 * which keeps every key built before views existed (and every one the diagram builds) meaning what it
	 * always did. */
	kind?: TableKeyKind;
}

export function buildTableKey(schema: string, table: string, kind?: TableKeyKind): TableKey {
	return kind ? { schema, table, kind } : { schema, table };
}

export function tableKeysEqual(a: TableKey, b: TableKey): boolean {
	return a.schema === b.schema && a.table === b.table && a.kind === b.kind;
}

// Tabs/list items need a primitive identity for React's `key` prop (and MUI Tabs' value-matching,
// which compares via `===`) - freshly built TableKey objects aren't reference-equal across renders
// even when they represent the same table, so this string form is what those comparisons use. Also the
// membership form the tree's multi-select mode uses, for the same reason.
//
// A view's or function's form carries a "view:"/"function:" prefix, so it can never equal the
// same-named table's.
export function tableKeyToString(key: TableKey): string {
	let prefix = key.kind ? KIND_PREFIXES[key.kind] : '';
	return `${prefix}${key.schema}/${key.table}`;
}

// The inverse, for a caller holding a set of the string form (the tree's multi-select) that needs the
// schema/table pair back - e.g. to name the tables in a message to the host. Split on the FIRST
// separator only: DB2 object names can't contain "/", but being explicit about it costs nothing and
// makes the round-trip guarantee obvious.
export function tableKeyFromString(value: string): TableKey {
	let kind = (<TableKeyKind[]>Object.keys(KIND_PREFIXES)).find(candidate => value.startsWith(KIND_PREFIXES[candidate]));
	let body = kind ? value.slice(KIND_PREFIXES[kind].length) : value;
	let separator = body.indexOf('/');

	return separator < 0
		? buildTableKey('', body, kind)
		: buildTableKey(body.slice(0, separator), body.slice(separator + 1), kind);
}
