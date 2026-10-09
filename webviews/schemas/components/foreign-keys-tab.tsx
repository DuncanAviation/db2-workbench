import { useEffect, useMemo, useState } from 'react';
import { Stack } from '@mui/material';
import type { CellContext, ColumnDef, SortingState } from '@tanstack/react-table';
import { getCoreRowModel, getFilteredRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table';
import type { ResolvedForeignKey } from '../../../src/schema-conversion/schema-format-converter';
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
const FLAGS_COLUMN: ColumnDef<ResolvedForeignKey> = {
	id: 'flags',
	header: '',
	// A whole-row flag, not a per-field one - identity for a foreign key is the relationship itself,
	// not a single value, so there's no partial "this cell came from an import" case here the way
	// there is for columns. See table-resolver.ts.
	cell: (info: CellContext<ResolvedForeignKey, unknown>) => info.row.original.isNew ? <ImportBadge kind="new" /> : null
};

const BASE_COLUMN_DEFS: ColumnDef<ResolvedForeignKey>[] = [
	{ accessorKey: 'constraintName', header: 'Constraint Name' },
	{ accessorKey: 'columnName', header: 'Column' },
	{ accessorKey: 'systemColumnName', header: 'System Column' },
	{ accessorKey: 'ordinalPosition', header: 'Position' },
	{ accessorKey: 'updateRule', header: 'Update Rule' },
	{ accessorKey: 'deleteRule', header: 'Delete Rule' },
	{ accessorKey: 'referencedSchema', header: 'Referenced Schema' },
	{ accessorKey: 'referencedTable', header: 'Referenced Table' },
	{ accessorKey: 'referencedColumnName', header: 'Referenced Column' },
	{ accessorKey: 'referencedSystemColumnName', header: 'Referenced System Column' }
];

export function ForeignKeysTab({ table, hasImportedData }: Props) {
	const [foreignKeys, setForeignKeys] = useState<ResolvedForeignKey[] | null>(null);
	const [error, setError] = useState<DbErrorUtils.SerializedError | null>(null);
	const [sorting, setSorting] = useState<SortingState>([]);

	// The host caches by schema/table (MemoryCache.getForeignKeys), so re-requesting on every mount
	// (e.g. switching back to this sub-tab) is cheap.
	useEffect(() => {
		setForeignKeys(null);
		setError(null);

		function onMessage(event: MessageEvent<SchemasInboundMessage>) {
			let message = event.data;

			if (message.schema !== table.schema || message.table !== table.name) {
				return;
			}

			if (message.command === 'foreignKeysLoaded') {
				setForeignKeys(message.foreignKeys);
			} else if (message.command === 'foreignKeysError') {
				setError(message.error);
			}
		}

		window.addEventListener('message', onMessage);
		schemasVsCodeApi.postMessage({ command: 'loadForeignKeys', schema: table.schema, table: table.name });
		return () => window.removeEventListener('message', onMessage);
	}, [table.schema, table.name]);

	function handleRefresh() {
		setForeignKeys(null);
		setError(null);
		schemasVsCodeApi.postMessage({ command: 'loadForeignKeys', schema: table.schema, table: table.name, forceRefresh: true });
	}

	const columnDefs = useMemo<ColumnDef<ResolvedForeignKey>[]>(
		() => hasImportedData ? [FLAGS_COLUMN, ...BASE_COLUMN_DEFS] : BASE_COLUMN_DEFS,
		[hasImportedData]
	);

	const reactTable = useReactTable({
		data: foreignKeys ?? [],
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
				<SqlErrorDisplay error={error} label="Failed to load foreign keys" />
			</Stack>
		);
	}

	if (!foreignKeys) {
		return <Loading message="Loading foreign keys..." />;
	}

	return (
		<Stack sx={{ height: '100%', minHeight: 0 }}>
			<DataTable table={reactTable} onRefresh={handleRefresh} excludeColumnIdsFromExport={['flags']} />
		</Stack>
	);
}
