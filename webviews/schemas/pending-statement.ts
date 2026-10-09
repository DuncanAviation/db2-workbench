import type { RowValue } from '../../src/utils/row-edit-utils';

// schema/table identify which table's Data tab produced a statement - used to route a deletion
// notification back to it (see RunSqlPanel/TableDataTab). Kind is deliberately not stored here -
// StatementParser.StatementKind (src/utils/statement-parser.ts) already classifies a raw SQL string,
// so it's derived on demand wherever it's needed instead of being duplicated and risking drift from
// the actual sql text.
export interface PendingDataStatement {
	id: string;
	schema: string;
	table: string;
	sql: string;
	/** Present only for a row-edit-produced statement (Add/Edit/Delete Row, or inline editing) - never
	 * sent to the host (RunDataEditStatementsMessage only ever carries `statements: string[]`). Lets a
	 * live edit regenerate `sql` in place and lets a freshly-reloaded row be matched back to its own
	 * pending statement. See RowEditPayload. */
	rowEdit?: RowEditPayload;
	/** Why this statement can't run as it stands (e.g. "PARTNO is required") - set by whatever built
	 * it, since only that knows the columns. RunSqlPanel marks the statement and holds Run until none
	 * is left. Rebuilding the statement replaces it, so a fixed value clears its message. */
	validationErrors?: string[];
}

export interface RowEditPayload {
	/** Absent only for a not-yet-run INSERT (no row exists to key off yet). */
	keyValues?: Record<string, RowValue>;
	/** insert: every insertable column's entered value. update: only the columns that actually changed. */
	columnValues: Record<string, RowValue>;
}

let nextId = 0;

export function newPendingStatement(schema: string, table: string, sql: string, rowEdit?: RowEditPayload): PendingDataStatement {
	return { id: `pending-statement-${nextId++}`, schema, table, sql, rowEdit };
}
