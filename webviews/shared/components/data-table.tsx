import {
	Button,
	Chip,
	Divider,
	IconButton,
	InputAdornment,
	ListItemText,
	Menu,
	MenuItem,
	Stack,
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableRow,
	TableSortLabel,
	TextField,
	Tooltip
} from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import { alpha, decomposeColor, recomposeColor, useTheme } from '@mui/material/styles';
import type { Row, RowData, Table as ReactTable } from '@tanstack/react-table';
import { flexRender } from '@tanstack/react-table';
import type { Virtualizer } from '@tanstack/react-virtual';
import type { MouseEvent, ReactNode, RefObject, UIEvent } from 'react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Row as DataRow } from '../../../src/interfaces/row';
import type { ColumnDetails } from '../../../src/utils/column-details';
import { ColumnDetailsUtils } from '../../../src/utils/column-details';
import type { ExportDestination, ExportFormat, ExportWhat } from '../../../src/utils/export-utils';
import { ExportUtils } from '../../../src/utils/export-utils';
import type { ButtonGroupAction } from './button-group';
import { ButtonGroup, flattenActions } from './button-group';
import { ContextMenu } from './context-menu';
import { ExportDialog } from './export-dialog';
import { TooltipLines } from './tooltip-lines';

declare module '@tanstack/react-table' {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	interface ColumnMeta<TData extends RowData, TValue> {
		/** Horizontal alignment of the column's body cells - 'right' for a numeric column, so its digits
		 * line up. Headers always stay left-aligned. Omitted means MUI's default (left). */
		align?: 'left' | 'right';
		/** What the column's header tooltip and its Copy Name / Copy Long Name / Copy Description
		 * right-click menu describe - set for a column that is a database column (the results grid, the
		 * schema browser's Data tab), never for a fixed heading like the Columns tab's "Type". */
		details?: ColumnDetails;
	}
}

export interface TableAction<TData> {
	label: string;
	icon?: ReactNode;
	// false = only ever operates on exactly one row at a time - auto-disabled whenever more than
	// one row is targeted. true = row-count-agnostic: covers both a genuinely multi-row-capable
	// action and one (e.g. Export, Refresh) that doesn't consume the target rows at all.
	appliesToSelection: boolean;
	onClick: (rows: TData[]) => void;
	disabled?: (rows: TData[]) => boolean;
	/** Shown as a tooltip only while disabled - e.g. explaining why "Add Row" is unavailable for a
	 * non-insertable view. Ignored while the action is enabled. */
	disabledReason?: (rows: TData[]) => string | undefined;
	/** Table actions only: other ways of doing the same thing, e.g. "Add Row in Dialog" beside "Add Row".
	 * The toolbar shows a split button; a menu lists them as items right after this one. */
	secondaryActions?: TableAction<TData>[];
}

// A generic, removable chip describing some externally-applied filter/search criterion (e.g. one
// condition of the Data tab's Edit Search) - DataTable only knows how to render it and call back on
// removal, not what it represents. Consumers own building/rebuilding whatever underlying query state
// a removal implies.
export interface FilterChip {
	key: string;
	label: string;
	/** Shown in a tooltip on hover - the full criteria detail. Falls back to `label` if omitted. */
	tooltip?: string;
	onRemove: () => void;
}

export interface ExportRequest<TData> {
	what: ExportWhat;
	format: ExportFormat;
	destination: ExportDestination;
	// Only meaningful when what === 'filtered' - DataTable has no visibility into a consumer's own
	// message-passing/host access, so it resolves the filtered rows itself and hands them over here.
	filteredRows: TData[];
	// Only meaningful when what === 'selected' - same reasoning as filteredRows above.
	selectedRows: TData[];
}

// A fixed list for a consumer whose row actions never depend on which row they'd apply to (e.g.
// AdvisedIndexesTab), or a function for one whose actions depend on the specific target row(s) (e.g.
// TableDataTab: a plain row offers Edit Row/Delete Row, a row with a pending statement offers only
// its matching Cancel action instead) - called with the same resolved target row(s) resolveActionRows
// already computes for a fixed list, at the point the row's "..." menu or right-click menu opens.
export type RowActionsSource<TData> = TableAction<TData>[] | ((rows: TData[]) => TableAction<TData>[]);

export interface ExportCapability<TData> {
	// Enables the "All results" radio in the Export dialog - e.g. a still-open cursor whose remaining
	// rows haven't been fetched into the table yet.
	canExportAll?: boolean;
	// Takes over exporting entirely (fetching remaining rows first if requested, building the
	// CSV/JSON, and delivering it to the chosen destination) instead of DataTable's own built-in
	// client-side export - needed for the "All results" option (fetching remaining cursor rows is a
	// host-only operation) or to reuse column headings the host already resolved. Omit this prop for
	// tables with nothing host-specific to add: DataTable exports Loaded/Filtered rows as CSV/JSON to
	// the clipboard or a downloaded file entirely on its own.
	onExport: (request: ExportRequest<TData>) => void;
}

