import { useEffect, useMemo, useState } from 'react';
import { Stack } from '@mui/material';
import type { CellContext, ColumnDef, SortingState } from '@tanstack/react-table';
import { getCoreRowModel, getFilteredRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table';
import type { ResolvedColumn } from '../../../src/schema-conversion/schema-format-converter';
import type { SchemasInboundMessage } from '../../../src/webview-messages/schemas-messages';
import type { DbErrorUtils } from '../../../src/utils/db-error-utils';
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

// Not part of the underlying data - excluded from DataTable's own export via excludeColumnIdsFromExport
// below, and only shown at all when hasImportedData (below).
const FLAGS_COLUMN: ColumnDef<ResolvedColumn> = {
	id: 'flags',
	header: '',
	cell: (info: CellContext<ResolvedColumn, unknown>) => info.row.original.isNew ? <ImportBadge kind="new" /> : null
};

// Deliberately just the fields requested for the tab today - SystemColumn also carries fields
// (hasDefault, hidden, updatable) reserved for a future edit-column/ALTER TABLE feature that
// aren't shown here yet.
const BASE_COLUMN_DEFS: ColumnDef<ResolvedColumn>[] = [
	{ accessorKey: 'colNo', header: '#' },
	{ accessorKey: 'sqlName', header: 'Name' },
	{ accessorKey: 'systemName', header: 'System Name' },
	{ accessorKey: 'heading', header: 'Heading' },
	{
		accessorKey: 'text',
		header: 'Text',
		// Only ever set when DB2's own Text was blank and an import filled it in (see table-resolver.ts's
		// mergeConnectedColumn) - flagged inline since it's a per-field, not per-row, provenance signal
		// and the leading flags column above only ever speaks to the whole row.
		cell: (info: CellContext<ResolvedColumn, unknown>) => (
			<Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
				<span>{info.getValue<string | undefined>()}</span>
				{info.row.original.importedFields.includes('text') && (
					<ImportBadge kind="imported" tooltip="This text came from an imported file - DB2 itself has no comment on this column" />
				)}
			</Stack>
		)
	},
	{ accessorKey: 'dataType', header: 'Type' },
	{ accessorKey: 'length', header: 'Length' },
	{ accessorKey: 'scale', header: 'Scale' },
	{ accessorKey: 'precision', header: 'Precision' },
	{ accessorKey: 'nulls', header: 'Nulls' },
	{ accessorKey: 'defaultValue', header: 'Default Value' },
	{ accessorKey: 'identity', header: 'Identity' },
	{ accessorKey: 'generated', header: 'Generated' },
	{ accessorKey: 'identityStart', header: 'Start' },
	{ accessorKey: 'increment', header: 'Increment' },
	{ accessorKey: 'minValue', header: 'Min Value' },
	{ accessorKey: 'maxValue', header: 'Max Value' },
	{ accessorKey: 'cycle', header: 'Cycle' },
	{ accessorKey: 'cache', header: 'Cache' },
	{ accessorKey: 'ccsid', header: 'CCSID' }
];

export function ColumnsTab({ table, hasImportedData }: Props) {
	const [columns, setColumns] = useState<ResolvedColumn[] | null>(null);
	const [error, setError] = useState<DbErrorUtils.SerializedError | null>(null);
	const [sorting, setSorting] = useState<SortingState>([]);

	// The host caches by schema/table (MemoryCache.getColumns, shared with autocomplete), so
	// re-requesting on every mount (e.g. switching back to this sub-tab) is cheap.
	useEffect(() => {
		setColumns(null);
		setError(null);

		function onMessage(event: MessageEvent<SchemasInboundMessage>) {
			let message = event.data;

			if (message.schema !== table.schema || message.table !== table.name) {
				return;
			}

			if (message.command === 'columnsLoaded') {
				setColumns(message.columns);
			} else if (message.command === 'columnsError') {
				setError(message.error);
			}
		}

		window.addEventListener('message', onMessage);
		schemasVsCodeApi.postMessage({ command: 'loadColumns', schema: table.schema, table: table.name });
		return () => window.removeEventListener('message', onMessage);
	}, [table.schema, table.name]);

	function handleRefresh() {
		setColumns(null);
		setError(null);
		schemasVsCodeApi.postMessage({ command: 'loadColumns', schema: table.schema, table: table.name, forceRefresh: true });
	}

	const columnDefs = useMemo<ColumnDef<ResolvedColumn>[]>(
		() => hasImportedData ? [FLAGS_COLUMN, ...BASE_COLUMN_DEFS] : BASE_COLUMN_DEFS,
		[hasImportedData]
	);

	const reactTable = useReactTable({
		data: columns ?? [],
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
				<SqlErrorDisplay error={error} label="Failed to load columns" />
			</Stack>
		);
	}

	if (!columns) {
		return <Loading message="Loading columns..." />;
	}

	return (
		<Stack sx={{ height: '100%', minHeight: 0 }}>
			<DataTable table={reactTable} onRefresh={handleRefresh} excludeColumnIdsFromExport={['flags']} />
		</Stack>
	);
}
