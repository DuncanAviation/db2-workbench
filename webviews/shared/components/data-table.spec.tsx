import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ColumnDef, RowSelectionState, SortingState } from '@tanstack/react-table';
import { getCoreRowModel, getFilteredRowModel, getSortedRowModel, useReactTable } from '@tanstack/react-table';
import { useFakeTimeouts } from '../../test-support/fake-timers';
import { renderWebview } from '../../test-support/render-webview';
import { TOOLTIP_ENTER_DELAY_MS } from '../theme/create-vscode-theme';
import type { ExportCapability, FilterChip, RowActionsSource, TableAction } from './data-table';
import { DataTable } from './data-table';

// DataTable's stated conventions (CLAUDE.md, "Conventions"): cells never wrap, rows alternate
// background, a sortable header, a per-row actions column frozen to the right edge, and the default
// Refresh/Export table actions. Built the way the schema browser tabs build theirs - the tab owns the
// useReactTable instance and hands it to <DataTable>.
//
// Styles are read with getComputedStyle, which jsdom resolves from the stylesheet emotion injects, so
// these check the CSS that would reach the browser rather than the sx objects that produce it. jsdom
// has no layout, though: "sticky at right: 0" is checked as declared CSS, not as a position on screen.

interface Part {
	id: number;
	name: string;
	quantity: number;
}

const PARTS: Part[] = [
	{ id: 1, name: 'Bolt', quantity: 30 },
	{ id: 2, name: 'Washer', quantity: 10 },
	{ id: 3, name: 'Nut', quantity: 20 },
	{ id: 4, name: 'Rivet', quantity: 40 }
];

const COLUMNS: ColumnDef<Part>[] = [
	{ id: 'id', accessorKey: 'id', header: 'ID' },
	{ id: 'name', accessorKey: 'name', header: 'Name' },
	{ id: 'quantity', accessorKey: 'quantity', header: 'Quantity', enableSorting: false }
];

interface HarnessProps {
	data?: Part[];
	columns?: ColumnDef<Part>[];
	rowActions?: RowActionsSource<Part>;
	tableActions?: TableAction<Part>[];
	onRefresh?: () => void;
	exportCapability?: ExportCapability<Part>;
	filterChips?: FilterChip[];
	onClearAllFilterChips?: () => void;
	emptyMessage?: string;
	maxCellWidth?: number;
	excludeColumnIdsFromExport?: string[];
	exportColumnLabels?: Record<string, string[]>;
}

function Harness({ data = PARTS, columns = COLUMNS, ...props }: HarnessProps) {
	const [sorting, setSorting] = useState<SortingState>([]);
	const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

	const reactTable = useReactTable({
		data,
		columns,
		state: { sorting, rowSelection },
		onSortingChange: setSorting,
		onRowSelectionChange: setRowSelection,
		getRowId: part => String(part.id),
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getSortedRowModel: getSortedRowModel()
	});

	return <DataTable table={reactTable} {...props} />;
}

function renderTable(props: HarnessProps = {}) {
	return renderWebview(<Harness {...props} />, { themeKind: 'light' });
}

function bodyRows(): HTMLElement[] {
	let [, body] = within(screen.getByRole('table')).getAllByRole('rowgroup');
	return within(body).queryAllByRole('row');
}

function headerCells(): HTMLElement[] {
	let [head] = within(screen.getByRole('table')).getAllByRole('rowgroup');
	return within(head).getAllByRole('columnheader');
}

function columnText(columnIndex: number): string[] {
	return bodyRows().map(row => within(row).getAllByRole('cell')[columnIndex].textContent ?? '');
}

function backgroundOf(row: HTMLElement): string {
	return getComputedStyle(row).backgroundColor;
}

function tableActionLabels(): string[] {
	// The ButtonGroup sits in the toolbar above the table; row "Actions" buttons live inside it.
	let table = screen.getByRole('table');
	return screen.getAllByRole('button').filter(button => !table.contains(button) && button.getAttribute('aria-label') === null).map(button => button.textContent ?? '');
}