interface Props<TData> {
	table: ReactTable<TData>;
	// When set, cell content is truncated with an ellipsis (and a title tooltip with the full value)
	// at this pixel width instead of the default nowrap/horizontal-scroll behavior - used by the
	// results grid, whose columns can hold long text/CLOB-like values.
	maxCellWidth?: number;
	// Row virtualization for large row counts (e.g. the results grid). Pass a container ref and a
	// @tanstack/react-virtual instance built from table.getRowModel().rows.length; DataTable renders
	// only the virtualizer's visible window, padded with spacer rows for the rest of the scroll height.
	// Whenever this is set, DataTable also locks each column to its columnDef.size via a <colgroup>
	// instead of the browser's default content-based auto layout - with only the visible row window in
	// the DOM, auto layout resizes columns to fit whatever rows happen to be rendered, so columns
	// visibly jump width while scrolling. The consumer is responsible for setting a sensible `size` per
	// column (e.g. measured from the full loaded dataset) since defaultColumn.size (150) is too generic
	// on its own.
	containerRef?: RefObject<HTMLDivElement | null>;
	onScroll?: (event: UIEvent<HTMLDivElement>) => void;
	virtualizer?: Virtualizer<HTMLDivElement, Element>;
	// Per-row actions, rendered from a sticky "..." menu button frozen to the right edge of the
	// table (and from the row right-click context menu). Requires no consumer-defined 'actions'
	// column - DataTable renders this column itself. See RowActionsSource for the function form.
	rowActions?: RowActionsSource<TData>;
	// Actions for the one cell that was right-clicked, listed at the top of the context menu above a
	// divider from the row actions - e.g. the Data tab's "Set NULL" on an edit field. Never in the
	// "..." menu, which has no cell. Applies to that cell's row only, whatever else is selected, so
	// onClick gets exactly that row.
	cellActions?: (row: TData, columnId: string) => TableAction<TData>[];
	// Per-row sx, merged in after the row's own background-color sx (so a consumer's border/strike-
	// through styling can't be clobbered by the zebra-stripe/selection background, but also can't
	// clobber it back - keep to properties (border, textDecoration, ...) that don't collide with
	// bgcolor). Called for every rendered row, not just ones with something to show - return
	// undefined for a plain row.
	rowSx?: (row: TData) => SxProps<Theme> | undefined;
	// Opts into memoized body rows: a rendered row then re-renders only when its row data object
	// (row.original, by identity), its selection/stripe background, the column defs, or this key
	// changes - not on every render of the table. Without it, every visible row re-renders every
	// time, which is fine for plain text but not for a grid of inline-edit inputs, where one keystroke
	// would otherwise re-render every visible input. A caller passing this promises its cells and
	// rowSx depend only on row.original and whatever this key captures (e.g. the row's pending-edit
	// state, or a flag that disables every input).
	rowRenderKey?: (row: TData) => unknown;
	// Table-level actions, rendered as a ButtonGroup above the table (right-aligned, same row as the
	// filter) and also listed in the row right-click context menu, below a divider from row actions.
	// A set of default actions (Refresh, then Export) is always appended after these, in order, so a
	// caller's own actions keep their relative order and only ever gain new ones at the end.
	tableActions?: TableAction<TData>[];
	// Table actions listed after the defaults (Refresh, Export...) rather than before them - e.g. the Data
	// tab's "Settings...", which belongs last. Past ButtonGroup's visible-button limit they fall into its
	// "⋮" menu like any other action.
	trailingTableActions?: TableAction<TData>[];
	// Adds a default "Refresh" action - unlike Export, there's no sensible built-in behavior (what
	// "refresh" means is entirely up to the consumer: re-run a query, invalidate a memory-cache entry
	// and reload, etc.), so this is only shown when supplied.
	onRefresh?: () => void;
	// Customizes the default Export action's dialog and hands it off to the host for cursor-aware
	// "All results" export and/or Save-to-file - see ExportCapability. Omit for the built-in
	// clipboard-only, Loaded/Filtered-rows default.
	exportCapability?: ExportCapability<TData>;
	// External filter/search criteria, rendered as removable chips in a row between the filter/actions
	// bar and the table - e.g. the Data tab's Edit Search conditions. Omit or pass an empty array to
	// hide the row entirely.
	filterChips?: FilterChip[];
	// "Clear all" action shown to the right of the chips - only rendered when filterChips is non-empty.
	onClearAllFilterChips?: () => void;
	// Shown as a single row spanning every column when there are no rows to render, instead of an
	// empty table body - lets a consumer keep the filter bar/chips/actions and column headers visible
	// (e.g. so "Clear" is still reachable) rather than swapping the whole table out for a message.
	// Omit for a consumer that's fine with a plain empty body under the headers.
	emptyMessage?: ReactNode;
	// Column ids to leave out of DataTable's own built-in export (CSV/JSON/clipboard) - for a UI-only
	// column (e.g. a New/Imported flag chip) that isn't part of the underlying data. Only applies to
	// the built-in `performClientExport` fallback - a consumer providing its own
	// `exportCapability.onExport` builds its own column list and isn't affected by this at all.
	excludeColumnIdsFromExport?: string[];
	// The host-built label map (ColumnNameUtils.buildLabelMap, keyed by column id) for a table whose
	// headers are rendered JSX rather than strings - the built-in export then heads each CSV column the
	// way the host-side results export does (ExportUtils.buildHeadings), following resultHeadingLabels,
	// instead of falling back to the raw column id. Like excludeColumnIdsFromExport, only applies to the
	// built-in `performClientExport` fallback.
	exportColumnLabels?: Record<string, string[]>;
}

