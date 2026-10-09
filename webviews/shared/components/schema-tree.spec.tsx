import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { useFakeLayout } from '../../test-support/fake-layout';
import type { FakeLayoutHandle } from '../../test-support/fake-layout';
import { renderWebview } from '../../test-support/render-webview';
import { tableKeyToString } from '../table-key';
import type { TableKey } from '../table-key';
import type { SchemaTreeEntry, SchemaTreeMenuItem } from './schema-tree';
import { SchemaTree, TABLE_ROW_DRAG_MIME_TYPE } from './schema-tree';

// SchemaTree is shared by the schema browser (single-select) and the diagram's table picker
// (multi-select). Covered here: the filter-derived expand/collapse rules, both selection modes, and the
// react-virtual windowing - with viewport and row heights supplied by fake-layout.ts, since jsdom has
// none. That makes the windowing assertions about which rows the virtualizer asks for, not about the
// CSS giving it a bounded viewport in the first place: a missing height on the scroll container would
// still pass here. See fake-layout.ts. The bounded viewport itself is checked in a real browser, in each
// host's app.browser.spec.tsx (schemas and diagram), through test-support/schema-tree-layout.ts.

const VIEWPORT_HEIGHT = 340;
const ROW_HEIGHT = 34;

const TABLES: Record<string, SchemaTreeEntry[]> = {
	SALES: [
		{ schema: 'SALES', table: 'ORDERS', description: 'Order header' },
		{ schema: 'SALES', table: 'CUSTOMER', description: 'Customer master' }
	],
	PARTS: [
		{ schema: 'PARTS', table: 'PART', description: 'Part master' },
		{ schema: 'PARTS', table: 'BIN', description: 'Stock location' }
	],
	EMPTYLIB: []
};

// A view named like a table in the same schema (ORDERS), so the two can't be confused for each other.
const VIEWS: Record<string, SchemaTreeEntry[]> = {
	SALES: [
		{ schema: 'SALES', table: 'ORDERS', description: 'Orders view' },
		{ schema: 'SALES', table: 'CUSTORD', description: 'Orders with customers' }
	]
};

// Two overloads of one function (keyed by specific name, labelled by signature) and a function named like
// a table, so neither the name nor the label can stand in for a row's identity.
const FUNCTIONS: Record<string, SchemaTreeEntry[]> = {
	SALES: [
		{ schema: 'SALES', table: 'ORDER_TOTAL', label: 'ORDER_TOTAL(INTEGER)' },
		{ schema: 'SALES', table: 'ORDER_TOTAL_CURRENCY', label: 'ORDER_TOTAL(INTEGER, CHAR)', description: 'In a currency' },
		{ schema: 'SALES', table: 'ORDERS', label: 'ORDERS' }
	]
};

// ORDER_TOTAL is also a function's name - a procedure is a different object, keyed under its own kind.
const PROCEDURES: Record<string, SchemaTreeEntry[]> = {
	SALES: [
		{ schema: 'SALES', table: 'ORDER_TOTAL', label: 'ORDER_TOTAL', description: 'Recalculate totals' },
		{ schema: 'SALES', table: 'NEXT_ORD00001', label: 'NEXT_ORDER_NUMBER' }
	]
};

interface SingleHarnessProps {
	tablesBySchema?: Record<string, SchemaTreeEntry[]>;
	viewsBySchema?: Record<string, SchemaTreeEntry[]>;
	functionsBySchema?: Record<string, SchemaTreeEntry[]>;
	proceduresBySchema?: Record<string, SchemaTreeEntry[]>;
	initialFilter?: string;
	selected?: TableKey | null;
	onSelectTable?: (schema: string, table: string) => void;
	onSelectView?: (schema: string, view: string) => void;
	onSelectFunction?: (schema: string, specificName: string) => void;
	onSelectProcedure?: (schema: string, specificName: string) => void;
	menuItems?: SchemaTreeMenuItem[];
	loading?: boolean;
	emptyMessage?: string;
}

function SingleHarness({ tablesBySchema = TABLES, initialFilter = '', selected = null, onSelectTable = () => {}, onSelectView, onSelectFunction, onSelectProcedure, ...props }: SingleHarnessProps) {
	const [filterText, setFilterText] = useState(initialFilter);

	return (
		<SchemaTree
			tablesBySchema={tablesBySchema}
			filterText={filterText}
			onFilterTextChange={setFilterText}
			selection={{ mode: 'single', selectedKey: selected, onSelectTable, onSelectView, onSelectFunction, onSelectProcedure }}
			title="Production"
			{...props}
		/>
	);
}

