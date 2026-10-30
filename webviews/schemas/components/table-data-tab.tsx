import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Stack, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import type { SxProps, Theme } from '@mui/material/styles';
import type { ColumnDef, OnChangeFn, SortingState, Updater } from '@tanstack/react-table';
import { getCoreRowModel, getFilteredRowModel, useReactTable } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { SystemColumn } from '../../../src/models/system-column';
import type { Row } from '../../../src/interfaces/row';
import type { SchemasInboundMessage } from '../../../src/webview-messages/schemas-messages';
import { ColumnDetailsUtils } from '../../../src/utils/column-details';
import { ColumnNameUtils } from '../../../src/utils/column-name-utils';
import { FieldUtils } from '../../../src/utils/field-utils';
import type { DbErrorUtils } from '../../../src/utils/db-error-utils';
import { StatementParser } from '../../../src/utils/statement-parser';
import type { RowFieldValue, RowKeyValue, RowValue } from '../../../src/utils/row-edit-utils';
import { RowEditUtils } from '../../../src/utils/row-edit-utils';
import type { FilterChip, TableAction } from '../../shared/components/data-table';
import { DataTable } from '../../shared/components/data-table';
import { FieldInput } from '../../shared/components/field-input';
import { Loading } from '../../shared/components/loading';
import { SqlErrorDisplay } from '../../shared/components/sql-error-display';
import { buildRowColumns, measureColumnWidths } from '../../shared/utils/row-columns';
import type { PendingDataStatement, RowEditPayload } from '../pending-statement';
import { newPendingStatement } from '../pending-statement';
import { schemasVsCodeApi } from '../vscode-api';
import { useDataEditSettings } from '../data-edit-settings-context';
import { DataEditDefaults } from '../../../src/utils/data-edit-defaults';
import { DataEditSettingsDialog } from './data-edit-settings-dialog';
import { resolveFieldColumns, RowEditDialog } from './row-edit-dialog';
import type { TableDataSearchRow, TableDataSearchState } from './table-data-search-dialog';
import { buildWhereClause, EMPTY_TABLE_DATA_SEARCH, TableDataSearchDialog } from './table-data-search-dialog';

interface Props {
	/** Only the identity and SYSTABLES' insertable flag are read - a view passes just its identity. */
	table: { schema: string; name: string; insertable?: string };
	/** Rows can be browsed and searched but never edited - a view. Hides "Edit Data", and keeps this tab
	 * out of edit mode even while another table's tab has the Run SQL panel open. */
	readOnly?: boolean;
	/** Whether the Run SQL panel is currently open - hides the "Edit Data" action while true. */
	editMode: boolean;
	onEnterEditMode: () => void;
	/** Replaces "Edit Data" in the same spot while editMode is on - same confirmation flow as the Run
	 * SQL panel's own Cancel button. See app.tsx's requestExitEditMode. */
	onCancelEditClick: () => void;
	/** True for the entire span of a run - disables Add Row and every row action that would add or
	 * remove a pending statement (Edit/Delete/Cancel Add/Cancel Update/Cancel Delete), since the host
	 * is currently executing the exact list that was sent. See app.tsx. */
	isRunning: boolean;
	/** Can span multiple open tables' tabs at once - only this tab's own (schema/table-matching)
	 * entries are ever acted on here. See app.tsx. */
	pendingStatements: PendingDataStatement[];
	onUpsertStatement: (statement: PendingDataStatement) => void;
	onDeleteStatement: (id: string) => void;
	/** The {schema, table} pairs whose pending statements just ran successfully - triggers a refresh
	 * when this tab's own table is in the list, since its just-committed rows are otherwise stale. */
	runCompletionNotice: Array<{schema: string; table: string}> | null;
}

/** The column(s) that key a row for update/delete - real primary-key/identity column(s), or the
 * single synthetic "$RRN" fallback. See DataQueries.KeyColumn/TableDataLoadedMessage.keyColumns. */
interface KeyColumn {
	systemName: string;
	isRrn: boolean;
}

interface RowEditDialogState {
	mode: 'add' | 'edit';
	/** Edit mode only. */
	keyValues?: Record<string, RowValue>;
	initialValues: Record<string, RowValue>;
	/** Edit mode only - see RowEditDialog.originalValues. */
	originalValues?: Record<string, RowValue>;
	/** Set when reopening the dialog on a row/insert that already has a pending statement - upsert
	 * replaces it in place instead of creating a second one. */
	existingStatementId?: string;
}

const PAGE_SIZE = 100;
const MAX_CELL_WIDTH = 300;

function formatByteLength(value: unknown): string {
	let bytes = typeof value === 'number' ? value : Number(value);

	if (!Number.isFinite(bytes)) {
		return '[LOB]';
	}

	if (bytes < 1024) {
		return `[LOB, ${bytes} B]`;
	}

	if (bytes < 1024 * 1024) {
		return `[LOB, ${(bytes / 1024).toFixed(1)} KB]`;
	}

	return `[LOB, ${(bytes / (1024 * 1024)).toFixed(1)} MB]`;
}

// DB2 blank-pads a CHAR column's value out to its declared length - the raw fetched value (e.g.
// "ABC                 ") shows/edits badly, and would make a row's real state look "changed" the
// instant it's read back in without the user having touched anything, so it's right-trimmed (never
// left-trimmed - a leading space is meaningful; right-padding is specifically what DB2 CHAR does)
// everywhere a character-typed value is shown for editing, compared to detect a change, or used as a
// key (DB2 pads a comparison with blanks, so the trimmed key still matches). Only fixed-length types
// are trimmed: padding is all their trailing blanks can be, while a VARCHAR's are data and kept. A
// NULL stays null, never ''.
function trimCharacterValue(value: unknown, dataType: string | undefined): RowValue {
	if (value === null || value === undefined) {
		return null;
	}

	let text = String(value);
	return FieldUtils.isFixedLengthCharacterType(dataType) ? text.replace(/\s+$/, '') : text;
}