const CELL_SX = { whiteSpace: 'nowrap' } as const;

const ACTIONS_CELL_SX = {
	...CELL_SX,
	position: 'sticky',
	right: 0,
	borderLeft: 1,
	borderColor: 'divider'
} as const;

const ACTIONS_COLUMN_WIDTH = 48;

// A database column header's right-click menu. "Name" is DB2's short system name, the one hand-written SQL
// against these files mostly uses. An item the column has no value for (a computed column has no short
// name or description) is shown disabled rather than left out, so the menu always reads the same.
const HEADER_COPY_ITEMS: { label: string; value: (details: ColumnDetails) => string | undefined }[] = [
	{ label: 'Copy Name', value: details => details.shortName },
	{ label: 'Copy Long Name', value: details => details.longName },
	{ label: 'Copy Description', value: details => details.description }
];

// theme.palette.action.hover is a translucent overlay color (e.g. rgba(0,0,0,0.04)), meant to be
// laid over a background once. That's fine for a plain zebra-striped cell, but the actions column
// is `position: sticky` and sits on top of cells scrolling underneath it - a translucent
// background there lets that underlying text bleed through. Flatten it against background.paper
// up front so every cell (including the sticky one) gets a genuinely opaque color.
function flattenOverlay(overlay: string, background: string): string {
	const o = decomposeColor(overlay);
	const b = decomposeColor(background);
	const opacity = typeof o.values[3] === 'number' ? o.values[3] : 1;
	const blendChannel = (i: number) => Math.round(o.values[i] * opacity + b.values[i] * (1 - opacity));
	const values: [number, number, number] = [blendChannel(0), blendChannel(1), blendChannel(2)];
	return recomposeColor({ type: 'rgb', values });
}

// Right-clicking (or clicking the sticky row-actions button on) a row that isn't already part of
// the current selection collapses the selection down to just that row and targets it alone;
// doing so on a row that's already part of a multi-row selection targets the whole selection.
function resolveActionRows<TData>(table: ReactTable<TData>, row: Row<TData>): TData[] {
	if (!row.getIsSelected()) {
		table.setRowSelection({ [row.id]: true });
		return [row.original];
	}

	let selectedRows = table.getSelectedRowModel().rows;
	return selectedRows.length > 0 ? selectedRows.map(selectedRow => selectedRow.original) : [row.original];
}

function resolveActions<TData>(actions: RowActionsSource<TData> | undefined, rows: TData[]): ButtonGroupAction[] {
	let resolvedActions = typeof actions === 'function' ? actions(rows) : (actions ?? []);

	return resolvedActions.map(action => ({
		label: action.label,
		icon: action.icon,
		disabled: (action.appliesToSelection === false && rows.length > 1) || Boolean(action.disabled?.(rows)),
		disabledReason: action.disabledReason?.(rows),
		onClick: () => action.onClick(rows),
		secondaryActions: action.secondaryActions && resolveActions(action.secondaryActions, rows)
	}));
}

// A function form's own arity (how many parameters it declares) isn't what's being asked here - only
// whether *any* row actions were supplied at all, fixed list or not.
function hasRowActionsSource<TData>(actions: RowActionsSource<TData> | undefined): boolean {
	return typeof actions === 'function' || Boolean(actions?.length);
}

const EXPORT_MIME_TYPES: Record<ExportFormat, string> = {
	csv: 'text/csv',
	json: 'application/json'
};

// VS Code's webview iframe permits triggering a native Save As dialog this way (its sandbox
// includes allow-downloads) - no host round trip needed. A temporary object URL/anchor is the
// standard way to drive that from script rather than a real link already in the page.
function triggerFileDownload(content: string, fileName: string, format: ExportFormat): void {
	let blob = new Blob([content], { type: EXPORT_MIME_TYPES[format] });
	let url = URL.createObjectURL(blob);
	let anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = fileName;
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
	URL.revokeObjectURL(url);
}

// DataTable's own fallback for a table with no exportCapability - reads straight off the react-table
// instance (raw, unrendered cell values, same as the results grid's original host-side export), and
// delivers to the clipboard or a downloaded file directly rather than round-tripping through a host
// message. Each value goes through the column's accessor, so an accessorFn column (e.g. Triggers'
// library/program) exports what the grid shows rather than a lookup of its id on the raw row; a
// column with no accessor at all still falls back to that lookup.
function performClientExport<TData>(table: ReactTable<TData>, what: ExportWhat, format: ExportFormat, destination: ExportDestination, filteredRows: Row<TData>[], selectedRows: Row<TData>[], excludeColumnIdsFromExport: string[] | undefined, exportColumnLabels: Record<string, string[]> | undefined): void {
	let tableRows = what === 'filtered' ? filteredRows : what === 'selected' ? selectedRows : table.getCoreRowModel().rows;
	let leafColumns = table.getAllLeafColumns().filter(column => !excludeColumnIdsFromExport?.includes(column.id));
	let columns = leafColumns.map(column => column.id);
	let headings = exportColumnLabels
		? ExportUtils.buildHeadings(columns, exportColumnLabels)
		: leafColumns.map(column => typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id);

	let rows: DataRow[] = tableRows.map(row => {
		let original = row.original as unknown as DataRow;
		return Object.fromEntries(leafColumns.map(column => [column.id, column.accessorFn ? row.getValue(column.id) : original[column.id]]));
	});

	let content = format === 'csv'
		? ExportUtils.toCsv({ rows, columns, headings })
		: ExportUtils.toJson({ rows, columns });

	if (destination === 'clipboard') {
		void navigator.clipboard.writeText(content);
	} else {
		triggerFileDownload(content, ExportUtils.buildDefaultFileName('export', format), format);
	}
}