describe('DataTable', () => {
	describe('sorting', () => {
		it('sorts by a sortable header, ascending then descending', async () => {
			let user = userEvent.setup();
			renderTable();

			expect(columnText(1)).toEqual(['Bolt', 'Washer', 'Nut', 'Rivet']);

			await user.click(screen.getByRole('button', { name: 'Name' }));
			expect(columnText(1)).toEqual(['Bolt', 'Nut', 'Rivet', 'Washer']);

			await user.click(screen.getByRole('button', { name: 'Name' }));
			expect(columnText(1)).toEqual(['Washer', 'Rivet', 'Nut', 'Bolt']);
		});

		it('renders a column with sorting disabled as a plain header, with no sort control', () => {
			renderTable();

			expect(screen.getByRole('button', { name: 'Name' })).toBeTruthy();
			expect(screen.queryByRole('button', { name: 'Quantity' })).toBeNull();
			expect(headerCells().map(cell => cell.textContent)).toEqual(['ID', 'Name', 'Quantity']);
		});
	});

	describe('cells', () => {
		it('never wraps header or body cell content', () => {
			renderTable();

			let cells = [...headerCells(), ...bodyRows().flatMap(row => within(row).getAllByRole('cell'))];

			expect(cells.length).toBe(3 + PARTS.length * 3);
			for (let cell of cells) {
				expect(getComputedStyle(cell).whiteSpace, cell.textContent ?? '').toBe('nowrap');
			}
		});

		it('with maxCellWidth, truncates with an ellipsis and puts the full value in a title', () => {
			renderTable({ maxCellWidth: 120, data: [{ id: 1, name: 'A very long part description', quantity: 5 }] });

			let nameCell = within(bodyRows()[0]).getAllByRole('cell')[1];
			let style = getComputedStyle(nameCell);

			expect(style.whiteSpace).toBe('nowrap');
			expect(style.textOverflow).toBe('ellipsis');
			expect(style.overflow).toBe('hidden');
			expect(style.maxWidth).toBe('120px');
			expect(nameCell.getAttribute('title')).toBe('A very long part description');
		});

		it('without maxCellWidth, leaves cells untruncated and untitled, relying on horizontal scroll', () => {
			renderTable();

			let nameCell = within(bodyRows()[0]).getAllByRole('cell')[1];

			expect(getComputedStyle(nameCell).textOverflow).not.toBe('ellipsis');
			expect(nameCell.getAttribute('title')).toBeNull();
		});
	});

	describe('row striping', () => {
		it('alternates row backgrounds, with every color opaque', () => {
			renderTable();

			let colors = bodyRows().map(backgroundOf);

			expect(colors[0]).not.toBe(colors[1]);
			expect(colors[2]).toBe(colors[0]);
			expect(colors[3]).toBe(colors[1]);

			// Opaque, because the sticky actions cell reuses the row color and sits over cells scrolling
			// underneath it - a translucent stripe there would let their text show through.
			for (let color of colors) {
				expect(color).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
			}
		});

		it('stripes by position after sorting, not by which data row it was', async () => {
			let user = userEvent.setup();
			renderTable();

			let [even, odd] = bodyRows().map(backgroundOf);

			await user.click(screen.getByRole('button', { name: 'Name' }));

			expect(columnText(1)[1]).toBe('Nut');
			expect(bodyRows().map(backgroundOf)).toEqual([even, odd, even, odd]);
		});

		it('paints a selected row in its own color, distinct from both stripes', async () => {
			let user = userEvent.setup();
			renderTable();

			let [even, odd] = bodyRows().map(backgroundOf);

			await user.click(within(bodyRows()[1]).getAllByRole('cell')[1]);

			let selected = backgroundOf(bodyRows()[1]);
			expect(selected).not.toBe(even);
			expect(selected).not.toBe(odd);
			expect(backgroundOf(bodyRows()[0])).toBe(even);
		});
	});

	describe('row selection', () => {
		it('a plain click selects one row, ctrl-click toggles, shift-click selects a range', async () => {
			let user = userEvent.setup();
			let onClick = vi.fn();
			renderTable({ tableActions: [{ label: 'Inspect', appliesToSelection: true, onClick }] });

			let cellOf = (index: number) => within(bodyRows()[index]).getAllByRole('cell')[1];
			let selectedIds = async () => {
				await user.click(screen.getByRole('button', { name: 'Inspect' }));
				return (onClick.mock.lastCall?.[0] as Part[]).map(part => part.id);
			};

			await user.click(cellOf(0));
			expect(await selectedIds()).toEqual([1]);

			await user.keyboard('{Control>}');
			await user.click(cellOf(2));
			await user.keyboard('{/Control}');
			expect(await selectedIds()).toEqual([1, 3]);

			await user.click(cellOf(1));
			await user.keyboard('{Shift>}');
			await user.click(cellOf(3));
			await user.keyboard('{/Shift}');
			expect(await selectedIds()).toEqual([2, 3, 4]);
		});
	});

	describe('actions column', () => {
		const EDIT: TableAction<Part> = { label: 'Edit Row', appliesToSelection: false, onClick: vi.fn() };

		it('is added only when row actions are supplied', () => {
			renderTable();

			expect(headerCells()).toHaveLength(3);
			expect(screen.queryAllByRole('button', { name: 'Actions' })).toHaveLength(0);
			// Pairs the absence above with a positive count, so it is about the column, not an empty table.
			expect(bodyRows()).toHaveLength(PARTS.length);
		});

		it('is the last column, frozen to the right edge in the header and every row', () => {
			renderTable({ rowActions: [EDIT] });

			let lastCells = [headerCells().at(-1), ...bodyRows().map(row => within(row).getAllByRole('cell').at(-1))] as HTMLElement[];

			expect(lastCells).toHaveLength(1 + PARTS.length);
			for (let cell of lastCells) {
				let style = getComputedStyle(cell);
				expect(style.position).toBe('sticky');
				expect(style.right).toBe('0px');
			}

			expect(bodyRows().every(row => within(row).getAllByRole('cell').at(-1)?.querySelector('[aria-label="Actions"]'))).toBe(true);
		});

		it('paints the frozen cell with its own row color, so it stays opaque over scrolled content', () => {
			renderTable({ rowActions: [EDIT] });

			for (let row of bodyRows()) {
				let actionsCell = within(row).getAllByRole('cell').at(-1) as HTMLElement;
				expect(getComputedStyle(actionsCell).backgroundColor).toBe(backgroundOf(row));
			}
		});

		it('opens the row menu and runs the chosen action against that row', async () => {
			let user = userEvent.setup();
			let onClick = vi.fn();
			renderTable({ rowActions: [{ label: 'Edit Row', appliesToSelection: false, onClick }] });

			await user.click(within(bodyRows()[2]).getByRole('button', { name: 'Actions' }));
			await user.click(screen.getByRole('menuitem', { name: 'Edit Row' }));

			expect(onClick).toHaveBeenCalledTimes(1);
			expect(onClick).toHaveBeenCalledWith([PARTS[2]]);
		});

		it('targets the whole selection from a selected row, and disables single-row actions for it', async () => {
			let user = userEvent.setup();
			let deleteRows = vi.fn();
			renderTable({
				rowActions: [
					{ label: 'Edit Row', appliesToSelection: false, onClick: vi.fn() },
					{ label: 'Delete Rows', appliesToSelection: true, onClick: deleteRows }
				]
			});

			await user.click(within(bodyRows()[0]).getAllByRole('cell')[1]);
			await user.keyboard('{Shift>}');
			await user.click(within(bodyRows()[1]).getAllByRole('cell')[1]);
			await user.keyboard('{/Shift}');

			await user.click(within(bodyRows()[1]).getByRole('button', { name: 'Actions' }));

			expect(screen.getByRole('menuitem', { name: 'Edit Row' }).getAttribute('aria-disabled')).toBe('true');
			await user.click(screen.getByRole('menuitem', { name: 'Delete Rows' }));
			expect(deleteRows).toHaveBeenCalledWith([PARTS[0], PARTS[1]]);
		});

		it('collapses the selection to an unselected row when its menu is opened', async () => {
			let user = userEvent.setup();
			let onClick = vi.fn();
			renderTable({ rowActions: [{ label: 'Delete Rows', appliesToSelection: true, onClick }] });

			await user.click(within(bodyRows()[0]).getAllByRole('cell')[1]);
			await user.click(within(bodyRows()[3]).getByRole('button', { name: 'Actions' }));
			await user.click(screen.getByRole('menuitem', { name: 'Delete Rows' }));

			expect(onClick).toHaveBeenCalledWith([PARTS[3]]);
		});

		it('offers the row actions, then the table actions, from a right-click', async () => {
			let user = userEvent.setup();
			renderTable({
				rowActions: [EDIT],
				tableActions: [{ label: 'Add Row', appliesToSelection: true, onClick: vi.fn() }],
				onRefresh: vi.fn()
			});

			await user.pointer({ keys: '[MouseRight]', target: within(bodyRows()[0]).getAllByRole('cell')[1] });

			expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Edit Row', 'Add Row', 'Refresh', 'Export...']);
		});
	});

	describe('table actions', () => {
		it('appends Refresh then Export after the caller\'s own actions, in order', () => {
			renderTable({
				tableActions: [
					{ label: 'Add Row', appliesToSelection: true, onClick: vi.fn() },
					{ label: 'Fetch all', appliesToSelection: true, onClick: vi.fn() }
				],
				onRefresh: vi.fn()
			});

			expect(tableActionLabels()).toEqual(['Add Row', 'Fetch all', 'Refresh', 'Export...']);
		});

		it('shows an action with secondary actions as a split button, whose arrow lists them', async () => {
			let user = userEvent.setup();
			let addInGrid = vi.fn();
			let addInDialog = vi.fn();
			renderTable({
				tableActions: [{
					label: 'Add Row',
					appliesToSelection: true,
					onClick: addInGrid,
					secondaryActions: [{ label: 'Add Row in Dialog', appliesToSelection: true, onClick: addInDialog }]
				}]
			});

			expect(tableActionLabels()).toEqual(['Add Row', 'Export...']);

			await user.click(screen.getByRole('button', { name: 'Add Row' }));
			expect(addInGrid).toHaveBeenCalledOnce();

			await user.click(screen.getByRole('button', { name: 'More Add Row options' }));
			expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Add Row in Dialog']);
			await user.click(screen.getByRole('menuitem', { name: 'Add Row in Dialog' }));
			expect(addInDialog).toHaveBeenCalledOnce();
		});

		it('lists secondary actions right after their action in the right-click menu and the overflow menu', async () => {
			let user = userEvent.setup();
			let split = { label: 'Add Row', appliesToSelection: true, onClick: vi.fn(), secondaryActions: [{ label: 'Add Row in Dialog', appliesToSelection: true, onClick: vi.fn() }] };
			let plain = (label: string) => ({ label, appliesToSelection: true, onClick: vi.fn() });
			renderTable({ tableActions: [plain('One'), plain('Two'), plain('Three'), plain('Four'), plain('Five'), split] });

			await user.pointer({ keys: '[MouseRight]', target: within(bodyRows()[0]).getAllByRole('cell')[1] });
			expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['One', 'Two', 'Three', 'Four', 'Five', 'Add Row', 'Add Row in Dialog', 'Export...']);
			await user.keyboard('{Escape}');

			await user.click(screen.getByRole('button', { name: 'More actions' }));
			expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Add Row', 'Add Row in Dialog', 'Export...']);
		});

		it('offers Refresh only when onRefresh is supplied, and always offers Export', () => {
			renderTable();

			expect(tableActionLabels()).toEqual(['Export...']);
		});

		it('runs onRefresh from the Refresh action', async () => {
			let user = userEvent.setup();
			let onRefresh = vi.fn();
			renderTable({ onRefresh });

			await user.click(screen.getByRole('button', { name: 'Refresh' }));

			expect(onRefresh).toHaveBeenCalledTimes(1);
		});

		it('disables Export while there is nothing loaded to export', () => {
			renderTable({ data: [] });

			expect((screen.getByRole('button', { name: 'Export...' }) as HTMLButtonElement).disabled).toBe(true);
		});

		it('disables a single-row table action once more than one row is selected', async () => {
			let user = userEvent.setup();
			renderTable({ tableActions: [{ label: 'Edit Row', appliesToSelection: false, onClick: vi.fn() }] });

			let editButton = () => screen.getByRole('button', { name: 'Edit Row' }) as HTMLButtonElement;

			await user.click(within(bodyRows()[0]).getAllByRole('cell')[1]);
			expect(editButton().disabled).toBe(false);

			await user.keyboard('{Control>}');
			await user.click(within(bodyRows()[1]).getAllByRole('cell')[1]);
			await user.keyboard('{/Control}');
			expect(editButton().disabled).toBe(true);
		});
	});

	describe('filtering', () => {
		it('narrows the rows by the filter text, and the clear button restores them', async () => {
			let user = userEvent.setup();
			renderTable();

			await user.type(screen.getByPlaceholderText('Filter...'), 'ut');
			expect(columnText(1)).toEqual(['Nut']);

			await user.click(screen.getByRole('button', { name: 'Clear filter' }));
			expect(columnText(1)).toEqual(['Bolt', 'Washer', 'Nut', 'Rivet']);
			expect((screen.getByPlaceholderText('Filter...') as HTMLInputElement).value).toBe('');
		});

		it('shows the empty message across every column, keeping the headers', () => {
			renderTable({ data: [], emptyMessage: 'No parts found', rowActions: [{ label: 'Edit Row', appliesToSelection: false, onClick: vi.fn() }] });

			let rows = bodyRows();
			expect(rows).toHaveLength(1);

			let cell = within(rows[0]).getByRole('cell');
			expect(cell.textContent).toBe('No parts found');
			expect(cell.getAttribute('colspan')).toBe('4');
			expect(headerCells()).toHaveLength(4);
		});

		it('renders filter chips that remove themselves, and a Clear for all of them', async () => {
			let user = userEvent.setup();
			let removeFirst = vi.fn();
			let clearAll = vi.fn();
			let { container } = renderTable({
				filterChips: [
					{ key: 'a', label: 'NAME = Bolt', onRemove: removeFirst },
					{ key: 'b', label: 'QUANTITY > 10', onRemove: vi.fn() }
				],
				onClearAllFilterChips: clearAll
			});

			let chips = container.querySelectorAll('.MuiChip-root');
			expect([...chips].map(chip => chip.textContent)).toEqual(['NAME = Bolt', 'QUANTITY > 10']);

			await user.click(chips[0].querySelector('.MuiChip-deleteIcon') as Element);
			expect(removeFirst).toHaveBeenCalledTimes(1);

			await user.click(screen.getByRole('button', { name: 'Clear' }));
			expect(clearAll).toHaveBeenCalledTimes(1);
		});
	});

	describe('export', () => {
		it('without an exportCapability, copies the loaded rows as CSV itself, leaving out excluded columns', async () => {
			let user = userEvent.setup();
			renderTable({ excludeColumnIdsFromExport: ['quantity'] });
			await navigator.clipboard.writeText('untouched');

			await user.click(screen.getByRole('button', { name: 'Export...' }));
			await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Clipboard' }));

			let copied = await navigator.clipboard.readText();
			expect(copied.split(/\r?\n/).filter(line => line.length > 0)).toEqual(['ID,Name', '1,Bolt', '2,Washer', '3,Nut', '4,Rivet']);
		});

		it('exports an accessorFn column the way the grid shows it, not as a lookup of its id on the raw row', async () => {
			let user = userEvent.setup();
			renderTable({ columns: [...COLUMNS, { id: 'stock', accessorFn: part => `${part.name}/${part.quantity}`, header: 'Stock' }] });
			await navigator.clipboard.writeText('untouched');

			await user.click(screen.getByRole('button', { name: 'Export...' }));
			await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Clipboard' }));

			let copied = await navigator.clipboard.readText();
			expect(copied.split(/\r?\n/).filter(line => line.length > 0)).toEqual(['ID,Name,Quantity,Stock', '1,Bolt,30,Bolt/30', '2,Washer,10,Washer/10', '3,Nut,20,Nut/20', '4,Rivet,40,Rivet/40']);
		});

		it('with exportColumnLabels, heads the CSV columns from the label map instead of the headers', async () => {
			let user = userEvent.setup();
			renderTable({ exportColumnLabels: { id: ['PARTID', 'Part Identifier'], name: ['PARTNM'] } });
			await navigator.clipboard.writeText('untouched');

			await user.click(screen.getByRole('button', { name: 'Export...' }));
			await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Clipboard' }));

			let copied = await navigator.clipboard.readText();
			// Joined the same way the host-side results export joins them; a column the map has nothing for keeps its id.
			expect(copied.split(/\r?\n/)[0]).toBe('PARTID / Part Identifier,PARTNM,quantity');
		});

		it('with an exportCapability, hands the request to it instead, with the filtered rows resolved', async () => {
			let user = userEvent.setup();
			let onExport = vi.fn();
			renderTable({ exportCapability: { canExportAll: true, onExport } });
			// userEvent's clipboard stub outlives a test (its own reset hooks need vitest globals), so
			// seed a sentinel rather than assuming it starts empty.
			await navigator.clipboard.writeText('untouched');

			await user.type(screen.getByPlaceholderText('Filter...'), 'o');
			await user.click(screen.getByRole('button', { name: 'Export...' }));

			let dialog = within(screen.getByRole('dialog'));
			expect(dialog.getByLabelText('All results (fetches remaining rows first)')).toBeTruthy();

			await user.click(dialog.getByLabelText('Filtered results (1 rows)'));
			await user.click(dialog.getByLabelText('JSON'));
			await user.click(dialog.getByRole('button', { name: 'Save' }));

			expect(onExport).toHaveBeenCalledTimes(1);
			expect(onExport).toHaveBeenCalledWith({ what: 'filtered', format: 'json', destination: 'file', filteredRows: [PARTS[0]], selectedRows: [] });
			// The clipboard path is DataTable's own fallback - handing off must replace it, not add to it.
			expect(await navigator.clipboard.readText()).toBe('untouched');
		});
	});

	describe('memoized rows (rowRenderKey)', () => {
		// Counts renders of the Name cell per row id, the stand-in for an expensive inline-edit input.
		function MemoHarness({ data, renderKeys, withRenderKey, onNameRender }: { data: Part[]; renderKeys: Record<number, string>; withRenderKey: boolean; onNameRender: (id: number) => void }) {
			const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
			const columns = useState<ColumnDef<Part>[]>(() => [
				{ id: 'id', accessorKey: 'id', header: 'ID' },
				{
					id: 'name',
					accessorKey: 'name',
					header: 'Name',
					cell: info => {
						onNameRender(info.row.original.id);
						return info.getValue<string>();
					}
				}
			])[0];

			const reactTable = useReactTable({
				data,
				columns,
				state: { rowSelection },
				onRowSelectionChange: setRowSelection,
				getRowId: part => String(part.id),
				getCoreRowModel: getCoreRowModel()
			});

			return <DataTable table={reactTable} rowRenderKey={withRenderKey ? part => renderKeys[part.id] ?? '' : undefined} />;
		}

		function renderMemo(withRenderKey: boolean) {
			let renders: number[] = [];
			let onNameRender = (id: number) => renders.push(id);
			let result = renderWebview(<MemoHarness data={PARTS} renderKeys={{}} withRenderKey={withRenderKey} onNameRender={onNameRender} />, { themeKind: 'light' });

			return {
				renders,
				rerender: (data: Part[], renderKeys: Record<number, string> = {}) => {
					renders.length = 0;
					result.rerender(<MemoHarness data={data} renderKeys={renderKeys} withRenderKey={withRenderKey} onNameRender={onNameRender} />);
				}
			};
		}

		it('re-renders only the row whose data object changed, or whose render key did', () => {
			let { renders, rerender } = renderMemo(true);
			let edited = PARTS.map(part => part.id === 2 ? { ...part, name: 'Lock washer' } : part);

			rerender(edited);
			expect(renders).toEqual([2]);
			expect(columnText(1)).toEqual(['Bolt', 'Lock washer', 'Nut', 'Rivet']);

			rerender(edited, { 3: 'pending delete' });
			expect(renders).toEqual([3]);
		});

		it('still re-renders a memoized row whose selection changes, through its current click handler', async () => {
			let user = userEvent.setup();
			let { renders } = renderMemo(true);
			let before = bodyRows().map(backgroundOf);
			renders.length = 0;

			// Selects row 1, then moves the selection to row 3 - the second click only works if the
			// memoized rows reach the current handler rather than the one they first rendered with.
			await user.click(bodyRows()[0]);
			await user.click(bodyRows()[2]);

			expect(bodyRows().map((row, index) => backgroundOf(row) !== before[index])).toEqual([false, false, true, false]);
			expect([...new Set(renders)].sort()).toEqual([1, 3]);
		});

		it('re-renders every row on every render without a rowRenderKey, as before', () => {
			let { renders, rerender } = renderMemo(false);

			rerender(PARTS.map(part => part.id === 2 ? { ...part, name: 'Lock washer' } : part));
			expect(renders).toEqual([1, 2, 3, 4]);
		});
	});

	describe('database column headers', () => {
		const DETAILED_COLUMNS: ColumnDef<Part>[] = [
			{ id: 'id', accessorKey: 'id', header: 'PARTID', meta: { details: { shortName: 'PARTID', longName: 'PART_IDENTIFIER', description: 'Part Identifier', type: 'INTEGER', notNull: true } } },
			{ id: 'name', accessorKey: 'name', header: 'NAME', meta: { details: { longName: 'NAME', type: 'VARCHAR(50)' } } },
			{ id: 'quantity', accessorKey: 'quantity', header: 'Quantity' }
		];

		it('shows the column names, type and known flags when its header is hovered', async () => {
			let user = userEvent.setup();
			renderTable({ columns: DETAILED_COLUMNS });

			await user.hover(screen.getByText('PARTID'));

			let tooltip = await screen.findByRole('tooltip');
			expect(tooltip.textContent).toContain('Short Name: PARTID');
			expect(tooltip.textContent).toContain('Long Name: PART_IDENTIFIER');
			expect(tooltip.textContent).toContain('Description: Part Identifier');
			expect(tooltip.textContent).toContain('Type: INTEGER');
			expect(tooltip.textContent).toContain('Not Null: Yes');
		});

		it('copies the chosen name form from the header right-click menu', async () => {
			let user = userEvent.setup();
			renderTable({ columns: DETAILED_COLUMNS });
			await navigator.clipboard.writeText('untouched');

			await user.pointer({ keys: '[MouseRight]', target: screen.getByText('PARTID') });
			await user.click(screen.getByRole('menuitem', { name: 'Copy Long Name' }));

			expect(await navigator.clipboard.readText()).toBe('PART_IDENTIFIER');
			await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
		});

		it('disables a copy item the column has no value for', async () => {
			let user = userEvent.setup();
			renderTable({ columns: DETAILED_COLUMNS });

			await user.pointer({ keys: '[MouseRight]', target: screen.getByText('NAME') });

			expect(screen.getByRole('menuitem', { name: 'Copy Name' }).getAttribute('aria-disabled')).toBe('true');
			expect(screen.getByRole('menuitem', { name: 'Copy Long Name' }).getAttribute('aria-disabled')).toBeNull();
			expect(screen.getByRole('menuitem', { name: 'Copy Description' }).getAttribute('aria-disabled')).toBe('true');
		});

		// MUI opens a tooltip after a delay and closes it through a transition, both on setTimeout - faked
		// so a test can say no tooltip appeared, rather than only that one had not appeared yet.
		describe('tooltip around the header menu', () => {
			let restoreTimeouts: () => void;

			beforeEach(() => {
				restoreTimeouts = useFakeTimeouts();
			});

			afterEach(() => restoreTimeouts());

			// The tooltip repeats the header's name, so look it up in the header row only - including while the
			// menu is open, when MUI marks the rest of the page aria-hidden.
			function headerText(text: string): HTMLElement {
				let [head] = within(screen.getByRole('table', { hidden: true })).getAllByRole('rowgroup', { hidden: true });
				return within(head).getByText(text);
			}

			function settle() {
				act(() => {
					vi.advanceTimersByTime(1000);
				});
			}

			// The theme's delay (create-vscode-theme.ts), which every tooltip in every webview gets.
			it('waits the theme tooltip delay before showing', async () => {
				let user = userEvent.setup({ delay: null });
				renderTable({ columns: DETAILED_COLUMNS });

				await user.hover(headerText('PARTID'));
				act(() => {
					vi.advanceTimersByTime(TOOLTIP_ENTER_DELAY_MS - 100);
				});
				expect(screen.queryByRole('tooltip')).toBeNull();

				await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeNull());
			});

			it('hides on right-click and stays hidden over any header while the menu is open', async () => {
				let user = userEvent.setup({ delay: null });
				renderTable({ columns: DETAILED_COLUMNS });

				await user.hover(headerText('PARTID'));
				await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeNull());

				await user.pointer({ keys: '[MouseRight]', target: headerText('PARTID') });
				settle();
				expect(screen.getByRole('menu')).toBeTruthy();
				expect(screen.queryByRole('tooltip')).toBeNull();

				await user.hover(headerText('NAME'));
				settle();
				expect(screen.queryByRole('tooltip')).toBeNull();
			});

			it('stays hidden on the right-clicked header after the menu closes, until the pointer leaves it', async () => {
				let user = userEvent.setup({ delay: null });
				renderTable({ columns: DETAILED_COLUMNS });

				await user.hover(headerText('PARTID'));
				await user.pointer({ keys: '[MouseRight]', target: headerText('PARTID') });
				// Clicking the same header dismisses the menu without the pointer ever leaving it.
				await user.click(headerText('PARTID'));
				settle();
				expect(screen.queryByRole('menu')).toBeNull();
				expect(screen.queryByRole('tooltip')).toBeNull();

				await user.unhover(headerText('PARTID'));
				await user.hover(headerText('PARTID'));
				await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeNull());
			});
		});

		it('leaves a fixed heading with no details alone', async () => {
			let user = userEvent.setup();
			renderTable({ columns: DETAILED_COLUMNS });

			await user.pointer({ keys: '[MouseRight]', target: screen.getByText('Quantity') });

			expect(screen.queryByRole('menu')).toBeNull();
		});
	});
});