function nullableCell(value: unknown): ReactNode {
	return value === null || value === undefined
		? <Typography component="span" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>&lt;null&gt;</Typography>
		: String(value);
}

// Mirrors the same completeness rule SearchCriteriaUtils' buildClause applies when silently skipping
// a row that wouldn't actually contribute to the WHERE clause - a row that isn't filtering anything
// yet shouldn't get a chip either.
function isCriterionActive(row: TableDataSearchRow): boolean {
	if (!row.column) {
		return false;
	}

	if (row.operator === 'IS NULL' || row.operator === 'IS NOT NULL') {
		return true;
	}

	if (row.operator === 'IN') {
		return row.values.some(value => value.trim().length > 0);
	}

	return row.value.trim().length > 0;
}

function formatCriterionValue(row: TableDataSearchRow): string {
	if (row.operator === 'IS NULL' || row.operator === 'IS NOT NULL') {
		return '';
	}

	if (row.operator === 'IN') {
		return `(${row.values.map(value => value.trim()).filter(Boolean).join(', ')})`;
	}

	return row.value;
}

function keyValuesEqual(a: Record<string, RowValue>, b: Record<string, RowValue>): boolean {
	let keysA = Object.keys(a);
	return keysA.length === Object.keys(b).length && keysA.every(key => a[key] === b[key]);
}

// A real row's original (pre-edit) key values, tagged on by rowsWithOriginalKeys - see there for why
// this has to be read back rather than re-derived from the row's current (possibly overlaid/edited)
// column values. Absent for a synthetic pending-insert row (which has no key of its own yet).
function getOriginalKeyValues(row: Row): Record<string, RowValue> | undefined {
	return row.__originalKeyValues as Record<string, RowValue> | undefined;
}