// A disabled action's reason is shown as a caption under its label, not as the tooltip ButtonGroup uses:
// a disabled MenuItem has pointer-events: none, so a tooltip on it could never open.
function renderActionMenuItems(resolvedActions: ButtonGroupAction[], onDone: () => void) {
	return flattenActions(resolvedActions).map(action => (
		<MenuItem
			key={action.label}
			disabled={action.disabled}
			onClick={() => {
				onDone();
				action.onClick();
			}}
		>
			{action.icon && <Stack sx={{ mr: 1 }}>{action.icon}</Stack>}
			{action.disabled && action.disabledReason
				? <ListItemText primary={action.label} secondary={action.disabledReason} sx={{ my: 0 }} />
				: action.label}
		</MenuItem>
	));
}

interface RowHandlers<TData> {
	onMouseDown: (event: MouseEvent<HTMLTableRowElement>) => void;
	onClick: (event: MouseEvent<HTMLTableRowElement>, row: Row<TData>) => void;
	onContextMenu: (event: MouseEvent<HTMLTableRowElement>, row: Row<TData>) => void;
	onActionsClick: (event: MouseEvent<HTMLElement>, row: Row<TData>) => void;
}

interface BodyRowProps<TData> {
	row: Row<TData>;
	bgcolor: string;
	selected: boolean;
	hoverColor: string;
	cellSx: SxProps<Theme>;
	maxCellWidth?: number;
	hasRowActions: boolean;
	hasAnyActions: boolean;
	rowSx?: (row: TData) => SxProps<Theme> | undefined;
	/** Compared by identity only, so a column change re-renders every row - never rendered from. */
	columnDefs: unknown;
	/** False without a rowRenderKey - the row then re-renders on every table render, as it always did. */
	memoized: boolean;
	renderKey: unknown;
	handlersRef: RefObject<RowHandlers<TData>>;
}

// rowSx and handlersRef are deliberately left out: rowSx is a fresh closure every render (its output
// is what renderKey stands for), and handlersRef is one ref whose current value is always the latest.
function sameBodyRow<TData>(previous: BodyRowProps<TData>, next: BodyRowProps<TData>): boolean {
	return next.memoized
		&& previous.row.id === next.row.id
		&& previous.row.original === next.row.original
		&& previous.bgcolor === next.bgcolor
		&& previous.selected === next.selected
		&& previous.hoverColor === next.hoverColor
		&& previous.cellSx === next.cellSx
		&& previous.maxCellWidth === next.maxCellWidth
		&& previous.hasRowActions === next.hasRowActions
		&& previous.hasAnyActions === next.hasAnyActions
		&& previous.columnDefs === next.columnDefs
		&& Object.is(previous.renderKey, next.renderKey);
}

function DataTableBodyRowContent<TData>({ row, bgcolor, selected, hoverColor, cellSx, maxCellWidth, hasRowActions, hasAnyActions, rowSx, handlersRef }: BodyRowProps<TData>) {
	return (
		<TableRow
			onMouseDown={event => handlersRef.current.onMouseDown(event)}
			onClick={event => handlersRef.current.onClick(event, row)}
			onContextMenu={hasAnyActions ? event => handlersRef.current.onContextMenu(event, row) : undefined}
			sx={(sxTheme: Theme) => {
				let extra = rowSx?.(row.original);
				// rowSx is documented/used as a plain object or a (theme) => object function only
				// (never the array form SxProps<Theme> also allows) - cast past that unused
				// branch rather than widening every caller's return type to rule it out.
				let resolvedExtra = (typeof extra === 'function' ? extra(sxTheme) : extra) as Record<string, unknown> | undefined;

				return {
					cursor: 'pointer',
					// Each cell paints its own explicit background (needed so the sticky actions
					// column stays opaque over cells scrolling under it), which would otherwise
					// mask a hover style set on the row itself - target the cells directly so
					// hover is visible across the whole row. Skipped for an already-selected row
					// so hovering it doesn't dim its selected highlight.
					...(selected ? { bgcolor } : { bgcolor, '&:hover td': { bgcolor: hoverColor } }),
					...(resolvedExtra ?? {})
				};
			}}
		>
			{row.getVisibleCells().map(cell => (
				<TableCell
					key={cell.id}
					align={cell.column.columnDef.meta?.align}
					sx={cellSx}
					data-column-id={cell.column.id}
					title={maxCellWidth
						? (cell.getValue() === null || cell.getValue() === undefined ? '<null>' : String(cell.getValue()))
						: undefined}
				>
					{flexRender(cell.column.columnDef.cell, cell.getContext())}
				</TableCell>
			))}

			{hasRowActions && (
				<TableCell sx={{ ...ACTIONS_CELL_SX, bgcolor }}>
					<IconButton size="small" aria-label="Actions" onClick={event => handlersRef.current.onActionsClick(event, row)}>
						⋮
					</IconButton>
				</TableCell>
			)}
		</TableRow>
	);
}

