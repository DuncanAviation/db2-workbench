import type { ReactNode } from 'react';
import { Typography } from '@mui/material';
import type { ColumnDef } from '@tanstack/react-table';
import type { Row } from '../../../src/interfaces/row';
import { ColumnNameUtils } from '../../../src/utils/column-name-utils';

const MAX_CELL_WIDTH = 300;
const MIN_COLUMN_WIDTH = 60;
const CELL_HORIZONTAL_PADDING = 32; // MUI TableCell size="small" horizontal padding (16px each side)
const HEADER_SORT_ICON_ALLOWANCE = 28; // Room for TableSortLabel's arrow icon on sortable columns
// Row virtualization only renders whatever's currently scrolled into view, so column widths must be
// derived from the full loaded dataset up front (via table-layout: fixed) rather than left to the
// browser's normal auto layout, which would otherwise resize columns as different rows scroll by.
// Ellipsis truncation already covers any value this misses, so this just bounds the cost of the
// measurement pass against a very large "fetch all"/loaded result set.
const MAX_ROWS_TO_MEASURE = 2000;

// Shared by the results grid's DataTab and the schema browser's Data tab - both render a possibly
// large, virtualized row set with the same multi-line-header/nowrap/ellipsis conventions, so the
// width-measurement and ColumnDef-building logic lives here once instead of twice.
//
// Header labels are measured at headerFontWeight, not the body's normal weight - MUI renders head cells
// at fontWeightMedium, and measuring them at 400 left a column whose header is its widest text a few
// pixels too narrow, so the header got an ellipsis.
export function measureColumnWidths(font: string, headerFontWeight: number | string | undefined, columns: string[], columnLabels: Record<string, string[]>, rows: Row[]): Record<string, number> {
	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d');

	if (!ctx) {
		return {};
	}

	const headerFont = headerFontWeight != null ? `${headerFontWeight} ${font}` : font;
	const sampleRows = rows.slice(0, MAX_ROWS_TO_MEASURE);
	const widths: Record<string, number> = {};

	ctx.font = headerFont;
	const headerWidths = columns.map(col => Math.max(...ColumnNameUtils.labelsForKey(columnLabels, col).map(part => ctx.measureText(part).width)));

	ctx.font = font;

	for (const [index, col] of columns.entries()) {
		let maxTextWidth = headerWidths[index] + HEADER_SORT_ICON_ALLOWANCE;

		for (const row of sampleRows) {
			const value = row[col];
			const text = value === null || value === undefined ? '<null>' : String(value);
			const textWidth = ctx.measureText(text).width;

			if (textWidth > maxTextWidth) {
				maxTextWidth = textWidth;
			}
		}

		widths[col] = Math.min(MAX_CELL_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.ceil(maxTextWidth + CELL_HORIZONTAL_PADDING)));
	}

	return widths;
}

export interface BuildRowColumnsOptions {
	// Columns rendered as a size placeholder (via renderLobCell) instead of their raw value - the
	// schema browser's Data tab uses this for BLOB/CLOB/DBCLOB columns, whose "value" is actually a
	// byte length (see DbConnections.listTableData); omit for a plain results grid where every
	// column holds its real value.
	lobColumns?: Set<string>;
	renderLobCell?: (byteLength: unknown) => ReactNode;
	// Columns whose body cells are right-aligned (headers stay left-aligned), so their digits line up - see
	// FieldUtils.isNumericType. Omit to leave every column left-aligned.
	numericColumns?: Set<string>;
}

export function buildRowColumns(columns: string[], columnLabels: Record<string, string[]>, columnWidths: Record<string, number>, options?: BuildRowColumnsOptions): ColumnDef<Row>[] {
	return columns.map(col => {
		const labelParts = ColumnNameUtils.labelsForKey(columnLabels, col);
		const isLob = options?.lobColumns?.has(col) ?? false;

		return {
			id: col,
			size: columnWidths[col],
			// LOB columns show a size placeholder, not their real value (see renderLobCell below) -
			// sorting/searching by that placeholder wouldn't be meaningful. No-op for consumers (e.g.
			// the results grid) that never mark any column as LOB.
			enableSorting: !isLob,
			meta: options?.numericColumns?.has(col) ? { align: 'right' } : undefined,
			// accessorFn (exact key lookup) instead of accessorKey - accessorKey treats a "." in the
			// key as a nested-path separator, so a real DB2 column name containing one (e.g. an
			// unaliased qualified column/expression) would resolve to undefined instead of its value.
			accessorFn: row => row[col],
			// Wrapped in one enclosing div rather than returning the parts as siblings - a sortable
			// column's header renders straight inside MUI's TableSortLabel, whose root is an inline
			// flex row, so bare sibling divs would lay out side by side instead of stacking. One level
			// of nesting puts them back under normal (non-flex) block layout.
			header: () => (
				<div>
					{labelParts.map((part, index) => <div key={index}>{part}</div>)}
				</div>
			),
			cell: info => {
				const value = info.getValue();

				if (value === null || value === undefined) {
					return <Typography component="span" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>&lt;null&gt;</Typography>;
				}

				if (isLob && options?.renderLobCell) {
					return options.renderLobCell(value);
				}

				if (value === '') {
					// An empty string renders no text node, so the cell establishes no CSS line box and the
					// whole row collapses to just the TableCell's vertical padding - visibly shorter than a
					// row where every cell has real content. A non-breaking space preserves the row's normal
					// height while still rendering visually blank.
					return ' ';
				}

				return info.renderValue<ReactNode>();
			}
		};
	});
}
