import { useEffect, useMemo, useRef, useState } from 'react';
import { Stack, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import type { ColumnDef, SortingState } from '@tanstack/react-table';
import { getCoreRowModel, getFilteredRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Row } from '../../../src/interfaces/row';
import { ColumnNameUtils } from '../../../src/utils/column-name-utils';
import { FieldUtils } from '../../../src/utils/field-utils';
import type { ResultsSessionDetail } from '../../../src/webview-messages/results-messages';
import type { ExportCapability, TableAction } from '../../shared/components/data-table';
import { DataTable } from '../../shared/components/data-table';
import { WarningAlert } from '../../shared/components/warning-alert';
import { buildRowColumns, measureColumnWidths } from '../../shared/utils/row-columns';
import { resultsVsCodeApi } from '../vscode-api';
import { ProcedureOutParameters } from './procedure-out-parameters';

interface Props {
	session: ResultsSessionDetail;
}

const MAX_CELL_WIDTH = 300;

export function DataTab({ session }: Props) {
	const theme = useTheme();
	const containerRef = useRef<HTMLDivElement>(null);
	const loadingRef = useRef(false);
	const prevScrollTopRef = useRef(0);
	const [sorting, setSorting] = useState<SortingState>([]);

	// Deliberately keyed on session.columns/columnLabels only, NOT session.rows - measuring off
	// whatever's loaded the moment a new result set's columns first appear, then freezing. Widening
	// this to react to every subsequent Load More/fetch all batch would make columns visibly resize
	// as more rows arrive while scrolling, which is exactly what fixedLayout is meant to prevent.
	// Any value too long for the frozen width still degrades gracefully via the ellipsis/title
	// truncation below, so this trades a perfectly-fitted width for one that never moves.
	const columnWidths = useMemo(
		() => measureColumnWidths(`${theme.typography.fontSize}px ${theme.typography.fontFamily}`, theme.typography.fontWeightMedium, session.columns, session.columnLabels, session.rows),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[theme.typography.fontSize, theme.typography.fontFamily, theme.typography.fontWeightMedium, session.columns, session.columnLabels]
	);

	const numericColumns = useMemo(
		() => new Set(session.columns.filter(column => FieldUtils.isNumericType(session.columnDataTypes[column]))),
		[session.columns, session.columnDataTypes]
	);

	const columns = useMemo<ColumnDef<Row>[]>(
		() => buildRowColumns(session.columns, session.columnLabels, columnWidths, { numericColumns }),
		[session.columns, session.columnLabels, columnWidths, numericColumns]
	);

	const table = useReactTable({
		data: session.rows,
		columns,
		state: { sorting },
		onSortingChange: setSorting,
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getSortedRowModel: getSortedRowModel()
	});

	const rows = table.getRowModel().rows;

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => containerRef.current,
		estimateSize: () => 32,
		overscan: 10
	});

	// A new fetch batch means the extension host has responded - allow another loadMore trigger.
	useEffect(() => {
		loadingRef.current = false;
	}, [session.rows.length]);

	function handleScroll() {
		const element = containerRef.current;

		if (!element) {
			return;
		}

		// The scroll event fires for horizontal movement too - only respond when scrollTop itself moved.
		let scrolledVertically = element.scrollTop !== prevScrollTopRef.current;
		prevScrollTopRef.current = element.scrollTop;

		if (!scrolledVertically || !session.isCursorOpen || loadingRef.current) {
			return;
		}

		if (element.scrollTop + element.clientHeight >= element.scrollHeight - 100) {
			loadingRef.current = true;
			resultsVsCodeApi.postMessage({ command: 'loadMore' });
		}
	}

	function handleFetchAllToggle() {
		if (session.isFetchingAll) {
			resultsVsCodeApi.postMessage({ command: 'cancelFetchAll' });
		} else {
			resultsVsCodeApi.postMessage({ command: 'fetchAll' });
		}
	}

	// Same message the Parameters tab's Execute button posts - the host re-runs whatever statement(s)
	// last ran for this session (Commands.lastAttemptedSqlsByUri), which is exactly "refresh".
	function handleRefresh() {
		resultsVsCodeApi.postMessage({ command: 'executeSql' });
	}

	// Doesn't consume the rows argument - fetching more of the result set operates on the whole
	// connection, not on any row selection - so it's marked appliesToSelection so it's never
	// auto-disabled by how many rows happen to be selected.
	const tableActions: TableAction<Row>[] = session.isCursorOpen || session.isFetchingAll
		? [{ label: session.isFetchingAll ? 'Cancel fetching...' : 'Fetch all', appliesToSelection: true, onClick: handleFetchAllToggle }]
		: [];

	// Hands the default Export action's dialog off to the host: only the host can fetch the
	// remaining cursor rows ("All results") or show a native Save As dialog ("Save to file").
	const exportCapability: ExportCapability<Row> = {
		canExportAll: session.isCursorOpen,
		onExport: ({ what, format, destination, filteredRows, selectedRows }) => {
			resultsVsCodeApi.postMessage({
				command: 'exportData',
				destination,
				what,
				format,
				filteredRows: what === 'filtered' ? filteredRows : undefined,
				selectedRows: what === 'selected' ? selectedRows : undefined
			});
		}
	};

	const duplicateColumnsWarning = session.duplicateColumns && session.duplicateColumns.length > 0 && (
		<WarningAlert sx={{ flexShrink: 0 }}>
			Duplicate column name{session.duplicateColumns.length > 1 ? 's' : ''} in this result set: {session.duplicateColumns.map(key => ColumnNameUtils.labelForKey(session.columnLabels, key)).join(', ')}.
			{' '}This is a known database driver limitation - only the last matching column's values are shown for each duplicated name.
		</WarningAlert>
	);

	if (session.rows.length === 0) {
		return (
			<Stack sx={{ height: '100%', minHeight: 0 }}>
				{duplicateColumnsWarning}
				<ProcedureOutParameters parameters={session.procedureOutParameters} />
				<Typography sx={{ p: 2 }}>No data to display</Typography>
			</Stack>
		);
	}

	return (
		<Stack sx={{ height: '100%', minHeight: 0 }}>
			{duplicateColumnsWarning}
			<ProcedureOutParameters parameters={session.procedureOutParameters} />

			<DataTable
				table={table}
				maxCellWidth={MAX_CELL_WIDTH}
				containerRef={containerRef}
				onScroll={handleScroll}
				virtualizer={virtualizer}
				tableActions={tableActions}
				onRefresh={handleRefresh}
				exportCapability={exportCapability}
			/>
		</Stack>
	);
}