// One body row. Memoized only when the DataTable was given a rowRenderKey - see that prop.
const DataTableBodyRow = memo(DataTableBodyRowContent, sameBodyRow) as typeof DataTableBodyRowContent;

export function DataTable<TData>({ table, maxCellWidth, containerRef, onScroll, virtualizer, rowActions, cellActions, rowSx, rowRenderKey, tableActions, trailingTableActions, onRefresh, exportCapability, filterChips, onClearAllFilterChips, emptyMessage, excludeColumnIdsFromExport, exportColumnLabels }: Props<TData>) {
	const theme = useTheme();
	const fixedLayout = Boolean(virtualizer);
	// Anchor for shift-click range selection - the id of the row a plain or ctrl click last landed
	// on. A ref (not state) since it only matters for the next click and shouldn't trigger a render.
	const lastSelectedRowIdRef = useRef<string | null>(null);
	const [globalFilter, setGlobalFilter] = useState('');
	const [rowMenuState, setRowMenuState] = useState<{ anchorEl: HTMLElement; targetRows: TData[] } | null>(null);
	const [contextMenuState, setContextMenuState] = useState<{ mouseX: number; mouseY: number; targetRows: TData[]; cell?: { row: TData; columnId: string } } | null>(null);
	const [headerMenuState, setHeaderMenuState] = useState<{ mouseX: number; mouseY: number; details: ColumnDetails } | null>(null);
	const [exportDialogOpen, setExportDialogOpen] = useState(false);

	// Refresh and Export are default actions: Export is always available (but disabled with nothing
	// loaded to export); Refresh only when the caller supplied onRefresh. Both are listed after
	// whatever the caller passed in, Refresh first.
	const defaultActions: TableAction<TData>[] = [
		...(onRefresh ? [{ label: 'Refresh', appliesToSelection: true, onClick: () => onRefresh() }] : []),
		{ label: 'Export...', appliesToSelection: true, onClick: () => setExportDialogOpen(true), disabled: () => table.getCoreRowModel().rows.length === 0 }
	];

	const allTableActions: TableAction<TData>[] = [...(tableActions ?? []), ...defaultActions, ...(trailingTableActions ?? [])];

	const hasRowActions = hasRowActionsSource(rowActions);
	const hasTableActions = Boolean(allTableActions.length);
	const hasAnyActions = hasRowActions || hasTableActions || cellActions != null;
	const visibleLeafColumns = table.getVisibleLeafColumns();
	// The fixed layout's minimum table width - see the <Table> below.
	const fixedLayoutWidth = visibleLeafColumns.reduce((total, column) => total + column.getSize(), hasRowActions ? ACTIONS_COLUMN_WIDTH : 0);

	const stripeColor = useMemo(
		() => flattenOverlay(theme.palette.action.hover, theme.palette.background.paper),
		[theme]
	);

	// theme.palette.action.selected is a very subtle overlay (meant not to compete with genuinely
	// interactive controls) - too faint to read as "this row is selected" at a glance in a data
	// table, so use a stronger tint of the primary color instead. Hover reuses the same hue at a
	// fraction of the opacity so it reads as "related to selection" without being mistaken for it.
	const selectedColor = useMemo(
		() => flattenOverlay(alpha(theme.palette.primary.main, 0.3), theme.palette.background.paper),
		[theme]
	);

	const hoverColor = useMemo(
		() => flattenOverlay(alpha(theme.palette.primary.main, 0.12), theme.palette.background.paper),
		[theme]
	);

	function rowBgcolor(rowIndex: number, selected: boolean) {
		if (selected) {
			return selectedColor;
		}

		return rowIndex % 2 === 1 ? stripeColor : theme.palette.background.paper;
	}

	// One object for the life of a maxCellWidth, so it never by itself defeats a memoized row.
	const cellSx = useMemo(
		() => maxCellWidth ? { ...CELL_SX, maxWidth: maxCellWidth, overflow: 'hidden', textOverflow: 'ellipsis' } : CELL_SX,
		[maxCellWidth]
	);

	// A memoized row (see rowRenderKey) keeps whatever props it last rendered with, so its event
	// handlers go through this ref and always reach the current render's functions.
	const rowHandlers: RowHandlers<TData> = { onMouseDown: handleRowMouseDown, onClick: handleRowClick, onContextMenu: handleRowContextMenu, onActionsClick: handleRowActionsButtonClick };
	const rowHandlersRef = useRef(rowHandlers);
	rowHandlersRef.current = rowHandlers;

	function handleRowMouseDown(event: MouseEvent<HTMLTableRowElement>) {
		// Shift-click is meant to extend the row selection, but shift-click is also the browser's
		// native gesture for extending a text selection - left unchecked, every shift-click also
		// drags a text selection across the row. preventDefault on mousedown (rather than click)
		// blocks that native selection without blocking the click handler that follows it.
		if (event.shiftKey) {
			event.preventDefault();
		}
	}

	function handleRowClick(event: MouseEvent<HTMLTableRowElement>, row: Row<TData>) {
		// Let clicks on interactive cell content (e.g. an actions-column menu button) do their own
		// thing instead of also changing the row selection underneath them.
		if ((event.target as HTMLElement).closest('button, a, input, textarea, select')) {
			return;
		}

		let visibleRows = table.getRowModel().rows;

		if (event.shiftKey && lastSelectedRowIdRef.current !== null) {
			let anchorIndex = visibleRows.findIndex(r => r.id === lastSelectedRowIdRef.current);
			let targetIndex = visibleRows.findIndex(r => r.id === row.id);

			if (anchorIndex !== -1 && targetIndex !== -1) {
				let [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
				let selection: Record<string, boolean> = {};

				for (let i = start; i <= end; i++) {
					selection[visibleRows[i].id] = true;
				}

				table.setRowSelection(selection);
				return;
			}
		}

		if (event.ctrlKey || event.metaKey) {
			table.setRowSelection(prev => ({ ...prev, [row.id]: !prev[row.id] }));
			lastSelectedRowIdRef.current = row.id;
			return;
		}

		table.setRowSelection({ [row.id]: true });
		lastSelectedRowIdRef.current = row.id;
	}

	function handleRowActionsButtonClick(event: MouseEvent<HTMLElement>, row: Row<TData>) {
		setContextMenuState(null);
		let targetRows = resolveActionRows(table, row);
		setRowMenuState({ anchorEl: event.currentTarget, targetRows });
	}

	function handleRowActionsMenuClose() {
		setRowMenuState(null);
	}

	function handleRowContextMenu(event: MouseEvent<HTMLTableRowElement>, row: Row<TData>) {
		event.preventDefault();
		setRowMenuState(null);
		let targetRows = resolveActionRows(table, row);
		let target = event.target as HTMLElement;
		let columnId = target.closest('td[data-column-id]')?.getAttribute('data-column-id') ?? undefined;
		// The Menu key or Shift+F10 on a focused field fires contextmenu with no pointer position - open
		// the menu under the field instead of in the window's top-left corner.
		let fromKeyboard = event.clientX === 0 && event.clientY === 0;
		let rect = fromKeyboard ? target.getBoundingClientRect() : undefined;
		setContextMenuState({
			mouseX: rect ? rect.left : event.clientX,
			mouseY: rect ? rect.bottom : event.clientY,
			targetRows,
			cell: columnId != null ? { row: row.original, columnId } : undefined
		});
	}

	function handleContextMenuClose() {
		setContextMenuState(null);
	}

	// Replaces the webview's own Cut/Copy/Paste menu on a database column's header, which has nothing
	// selectable to copy there anyway.
	function handleHeaderContextMenu(event: MouseEvent<HTMLTableCellElement>, details: ColumnDetails) {
		event.preventDefault();
		setRowMenuState(null);
		setContextMenuState(null);
		setHeaderMenuState({ mouseX: event.clientX, mouseY: event.clientY, details });
	}

	function handleHeaderMenuClose() {
		setHeaderMenuState(null);
	}

	function handleExportDialogClose() {
		setExportDialogOpen(false);
	}

	function handleExportSubmit(what: ExportWhat, format: ExportFormat, destination: ExportDestination) {
		let filteredRows = table.getFilteredRowModel().rows;
		let selectedRowsForExport = table.getSelectedRowModel().rows;

		if (exportCapability) {
			exportCapability.onExport({ what, format, destination, filteredRows: filteredRows.map(row => row.original), selectedRows: selectedRowsForExport.map(row => row.original) });
		} else {
			performClientExport(table, what, format, destination, filteredRows, selectedRowsForExport, excludeColumnIdsFromExport, exportColumnLabels);
		}
	}

	// This menu renders a full-page (invisible) backdrop to catch a plain click-away, and it sits on
	// top of the table - so without this, a right-click meant for a different row instead lands on
	// that backdrop, which only closes on a plain click, not a right-click. Rather than hit-testing
	// through the backdrop, the backdrop is made pointer-events: none (see the Menu slotProps below)
	// so a click always reaches its real target underneath, and this effect takes over the
	// click-away job itself: any mousedown outside the menu closes it. For a right-click on another
	// row, that mousedown-then-close happens first, then the row's own onContextMenu fires normally
	// (nothing is blocking it anymore) and opens the (shared, see context-menu.tsx) context menu -
	// both part of the same physical click, so they land in the same render with no visible flicker.
	// contextMenuState doesn't need an equivalent effect of its own - <ContextMenu> already handles
	// its own click-away, and the two states are mutually exclusive (each handler below clears the
	// other before setting its own).
	useEffect(() => {
		if (!rowMenuState) {
			return;
		}

		function handleGlobalMouseDown(event: globalThis.MouseEvent) {
			if ((event.target as HTMLElement).closest('[role="menu"]')) {
				return;
			}

			setRowMenuState(null);
		}

		document.addEventListener('mousedown', handleGlobalMouseDown, true);
		return () => document.removeEventListener('mousedown', handleGlobalMouseDown, true);
	}, [rowMenuState]);

	const selectedRows = table.getSelectedRowModel().rows.map(row => row.original);
	const resolvedTableActions = resolveActions(allTableActions, selectedRows);
	const resolvedRowMenuActions = rowMenuState ? resolveActions(rowActions, rowMenuState.targetRows) : [];
	const resolvedContextRowActions = contextMenuState ? resolveActions(rowActions, contextMenuState.targetRows) : [];
	const contextCell = contextMenuState?.cell;
	const resolvedCellActions = contextCell && cellActions ? resolveActions(cellActions(contextCell.row, contextCell.columnId), [contextCell.row]) : [];

	const rows = table.getRowModel().rows;
	const virtualItems = virtualizer?.getVirtualItems();
	const displayRows = virtualItems ? virtualItems.map(item => ({ row: rows[item.index], index: item.index })) : rows.map((row, index) => ({ row, index }));
	const paddingTop = virtualItems && virtualItems.length > 0 ? virtualItems[0].start : 0;
	const paddingBottom = virtualizer && virtualItems && virtualItems.length > 0 ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end : 0;
	const columnCount = table.getVisibleFlatColumns().length + (hasRowActions ? 1 : 0);

	return (
		<Stack sx={{ height: '100%', minHeight: 0, flexGrow: 1 }}>
			<Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, p: 1 }}>
				<TextField
					size="small"
					placeholder="Filter..."
					value={globalFilter}
					onChange={event => {
						setGlobalFilter(event.target.value);
						table.setGlobalFilter(event.target.value);
					}}
					sx={{ maxWidth: 400, width: 1 }}
					slotProps={{
						input: {
							endAdornment: globalFilter && (
								<InputAdornment position="end">
									<IconButton
										size="small"
										aria-label="Clear filter"
										onClick={() => {
											setGlobalFilter('');
											table.setGlobalFilter('');
										}}
									>
										✕
									</IconButton>
								</InputAdornment>
							)
						}
					}}
				/>

				{hasTableActions && <ButtonGroup actions={resolvedTableActions} />}
			</Stack>

			{filterChips && filterChips.length > 0 && (
				<Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center', px: 1, pb: 1 }}>
					{filterChips.map(chip => (
						<Tooltip key={chip.key} title={chip.tooltip ?? chip.label}>
							<Chip size="small" label={chip.label} onDelete={chip.onRemove} />
						</Tooltip>
					))}

					{onClearAllFilterChips && (
						<Button size="small" onClick={onClearAllFilterChips} sx={{ ml: 'auto' }}>Clear</Button>
					)}
				</Stack>
			)}

			<TableContainer ref={containerRef} onScroll={onScroll} sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto' }}>
				<Table
					stickyHeader
					size="small"
					// Deliberately leaves MUI's default width: 100% alone here - forcing width: auto instead
					// (to make the table shrink-wrap to its <colgroup> widths) turned out to reintroduce the
					// exact bug fixedLayout exists to prevent: an auto/shrink-to-fit width still runs its own
					// content-based "preferred width" pass independent of table-layout's column-distribution
					// algorithm, and with virtualization swapping which rows are actually in the DOM on every
					// scroll tick, that preferred-width pass recomputes (and the table visibly resizes) on
					// every tick too. width: 100% is a definite value, so no such recomputation ever happens -
					// columns are sized purely from the colgroup below, full stop.
					//
					// A fixed table spreads any width its columns don't use across all of them, in proportion,
					// which made every column wider than its content needs. So the last column's <col> has no
					// width and takes the spare room alone, and the table is at least the sum of the measured
					// widths - max() is still a definite value - so with no spare room that column keeps
					// exactly its measured width rather than being squeezed to nothing.
					style={fixedLayout ? { tableLayout: 'fixed', width: `max(100%, ${fixedLayoutWidth}px)` } : undefined}
				>
					{fixedLayout && (
						<colgroup>
							{visibleLeafColumns.map((column, index) => (
								<col key={column.id} style={index === visibleLeafColumns.length - 1 ? undefined : { width: column.getSize() }} />
							))}
							{hasRowActions && <col style={{ width: ACTIONS_COLUMN_WIDTH }} />}
						</colgroup>
					)}

					<TableHead>
						{table.getHeaderGroups().map(headerGroup => (
							<TableRow key={headerGroup.id}>
								{headerGroup.headers.map(header => {
									let details = header.column.columnDef.meta?.details;
									let detailLines = details ? ColumnDetailsUtils.lines(details) : [];
									let content = header.column.getCanSort() ? (
										<TableSortLabel
											active={header.column.getIsSorted() !== false}
											direction={header.column.getIsSorted() || 'asc'}
											onClick={header.column.getToggleSortingHandler()}
										>
											{flexRender(header.column.columnDef.header, header.getContext())}
										</TableSortLabel>
									) : (
										flexRender(header.column.columnDef.header, header.getContext())
									);

									return (
										<TableCell
											key={header.id}
											sx={cellSx}
											onContextMenu={details ? event => handleHeaderContextMenu(event, details) : undefined}
										>
											{/* A span, since a Tooltip needs one element to listen on and a sortable header's
											content is a TableSortLabel while a plain one's is whatever the column renders. */}
											{detailLines.length > 0 ? (
												<Tooltip title={<TooltipLines lines={detailLines} />} placement="bottom-start">
													<span>{content}</span>
												</Tooltip>
											) : content}
										</TableCell>
									);
								})}

								{hasRowActions && (
									<TableCell sx={{ ...ACTIONS_CELL_SX, bgcolor: theme.palette.background.paper }} />
								)}
							</TableRow>
						))}
					</TableHead>

					<TableBody>
						{rows.length === 0 && emptyMessage ? (
							<TableRow>
								<TableCell colSpan={columnCount} sx={{ textAlign: 'center', color: 'text.secondary', py: 4 }}>
									{emptyMessage}
								</TableCell>
							</TableRow>
						) : null}

						{paddingTop > 0 && (
							<TableRow style={{ height: paddingTop }}>
								<TableCell colSpan={columnCount} sx={{ p: 0, border: 0 }} />
							</TableRow>
						)}

						{displayRows.map(({ row, index }) => {
							let selected = row.getIsSelected();

							return (
								<DataTableBodyRow
									key={row.id}
									row={row}
									bgcolor={rowBgcolor(index, selected)}
									selected={selected}
									hoverColor={hoverColor}
									cellSx={cellSx}
									maxCellWidth={maxCellWidth}
									hasRowActions={hasRowActions}
									hasAnyActions={hasAnyActions}
									rowSx={rowSx}
									columnDefs={table.options.columns}
									memoized={rowRenderKey != null}
									renderKey={rowRenderKey?.(row.original)}
									handlersRef={rowHandlersRef}
								/>
							);
						})}

						{paddingBottom > 0 && (
							<TableRow style={{ height: paddingBottom }}>
								<TableCell colSpan={columnCount} sx={{ p: 0, border: 0 }} />
							</TableRow>
						)}
					</TableBody>
				</Table>
			</TableContainer>

			{/*
				autoFocus={false}: opened by a mouse click, not keyboard navigation, so there's no need to
				steal focus into the menu on open - doing so also sidesteps a MUI focus-visible quirk where
				the very first menu opened in the webview session (before its global mousedown listener has
				attached) misclassifies that opening click as keyboard input and paints every item with the
				theme's focus-visible outline (see MuiButtonBase.styleOverrides in create-vscode-theme.ts)
				until the listener catches up.

				sx/slotProps.paper make the whole modal click-through except the menu's own Paper: Menu's
				root IS the underlying Modal (PopoverRoot = styled(Modal)), a fixed div covering the entire
				page, which - regardless of the invisible Backdrop it also renders - would otherwise be the
				real hit target for any click over the table, same as the Backdrop was. pointerEvents: 'none'
				on that root lets clicks (including right-clicks) fall through to the real row underneath;
				Paper needs pointerEvents: 'auto' back since pointer-events is inherited and would otherwise
				make the menu itself unclickable too. Click-away is handled by the effect above instead of
				the (now unreachable) Backdrop click. <ContextMenu> below (the per-row right-click menu)
				bakes the same treatment in - see context-menu.tsx.
			*/}
			<Menu
				anchorEl={rowMenuState?.anchorEl}
				open={Boolean(rowMenuState)}
				onClose={handleRowActionsMenuClose}
				autoFocus={false}
				sx={{ pointerEvents: 'none' }}
				slotProps={{ paper: { sx: { pointerEvents: 'auto' } } }}
			>
				{renderActionMenuItems(resolvedRowMenuActions, handleRowActionsMenuClose)}
			</Menu>

			<ContextMenu position={contextMenuState} onClose={handleContextMenuClose}>
				{renderActionMenuItems(resolvedCellActions, handleContextMenuClose)}
				{resolvedCellActions.length > 0 && (hasRowActions || hasTableActions) && <Divider />}
				{renderActionMenuItems(resolvedContextRowActions, handleContextMenuClose)}
				{hasRowActions && hasTableActions && <Divider />}
				{renderActionMenuItems(resolvedTableActions, handleContextMenuClose)}
			</ContextMenu>

			<ContextMenu position={headerMenuState} onClose={handleHeaderMenuClose}>
				{HEADER_COPY_ITEMS.map(item => {
					let value = headerMenuState ? item.value(headerMenuState.details) : undefined;

					return (
						<MenuItem
							key={item.label}
							disabled={value == null || value.trim() === ''}
							onClick={() => {
								handleHeaderMenuClose();

								if (value != null) {
									void navigator.clipboard.writeText(value);
								}
							}}
						>
							{item.label}
						</MenuItem>
					);
				})}
			</ContextMenu>

			<ExportDialog
				open={exportDialogOpen}
				onClose={handleExportDialogClose}
				loadedRowCount={table.getCoreRowModel().rows.length}
				filteredRowCount={table.getFilteredRowModel().rows.length}
				selectedRowCount={selectedRows.length}
				canExportFiltered={Boolean(globalFilter.trim())}
				canExportSelected={selectedRows.length > 0}
				canExportAll={Boolean(exportCapability?.canExportAll)}
				onExport={handleExportSubmit}
			/>
		</Stack>
	);
}