interface MultiHarnessProps {
	onSelectionChange?: (keys: ReadonlySet<string>) => void;
	contextMenuItems?: (keys: ReadonlySet<string>) => SchemaTreeMenuItem[];
}

function MultiHarness({ onSelectionChange, contextMenuItems }: MultiHarnessProps) {
	const [filterText, setFilterText] = useState('');
	const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());

	return (
		<SchemaTree
			tablesBySchema={TABLES}
			filterText={filterText}
			onFilterTextChange={setFilterText}
			selection={{
				mode: 'multi',
				selectedKeys,
				onSelectionChange: keys => {
					setSelectedKeys(keys);
					onSelectionChange?.(keys);
				},
				contextMenuItems
			}}
		/>
	);
}

function renderedRows(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>('[data-index]')];
}

function rowTexts(): string[] {
	return renderedRows().map(element => element.textContent ?? '');
}

function row(text: string): HTMLElement {
	let match = renderedRows().find(element => element.textContent === text);
	if (!match) {
		throw new Error(`no rendered row "${text}" - rendered: ${JSON.stringify(rowTexts())}`);
	}
	return match.querySelector('[role="button"]') as HTMLElement;
}

function key(schema: string, table: string): string {
	return tableKeyToString({ schema, table });
}

function selectedTexts(): string[] {
	return renderedRows().filter(element => element.querySelector('.Mui-selected')).map(element => element.textContent ?? '');
}

// Every schema has its own "Tables (n)" node, so it is found as the row right after its schema.
function tablesNodeOf(schema: string): HTMLElement {
	let rows = renderedRows();
	let index = rows.findIndex(element => element.textContent === schema);
	return rows[index + 1].querySelector('[role="button"]') as HTMLElement;
}

async function expandAll(user: ReturnType<typeof userEvent.setup>, ...schemas: string[]) {
	for (let schema of schemas) {
		await user.click(row(schema));
		await user.click(tablesNodeOf(schema));
	}
}

