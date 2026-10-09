import { useMemo, useState } from 'react';
import { Stack } from '@mui/material';
import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { getCoreRowModel, getFilteredRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table';
import type { SchemasRoutineParam, SchemasSystemRoutine } from '../../../src/webview-messages/schemas-messages';
import { DataTable } from '../../shared/components/data-table';
import { Loading } from '../../shared/components/loading';
import { SqlErrorDisplay } from '../../shared/components/sql-error-display';
import { routineNoun, useRoutineParams } from './routine-data';
import { describeDataType } from './routine-info-tab';

interface Props {
	routine: SchemasSystemRoutine;
	/** 'P' for the Parameters tab, 'R' for a table function's Result Columns tab. */
	rowType: 'P' | 'R';
}

const PARAMETER_COLUMNS: ColumnDef<SchemasRoutineParam>[] = [
	{ accessorKey: 'position', header: 'Position', meta: { align: 'right' } },
	{ accessorKey: 'name', header: 'Name' },
	{ accessorKey: 'parameterMode', header: 'Mode' },
	{ id: 'type', accessorFn: param => describeDataType(param), header: 'Type' },
	{ accessorKey: 'default', header: 'Default' },
	{ accessorKey: 'description', header: 'Description' }
];

// A result column has no mode or default - those only mean something for an argument.
const RESULT_COLUMNS: ColumnDef<SchemasRoutineParam>[] = [
	{ accessorKey: 'position', header: 'Position', meta: { align: 'right' } },
	{ accessorKey: 'name', header: 'Name' },
	{ id: 'type', accessorFn: param => describeDataType(param), header: 'Type' },
	{ accessorKey: 'description', header: 'Description' }
];

// One tab for both of a routine's SYSPARMS row kinds: its parameters, and a table function's result
// columns. Both read the same cached rows (useRoutineParams), so switching between them costs nothing.
export function RoutineParamsTab({ routine, rowType }: Props) {
	const params = useRoutineParams({ schema: routine.schema, specificName: routine.specificName });
	const [sorting, setSorting] = useState<SortingState>([]);
	const rows = useMemo(() => (params.value ?? []).filter(param => param.rowType === rowType), [params.value, rowType]);

	const reactTable = useReactTable({
		data: rows,
		columns: rowType === 'P' ? PARAMETER_COLUMNS : RESULT_COLUMNS,
		state: { sorting },
		onSortingChange: setSorting,
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getSortedRowModel: getSortedRowModel()
	});

	if (params.error) {
		return (
			<Stack sx={{ p: 2 }}>
				<SqlErrorDisplay error={params.error} label={rowType === 'P' ? 'Failed to load parameters' : 'Failed to load result columns'} />
			</Stack>
		);
	}

	if (!params.value) {
		return <Loading message={rowType === 'P' ? 'Loading parameters...' : 'Loading result columns...'} />;
	}

	return (
		<Stack sx={{ height: '100%', minHeight: 0 }}>
			<DataTable
				table={reactTable}
				onRefresh={params.refresh}
				emptyMessage={rowType === 'P' ? `This ${routineNoun(routine)} takes no parameters` : 'No result columns found for this function'}
			/>
		</Stack>
	);
}
