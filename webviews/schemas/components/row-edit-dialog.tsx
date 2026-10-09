import { useEffect, useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, Stack } from '@mui/material';
import type { SystemColumn } from '../../../src/models/system-column';
import { ColumnNameUtils } from '../../../src/utils/column-name-utils';
import { FieldUtils } from '../../../src/utils/field-utils';
import type { RowFieldValue, RowKeyValue, RowValue } from '../../../src/utils/row-edit-utils';
import { RowEditUtils } from '../../../src/utils/row-edit-utils';
import { FieldInput } from '../../shared/components/field-input';
import type { PendingDataStatement } from '../pending-statement';
import { newPendingStatement } from '../pending-statement';

interface Props {
	open: boolean;
	mode: 'add' | 'edit';
	table: { schema: string; name: string };
	columns: SystemColumn[];
	/** Keyed by systemName - same Short Name/Long Name/Description preference order (and the same
	 * lookup) the grid's own column headers use, so a field's label here matches what the user sees
	 * on that same column elsewhere: every configured label, joined with " / " on one line (as the search dialog does) where the grid
	 * header stacks them. See ColumnNameUtils.buildLabelMap/SchemasProvider.postTableData. */
	columnLabels: Record<string, string[]>;
	keyColumns: Array<{ systemName: string; isRrn: boolean }>;
	/** Edit mode only - the row's real key values (for the WHERE clause and re-matching). */
	keyValues?: Record<string, RowValue>;
	/** Add: all NULL (empty). Edit: the row's current values, already overlaid with any pending edit - what
	 * the form is pre-filled with and what the dirty-check/"still NULL" comparisons use. */
	initialValues: Record<string, RowValue>;
	/** Edit mode only - the row's real fetched values, never overlaid with a pending edit. Submitting
	 * diffs against this (not initialValues) so a column changed in an earlier session (dialog or
	 * inline) that the user doesn't touch again this time still makes it into the resubmitted
	 * statement, instead of being silently dropped because it no longer differs from initialValues. */
	originalValues?: Record<string, RowValue>;
	/** Set when a pending statement already exists for this row/insert - upsert replaces it in place
	 * instead of creating a second one. */
	existingStatementId?: string;
	onCancel: () => void;
	onSubmit: (statement: PendingDataStatement) => void;
	/** Edit mode only - called (with existingStatementId) instead of onSubmit, and the dialog closes the
	 * same way it would via Cancel, when every field has been changed back to its real fetched value:
	 * same "only keep what actually changed" rule inline editing already follows. Without this, "Add to
	 * Run" would happily upsert a same-as-the-database update statement - syntactically a no-op run,
	 * not a genuine edit - instead of removing the pending statement the way reverting it inline does. */
	onDelete: (id: string) => void;
}

// Applied uniformly with inline grid editing (TableDataTab) - LOB and identity columns are never
// editable or insertable (DB2 assigns identity values; LOB columns are display-only everywhere in
// this tab). A real (non-identity) key column - primary key or otherwise - stays editable once a row
// already exists: the WHERE clause is built from the row's original key values (captured once, before
// any edit - see TableDataTab), not re-derived from whatever the field currently shows, so changing a
// key column's value here is just an ordinary UPDATE ... SET key_col = <new>. updatable === 'NO'
// columns are excluded once a row already exists (that flag is specifically about UPDATE), but still
// fair game on a brand-new row, which needs an explicit value for everything but an identity column.
export function resolveFieldColumns(mode: 'add' | 'edit', columns: SystemColumn[]): SystemColumn[] {
	return columns.filter(column => {
		if (FieldUtils.isLobType(column.dataType) || column.identity === 'YES') {
			return false;
		}

		if (mode === 'edit' && column.updatable === 'NO') {
			return false;
		}

		return true;
	});
}