export function TableDataTab({ table, readOnly, editMode: sessionEditMode, onEnterEditMode, onCancelEditClick, isRunning, pendingStatements, onUpsertStatement, onDeleteStatement, runCompletionNotice }: Props) {
	const theme = useTheme();
	const containerRef = useRef<HTMLDivElement>(null);
	const loadingRef = useRef(false);
	const prevScrollTopRef = useRef(0);
	// The pending insert grid Add Row just made - its first field takes focus once it mounts, then this
	// clears, so scrolling the row out and back doesn't steal focus again.
	const focusNewRowRef = useRef<string | null>(null);

	const [rows, setRows] = useState<Row[]>([]);
	const [columns, setColumns] = useState<SystemColumn[]>([]);
	const [columnLabels, setColumnLabels] = useState<Record<string, string[]>>({});
	const [keyColumns, setKeyColumns] = useState<KeyColumn[]>([]);
	// Edit mode is one session across every open Data tab, but a read-only source never takes part in it.
	const editMode = sessionEditMode && !readOnly;
	const [hasMore, setHasMore] = useState(true);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<DbErrorUtils.SerializedError | null>(null);
	const [sorting, setSorting] = useState<SortingState>([]);
	const [appliedWhere, setAppliedWhere] = useState('');
	const [appliedSearch, setAppliedSearch] = useState<TableDataSearchState>(EMPTY_TABLE_DATA_SEARCH);
	const [searchDialogOpen, setSearchDialogOpen] = useState(false);
	const [rowEditDialog, setRowEditDialog] = useState<RowEditDialogState | null>(null);
	const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
	const { settings: dataEditSettings, save: saveDataEditSettings } = useDataEditSettings();

	// Keyed by systemName, not sqlName - DataQueries.listTableData selects columns by their short
	// system name (no alias), so that's what the raw row keys/grid column ids are (see
	// SchemasProvider.postTableData).
	const lobColumns = useMemo(() => new Set(columns.filter(column => FieldUtils.isLobType(column.dataType)).map(column => column.systemName)), [columns]);
	const numericColumns = useMemo(() => new Set(columns.filter(column => FieldUtils.isNumericType(column.dataType)).map(column => column.systemName)), [columns]);
	const columnKeys = useMemo(() => columns.map(column => column.systemName), [columns]);
	// Each header's tooltip and copy menu, straight from the catalog columns this tab already holds. No
	// Primary Key line: keyColumns may be the identity column standing in for the key, not the real one.
	const columnDetails = useMemo(() => Object.fromEntries(columns.map(column => [column.systemName, ColumnDetailsUtils.fromSystemColumn(column)])), [columns]);
	const searchableColumns = useMemo(() => columns.filter(column => !FieldUtils.isLobType(column.dataType)), [columns]);

	// This tab's own pending statements - RunSqlPanel's list can span multiple open tables at once.
	const myStatements = useMemo(
		() => pendingStatements.filter(statement => statement.schema === table.schema && statement.table === table.name),
		[pendingStatements, table.schema, table.name]
	);
	const insertStatements = useMemo(
		() => myStatements.filter(statement => StatementParser.classifyKind(statement.sql) === StatementParser.StatementKind.INSERT),
		[myStatements]
	);
	const nonInsertStatements = useMemo(
		() => myStatements.filter(statement => StatementParser.classifyKind(statement.sql) !== StatementParser.StatementKind.INSERT),
		[myStatements]
	);

	// trimCharacterValue needs the column's dataType, which callers keyed only by systemName (a row's
	// raw fields, or keyColumns) don't have handy - looks it up from `columns` rather than making every
	// call site do it.
	function displayColumnValue(row: Row, systemName: string): RowValue {
		return trimCharacterValue(row[systemName], columns.find(candidate => candidate.systemName === systemName)?.dataType);
	}

	function computeRowKeyValues(row: Row): Record<string, RowValue> {
		return Object.fromEntries(keyColumns.map(key => [key.systemName, displayColumnValue(row, key.systemName)]));
	}

	function findMatchingStatement(keyValues: Record<string, RowValue>): PendingDataStatement | undefined {
		return nonInsertStatements.find(statement => statement.rowEdit?.keyValues && keyValuesEqual(statement.rowEdit.keyValues, keyValues));
	}

	function buildKeyValueList(keyValues: Record<string, RowValue>): RowKeyValue[] {
		return keyColumns.map(key => ({
			systemName: key.systemName,
			isRrn: key.isRrn,
			dataType: key.isRrn ? undefined : columns.find(column => column.systemName === key.systemName)?.dataType,
			value: keyValues[key.systemName] ?? null
		}));
	}

	// Every fetched row tagged with its own original (pre-edit) key values, under a marker field never
	// mistaken for a real column - a key column is now editable like any other (see resolveFieldColumns
	// in RowEditDialog/the `editable` check below), so its *displayed* value can differ from the value
	// that still has to identify the row for matching/the WHERE clause. Everything downstream that
	// needs "this row's real key" (resolveRowActions, handleInlineChangeForRow, pendingStatementForRow)
	// reads __originalKeyValues instead of re-deriving it from the (possibly overlaid/edited) row.
	// Recomputed only when the fetched page itself changes, not on every pending-statement edit.
	const rowsWithOriginalKeys = useMemo(
		() => rows.map(row => ({ ...row, __originalKeyValues: computeRowKeyValues(row) })),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[rows, keyColumns]
	);

	// Every fetched row overlaid with whichever pending update/delete matches its key (so the grid
	// always shows the pending new values, not the stale fetched ones - a pending delete's
	// columnValues is always empty, so it overlays to no visual change beyond the row's border/strike-
	// through below). __originalKeyValues rides along unchanged through the spread. Pending inserts
	// are never spliced in here - see newRowData.
	const overlaidRows = useMemo(() => {
		return rowsWithOriginalKeys.map(row => {
			let match = findMatchingStatement(row.__originalKeyValues);
			return match?.rowEdit ? { ...row, ...match.rowEdit.columnValues } : row;
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [rowsWithOriginalKeys, nonInsertStatements]);

	// Pending new rows are a separate, always-pinned segment - never spliced into the fetched rows
	// state, so they stay pinned at the top regardless of sorting/search/paging state. Marked with
	// __pendingStatementId so the row actions/inline-edit handlers below recognize "this is a
	// not-yet-run insert" rather than a real fetched row. Newest first, so a row Add Row just made is the
	// top one.
	const newRowData = useMemo(
		() => insertStatements.map(statement => ({ ...(statement.rowEdit?.columnValues ?? {}), __pendingStatementId: statement.id })).reverse(),
		[insertStatements]
	);

	const displayRows = useMemo(() => [...newRowData, ...overlaidRows], [newRowData, overlaidRows]);

	// Builds and posts a loadTableData request from current sorting/search state, defaulting to
	// `sorting`/`appliedWhere` - callers that are themselves changing one of those (sort click,
	// search Run/Clear) pass the new value explicitly, since the state setter that applies it
	// hasn't been reflected in a re-render (and so isn't visible via closure) yet.
	function loadPage(offset: number, overrides?: { sorting?: SortingState; where?: string }) {
		let activeSort = (overrides?.sorting ?? sorting)[0];
		let sortColumn = activeSort ? columns.find(column => column.systemName === activeSort.id) : undefined;
		let orderBy = sortColumn ? { systemName: sortColumn.systemName, direction: (activeSort.desc ? 'desc' : 'asc') as 'asc' | 'desc' } : undefined;

		loadingRef.current = true;
		schemasVsCodeApi.postMessage({
			command: 'loadTableData',
			schema: table.schema,
			table: table.name,
			offset,
			limit: PAGE_SIZE,
			orderBy,
			where: overrides?.where ?? appliedWhere
		});
	}

	// Unlike the other schema-browser tabs (which reset and re-post on every mount, relying on the
	// host's MemoryCache to make that cheap), this tab is only mounted once per table - see
	// TableDetail, which keeps it mounted (display: none) rather than unmounting it on tab switch,
	// specifically so the accumulated rows/scroll position below survive switching to another
	// sub-tab and back. So the initial load below only fires once, not on every remount.
	useEffect(() => {
		function onMessage(event: MessageEvent<SchemasInboundMessage>) {
			let message = event.data;

			if (message.schema !== table.schema || message.table !== table.name) {
				return;
			}

			if (message.command === 'tableDataLoaded') {
				setRows(prev => message.offset === 0 ? message.rows : [...prev, ...message.rows]);
				setColumns(message.columns);
				setColumnLabels(message.columnLabels);
				setKeyColumns(message.keyColumns);
				setHasMore(message.hasMore);
				setLoaded(true);
				setError(null);
				loadingRef.current = false;
			} else if (message.command === 'tableDataError') {
				setError(message.error);
				loadingRef.current = false;
			}
		}

		window.addEventListener('message', onMessage);
		loadPage(0);
		return () => window.removeEventListener('message', onMessage);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [table.schema, table.name]);

	function handleRefresh() {
		setError(null);
		setRows([]);
		setHasMore(true);
		loadPage(0);
	}

	// A successful run leaves this tab's currently-loaded rows stale the instant it commits - without
	// this, a row whose update just succeeded would appear to silently "revert" to its pre-edit value
	// once its pending statement is spliced away by App. Only the currently-mounted tab reacts live;
	// any other affected table just re-fetches fresh on its own next mount anyway.
	useEffect(() => {
		if (runCompletionNotice?.some(entry => entry.schema === table.schema && entry.table === table.name)) {
			handleRefresh();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [runCompletionNotice]);

	function handleScroll() {
		const element = containerRef.current;

		if (!element) {
			return;
		}

		// The scroll event fires for horizontal movement too - only respond when scrollTop itself moved.
		let scrolledVertically = element.scrollTop !== prevScrollTopRef.current;
		prevScrollTopRef.current = element.scrollTop;

		if (!scrolledVertically || !hasMore || loadingRef.current) {
			return;
		}

		if (element.scrollTop + element.clientHeight >= element.scrollHeight - 100) {
			loadPage(rows.length);
		}
	}

	const handleSortingChange: OnChangeFn<SortingState> = (updater: Updater<SortingState>) => {
		let next = typeof updater === 'function' ? updater(sorting) : updater;
		setSorting(next);
		setRows([]);
		setHasMore(true);
		loadPage(0, { sorting: next });
	};

	function handleSearchRun(newSearch: TableDataSearchState) {
		let whereClause = buildWhereClause(newSearch, columns);
		setAppliedSearch(newSearch);
		setAppliedWhere(whereClause);
		setSearchDialogOpen(false);
		setRows([]);
		setHasMore(true);
		loadPage(0, { where: whereClause });
	}

	// A search criteria chip's X and the "Clear" button both just re-run the search with a smaller
	// TableDataSearchState - same apply path (and the same immediate requery) as clicking Run in the
	// dialog itself.
	function handleRemoveFieldRow(rowId: string) {
		handleSearchRun({ ...appliedSearch, fieldsRows: appliedSearch.fieldsRows.filter(row => row.id !== rowId) });
	}

	function handleClearAllCriteria() {
		handleSearchRun(EMPTY_TABLE_DATA_SEARCH);
	}

	// Add Row: a pending insert straight in the grid, starting from the same defaults the dialog would
	// show, its missing required columns flagged the way an inline edit flags them.
	function handleAddRowInGrid() {
		addPendingInsert(DataEditDefaults.newRowValues(resolveFieldColumns('add', columns), dataEditSettings));
	}

	// Duplicate Row: a pending insert seeded with the row's own displayed values (a pending update's
	// included), for every column Add Row lets the user fill in - identity and LOB columns are left
	// out the same way, so DB2 generates the one and the other starts NULL.
	function handleDuplicateRow(row: Row) {
		let syntheticId = row.__pendingStatementId as string | undefined;
		let insertValues = syntheticId ? insertStatements.find(candidate => candidate.id === syntheticId)?.rowEdit?.columnValues : undefined;
		addPendingInsert(Object.fromEntries(resolveFieldColumns('add', columns).map(column => [
			column.systemName,
			insertValues ? (insertValues[column.systemName] ?? null) : displayColumnValue(row, column.systemName)
		])));
	}

	function addPendingInsert(columnValues: Record<string, RowValue>) {
		let fieldColumns = resolveFieldColumns('add', columns);
		let sql = RowEditUtils.buildInsertSql(table.schema, table.name, RowEditUtils.buildInsertValues(fieldColumns, columnValues));
		let validationErrors = requiredMessages(RowEditUtils.findMissingRequired('insert', fieldColumns, columnValues));
		let statement = { ...newPendingStatement(table.schema, table.name, sql, { columnValues }), validationErrors };

		focusNewRowRef.current = statement.id;
		onUpsertStatement(statement);
		virtualizer.scrollToIndex(0);
	}

	// Add Row in Dialog, or reopening a pending insert's own dialog, pre-filled with whatever's been
	// entered for it so far.
	function handleOpenAddRow() {
		setRowEditDialog({ mode: 'add', initialValues: DataEditDefaults.newRowValues(resolveFieldColumns('add', columns), dataEditSettings) });
	}

	function handleOpenEditForInsert(statementId: string) {
		let statement = insertStatements.find(candidate => candidate.id === statementId);

		if (statement) {
			setRowEditDialog({ mode: 'add', initialValues: statement.rowEdit?.columnValues ?? {}, existingStatementId: statementId });
		}
	}

	// row is the row's current *displayed* (possibly overlaid) values - what the dialog pre-fills with.
	// originalValues is the row's real fetched values, looked up separately, so the dialog can still
	// diff a resubmit against the database's true state rather than just against what it opened with
	// (see RowEditDialog.originalValues) - otherwise reopening the dialog on a row that already has a
	// pending update and changing a *different* field would silently drop the earlier change instead of
	// keeping it alongside the new one. existingStatementId (found by key, not by any UI-passed hint)
	// makes this an upsert regardless of whether the row's pending statement was created by this same
	// dialog, a previous dialog submit, or inline editing.
	function handleOpenEditRow(row: Row, keyValues: Record<string, RowValue>) {
		let initialValues = Object.fromEntries(columnKeys.map(key => [key, displayColumnValue(row, key)]));
		let rawRow = rows.find(candidate => keyValuesEqual(computeRowKeyValues(candidate), keyValues));
		let originalValues = rawRow ? Object.fromEntries(columnKeys.map(key => [key, displayColumnValue(rawRow, key)])) : initialValues;
		let existing = findMatchingStatement(keyValues);
		setRowEditDialog({ mode: 'edit', keyValues, initialValues, originalValues, existingStatementId: existing?.id });
	}

	// No confirmation dialog - nothing has executed yet. Replaces any existing pending statement for
	// this same row (by key) rather than assuming none exists, so this stays correct even if it's ever
	// reached from a row that already had a pending update.
	function handleDeleteRow(keyValues: Record<string, RowValue>) {
		let existing = findMatchingStatement(keyValues);
		let sql = RowEditUtils.buildDeleteSql(table.schema, table.name, buildKeyValueList(keyValues));
		let rowEdit: RowEditPayload = { keyValues, columnValues: {} };
		onUpsertStatement(existing
			? { id: existing.id, schema: table.schema, table: table.name, sql, rowEdit }
			: newPendingStatement(table.schema, table.name, sql, rowEdit));
	}

	function handleDialogSubmit(statement: PendingDataStatement) {
		onUpsertStatement(statement);
		setRowEditDialog(null);
	}

	function handleDialogCancel() {
		setRowEditDialog(null);
	}

	// Inline editing on an existing row - recomputes this row's full columnValues (existing override,
	// if any, merged with this column's new value), dropping the column back out the moment its value
	// matches the row's real fetched value again (only keep what actually changed, same rule the
	// dialog uses). Empty columnValues afterward reverts the row entirely (deletes the statement,
	// which is also what typing a value back to its original ends up doing on its own).
	// value arrives already sanitized (and, for a DATE/TIME/TIMESTAMP column, already formatted if it
	// came from a picker selection) - FieldInput owns that step now.
	function handleInlineChangeForRow(row: Row, column: SystemColumn, newValue: RowValue) {
		// The disabled cell already prevents this during a run - defense in depth, same as App's own
		// handleDeleteStatement guard.
		if (isRunning) {
			return;
		}

		let keyValues = getOriginalKeyValues(row) ?? computeRowKeyValues(row);
		let rawRow = rows.find(candidate => keyValuesEqual(computeRowKeyValues(candidate), keyValues)) ?? row;
		let existing = findMatchingStatement(keyValues);
		let mergedColumnValues = { ...(existing?.rowEdit?.columnValues ?? {}) };

		if (newValue === trimCharacterValue(rawRow[column.systemName], column.dataType)) {
			delete mergedColumnValues[column.systemName];
		} else {
			mergedColumnValues[column.systemName] = newValue;
		}

		if (Object.keys(mergedColumnValues).length === 0) {
			if (existing) {
				onDeleteStatement(existing.id);
			}

			return;
		}

		let columnValues: RowFieldValue[] = Object.entries(mergedColumnValues).map(([systemName, value]) => ({
			systemName,
			dataType: columns.find(candidate => candidate.systemName === systemName)?.dataType,
			value
		}));

		let sql = RowEditUtils.buildUpdateSql(table.schema, table.name, columnValues, buildKeyValueList(keyValues));
		let rowEdit: RowEditPayload = { keyValues, columnValues: mergedColumnValues };
		let validationErrors = requiredMessages(RowEditUtils.findMissingRequired('update', columns, mergedColumnValues));

		onUpsertStatement({
			...(existing ? { id: existing.id, schema: table.schema, table: table.name, sql, rowEdit } : newPendingStatement(table.schema, table.name, sql, rowEdit)),
			validationErrors
		});
	}

	// The Run SQL panel's message under a statement that writes NULL into a required column, naming the
	// column the way its header does.
	function requiredMessages(missing: SystemColumn[]): string[] | undefined {
		return missing.length > 0
			? missing.map(column => `${ColumnNameUtils.labelsForKey(columnLabels, column.systemName).join(' / ')} is required`)
			: undefined;
	}

	// A pending new row's own cells write back into that same insert statement's columnValues instead.
	// value arrives already sanitized/formatted - see handleInlineChangeForRow above.
	function handleInlineChangeForInsert(statementId: string, column: SystemColumn, newValue: RowValue) {
		if (isRunning) {
			return;
		}

		let statement = insertStatements.find(candidate => candidate.id === statementId);

		if (!statement) {
			return;
		}

		let mergedColumnValues = { ...(statement.rowEdit?.columnValues ?? {}), [column.systemName]: newValue };
		let fieldColumns = resolveFieldColumns('add', columns);
		let sql = RowEditUtils.buildInsertSql(table.schema, table.name, RowEditUtils.buildInsertValues(fieldColumns, mergedColumnValues));
		let validationErrors = requiredMessages(RowEditUtils.findMissingRequired('insert', fieldColumns, mergedColumnValues));
		onUpsertStatement({ id: statementId, schema: table.schema, table: table.name, sql, rowEdit: { columnValues: mergedColumnValues }, validationErrors });
	}

	function pendingStatementForRow(row: Row): { statement: PendingDataStatement; isInsert: boolean } | undefined {
		let syntheticId = row.__pendingStatementId as string | undefined;

		if (syntheticId) {
			let statement = insertStatements.find(candidate => candidate.id === syntheticId);
			return statement ? { statement, isInsert: true } : undefined;
		}

		let keyValues = getOriginalKeyValues(row);

		if (!keyValues) {
			return undefined;
		}

		let match = findMatchingStatement(keyValues);
		return match ? { statement: match, isInsert: false } : undefined;
	}

	// editableColumnDefs' cell renderers read through this instead of closing over
	// pendingStatementForRow/the inline-change handlers directly, and editableColumnDefs' own useMemo
	// deliberately excludes pendingStatements from its dependency list (see below) - @tanstack/react-
	// table's flexRender treats a columnDef.cell function as a component type, keyed by that function's
	// *identity*; recreating it on every keystroke (pendingStatements changes on every keystroke) was
	// making React unmount/remount the cell's TextField each time, kicking focus out of whatever field
	// was being typed into. Assigning .current directly in the render body (no effect) is safe here:
	// it's reassigned before the table renders, and the cells re-run on every render of this component
	// (only their identity is stable), so the one value a cell reads while rendering - isRunning, for
	// its disabled state - is always this render's.
	const liveRef = useRef({ isRunning, pendingStatementForRow, handleInlineChangeForRow, handleInlineChangeForInsert });
	liveRef.current = { isRunning, pendingStatementForRow, handleInlineChangeForRow, handleInlineChangeForInsert };

	// Row actions are state-dependent - which actions apply depends on whether this specific row
	// already has a pending statement, and (for one that does) which kind.
	function resolveRowActions(targetRows: Row[]): TableAction<Row>[] {
		if (targetRows.length === 0) {
			return [];
		}

		let row = targetRows[0];
		let syntheticId = row.__pendingStatementId as string | undefined;
		// Every row action below adds or removes a pending statement - locked for the whole run, same
		// reasoning as the Add Row action further down.
		let disabledReason = () => isRunning ? 'A run is in progress' : undefined;
		let disabled = () => isRunning;

		if (syntheticId) {
			return [
				{ label: 'Edit Row', appliesToSelection: false, disabled, disabledReason, onClick: () => handleOpenEditForInsert(syntheticId) },
				{ label: 'Duplicate Row', appliesToSelection: false, disabled, disabledReason, onClick: () => handleDuplicateRow(row) },
				{ label: 'Cancel Add', appliesToSelection: false, disabled, disabledReason, onClick: () => onDeleteStatement(syntheticId) }
			];
		}

		let keyValues = getOriginalKeyValues(row);

		if (!keyValues) {
			return [];
		}

		let match = findMatchingStatement(keyValues);

		if (match) {
			let isDelete = StatementParser.classifyKind(match.sql) === StatementParser.StatementKind.DELETE;

			// A row pending deletion isn't offered Edit Row - editing values on a row that's about to be
			// deleted has no effect, and it's already excluded from inline editing for the same reason.
			// A row with a pending update still is - reopening it (with its current pending values, and
			// upserting rather than creating a second statement) is just as valid a way to keep adjusting
			// it as inline editing.
			return isDelete
				? [{ label: 'Cancel Delete', appliesToSelection: false, disabled, disabledReason, onClick: () => onDeleteStatement(match.id) }]
				: [
					{ label: 'Edit Row', appliesToSelection: false, disabled, disabledReason, onClick: () => handleOpenEditRow(row, keyValues) },
					{ label: 'Duplicate Row', appliesToSelection: false, disabled, disabledReason, onClick: () => handleDuplicateRow(row) },
					{ label: 'Cancel Update', appliesToSelection: false, disabled, disabledReason, onClick: () => onDeleteStatement(match.id) }
				];
		}

		return [
			{ label: 'Edit Row', appliesToSelection: false, disabled, disabledReason, onClick: () => handleOpenEditRow(row, keyValues) },
			{ label: 'Duplicate Row', appliesToSelection: false, disabled, disabledReason, onClick: () => handleDuplicateRow(row) },
			{ label: 'Delete Row', appliesToSelection: false, disabled, disabledReason, onClick: () => handleDeleteRow(keyValues) }
		];
	}

	// Right-clicking an edit field offers Set NULL - the only way to write NULL, since a cleared field
	// is the empty string. Only offered where it can be done, never shown disabled: not on a cell that
	// isn't an edit field (LOB, identity, non-updatable, a row pending deletion), a NOT NULL column, a
	// field already NULL, or during a run - the menu is then just the row's. On a pending insert, a column
	// with a table default offers Use Table Default instead, NOT NULL or not: its NULL is left out of the
	// INSERT for DB2 to fill (RowEditUtils.buildInsertValues).
	function resolveCellActions(row: Row, columnId: string): TableAction<Row>[] {
		let column = columns.find(candidate => candidate.systemName === columnId);
		let pending = pendingStatementForRow(row);
		let isPendingDelete = pending !== undefined && !pending.isInsert && StatementParser.classifyKind(pending.statement.sql) === StatementParser.StatementKind.DELETE;
		let syntheticId = row.__pendingStatementId as string | undefined;
		let usesDefault = syntheticId !== undefined && column !== undefined && RowEditUtils.hasTableDefault(column);
		// row is the overlaid row, so this is what the field currently shows.
		let isNull = column !== undefined && (row[column.systemName] === null || row[column.systemName] === undefined);

		if (!column || FieldUtils.isLobType(column.dataType) || column.identity === 'YES' || column.updatable === 'NO' || isPendingDelete
			|| (RowEditUtils.isNotNull(column) && !usesDefault) || isNull || isRunning) {
			return [];
		}

		return [{
			label: usesDefault ? 'Use Table Default' : 'Set NULL',
			appliesToSelection: false,
			onClick: () => syntheticId
				? handleInlineChangeForInsert(syntheticId, column, null)
				: handleInlineChangeForRow(row, column, null)
		}];
	}

	// Green border for any pending statement (insert, update, or delete alike); a pending delete
	// additionally gets its text struck through.
	// Lets DataTable skip re-rendering every visible row's inputs on each keystroke - only the row
	// being edited gets a new row object (overlaidRows/newRowData), so without this one keystroke
	// re-rendered hundreds of TextFields. Beyond row.original, the edit cells and resolveRowSx read
	// exactly this: whether a run is locking the inputs, and the row's own pending statement (whether
	// it's a delete, which switches its cells to read-only, and the border it earns).
	function resolveRowRenderKey(row: Row): string {
		let pending = pendingStatementForRow(row);
		return `${isRunning}|${pending?.statement.id ?? ''}|${pending?.statement.sql ?? ''}`;
	}

	function resolveRowSx(row: Row): SxProps<Theme> | undefined {
		let pending = pendingStatementForRow(row);

		if (!pending) {
			return undefined;
		}

		let isDelete = !pending.isInsert && StatementParser.classifyKind(pending.statement.sql) === StatementParser.StatementKind.DELETE;

		return (currentTheme: Theme) => ({
			'& td': {
				boxShadow: `inset 0 0 0 1.5px ${currentTheme.palette.success.main}`,
				...(isDelete ? { textDecoration: 'line-through' } : {})
			}
		});
	}

	const columnWidths = useMemo(
		() => measureColumnWidths(`${theme.typography.fontSize}px ${theme.typography.fontFamily}`, theme.typography.fontWeightMedium, columnKeys, columnLabels, rows),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[theme.typography.fontSize, theme.typography.fontFamily, theme.typography.fontWeightMedium, columnKeys, columnLabels]
	);

	const readOnlyColumnDefs = useMemo<ColumnDef<Row>[]>(
		() => buildRowColumns(columnKeys, columnLabels, columnWidths, {
			lobColumns,
			renderLobCell: (byteLength: unknown): ReactNode => (
				<Typography component="span" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>{formatByteLength(byteLength)}</Typography>
			),
			numericColumns,
			columnDetails
		}),
		[columnKeys, columnLabels, columnWidths, lobColumns, numericColumns, columnDetails]
	);

	// Kept out of webviews/shared/utils/row-columns.tsx (unlike buildRowColumns, still used above for
	// the read-only case) since inline editing is specific to this one consumer. Every non-LOB,
	// non-identity, updatable column renders a dense TextField instead of plain text - a real (non-
	// identity) key column stays editable here too (see resolveFieldColumns in RowEditDialog for why
	// that's safe); LOB/identity columns (and any column on a row pending deletion) keep the read-only
	// rendering.
	const editableColumnDefs = useMemo<ColumnDef<Row>[]>(() => {
		let isEditable = (column: SystemColumn) => !FieldUtils.isLobType(column.dataType) && column.identity !== 'YES' && column.updatable !== 'NO';
		let firstEditableColumn = columns.find(isEditable)?.systemName;

		return columns.map(column => {
			let isLob = FieldUtils.isLobType(column.dataType);
			let isNumeric = FieldUtils.isNumericType(column.dataType);
			let editable = isEditable(column);
			let labelParts = ColumnNameUtils.labelsForKey(columnLabels, column.systemName);
			// Marked the way the Add/Edit Row dialog marks a required field - by the UPDATE rule, since
			// fetched rows are what the grid mostly edits (a pending insert's NULL cell with a default
			// is fine, and isn't flagged below).
			let notNull = editable && RowEditUtils.isNotNull(column);

			return {
				id: column.systemName,
				size: columnWidths[column.systemName],
				enableSorting: !isLob,
				meta: { align: isNumeric ? 'right' : undefined, details: columnDetails[column.systemName] },
				accessorFn: (row: Row) => row[column.systemName],
				header: () => (
					<div>
						{labelParts.map((part, index) => <div key={index}>{index === 0 && notNull ? `${part} *` : part}</div>)}
					</div>
				),
				cell: info => {
					let value = info.getValue();

					if (isLob) {
						return <Typography component="span" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>{formatByteLength(value)}</Typography>;
					}

					if (!editable) {
						return nullableCell(value);
					}

					let row = info.row.original;
					let syntheticId = row.__pendingStatementId as string | undefined;
					let pending = liveRef.current.pendingStatementForRow(row);
					let isPendingDelete = pending !== undefined && !pending.isInsert && StatementParser.classifyKind(pending.statement.sql) === StatementParser.StatementKind.DELETE;

					if (isPendingDelete) {
						return nullableCell(value);
					}

					// Only a fetched value gets DB2's CHAR padding trimmed off. A value the user typed (a pending
					// update's or insert's own columnValues) is shown exactly as typed - trimming it too would
					// eat a trailing space the moment it's typed, so "Hex bolt" could never be entered.
					// A pending NULL is a value of its own, so presence is checked with `in`, not `??`.
					let pendingValues = pending?.statement.rowEdit?.columnValues;
					let isPendingColumn = pendingValues !== undefined && column.systemName in pendingValues;
					let pendingValue = pendingValues?.[column.systemName];
					// Same rules as the statement's own validationErrors (RowEditUtils.findMissingRequired):
					// a pending insert's required column left NULL, or a NOT NULL column this row's update
					// writes NULL into. A fetched NULL the user hasn't touched isn't in the UPDATE, so isn't flagged.
					let missing = syntheticId
						? RowEditUtils.isRequired(column) && RowEditUtils.writesNull(column.dataType, pendingValue)
						: isPendingColumn && RowEditUtils.isNotNull(column) && RowEditUtils.writesNull(column.dataType, pendingValue);
					// A pending insert leaves a NULL column with a table default out, so DB2 fills it.
					let usesDefault = syntheticId !== undefined && RowEditUtils.hasTableDefault(column);

					return (
						<FieldInput
							field={column}
							variant="standard"
							fullWidth
							hideHelperText
							alignNumericRight
							error={missing}
							// Locked for the whole run, like every row action - the host is executing the exact
							// SQL that was sent, so an edit now would rewrite a statement that then gets marked
							// done without its new text ever having run.
							disabled={liveRef.current.isRunning}
							value={isPendingColumn ? (pendingValue ?? null) : trimCharacterValue(value, column.dataType)}
							nullPlaceholder={usesDefault ? '<default>' : undefined}
							inputRef={syntheticId !== undefined && column.systemName === firstEditableColumn ? element => {
								if (element && focusNewRowRef.current === syntheticId) {
									focusNewRowRef.current = null;
									element.focus();
								}
							} : undefined}
							onChange={newValue => syntheticId
								? liveRef.current.handleInlineChangeForInsert(syntheticId, column, newValue)
								: liveRef.current.handleInlineChangeForRow(row, column, newValue)}
						/>
					);
				}
			};
		});
		// Deliberately excludes pendingStatements-derived state (nonInsertStatements/insertStatements) -
		// see liveRef above. Only column *metadata* (shape/labels/widths) should ever recreate these
		// cell functions.
	}, [columns, columnLabels, columnWidths, columnDetails]);

	const columnDefs = editMode ? editableColumnDefs : readOnlyColumnDefs;

	// manualSorting: true is the interception point - TanStack keeps the sorting state and header
	// click UI (TableSortLabel) working, but never reorders rows itself; handleSortingChange (above)
	// is what actually re-runs the query with an ORDER BY instead.
	const reactTable = useReactTable({
		data: displayRows,
		columns: columnDefs,
		state: { sorting },
		onSortingChange: handleSortingChange,
		manualSorting: true,
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel()
	});

	const tableRows = reactTable.getRowModel().rows;

	const virtualizer = useVirtualizer({
		count: tableRows.length,
		getScrollElement: () => containerRef.current,
		estimateSize: () => 32,
		overscan: 10
	});

	// Custom tab: a single "Custom" chip standing in for the whole applied WHERE clause - removing it
	// is the same as Clear since there's only ever one criterion in that mode. Fields tab: one chip
	// per active row reading as the criterion itself, "[field] [operator] [value]" (e.g. "AGE > 30"),
	// with the raw SQL operator token rather than the dialog's friendlier OPERATOR_LABELS wording and
	// the column's short name whatever resultHeadingLabels says - the chip stands for SQL that runs,
	// like the generated statements and the Edit Row dialog's key line. Its tooltip names the column
	// the way the setting does instead, every configured label joined with " / " as the search
	// dialog's picker shows it.
	const filterChips = useMemo<FilterChip[]>(() => {
		if (appliedSearch.activeTab === 'custom') {
			return appliedWhere
				? [{ key: 'custom', label: 'Custom', tooltip: appliedWhere, onRemove: handleClearAllCriteria }]
				: [];
		}

		return appliedSearch.fieldsRows.filter(isCriterionActive).map(row => {
			let valueText = formatCriterionValue(row);

			return {
				key: row.id,
				label: valueText ? `${row.column} ${row.operator} ${valueText}` : `${row.column} ${row.operator}`,
				tooltip: ColumnNameUtils.labelsForKey(columnLabels, row.column).join(' / '),
				onRemove: () => handleRemoveFieldRow(row.id)
			};
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [appliedSearch, appliedWhere, columns, columnLabels]);

	const tableActions: TableAction<Row>[] = [
		// Hidden once edit mode is active (globally, across every open Data tab, not just this one) -
		// the Run SQL panel is already open at that point, see app.tsx.
		...(editMode
			? [{
				label: 'Add Row',
				appliesToSelection: true,
				onClick: () => handleAddRowInGrid(),
				disabled: () => table.insertable === 'NO' || isRunning,
				disabledReason: () => table.insertable === 'NO' ? 'This table is not insertable' : isRunning ? 'A run is in progress' : undefined,
				secondaryActions: [{
					label: 'Add Row in Dialog',
					appliesToSelection: true,
					onClick: () => handleOpenAddRow(),
					disabled: () => table.insertable === 'NO' || isRunning
				}]
			}]
			: []),
		{ label: 'Edit Search', appliesToSelection: true, onClick: () => setSearchDialogOpen(true) },
		// Same spot as "Edit Data" below - Cancel Edit is its edit-mode replacement, using the same
		// discard-confirmation flow as the Run SQL panel's own Cancel button.
		...(editMode
			? [{
				label: 'Cancel Edit',
				appliesToSelection: true,
				onClick: () => onCancelEditClick(),
				disabled: () => isRunning,
				disabledReason: () => isRunning ? 'A run is in progress' : undefined
			}]
			: readOnly ? [] : [{ label: 'Edit Data', appliesToSelection: true, onClick: () => onEnterEditMode() }])
	];

	// Only reached the first time this table's ever loaded (columns/tableActions/etc. never resolved
	// yet) - nothing meaningful to build table chrome around, so this is the one case still allowed to
	// replace the whole panel. Once loaded once, a later error (e.g. an Edit Search WHERE clause that
	// doesn't parse) instead surfaces inline via emptyMessage below, keeping the filter bar/chips/
	// actions in place so the user can fix the criteria that caused it.
	if (error && !loaded) {
		return (
			<Stack sx={{ p: 2 }}>
				<SqlErrorDisplay error={error} label="Failed to load data" />
			</Stack>
		);
	}

	if (!loaded) {
		return <Loading message="Loading data..." />;
	}

	return (
		<Stack sx={{ height: '100%', minHeight: 0 }}>
			<DataTable
				table={reactTable}
				maxCellWidth={MAX_CELL_WIDTH}
				containerRef={containerRef}
				onScroll={handleScroll}
				virtualizer={virtualizer}
				tableActions={tableActions}
				// Shown in and out of edit mode, after Refresh and Export... - a view is never edited, so its
				// Data tab has nothing to configure.
				trailingTableActions={readOnly ? undefined : [{ label: 'Settings...', appliesToSelection: true, onClick: () => setSettingsDialogOpen(true) }]}
				rowActions={editMode ? resolveRowActions : undefined}
				cellActions={editMode ? resolveCellActions : undefined}
				rowSx={editMode ? resolveRowSx : undefined}
				rowRenderKey={editMode ? resolveRowRenderKey : undefined}
				onRefresh={handleRefresh}
				exportColumnLabels={columnLabels}
				filterChips={filterChips}
				onClearAllFilterChips={filterChips.length > 0 ? handleClearAllCriteria : undefined}
				emptyMessage={error ? <SqlErrorDisplay error={error} label="Failed to load data" /> : 'No data to display'}
			/>

			<TableDataSearchDialog
				open={searchDialogOpen}
				columns={searchableColumns}
				columnLabels={columnLabels}
				initialState={appliedSearch}
				onCancel={() => setSearchDialogOpen(false)}
				onRun={handleSearchRun}
			/>

			<DataEditSettingsDialog
				open={settingsDialogOpen}
				settings={dataEditSettings}
				onCancel={() => setSettingsDialogOpen(false)}
				onSave={settings => {
					saveDataEditSettings(settings);
					setSettingsDialogOpen(false);
				}}
			/>

			<RowEditDialog
				open={rowEditDialog !== null}
				mode={rowEditDialog?.mode ?? 'add'}
				table={table}
				columns={columns}
				columnLabels={columnLabels}
				keyColumns={keyColumns}
				keyValues={rowEditDialog?.keyValues}
				initialValues={rowEditDialog?.initialValues ?? {}}
				originalValues={rowEditDialog?.originalValues}
				existingStatementId={rowEditDialog?.existingStatementId}
				onCancel={handleDialogCancel}
				onSubmit={handleDialogSubmit}
				onDelete={onDeleteStatement}
			/>
		</Stack>
	);
}
