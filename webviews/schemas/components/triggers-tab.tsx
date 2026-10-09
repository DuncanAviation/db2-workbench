import { useEffect, useMemo, useState } from 'react';
import { Stack } from '@mui/material';
import type { CellContext, ColumnDef, SortingState } from '@tanstack/react-table';
import { getCoreRowModel, getFilteredRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table';
import type { SchemasInboundMessage, SchemasTrigger } from '../../../src/webview-messages/schemas-messages';
import type { DbErrorUtils } from '../../../src/utils/db-error-utils';
import type { TableAction } from '../../shared/components/data-table';
import { DataTable } from '../../shared/components/data-table';
import { Loading } from '../../shared/components/loading';
import { SqlErrorDisplay } from '../../shared/components/sql-error-display';
import { schemasVsCodeApi } from '../vscode-api';
import { TriggerSourceDialog } from './trigger-source-dialog';

interface Props {
	table: { schema: string; name: string };
}

function formatDate(value: string | undefined): string {
	return value ? new Date(value).toLocaleString() : '';
}

const COLUMN_DEFS: ColumnDef<SchemasTrigger>[] = [
	{ accessorKey: 'triggerName', header: 'Trigger Name' },
	{ accessorKey: 'triggerSchema', header: 'Schema' },
	{ accessorKey: 'event', header: 'Event' },
	{ accessorKey: 'timing', header: 'Timing' },
	{ accessorKey: 'orientation', header: 'Orientation' },
	{ accessorKey: 'mode', header: 'Mode' },
	{ accessorKey: 'actionOrder', header: 'Order', meta: { align: 'right' } },
	{ accessorKey: 'enabled', header: 'Enabled' },
	{ accessorKey: 'operative', header: 'Operative' },
	{ accessorKey: 'condition', header: 'Condition' },
	{ accessorKey: 'updateCondition', header: 'Update Condition' },
	{ id: 'program', accessorFn: trigger => [trigger.programLibrary, trigger.programName].filter(Boolean).join('/'), header: 'Program' },
	{ accessorKey: 'description', header: 'Description' },
	{ accessorKey: 'remarks', header: 'Long Comment' },
	{ accessorKey: 'created', header: 'Created', cell: (info: CellContext<SchemasTrigger, unknown>) => formatDate(info.getValue<string | undefined>()) },
	{ accessorKey: 'lastAltered', header: 'Last Altered', cell: (info: CellContext<SchemasTrigger, unknown>) => formatDate(info.getValue<string | undefined>()) },
	{ accessorKey: 'definer', header: 'Definer' },
	{ accessorKey: 'oldRow', header: 'Old Row' },
	{ accessorKey: 'newRow', header: 'New Row' },
	{ accessorKey: 'oldTable', header: 'Old Table' },
	{ accessorKey: 'newTable', header: 'New Table' },
	{ accessorKey: 'allowRepeatedChange', header: 'Allow Repeated Change' },
	{ accessorKey: 'threadSafe', header: 'Threadsafe' },
	{ accessorKey: 'multithreadedJobAction', header: 'Multithreaded Job Action' },
	{ accessorKey: 'secure', header: 'Secure' }
];

// The triggers defined over a connected table (QSYS2.SYSTRIGGERS). View Source in the row menu shows an SQL
// trigger's body, or the source an external trigger's program was compiled from - see TriggerSourceDialog.
export function TriggersTab({ table }: Props) {
	const [triggers, setTriggers] = useState<SchemasTrigger[] | null>(null);
	const [error, setError] = useState<DbErrorUtils.SerializedError | null>(null);
	const [sorting, setSorting] = useState<SortingState>([]);
	const [sourceTrigger, setSourceTrigger] = useState<SchemasTrigger | null>(null);

	// The host caches by schema/table (MemoryCache.getTriggers), so re-requesting on every mount
	// (e.g. switching back to this sub-tab) is cheap.
	useEffect(() => {
		setTriggers(null);
		setError(null);

		function onMessage(event: MessageEvent<SchemasInboundMessage>) {
			let message = event.data;

			if (message.schema !== table.schema || message.table !== table.name) {
				return;
			}

			if (message.command === 'triggersLoaded') {
				setTriggers(message.triggers);
			} else if (message.command === 'triggersError') {
				setError(message.error);
			}
		}

		window.addEventListener('message', onMessage);
		schemasVsCodeApi.postMessage({ command: 'loadTriggers', schema: table.schema, table: table.name });
		return () => window.removeEventListener('message', onMessage);
	}, [table.schema, table.name]);

	function handleRefresh() {
		setTriggers(null);
		setError(null);
		schemasVsCodeApi.postMessage({ command: 'loadTriggers', schema: table.schema, table: table.name, forceRefresh: true });
	}

	const rowActions = useMemo<TableAction<SchemasTrigger>[]>(() => [
		{ label: 'View Source', appliesToSelection: false, onClick: rows => setSourceTrigger(rows[0]) }
	], []);

	const reactTable = useReactTable({
		data: triggers ?? [],
		columns: COLUMN_DEFS,
		state: { sorting },
		onSortingChange: setSorting,
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getSortedRowModel: getSortedRowModel()
	});

	if (error) {
		return (
			<Stack sx={{ p: 2 }}>
				<SqlErrorDisplay error={error} label="Failed to load triggers" />
			</Stack>
		);
	}

	if (!triggers) {
		return <Loading message="Loading triggers..." />;
	}

	return (
		<Stack sx={{ height: '100%', minHeight: 0 }}>
			{/* Always rendered, even with no rows, so Refresh stays reachable. */}
			<DataTable
				table={reactTable}
				rowActions={rowActions}
				onRefresh={handleRefresh}
				emptyMessage="No triggers found for this table"
			/>

			<TriggerSourceDialog table={table} trigger={sourceTrigger} onClose={() => setSourceTrigger(null)} />
		</Stack>
	);
}