describe('SchemaTree', () => {
	let layout: FakeLayoutHandle;

	beforeEach(() => {
		layout = useFakeLayout({ viewportHeight: VIEWPORT_HEIGHT, rowHeight: ROW_HEIGHT });
	});

	afterEach(() => {
		layout.restore();
	});

	describe('expanding and collapsing', () => {
		it('starts with every schema collapsed, in name order', () => {
			renderWebview(<SingleHarness />);

			expect(rowTexts()).toEqual(['EMPTYLIB', 'PARTS', 'SALES']);
		});

		it('expands a schema to its Tables node, and that to its tables in name order', async () => {
			let user = userEvent.setup();
			renderWebview(<SingleHarness />);

			await user.click(row('SALES'));
			expect(rowTexts()).toEqual(['EMPTYLIB', 'PARTS', 'SALES', 'Tables (2)']);

			await user.click(row('Tables (2)'));
			expect(rowTexts()).toEqual(['EMPTYLIB', 'PARTS', 'SALES', 'Tables (2)', 'CUSTOMER (Customer master)', 'ORDERS (Order header)']);

			await user.click(row('SALES'));
			expect(rowTexts()).toEqual(['EMPTYLIB', 'PARTS', 'SALES']);
		});

		it('shows no folders under an empty schema', async () => {
			let user = userEvent.setup();
			renderWebview(<SingleHarness />);

			await user.click(row('EMPTYLIB'));

			expect(rowTexts()).toEqual(['EMPTYLIB', 'PARTS', 'SALES']);
		});

		it('collapses to a rail and back, keeping its state', async () => {
			let user = userEvent.setup();
			renderWebview(<SingleHarness />);
			await user.click(row('SALES'));

			await user.click(screen.getByRole('button', { name: 'Collapse schema tree' }));
			expect(renderedRows()).toEqual([]);
			expect(screen.queryByPlaceholderText('Filter...')).toBeNull();

			await user.click(screen.getByRole('button', { name: 'Expand schema tree' }));
			expect(rowTexts()).toEqual(['EMPTYLIB', 'PARTS', 'SALES', 'Tables (2)']);
		});
	});

	describe('filtering', () => {
		it('matches table names and auto-expands only the schemas holding a match', async () => {
			let user = userEvent.setup();
			renderWebview(<SingleHarness />);

			// 'bin' matches one table name only - not its schema, and no description.
			await user.type(screen.getByPlaceholderText('Filter...'), 'bin');

			expect(rowTexts()).toEqual(['PARTS', 'Tables (1)', 'BIN (Stock location)']);
		});

		it('matches descriptions too, case-insensitively', async () => {
			let user = userEvent.setup();
			renderWebview(<SingleHarness />);

			await user.type(screen.getByPlaceholderText('Filter...'), 'MASTER');

			expect(rowTexts()).toEqual(['PARTS', 'Tables (1)', 'PART (Part master)', 'SALES', 'Tables (1)', 'CUSTOMER (Customer master)']);
		});

		it('keeps every table of a schema whose own name matches, and keeps an empty schema that matches', async () => {
			let user = userEvent.setup();
			renderWebview(<SingleHarness />);

			await user.type(screen.getByPlaceholderText('Filter...'), 'sales');
			expect(rowTexts()).toEqual(['SALES', 'Tables (2)', 'CUSTOMER (Customer master)', 'ORDERS (Order header)']);

			await user.clear(screen.getByPlaceholderText('Filter...'));
			await user.type(screen.getByPlaceholderText('Filter...'), 'empty');
			expect(rowTexts()).toEqual(['EMPTYLIB']);
		});

		it('a collapse made while filtering lasts only for that filter, and clearing it restores the manual layout', async () => {
			let user = userEvent.setup();
			renderWebview(<SingleHarness />);

			// Manual layout before filtering: SALES open to its Tables node, nothing else.
			await user.click(row('SALES'));

			await user.type(screen.getByPlaceholderText('Filter...'), 'master');
			await user.click(row('PARTS'));
			expect(rowTexts()).toEqual(['PARTS', 'SALES', 'Tables (1)', 'CUSTOMER (Customer master)']);

			await user.click(screen.getByRole('button', { name: 'Clear filter' }));
			expect(rowTexts()).toEqual(['EMPTYLIB', 'PARTS', 'SALES', 'Tables (2)']);

			// The PARTS collapse belonged to the old filter, so a new one auto-expands it again.
			await user.type(screen.getByPlaceholderText('Filter...'), 'master');
			expect(rowTexts()).toEqual(['PARTS', 'Tables (1)', 'PART (Part master)', 'SALES', 'Tables (1)', 'CUSTOMER (Customer master)']);
		});

		it('says so when nothing matches, with the host\'s own message if it gave one', async () => {
			let user = userEvent.setup();
			let { unmount } = renderWebview(<SingleHarness />);

			await user.type(screen.getByPlaceholderText('Filter...'), 'zzz');
			expect(screen.getByText('No schemas match the current filter')).toBeTruthy();
			expect(renderedRows()).toEqual([]);
			unmount();

			renderWebview(<SingleHarness tablesBySchema={{}} emptyMessage="Loading tables..." />);
			expect(screen.getByText('Loading tables...')).toBeTruthy();
		});
	});

	describe('views', () => {
		it('adds a Views node after Tables, only when the host passes views', async () => {
			let user = userEvent.setup();
			let { unmount } = renderWebview(<SingleHarness viewsBySchema={VIEWS} />);

			await user.click(row('SALES'));
			expect(rowTexts()).toEqual(['EMPTYLIB', 'PARTS', 'SALES', 'Tables (2)', 'Views (2)']);

			await user.click(row('Views (2)'));
			expect(rowTexts()).toEqual(['EMPTYLIB', 'PARTS', 'SALES', 'Tables (2)', 'Views (2)', 'CUSTORD (Orders with customers)', 'ORDERS (Orders view)']);
			unmount();

			renderWebview(<SingleHarness />);
			await user.click(row('SALES'));
			expect(rowTexts()).toEqual(['EMPTYLIB', 'PARTS', 'SALES', 'Tables (2)']);
		});

		it('leaves out the Views node of a schema with no views', async () => {
			let user = userEvent.setup();
			renderWebview(<SingleHarness viewsBySchema={VIEWS} />);

			await user.click(row('PARTS'));

			expect(rowTexts()).toEqual(['EMPTYLIB', 'PARTS', 'Tables (2)', 'SALES']);
		});

		it('filters views like tables, keeping a schema whose only match is a view', () => {
			renderWebview(<SingleHarness viewsBySchema={VIEWS} initialFilter="customers" />);

			expect(rowTexts()).toEqual(['SALES', 'Views (1)', 'CUSTORD (Orders with customers)']);
		});

		it('reports a clicked view through onSelectView, and highlights only the selected kind', async () => {
			let user = userEvent.setup();
			let onSelectTable = vi.fn();
			let onSelectView = vi.fn();
			renderWebview(<SingleHarness viewsBySchema={VIEWS} initialFilter="orders" selected={{ schema: 'SALES', table: 'ORDERS', kind: 'view' }} onSelectTable={onSelectTable} onSelectView={onSelectView} />);

			// The ORDERS table shares the selected view's name - only the view row is highlighted.
			expect(selectedTexts()).toEqual(['ORDERS (Orders view)']);

			await user.click(row('CUSTORD (Orders with customers)'));

			expect(onSelectView).toHaveBeenCalledWith('SALES', 'CUSTORD');
			expect(onSelectTable).not.toHaveBeenCalled();
		});
	});

	describe('functions', () => {
		it('adds a Functions node after Views, showing each overload by its label', async () => {
			let user = userEvent.setup();
			renderWebview(<SingleHarness viewsBySchema={VIEWS} functionsBySchema={FUNCTIONS} />);

			await user.click(row('SALES'));
			expect(rowTexts()).toEqual(['EMPTYLIB', 'PARTS', 'SALES', 'Tables (2)', 'Views (2)', 'Functions (3)']);

			await user.click(row('Functions (3)'));
			expect(rowTexts().slice(6)).toEqual(['ORDER_TOTAL(INTEGER)', 'ORDER_TOTAL(INTEGER, CHAR) (In a currency)', 'ORDERS']);
		});

		it('filters on the label, keeping a schema whose only match is a function', () => {
			renderWebview(<SingleHarness functionsBySchema={FUNCTIONS} initialFilter="char" />);

			expect(rowTexts()).toEqual(['SALES', 'Functions (1)', 'ORDER_TOTAL(INTEGER, CHAR) (In a currency)']);
		});

		it('reports a clicked function by specific name, and highlights only the selected kind', async () => {
			let user = userEvent.setup();
			let onSelectTable = vi.fn();
			let onSelectFunction = vi.fn();
			renderWebview(<SingleHarness functionsBySchema={FUNCTIONS} initialFilter="order" selected={{ schema: 'SALES', table: 'ORDERS', kind: 'function' }} onSelectTable={onSelectTable} onSelectFunction={onSelectFunction} />);

			// The ORDERS table shares the selected function's name - only the function row is highlighted.
			expect(selectedTexts()).toEqual(['ORDERS']);

			await user.click(row('ORDER_TOTAL(INTEGER, CHAR) (In a currency)'));

			expect(onSelectFunction).toHaveBeenCalledWith('SALES', 'ORDER_TOTAL_CURRENCY');
			expect(onSelectTable).not.toHaveBeenCalled();
		});
	});

	describe('procedures', () => {
		it('adds a Procedures node after Functions', async () => {
			let user = userEvent.setup();
			renderWebview(<SingleHarness functionsBySchema={FUNCTIONS} proceduresBySchema={PROCEDURES} />);

			await user.click(row('SALES'));
			expect(rowTexts()).toEqual(['EMPTYLIB', 'PARTS', 'SALES', 'Tables (2)', 'Functions (3)', 'Procedures (2)']);

			await user.click(row('Procedures (2)'));
			expect(rowTexts().slice(6)).toEqual(['NEXT_ORDER_NUMBER', 'ORDER_TOTAL (Recalculate totals)']);
		});

		it('reports a clicked procedure by specific name, never highlighting the same-named function', async () => {
			let user = userEvent.setup();
			let onSelectFunction = vi.fn();
			let onSelectProcedure = vi.fn();
			renderWebview(<SingleHarness functionsBySchema={FUNCTIONS} proceduresBySchema={PROCEDURES} initialFilter="order" selected={{ schema: 'SALES', table: 'ORDER_TOTAL', kind: 'procedure' }} onSelectFunction={onSelectFunction} onSelectProcedure={onSelectProcedure} />);

			expect(selectedTexts()).toEqual(['ORDER_TOTAL (Recalculate totals)']);

			await user.click(row('NEXT_ORDER_NUMBER'));

			expect(onSelectProcedure).toHaveBeenCalledWith('SALES', 'NEXT_ORD00001');
			expect(onSelectFunction).not.toHaveBeenCalled();
		});
	});

	describe('single-select', () => {
		it('reports the clicked table, and highlights the host\'s selected one', async () => {
			let user = userEvent.setup();
			let onSelectTable = vi.fn();
			renderWebview(<SingleHarness initialFilter="master" selected={{ schema: 'SALES', table: 'CUSTOMER' }} onSelectTable={onSelectTable} />);

			expect(selectedTexts()).toEqual(['CUSTOMER (Customer master)']);

			await user.click(row('PART (Part master)'));

			expect(onSelectTable).toHaveBeenCalledWith('PARTS', 'PART');
			// Selection belongs to the host: until it passes a new selectedKey, the highlight stays put.
			expect(selectedTexts()).toEqual(['CUSTOMER (Customer master)']);
		});

		it('offers the host\'s menu items, except while loading', async () => {
			let user = userEvent.setup();
			let onClick = vi.fn();
			let { unmount } = renderWebview(<SingleHarness menuItems={[{ label: 'Edit Schema List', onClick }]} />);

			await user.click(screen.getByRole('button', { name: 'Schema tree options' }));
			await user.click(screen.getByRole('menuitem', { name: 'Edit Schema List' }));
			expect(onClick).toHaveBeenCalledTimes(1);
			unmount();

			renderWebview(<SingleHarness menuItems={[{ label: 'Edit Schema List', onClick }]} loading />);
			expect(screen.queryByRole('button', { name: 'Schema tree options' })).toBeNull();
			expect(screen.getByRole('button', { name: 'Collapse schema tree' })).toBeTruthy();
		});
	});

	describe('multi-select', () => {
		it('a plain click selects one row, ctrl-click toggles, shift-click takes the visible range', async () => {
			let user = userEvent.setup();
			let onSelectionChange = vi.fn();
			renderWebview(<MultiHarness onSelectionChange={onSelectionChange} />);
			await expandAll(user, 'PARTS', 'SALES');

			await user.click(row('BIN (Stock location)'));
			expect(selectedTexts()).toEqual(['BIN (Stock location)']);

			await user.keyboard('{Control>}');
			await user.click(row('ORDERS (Order header)'));
			await user.keyboard('{/Control}');
			expect(selectedTexts()).toEqual(['BIN (Stock location)', 'ORDERS (Order header)']);

			// The range runs in display order across schemas, from the anchor (the last non-shift click).
			await user.click(row('PART (Part master)'));
			await user.keyboard('{Shift>}');
			await user.click(row('ORDERS (Order header)'));
			await user.keyboard('{/Shift}');
			expect(selectedTexts()).toEqual(['PART (Part master)', 'CUSTOMER (Customer master)', 'ORDERS (Order header)']);
			expect([...onSelectionChange.mock.lastCall?.[0] as ReadonlySet<string>]).toEqual([key('PARTS', 'PART'), key('SALES', 'CUSTOMER'), key('SALES', 'ORDERS')]);
		});

		it('repeated shift-clicks re-stretch one range from a fixed anchor, rather than walking it forward', async () => {
			let user = userEvent.setup();
			renderWebview(<MultiHarness />);
			await expandAll(user, 'PARTS', 'SALES');

			await user.click(row('BIN (Stock location)'));
			await user.keyboard('{Shift>}');
			await user.click(row('ORDERS (Order header)'));
			await user.click(row('PART (Part master)'));
			await user.keyboard('{/Shift}');

			expect(selectedTexts()).toEqual(['BIN (Stock location)', 'PART (Part master)']);
		});

		it('a shift-click whose anchor has been filtered out acts as a plain click', async () => {
			let user = userEvent.setup();
			renderWebview(<MultiHarness />);
			await expandAll(user, 'PARTS', 'SALES');

			await user.click(row('BIN (Stock location)'));
			await user.type(screen.getByPlaceholderText('Filter...'), 'master');

			// The first visible table, where a range drawn from a missing anchor (index -1) would come out
			// empty rather than coincidentally matching a plain click.
			await user.keyboard('{Shift>}');
			await user.click(row('PART (Part master)'));
			await user.keyboard('{/Shift}');
			expect(selectedTexts()).toEqual(['PART (Part master)']);

			// And, being a plain click, it became the new anchor.
			await user.keyboard('{Shift>}');
			await user.click(row('CUSTOMER (Customer master)'));
			await user.keyboard('{/Shift}');
			expect(selectedTexts()).toEqual(['PART (Part master)', 'CUSTOMER (Customer master)']);
		});

		it('right-clicking outside the selection replaces it, and the menu is built for what it applies to', async () => {
			let user = userEvent.setup();
			let contextMenuItems = vi.fn((keys: ReadonlySet<string>) => [{ label: `Add ${keys.size} tables to Diagram`, onClick: () => {} }]);
			renderWebview(<MultiHarness contextMenuItems={contextMenuItems} />);
			await expandAll(user, 'SALES');

			await user.click(row('CUSTOMER (Customer master)'));
			await user.keyboard('{Control>}');
			await user.click(row('ORDERS (Order header)'));
			await user.keyboard('{/Control}');

			await user.pointer({ keys: '[MouseRight]', target: row('ORDERS (Order header)') });
			expect(screen.getByRole('menuitem', { name: 'Add 2 tables to Diagram' })).toBeTruthy();
			expect(selectedTexts()).toEqual(['CUSTOMER (Customer master)', 'ORDERS (Order header)']);
			await user.keyboard('{Escape}');

			await expandAll(user, 'PARTS');
			await user.pointer({ keys: '[MouseRight]', target: row('BIN (Stock location)') });
			expect(screen.getByRole('menuitem', { name: 'Add 1 tables to Diagram' })).toBeTruthy();
			expect(selectedTexts()).toEqual(['BIN (Stock location)']);
		});

		it('double-click runs the first context menu entry for that row', async () => {
			let user = userEvent.setup();
			let add = vi.fn();
			renderWebview(<MultiHarness contextMenuItems={keys => [{ label: 'Add', onClick: () => add([...keys]) }, { label: 'Other', onClick: () => {} }]} />);
			await expandAll(user, 'SALES');

			await user.dblClick(row('ORDERS (Order header)'));

			expect(add).toHaveBeenCalledWith([key('SALES', 'ORDERS')]);
		});

		it('a drag carries the selected keys under the tree\'s own MIME type', async () => {
			let user = userEvent.setup();
			renderWebview(<MultiHarness />);
			await expandAll(user, 'SALES');

			await user.click(row('CUSTOMER (Customer master)'));
			await user.keyboard('{Control>}');
			await user.click(row('ORDERS (Order header)'));
			await user.keyboard('{/Control}');

			let dataTransfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: 'none' };
			fireEvent.dragStart(row('ORDERS (Order header)'), { dataTransfer });

			expect(dataTransfer.setData).toHaveBeenCalledWith(TABLE_ROW_DRAG_MIME_TYPE, JSON.stringify([key('SALES', 'CUSTOMER'), key('SALES', 'ORDERS')]));
			expect(dataTransfer.effectAllowed).toBe('copy');
		});
	});

	describe('windowing', () => {
		const MANY: Record<string, SchemaTreeEntry[]> = {
			BIGLIB: Array.from({ length: 500 }, (_, index) => ({ schema: 'BIGLIB', table: `T${String(index).padStart(3, '0')}` }))
		};

		function windowIndexes(): number[] {
			return renderedRows().map(element => Number(element.getAttribute('data-index')));
		}

		it('renders only the rows in view plus overscan, not all 502', async () => {
			let user = userEvent.setup();
			renderWebview(<SingleHarness tablesBySchema={MANY} />);

			await user.click(row('BIGLIB'));
			await user.click(row('Tables (500)'));

			// 340px / 34px = 10 rows in view, plus the tree's overscan of 10 below.
			expect(windowIndexes()).toEqual(Array.from({ length: 20 }, (_, index) => index));
			// The spacer still reserves the full height, so the scrollbar reflects all 502 rows.
			let spacer = renderedRows()[0].parentElement as HTMLElement;
			expect(getComputedStyle(spacer).height).toBe(`${502 * ROW_HEIGHT}px`);
		});

		it('moves the window as the tree scrolls', async () => {
			let user = userEvent.setup();
			renderWebview(<SingleHarness tablesBySchema={MANY} />);
			await user.click(row('BIGLIB'));
			await user.click(row('Tables (500)'));

			let scroller = (renderedRows()[0].parentElement as HTMLElement).parentElement as HTMLElement;
			layout.scroll(scroller, { top: 100 * ROW_HEIGHT });

			// Rows 100-109 in view, 10 of overscan either side.
			expect(windowIndexes()).toEqual(Array.from({ length: 30 }, (_, index) => 90 + index));
			expect(rowTexts()[10]).toBe('T098');
		});
	});
});
