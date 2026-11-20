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
import { TableLink } from './table-link';

interface Props {
	table: { schema: string; name: string };
}

// Not part of the underlying data - excluded from DataTable's own export below. Shown whenever any row
// came from an import, not by the Foreign Keys tab's hasImportedData rule: that describes THIS table's
// imports, while a referencing key comes from the child's, so a table with no import of its own can
// still be referenced by an imported relationship.
const FLAGS_COLUMN: ColumnDef<ResolvedForeignKey> = {
	id: 'flags',
	header: '',
	cell: (info: CellContext<ResolvedForeignKey, unknown>) => info.row.original.isNew ? <ImportBadge kind="new" /> : null
};

// The mirror of the Foreign Keys tab's columns: each row is a child table's key, so the child comes
// first and this table's columns are the "References" side.
const BASE_COLUMN_DEFS: ColumnDef<ResolvedForeignKey>[] = [
	{ accessorKey: 'schema', header: 'Referencing Schema' },
	{ accessorKey: 'tableName', header: 'Referencing Table', cell: info => <TableLink schema={info.row.original.schema} table={info.row.original.tableName} /> },
	{ accessorKey: 'constraintName', header: 'Constraint Name' },
	{ accessorKey: 'columnName', header: 'Column' },
	{ accessorKey: 'systemColumnName', header: 'System Column' },
	{ accessorKey: 'referencedColumnName', header: 'References Column' },
	{ accessorKey: 'referencedSystemColumnName', header: 'References System Column' },
	{ accessorKey: 'ordinalPosition', header: 'Position' },
	{ accessorKey: 'updateRule', header: 'Update Rule' },
	{ accessorKey: 'deleteRule', header: 'Delete Rule' }
];

export function ReferencedByTab({ table }: Props) {
	const [foreignKeys, setForeignKeys] = useState<ResolvedForeignKey[] | null>(null);
	const [error, setError] = useState<DbErrorUtils.SerializedError | null>(null);
	const [sorting, setSorting] = useState<SortingState>([]);

	// The host caches by referenced table (MemoryCache.getReferencingForeignKeys), so re-requesting on
	// every mount is cheap, as for the Foreign Keys tab.
	useEffect(() => {
		setForeignKeys(null);
		setError(null);

		function onMessage(event: MessageEvent<SchemasInboundMessage>) {
			let message = event.data;

			if (message.schema !== table.schema || message.table !== table.name) {
				return;
			}

			if (message.command === 'referencingForeignKeysLoaded') {
				setForeignKeys(message.foreignKeys);
			} else if (message.command === 'referencingForeignKeysError') {
				setError(message.error);
			}
		}

		window.addEventListener('message', onMessage);
		schemasVsCodeApi.postMessage({ command: 'loadReferencingForeignKeys', schema: table.schema, table: table.name });
		return () => window.removeEventListener('message', onMessage);
	}, [table.schema, table.name]);

	function handleRefresh() {
		setForeignKeys(null);
		setError(null);
		schemasVsCodeApi.postMessage({ command: 'loadReferencingForeignKeys', schema: table.schema, table: table.name, forceRefresh: true });
	}

	const hasImportedRows = !!foreignKeys?.some(foreignKey => foreignKey.isNew);

	const columnDefs = useMemo<ColumnDef<ResolvedForeignKey>[]>(
		() => hasImportedRows ? [FLAGS_COLUMN, ...BASE_COLUMN_DEFS] : BASE_COLUMN_DEFS,
		[hasImportedRows]
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
				<SqlErrorDisplay error={error} label="Failed to load referencing foreign keys" />
			</Stack>
		);
	}

	if (!foreignKeys) {
		return <Loading message="Loading referencing foreign keys..." />;
	}

	return (
		<Stack sx={{ height: '100%', minHeight: 0 }}>
			<DataTable table={reactTable} onRefresh={handleRefresh} excludeColumnIdsFromExport={['flags']} />
		</Stack>
	);
}