export function RowEditDialog({ open, mode, table, columns, columnLabels, keyColumns, keyValues, initialValues, originalValues, existingStatementId, onCancel, onSubmit, onDelete }: Props) {
	const [values, setValues] = useState<Record<string, RowValue>>(initialValues);

	// Re-seeds the draft from whatever the row currently shows every time the dialog opens - not tied
	// to initialValues' identity, only to the open transition, so an unrelated parent re-render while
	// open can't clobber an in-progress edit. A row already mid-edit (inline or a previous dialog
	// submit) reopens pre-filled with those current pending values, not the stale original fetch,
	// since initialValues is already overlaid with any pending edit by the caller.
	useEffect(() => {
		if (open) {
			setValues(initialValues);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	let fieldColumns = resolveFieldColumns(mode, columns);

	// FieldInput already sanitizes (and, for a DATE/TIME/TIMESTAMP column, formats a picker selection)
	// before calling this.
	function handleChange(column: SystemColumn, value: RowValue) {
		setValues(current => ({ ...current, [column.systemName]: value }));
	}

	// For Add that's "still all NULL", for Edit that's "still what the row currently shows" - either way,
	// nothing to submit until at least one field actually changed.
	let isDirty = fieldColumns.some(column => (values[column.systemName] ?? null) !== (initialValues[column.systemName] ?? null));

	// Edit mode only - the fields that differ from the row's real fetched value (originalValues), not
	// from initialValues, which is already overlaid with whatever was pending before this dialog opened.
	// Diffing against the true original instead of the session's starting point means a column changed
	// earlier (inline or a prior dialog submit) that isn't touched again this time is still included,
	// rather than dropping out just because it no longer differs from what the form opened with.
	function changedValues(): Record<string, RowValue> {
		let diffBase = originalValues ?? initialValues;
		return Object.fromEntries(fieldColumns
			.filter(column => (values[column.systemName] ?? null) !== (diffBase[column.systemName] ?? null))
			.map(column => [column.systemName, values[column.systemName] ?? null]));
	}

	// Add: every NOT NULL column without a default. Edit: only a NOT NULL column this edit changes - one
	// the row already holds NULL in and the user leaves alone isn't in the UPDATE, so it can't fail it.
	let missingRequired = RowEditUtils.findMissingRequired(mode === 'add' ? 'insert' : 'update', fieldColumns, mode === 'add' ? values : changedValues()).length > 0;

	function buildKeyValues(): RowKeyValue[] {
		return keyColumns.map(key => ({
			systemName: key.systemName,
			isRrn: key.isRrn,
			dataType: key.isRrn ? undefined : columns.find(column => column.systemName === key.systemName)?.dataType,
			value: keyValues?.[key.systemName] ?? null
		}));
	}

	function handleSubmit() {
		// insert: every insertable field's current value. update: only the fields that actually differ
		// from the row's real fetched value - see changedValues.
		let columnValuesRecord = mode === 'add'
			? Object.fromEntries(fieldColumns.map(column => [column.systemName, values[column.systemName] ?? null]))
			: changedValues();

		// Every field's back to what the database actually has - nothing left to run. Remove whatever
		// pending statement got us here instead of upserting one that would just set the row back to
		// its own current values.
		if (mode === 'edit' && Object.keys(columnValuesRecord).length === 0) {
			if (existingStatementId) {
				onDelete(existingStatementId);
			}

			onCancel();
			return;
		}

		let updateValues: RowFieldValue[] = fieldColumns
			.filter(column => column.systemName in columnValuesRecord)
			.map(column => ({ systemName: column.systemName, dataType: column.dataType, value: columnValuesRecord[column.systemName] }));

		let sql = mode === 'add'
			? RowEditUtils.buildInsertSql(table.schema, table.name, RowEditUtils.buildInsertValues(fieldColumns, columnValuesRecord))
			: RowEditUtils.buildUpdateSql(table.schema, table.name, updateValues, buildKeyValues());

		let rowEdit = mode === 'add' ? { columnValues: columnValuesRecord } : { keyValues, columnValues: columnValuesRecord };

		onSubmit(existingStatementId
			? { id: existingStatementId, schema: table.schema, table: table.name, sql, rowEdit }
			: newPendingStatement(table.schema, table.name, sql, rowEdit));
	}

	let keyContextText = mode === 'edit'
		? `Editing row where ${keyColumns.map(key => `${ColumnNameUtils.labelForKey(columnLabels, key.systemName)} = ${keyValues?.[key.systemName] ?? '<null>'}`).join(' and ')}`
		: null;

	return (
		<Dialog open={open} onClose={onCancel} maxWidth="sm" fullWidth>
			<DialogTitle>{mode === 'add' ? 'Add Row' : 'Edit Row'}</DialogTitle>
			<DialogContent>
				{keyContextText && <DialogContentText sx={{ mb: 2 }}>{keyContextText}</DialogContentText>}

				{/*
					mt here (rather than relying on DialogContent's own fixed-pixel top padding) is
					deliberately in "em" units: this app's theme fontSize is read live from
					--vscode-font-size (create-vscode-theme.ts), which can run well above MUI's typical
					default. An outlined TextField's shrunk/focused label floats up by an amount that
					scales with that same font size, so a fixed-pixel gap that's just barely enough at a
					small font size clips the top field's label (behind the DialogTitle) at a larger one -
					every other Dialog with a TextField in this app happens to have something else (a
					Typography, a preceding field) providing that clearance already.
				*/}
				<Stack spacing={2} sx={{ mt: '0.5em' }}>
					{fieldColumns.map(column => {
						let value = values[column.systemName] ?? null;
						// Same rule as missingRequired: a default only stands in for a column an INSERT leaves out.
						let required = mode === 'add' ? RowEditUtils.isRequired(column) : RowEditUtils.isNotNull(column);
						// A new row's column with a table default is left out of the INSERT while NULL, so DB2 fills it - its
						// NULL reads as <default>, and the button that puts it back says so (NOT NULL or not).
						let usesDefault = mode === 'add' && RowEditUtils.hasTableDefault(column);

						return (
							<FieldInput
								key={column.systemName}
								field={column}
								label={ColumnNameUtils.labelsForKey(columnLabels, column.systemName).join(' / ')}
								required={required}
								value={value}
								nullPlaceholder={usesDefault ? '<default>' : undefined}
								onChange={newValue => handleChange(column, newValue)}
								onSetNull={usesDefault || !RowEditUtils.isNotNull(column) ? () => handleChange(column, null) : undefined}
								setNullLabel={usesDefault ? 'Use Table Default' : undefined}
							/>
						);
					})}
				</Stack>
			</DialogContent>
			<DialogActions>
				<Button onClick={onCancel}>Cancel</Button>
				{/* existingStatementId means this row already has a pending statement (Add or Edit alike) -
					submitting here upserts into it rather than creating a second one, so the label says so. */}
				<Button variant="contained" onClick={handleSubmit} disabled={!isDirty || missingRequired}>
					{existingStatementId ? 'Update Run' : 'Add to Run'}
				</Button>
			</DialogActions>
		</Dialog>
	);
}
