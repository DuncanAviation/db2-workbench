import { useEffect, useMemo, useState } from 'react';
import {
	Button,
	Dialog,
	DialogActions,
	DialogContent,
	DialogContentText,
	DialogTitle,
	Stack,
	TextField
} from '@mui/material';
import type { CellContext, ColumnDef, SortingState } from '@tanstack/react-table';
import { getCoreRowModel, getFilteredRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table';
import { IndexAdviceUtils } from '../../../src/utils/index-advice-utils';
import type { ResolvedIndex } from '../../../src/schema-conversion/schema-format-converter';
import type { SchemasInboundMessage } from '../../../src/webview-messages/schemas-messages';
import type { DbErrorUtils } from '../../../src/utils/db-error-utils';
import type { TableAction } from '../../shared/components/data-table';
import { DataTable } from '../../shared/components/data-table';
import { ImportBadge } from '../../shared/components/import-badge';
import { Loading } from '../../shared/components/loading';
import { SqlErrorDisplay } from '../../shared/components/sql-error-display';
import { schemasVsCodeApi } from '../vscode-api';

interface Props {
	table: { schema: string; name: string };
	/** Whether this table's TableDetail header shows an Imported/Enhanced badge - see table-detail.tsx.
	 * The flags column below is only ever non-blank in that case, so it's only shown then. */
	hasImportedData: boolean;
}

function formatDate(value: string | null | undefined): string {
	return value ? new Date(value).toLocaleString() : '';
}

// DROP/RENAME INDEX only make sense for a real, existing SQL index - an imported (isNew) row has no
// underlying object to rename/drop at all, and indexOwner is null/absent for logical files and
// constraint-backed indexes too (see SystemIndex.indexOwner).
function isSqlIndex(index: ResolvedIndex): boolean {
	return !index.isNew && !!index.indexOwner;
}

function buildDropIndexSql(index: ResolvedIndex): string {
	return `DROP INDEX ${index.indexSchema}.${index.indexName}`;
}

function buildRenameIndexSql(index: ResolvedIndex, newName: string): string {
	return `RENAME INDEX ${index.indexSchema}.${index.indexName} TO ${newName}`;
}

export function IndexesTab({ table, hasImportedData }: Props) {
	const [indexes, setIndexes] = useState<ResolvedIndex[] | null>(null);
	const [error, setError] = useState<DbErrorUtils.SerializedError | null>(null);
	const [sorting, setSorting] = useState<SortingState>([]);
	const [deleteIndex, setDeleteIndex] = useState<ResolvedIndex | null>(null);
	const [renameState, setRenameState] = useState<{ index: ResolvedIndex; newName: string } | null>(null);

	// Mirrors AdvisedIndexesTab/ColumnsTab's lazy-load-on-mount pattern.
	useEffect(() => {
		setIndexes(null);
		setError(null);

		function onMessage(event: MessageEvent<SchemasInboundMessage>) {
			let message = event.data;

			if (message.schema !== table.schema || message.table !== table.name) {
				return;
			}

			if (message.command === 'indexesLoaded') {
				setIndexes(message.indexes);
				setError(null);
			} else if (message.command === 'indexesError') {
				setError(message.error);
			}
		}

		window.addEventListener('message', onMessage);
		schemasVsCodeApi.postMessage({ command: 'loadIndexes', schema: table.schema, table: table.name });
		return () => window.removeEventListener('message', onMessage);
	}, [table.schema, table.name]);

	function handleRefresh() {
		setIndexes(null);
		setError(null);
		schemasVsCodeApi.postMessage({ command: 'loadIndexes', schema: table.schema, table: table.name, forceRefresh: true });
	}

	function handleOpenDelete(index: ResolvedIndex) {
		setDeleteIndex(index);
	}

	function handleConfirmDelete() {
		if (!deleteIndex) {
			return;
		}

		schemasVsCodeApi.postMessage({
			command: 'deleteIndex',
			schema: table.schema,
			table: table.name,
			sql: buildDropIndexSql(deleteIndex)
		});

		setDeleteIndex(null);
	}

	function handleOpenRename(index: ResolvedIndex) {
		setRenameState({ index, newName: index.indexName ?? '' });
	}

	// Only the length is validated per IndexAdviceUtils.MAX_INDEX_NAME_LENGTH (Db2 for i's SQL
	// identifier limit) - anything else invalid about the name (bad characters, etc.) surfaces as a
	// normal DB2 error in this session's History tab, same as any other generated statement.
	const renameError = useMemo(() => {
		if (!renameState) {
			return null;
		}

		let trimmed = renameState.newName.trim();

		if (!trimmed) {
			return 'Name is required';
		}

		if (trimmed.length > IndexAdviceUtils.MAX_INDEX_NAME_LENGTH) {
			return `Name must be ${IndexAdviceUtils.MAX_INDEX_NAME_LENGTH} characters or fewer`;
		}

		return null;
	}, [renameState]);

	function handleConfirmRename() {
		if (!renameState || renameError) {
			return;
		}

		schemasVsCodeApi.postMessage({
			command: 'renameIndex',
			schema: table.schema,
			table: table.name,
			sql: buildRenameIndexSql(renameState.index, renameState.newName.trim())
		});

		setRenameState(null);
	}

	const columnDefs = useMemo<ColumnDef<ResolvedIndex>[]>(() => [
		...(hasImportedData ? [{
			id: 'flags',
			header: '',
			// Not part of the underlying data - excluded from DataTable's own export via
			// excludeColumnIdsFromExport below.
			cell: (info: CellContext<ResolvedIndex, unknown>) => info.row.original.isNew ? <ImportBadge kind="new" /> : null
		} as ColumnDef<ResolvedIndex>] : []),
		{ accessorKey: 'indexName', header: 'Index Name' },
		{ accessorKey: 'indexSchema', header: 'Schema' },
		{ accessorKey: 'partition', header: 'Partition' },
		{ accessorKey: 'indexType', header: 'Index Type' },
		{ accessorKey: 'uniqueness', header: 'Unique' },
		{ accessorKey: 'keyColumns', header: 'Key Columns' },
		{ accessorKey: 'size', header: 'Size' },
		{ accessorKey: 'created', header: 'Created', cell: (info: CellContext<ResolvedIndex, unknown>) => formatDate(info.getValue<string | null>()) },
		{ accessorKey: 'lastBuild', header: 'Last Build', cell: (info: CellContext<ResolvedIndex, unknown>) => formatDate(info.getValue<string | null>()) },
		{ accessorKey: 'lastQueryUsed', header: 'Last Query Used', cell: (info: CellContext<ResolvedIndex, unknown>) => formatDate(info.getValue<string | null>()) },
		{ accessorKey: 'queryUseCount', header: 'Query Use Count' },
		{ accessorKey: 'queryStatisticsUseCount', header: 'Query Statistics Use Count' },
		{ accessorKey: 'lastUsed', header: 'Last Used', cell: (info: CellContext<ResolvedIndex, unknown>) => formatDate(info.getValue<string | null>()) },
		{ accessorKey: 'comment', header: 'Comment' },
		{ accessorKey: 'indexOwner', header: 'Owner' }
	], [hasImportedData]);

	// Both single-row only. DROP/RENAME INDEX only make sense for an actual, existing SQL index (see
	// isSqlIndex) - rather than hiding the actions button for a row that isn't one, both items are just
	// disabled for it, since the shared actions column always shows the button.
	const rowActions: TableAction<ResolvedIndex>[] = [
		{ label: 'Rename', appliesToSelection: false, disabled: rows => !isSqlIndex(rows[0]), onClick: rows => handleOpenRename(rows[0]) },
		{ label: 'Delete', appliesToSelection: false, disabled: rows => !isSqlIndex(rows[0]), onClick: rows => handleOpenDelete(rows[0]) }
	];

	const reactTable = useReactTable({
		data: indexes ?? [],
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
				<SqlErrorDisplay error={error} label="Failed to load indexes" />
			</Stack>
		);
	}

	if (!indexes) {
		return <Loading message="Loading indexes..." />;
	}

	return (
		<Stack sx={{ height: '100%', minHeight: 0 }}>
			{/* Always rendered, even with no rows, so Refresh stays reachable - an index created after
			    this tab opened would otherwise never show up without reopening the table. */}
			<DataTable
				table={reactTable}
				rowActions={rowActions}
				onRefresh={handleRefresh}
				excludeColumnIdsFromExport={['flags']}
				emptyMessage="No indexes found for this table"
			/>

			<Dialog open={Boolean(deleteIndex)} onClose={() => setDeleteIndex(null)} maxWidth="sm" fullWidth>
				<DialogTitle>Delete Index</DialogTitle>
				<DialogContent>
					<DialogContentText>
						Delete index <b>{deleteIndex?.indexSchema}.{deleteIndex?.indexName}</b>? This cannot be undone.
					</DialogContentText>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setDeleteIndex(null)}>Cancel</Button>
					<Button variant="contained" color="error" onClick={handleConfirmDelete}>Delete</Button>
				</DialogActions>
			</Dialog>

			<Dialog open={Boolean(renameState)} onClose={() => setRenameState(null)} maxWidth="sm" fullWidth>
				<DialogTitle>Rename Index</DialogTitle>
				<DialogContent>
					<TextField
						autoFocus
						fullWidth
						label="Name"
						value={renameState?.newName ?? ''}
						onChange={event => renameState && setRenameState({ ...renameState, newName: event.target.value })}
						error={Boolean(renameError)}
						helperText={renameError ?? `${(renameState?.newName ?? '').trim().length}/${IndexAdviceUtils.MAX_INDEX_NAME_LENGTH}`}
					/>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setRenameState(null)}>Cancel</Button>
					<Button variant="contained" disabled={Boolean(renameError)} onClick={handleConfirmRename}>Rename</Button>
				</DialogActions>
			</Dialog>
		</Stack>
	);
}
