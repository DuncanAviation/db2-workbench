import { useEffect, useMemo, useState } from 'react';
import {
	Button,
	Checkbox,
	Dialog,
	DialogActions,
	DialogContent,
	DialogContentText,
	DialogTitle,
	FormControlLabel,
	Stack,
	TextField,
	Typography
} from '@mui/material';
import type { CellContext, ColumnDef, SortingState } from '@tanstack/react-table';
import { getCoreRowModel, getFilteredRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table';
import { IndexAdviceUtils } from '../../../src/utils/index-advice-utils';
import type { SchemasIndexAdvice, SchemasInboundMessage, SchemasSystemTable } from '../../../src/webview-messages/schemas-messages';
import type { DbErrorUtils } from '../../../src/utils/db-error-utils';
import type { TableAction } from '../../shared/components/data-table';
import { DataTable } from '../../shared/components/data-table';
import { Loading } from '../../shared/components/loading';
import { SourceEditor } from '../../shared/components/source-editor';
import { SqlErrorDisplay } from '../../shared/components/sql-error-display';
import { WarningAlert } from '../../shared/components/warning-alert';
import { schemasVsCodeApi } from '../vscode-api';

interface Props {
	table: SchemasSystemTable;
	currentSortSequence: string;
	currentSortSequenceLibrary: string;
}

// Shared by the Create Index dialog's "Delete advised index" checkbox and the row Delete action -
// see DbConnections.deleteIndexAdvice().
function buildDeleteAdviceSql(advice: SchemasIndexAdvice): string {
	return `DELETE FROM QSYS2.SYSIXADV WHERE RRN(SYSIXADV) = ${advice.id}`;
}

export function AdvisedIndexesTab({ table, currentSortSequence, currentSortSequenceLibrary }: Props) {
	const [indexAdvice, setIndexAdvice] = useState<SchemasIndexAdvice[] | null>(null);
	const [error, setError] = useState<DbErrorUtils.SerializedError | null>(null);
	const [sorting, setSorting] = useState<SortingState>([]);
	const [confirmAdvice, setConfirmAdvice] = useState<SchemasIndexAdvice | null>(null);
	const [confirmName, setConfirmName] = useState('');
	const [confirmSql, setConfirmSql] = useState('');
	const [deleteAdvisedIndex, setDeleteAdvisedIndex] = useState(false);
	const [deleteAdvice, setDeleteAdvice] = useState<SchemasIndexAdvice | null>(null);

	// Mirrors ColumnsTab's lazy-load-on-mount pattern. Unlike Columns, a runGeneratedSql round trip
	// (Create Index) also pushes a fresh indexAdviceLoaded here on completion (see schemas-provider.ts),
	// so this tab doesn't need to re-request after running a statement itself.
	useEffect(() => {
		setIndexAdvice(null);
		setError(null);

		function onMessage(event: MessageEvent<SchemasInboundMessage>) {
			let message = event.data;

			if (message.schema !== table.schema || message.table !== table.name) {
				return;
			}

			if (message.command === 'indexAdviceLoaded') {
				setIndexAdvice(message.indexAdvice);
				setError(null);
			} else if (message.command === 'indexAdviceError') {
				setError(message.error);
			}
		}

		window.addEventListener('message', onMessage);
		schemasVsCodeApi.postMessage({ command: 'loadIndexAdvice', schema: table.schema, table: table.name });
		return () => window.removeEventListener('message', onMessage);
	}, [table.schema, table.name]);

	function handleRefresh() {
		setIndexAdvice(null);
		setError(null);
		schemasVsCodeApi.postMessage({ command: 'loadIndexAdvice', schema: table.schema, table: table.name, forceRefresh: true });
	}

	function handleCopySql(advice: SchemasIndexAdvice) {
		void navigator.clipboard.writeText(IndexAdviceUtils.buildCreateIndexSql(advice));
	}

	function handleOpenCreateIndex(advice: SchemasIndexAdvice) {
		let name = IndexAdviceUtils.suggestIndexName(advice);
		setConfirmName(name);
		setConfirmSql(IndexAdviceUtils.buildCreateIndexSql(advice, name));
		setConfirmAdvice(advice);
		setDeleteAdvisedIndex(false);
	}

	// Keeps the SQL preview in sync while the user is still typing the name - once they start editing
	// the SQL box directly instead, the two intentionally stop tracking each other (same as the
	// Advised Indexes tab's original editable-SQL box - the SQL is always the actual source of truth
	// for what Run executes).
	function handleNameChange(newName: string) {
		setConfirmName(newName);

		if (confirmAdvice) {
			setConfirmSql(IndexAdviceUtils.buildCreateIndexSql(confirmAdvice, newName));
		}
	}

	// Only the length is validated per IndexAdviceUtils.MAX_INDEX_NAME_LENGTH (Db2 for i's SQL
	// identifier limit) - anything else invalid about the name surfaces as a normal DB2 error in this
	// session's History tab once Run is clicked, same as any other generated statement.
	const nameError = useMemo(() => {
		let trimmed = confirmName.trim();

		if (!trimmed) {
			return 'Name is required';
		}

		if (trimmed.length > IndexAdviceUtils.MAX_INDEX_NAME_LENGTH) {
			return `Name must be ${IndexAdviceUtils.MAX_INDEX_NAME_LENGTH} characters or fewer`;
		}

		return null;
	}, [confirmName]);

	function handleRunCreateIndex() {
		schemasVsCodeApi.postMessage({
			command: 'runGeneratedSql',
			schema: table.schema,
			table: table.name,
			sql: confirmSql,
			sortSequence: confirmAdvice?.sortSequence,
			sortSequenceLibrary: confirmAdvice?.sortSequenceLibrary,
			deleteAdviceSql: deleteAdvisedIndex && confirmAdvice ? buildDeleteAdviceSql(confirmAdvice) : undefined
		});
		setConfirmAdvice(null);
	}

	function handleOpenDelete(advice: SchemasIndexAdvice) {
		setDeleteAdvice(advice);
	}

	function handleConfirmDelete() {
		if (!deleteAdvice) {
			return;
		}

		schemasVsCodeApi.postMessage({
			command: 'deleteIndexAdvice',
			schema: table.schema,
			table: table.name,
			sql: buildDeleteAdviceSql(deleteAdvice)
		});

		setDeleteAdvice(null);
	}

	// See SortSequenceUtils.matches() on the host side - the same name+library comparison, just
	// evaluated here so the confirm dialog can warn before the user clicks Run rather than after.
	const sortSequenceMismatch = confirmAdvice !== null
		&& (confirmAdvice.sortSequence !== currentSortSequence || confirmAdvice.sortSequenceLibrary !== currentSortSequenceLibrary);

	const columnDefs = useMemo<ColumnDef<SchemasIndexAdvice>[]>(() => [
		{ accessorKey: 'keyColumnsAdvised', header: 'Suggested Key Columns' },
		{ accessorKey: 'indexType', header: 'Index Type' },
		{ accessorKey: 'reasonAdvised', header: 'Reason' },
		{ accessorKey: 'timesAdvised', header: 'Times Advised' },
		{ accessorKey: 'sortSequence', header: 'Sort Sequence' },
		{
			accessorKey: 'lastAdvised',
			header: 'Last Advised',
			cell: (info: CellContext<SchemasIndexAdvice, unknown>) => new Date(info.getValue<string>()).toLocaleString()
		}
	], []);

	// All single-row only - creating/copying/deleting an advised index recommendation doesn't have a
	// meaningful multi-row form.
	const rowActions: TableAction<SchemasIndexAdvice>[] = [
		{ label: 'Create Index', appliesToSelection: false, onClick: rows => handleOpenCreateIndex(rows[0]) },
		{ label: 'Copy SQL', appliesToSelection: false, onClick: rows => handleCopySql(rows[0]) },
		{ label: 'Delete', appliesToSelection: false, onClick: rows => handleOpenDelete(rows[0]) }
	];

	const reactTable = useReactTable({
		data: indexAdvice ?? [],
		columns: columnDefs,
		state: { sorting },
		onSortingChange: setSorting,
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getSortedRowModel: getSortedRowModel()
	});

	if (error) {
		return (
			<Stack sx={{ p: 2 }}>
				<SqlErrorDisplay error={error} label="Failed to load index advice" />
			</Stack>
		);
	}

	if (!indexAdvice) {
		return <Loading message="Loading index advice..." />;
	}

	return (
		<Stack sx={{ height: '100%', minHeight: 0 }}>
			{/* Always rendered, even with no rows, so Refresh stays reachable - advice produced by queries
			    run after this tab opened would otherwise never show up without reopening the table. */}
			<DataTable
				table={reactTable}
				rowActions={rowActions}
				onRefresh={handleRefresh}
				emptyMessage="No index advisor recommendations for this table"
			/>

			<Dialog open={Boolean(confirmAdvice)} onClose={() => setConfirmAdvice(null)} maxWidth="sm" fullWidth>
				<DialogTitle>Create Index</DialogTitle>
				<DialogContent>
					<Typography variant="body2" sx={{ pb: 1 }}>
						Review (and edit, if needed) the statement below before running it.
					</Typography>

					{sortSequenceMismatch && confirmAdvice && (
						<WarningAlert sx={{ mb: 2 }}>
							This index was advised under sort sequence <b>{confirmAdvice.sortSequence}</b>, which differs from
							this connection's current sort sequence (<b>{currentSortSequence}</b>). It will be created using a
							temporary connection matching <b>{confirmAdvice.sortSequence}</b> instead.
						</WarningAlert>
					)}

					<TextField
						autoFocus
						required
						fullWidth
						label="Index name"
						value={confirmName}
						onChange={event => handleNameChange(event.target.value)}
						error={Boolean(nameError)}
						helperText={nameError ?? `${confirmName.trim().length}/${IndexAdviceUtils.MAX_INDEX_NAME_LENGTH}`}
						sx={{ mb: 2 }}
					/>

					<SourceEditor
						aria-label="Create index SQL"
						minRows={3}
						value={confirmSql}
						onChange={setConfirmSql}
					/>

					<FormControlLabel
						sx={{ mt: 1 }}
						control={(
							<Checkbox
								checked={deleteAdvisedIndex}
								onChange={event => setDeleteAdvisedIndex(event.target.checked)}
							/>
						)}
						label="Delete advised index"
					/>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setConfirmAdvice(null)}>Cancel</Button>
					<Button variant="contained" onClick={handleRunCreateIndex} disabled={Boolean(nameError)}>Run</Button>
				</DialogActions>
			</Dialog>

			<Dialog open={Boolean(deleteAdvice)} onClose={() => setDeleteAdvice(null)} maxWidth="sm" fullWidth>
				<DialogTitle>Delete Index Advice</DialogTitle>
				<DialogContent>
					<DialogContentText>
						Delete this index advice recommendation on <b>{deleteAdvice?.keyColumnsAdvised}</b>? This cannot be undone.
					</DialogContentText>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setDeleteAdvice(null)}>Cancel</Button>
					<Button variant="contained" color="error" onClick={handleConfirmDelete}>Delete</Button>
				</DialogActions>
			</Dialog>
		</Stack>
	);
}
