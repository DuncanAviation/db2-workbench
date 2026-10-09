import { Nullable } from '../utils/nullable.js';
import { StringUtils } from '../utils/string-utils.js';
import { NO_SCHEMA_BUCKET, SchemaImportEntry, SchemaImportSummary } from '../webview-messages/schemas-messages.js';
import { ImportedTableSchema } from './schema-format-converter.js';

// The batch view of the flat per-connection imported-table store SchemaTrees keeps, plus the matching rule
// removal uses. Pure and vscode-free (unlike SchemaTrees itself, which owns the store, the file dialogs and
// the event bus) so both rules can be unit tested - see import-groups.spec.ts.

// Rebuilds the batch structure the store deliberately doesn't keep: tables are grouped by
// provenance.importId, batches come back in the order they were first seen (i.e. import order, since a
// batch's tables are appended together) and each table keeps its import order within its batch.
export function groupImports(tables: ImportedTableSchema[], disabledKeys: ReadonlySet<string> = new Set()): SchemaImportSummary[] {
	let summaries = new Map<string, SchemaImportSummary>();

	for(let table of tables) {
		let summary = summaries.get(table.provenance.importId);

		if(!summary) {
			summary = {
				importId: table.provenance.importId,
				sourceLabel: table.provenance.sourceLabel,
				sourceFormat: table.provenance.sourceFormat,
				importedAt: table.provenance.importedAt,
				tables: []
			};

			summaries.set(table.provenance.importId, summary);
		}

		// NO_SCHEMA_BUCKET rather than undefined, so the dialog names a schema-less table exactly the way the
		// tree buckets it - and so the entry it later sends back for removal matches what matchesImportEntry
		// below compares against.
		//
		// `enabled` is what the View Imports dialog's checkboxes bind to: the dialog shows what is currently
		// applied rather than an empty selection, so a disabled table has to come through the grouping
		// rather than being filtered out of it (see SchemaTrees.getAllImportedTables, which is what feeds
		// this - the ordinary getImportedTables already hides disabled rows from every other consumer).
		summary.tables.push({
			schema: table.schema ?? NO_SCHEMA_BUCKET,
			table: table.name,
			enabled: !disabledKeys.has(importedTableKey(table))
		});
	}

	return [...summaries.values()];
}

// The disabled-set key for one table of one import. Upper-cased on both halves so the set matches the
// case-insensitive comparisons the rest of the import code uses (matchesImportEntry below,
// SchemaTrees.getImportedTablesFor), and NO_SCHEMA_BUCKET for a schema-less import for the same reason
// groupImports uses it - the sentinel IS the schema name everywhere else.
export function importEntryKey(importId: string, schema: Nullable<string>, table: string): string {
	return `${importId}|${(schema ?? NO_SCHEMA_BUCKET).toUpperCase()}|${table.toUpperCase()}`;
}

/** importEntryKey for a stored table, which carries its import id on its provenance. */
export function importedTableKey(table: ImportedTableSchema): string {
	return importEntryKey(table.provenance.importId, table.schema, table.name);
}

/** importEntryKey for an entry as the webviews send it, where the schema is already the bucket name. */
export function importEntryKeyOf(entry: SchemaImportEntry): string {
	return importEntryKey(entry.importId, entry.schema, entry.table);
}

// The imports an apply leaves with nothing applied at all - every table they contributed ends up
// disabled. Computed against the OUTCOME of the apply rather than against its `disable` list alone: a
// table that was already disabled before this apply still counts, unless this same apply is turning it
// back on. Only these imports can be unlinked or deleted - one that keeps even a single table applied is
// still doing something. The View Imports dialog's delete button disables an import's tables as part of
// the same apply for exactly this reason; the two functions below re-derive it host-side rather than
// taking the webview's id list on trust.
export function findFullyDisabledImports(summaries: SchemaImportSummary[], disable: SchemaImportEntry[], enable: SchemaImportEntry[]): SchemaImportSummary[] {
	return summaries.filter(summary => summary.tables.length > 0 && summary.tables.every(table => {
		let matches = (entry: SchemaImportEntry) => entry.importId === summary.importId
			&& StringUtils.equalsIgnoreCase(entry.schema, table.schema)
			&& StringUtils.equalsIgnoreCase(entry.table, table.table);

		return disable.some(matches) || (!table.enabled && !enable.some(matches));
	}));
}

// Which of the imports an apply asked to unlink from this connection may actually be unlinked: only ones
// this apply leaves fully disabled, and only saved ones (nothing else has a settings entry to stay behind
// for another connection). The webview's radio decides whether to ask, and this decides whether the ask is
// honoured - the host never acts on a webview's word alone, since the list it was chosen against can have
// moved on by the time the message arrives.
export function findImportsToUnlink(summaries: SchemaImportSummary[], disable: SchemaImportEntry[], enable: SchemaImportEntry[], requestedImportIds: string[]): SchemaImportSummary[] {
	return findFullyDisabledImports(summaries, disable, enable).filter(summary => summary.saved && requestedImportIds.includes(summary.importId));
}

// Which of the imports an apply asked to delete outright may actually be deleted. Same re-derivation as
// findImportsToUnlink, but not saved-only: deleting an unsaved import just drops the rows nothing else
// holds a copy of, while deleting a saved one also takes its settings entry.
export function findImportsToDelete(summaries: SchemaImportSummary[], disable: SchemaImportEntry[], enable: SchemaImportEntry[], requestedImportIds: string[]): SchemaImportSummary[] {
	return findFullyDisabledImports(summaries, disable, enable).filter(summary => requestedImportIds.includes(summary.importId));
}
