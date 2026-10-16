import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactFlowProvider } from '@xyflow/react';
import type { DiagramInboundMessage, DiagramInitialState, DiagramModel, DiagramOutboundMessage, DiagramTable } from '../../src/webview-messages/diagram-messages';
import { useFakeLayout } from '../test-support/fake-layout';
import type { FakeLayoutHandle } from '../test-support/fake-layout';
import { postFromHost } from '../test-support/host-messages';
import { renderWebview } from '../test-support/render-webview';
import { postedMessages } from '../test-support/vscode-api-stub';
import { TABLE_ROW_DRAG_MIME_TYPE } from '../shared/components/schema-tree';
import { TOOLTIP_ENTER_DELAY_MS } from '../shared/theme/create-vscode-theme';
import { TABLE_DRAG_HANDLE_CLASS } from './components/table-node';
import { App } from './app';

// The diagram editor's half of diagram-messages.ts. The host owns the document: every edit here is a
// request (removeTable, addTables, syncDiagram, ...) and the canvas only changes when a modelUpdated comes
// back, so most of these tests are "this gesture posts exactly this message" plus "this push changes
// exactly this".
//
// React Flow renders into jsdom once it has a container size (fake-layout.ts supplies 1200x800) - but
// it calls onInit from a setTimeout, and that is what moves the canvas off its initial 'cluster' zoom
// tier (tables hidden) to one that shows them, so every test first waits for the table nodes to appear.
// Not covered here: dragging (moveTable/moveTables/moveSchema/resizeSchema go through d3-drag pointer
// sequences jsdom can't produce meaningfully), zoom tiers, edge routing and anchoring - the geometry
// behind those is unit tested in src/diagram/*.spec.ts, and the rendered result needs a real browser.
// app.browser.spec.tsx is that browser: it runs in headless Chromium and covers moving tables (one or a
// selection) and schemas, panning from inside a schema, and resizing a schema.

const VIEWPORT_WIDTH = 1200;
const VIEWPORT_HEIGHT = 800;

function column(name: string, overrides: Partial<DiagramTable['columns'][number]> = {}): DiagramTable['columns'][number] {
	return { name, type: 'DECIMAL(7,0)', primaryKey: false, foreignKey: false, identity: false, notNull: true, unique: false, indexed: false, ...overrides };
}

const MODEL: DiagramModel = {
	schemas: [
		{ id: 'SALES', name: 'SALES', color: '#3366cc', bounds: { x: 0, y: 0, width: 640, height: 320 } },
		{ id: 'PARTS', name: 'PARTS', color: '#cc6633', bounds: { x: 0, y: 360, width: 320, height: 240 } }
	],
	tables: [
		{
			id: 'SALES.CUSTOMER', schemaId: 'SALES', name: 'CUSTOMER', description: 'Customer master', position: { x: 20, y: 40 },
			columns: [column('CUSTOMER_NUMBER', { shortName: 'CUSNO', longName: 'CUSTOMER_NUMBER', primaryKey: true, indexed: true })]
		},
		{
			id: 'SALES.ORDERS', schemaId: 'SALES', name: 'ORDERS', position: { x: 340, y: 40 },
			columns: [
				column('ORDER_NUMBER', { shortName: 'ORDNO', longName: 'ORDER_NUMBER', primaryKey: true }),
				column('CUSTOMER_NUMBER', { shortName: 'CUSNO', longName: 'CUSTOMER_NUMBER', foreignKey: true })
			]
		},
		{
			id: 'PARTS.PART', schemaId: 'PARTS', name: 'PART', position: { x: 20, y: 400 }, importStatus: 'imported',
			columns: [column('PART_NUMBER', { type: 'CHAR(15)', primaryKey: true }), column('BIN_ID', { type: 'CHAR(8)', foreignKey: true })]
		}
	],
	relationships: [{ id: 'r1', fromTable: 'SALES.ORDERS', fromColumn: 'CUSTOMER_NUMBER', toTable: 'SALES.CUSTOMER', toColumn: 'CUSTOMER_NUMBER' }]
};

function initialState(overrides: Partial<DiagramInitialState> = {}): DiagramInitialState {
	return { model: MODEL, fileName: 'sales.drawio', columnLabels: ['Short Name', 'Long Name'], ...overrides };
}

function tableNode(id: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
}

function requireTableNode(id: string): HTMLElement {
	let node = tableNode(id);
	if (!node) {
		throw new Error(`table node ${id} is not rendered`);
	}
	return node;
}

function tableHeader(id: string): HTMLElement {
	return requireTableNode(id).querySelector<HTMLElement>(`.${TABLE_DRAG_HANDLE_CLASS}`) as HTMLElement;
}

function isDimmed(id: string): boolean {
	// The node's own root box, which carries the whole-table dimming - the header's direct parent.
	return getComputedStyle(tableHeader(id).parentElement as HTMLElement).opacity === '0.35';
}

async function renderDiagram(overrides: Partial<DiagramInitialState> = {}) {
	let result = renderWebview(<ReactFlowProvider><App /></ReactFlowProvider>, { initialState: initialState(overrides) });
	// See the file comment: tables appear once React Flow's deferred onInit has set the zoom tier.
	let firstTable = (overrides.model ?? MODEL).tables[0];
	if (firstTable) {
		await waitFor(() => requireTableNode(firstTable.id));
	}
	return result;
}

function posted(): DiagramOutboundMessage[] {
	return postedMessages<DiagramOutboundMessage>();
}

/** Everything posted except the mount-time ready, which every test would otherwise have to list. */
function postedAfterReady(): DiagramOutboundMessage[] {
	let messages = posted();
	expect(messages[0]).toEqual({ command: 'ready' });
	return messages.slice(1);
}

async function openDiagramMenu(user: ReturnType<typeof userEvent.setup>, item: string) {
	await user.click(screen.getByRole('button', { name: 'Diagram menu' }));
	await user.click(screen.getByRole('menuitem', { name: item }));
}

function connect(name: string = 'Production') {
	postFromHost<DiagramInboundMessage>({ command: 'connectionChanged', connectionName: name });
	postFromHost<DiagramInboundMessage>({
		command: 'schemaTablesLoaded',
		tablesBySchema: {
			SALES: [{ schema: 'SALES', table: 'INVOICE', description: 'Invoice header' }, { schema: 'SALES', table: 'CUSTOMER' }],
			PARTS: [{ schema: 'PARTS', table: 'BIN' }]
		},
		schemaList: [{ name: 'SALES', hidden: false, added: false }, { name: 'PARTS', hidden: false, added: false }],
		disabledImportTables: []
	});
}

function treeRow(text: string): HTMLElement {
	let match = [...document.querySelectorAll<HTMLElement>('[data-index]')].find(element => element.textContent === text);
	if (!match) {
		throw new Error(`no tree row "${text}"`);
	}
	return match.querySelector('[role="button"]') as HTMLElement;
}

async function expandTreeSchema(user: ReturnType<typeof userEvent.setup>, schema: string, tableCount: number) {
	await user.click(treeRow(schema));
	await user.click(treeRow(`Tables (${tableCount})`));
}

describe('diagram webview', () => {
	let layout: FakeLayoutHandle;

	beforeEach(() => {
		layout = useFakeLayout({ viewportHeight: VIEWPORT_HEIGHT, rowHeight: 34, width: VIEWPORT_WIDTH });
	});

	afterEach(() => {
		layout.restore();
	});

	describe('document', () => {
		it('announces ready once, on mount, before anything else', async () => {
			await renderDiagram();

			expect(posted()).toEqual([{ command: 'ready' }]);
		});

		it('renders every table with its columns, labelled by the heading-label setting', async () => {
			await renderDiagram();

			expect(within(requireTableNode('SALES.CUSTOMER')).getByText('CUSTOMER')).toBeTruthy();
			expect(within(requireTableNode('SALES.CUSTOMER')).getByText('Customer master')).toBeTruthy();
			// 'Short Name' first in the setting, so the short name wins where there is one...
			expect(within(requireTableNode('SALES.ORDERS')).getByText('ORDNO')).toBeTruthy();
			// ...and a column without one falls back to its identity.
			expect(within(requireTableNode('PARTS.PART')).getByText('PART_NUMBER')).toBeTruthy();
			expect(screen.getByText('3 tables - 1 relationships')).toBeTruthy();
			expect(screen.getByText('sales.drawio')).toBeTruthy();
			expect(document.querySelectorAll('.react-flow__edge')).toHaveLength(1);
		});

		it('relabels columns in place when the setting changes', async () => {
			await renderDiagram();

			postFromHost<DiagramInboundMessage>({ command: 'columnLabelsChanged', columnLabels: ['Long Name'] });

			expect(within(requireTableNode('SALES.ORDERS')).getByText('ORDER_NUMBER')).toBeTruthy();
			expect(within(requireTableNode('SALES.ORDERS')).queryByText('ORDNO')).toBeNull();
		});

		it('modelUpdated replaces the canvas wholesale', async () => {
			await renderDiagram();

			postFromHost<DiagramInboundMessage>({
				command: 'modelUpdated',
				model: { ...MODEL, tables: MODEL.tables.filter(table => table.id !== 'SALES.ORDERS'), relationships: [] }
			});

			await waitFor(() => expect(tableNode('SALES.ORDERS')).toBeNull());
			expect(tableNode('SALES.CUSTOMER')).not.toBeNull();
			expect(screen.getByText('2 tables - 0 relationships')).toBeTruthy();
			expect(document.querySelectorAll('.react-flow__edge')).toHaveLength(0);
		});
	});

	describe('connection', () => {
		it('starts disconnected, with no table picker, and Connect asks the host and shows a spinner', async () => {
			let user = userEvent.setup();
			await renderDiagram();

			expect(screen.queryByPlaceholderText('Filter...')).toBeNull();

			await openDiagramMenu(user, 'Connect');

			expect(postedAfterReady()).toEqual([{ command: 'connectToDatabase' }]);
			// The spinner replaces the menu button, so a second competing connect can't be started.
			expect(screen.queryByRole('button', { name: 'Diagram menu' })).toBeNull();
		});

		it('starts on the spinner when the host is already connecting', async () => {
			await renderDiagram({ connecting: true });

			expect(screen.queryByRole('button', { name: 'Diagram menu' })).toBeNull();

			postFromHost<DiagramInboundMessage>({ command: 'connectionChanged', connectionName: 'Production' });
			expect(screen.getByRole('button', { name: 'Diagram menu' })).toBeTruthy();
		});

		it('once connected, shows the picker - loading until its tables arrive - and offers Reconnect', async () => {
			let user = userEvent.setup();
			await renderDiagram();

			postFromHost<DiagramInboundMessage>({ command: 'connectionChanged', connectionName: 'Production' });
			expect(screen.getByText('Production')).toBeTruthy();
			expect(screen.getByText('Loading tables...')).toBeTruthy();

			connect();
			expect(treeRow('PARTS')).toBeTruthy();
			expect(treeRow('SALES')).toBeTruthy();

			await user.click(screen.getByRole('button', { name: 'Diagram menu' }));
			expect(screen.getByRole('menuitem', { name: 'Reconnect' })).toBeTruthy();
		});

		it('a failed connect drops back to disconnected', async () => {
			await renderDiagram();
			connect();

			postFromHost<DiagramInboundMessage>({ command: 'connectionChanged' });

			expect(screen.queryByPlaceholderText('Filter...')).toBeNull();
			expect(screen.queryByText('Production')).toBeNull();
		});

		it('a cancelled connect ends the spinner and leaves the existing connection and its tables alone', async () => {
			let user = userEvent.setup();
			await renderDiagram();
			connect();

			await openDiagramMenu(user, 'Reconnect');
			expect(screen.queryByRole('button', { name: 'Diagram menu' })).toBeNull();

			postFromHost<DiagramInboundMessage>({ command: 'connectAborted' });

			expect(screen.getByRole('button', { name: 'Diagram menu' })).toBeTruthy();
			expect(screen.getByText('Production')).toBeTruthy();
			expect(treeRow('SALES')).toBeTruthy();
		});
	});

	describe('adding tables', () => {
		it('adds the tables picked in the tree, by schema and table name', async () => {
			let user = userEvent.setup();
			await renderDiagram();
			connect();
			await expandTreeSchema(user, 'SALES', 2);

			await user.click(treeRow('CUSTOMER'));
			await user.keyboard('{Control>}');
			await user.click(treeRow('INVOICE (Invoice header)'));
			await user.keyboard('{/Control}');
			await user.pointer({ keys: '[MouseRight]', target: treeRow('INVOICE (Invoice header)') });
			await user.click(screen.getByRole('menuitem', { name: 'Add 2 Tables to Diagram' }));

			// Nothing but the keys: the host looks the tables up itself rather than trusting the webview's copy.
			expect(postedAfterReady()).toEqual([{ command: 'addTables', tables: [{ schema: 'SALES', table: 'CUSTOMER' }, { schema: 'SALES', table: 'INVOICE' }] }]);
		});

		it('a tree drag dropped anywhere on the canvas adds the same way, and a foreign drag is ignored', async () => {
			await renderDiagram();
			let canvas = document.querySelector('.react-flow')?.parentElement as HTMLElement;

			let foreign = { types: ['Files'], getData: () => '', dropEffect: 'none' };
			// A file from the OS, say: no drop target offered, and nothing added if it's dropped anyway.
			fireEvent.dragEnter(canvas, { dataTransfer: foreign });
			expect(screen.queryByText('Drop to add to diagram')).toBeNull();
			fireEvent.drop(canvas, { dataTransfer: foreign });

			// The same key form the tree writes into its drag (tableKeyToString).
			let keys = JSON.stringify(['SALES/INVOICE']);
			let rows = { types: [TABLE_ROW_DRAG_MIME_TYPE], getData: (type: string) => type === TABLE_ROW_DRAG_MIME_TYPE ? keys : '', dropEffect: 'none' };
			fireEvent.dragEnter(canvas, { dataTransfer: rows });
			expect(screen.getByText('Drop to add to diagram')).toBeTruthy();
			fireEvent.drop(canvas, { dataTransfer: rows });

			expect(screen.queryByText('Drop to add to diagram')).toBeNull();
			expect(postedAfterReady()).toEqual([{ command: 'addTables', tables: [{ schema: 'SALES', table: 'INVOICE' }] }]);
		});

		it('a missing foreign-key target is added from its marker - directly for one, through a picker for several', async () => {
			let user = userEvent.setup();
			await renderDiagram();

			postFromHost<DiagramInboundMessage>({
				command: 'missingTargetsLoaded',
				targets: [
					{ tableId: 'SALES.ORDERS', columnName: 'CUSTOMER_NUMBER', targets: [{ targetSchema: 'SALES', targetTable: 'REGION', targetColumn: 'REGION_ID' }] },
					{
						tableId: 'PARTS.PART', columnName: 'BIN_ID',
						targets: [{ targetSchema: 'PARTS', targetTable: 'BIN', targetColumn: 'BIN_ID' }, { targetSchema: 'PARTS', targetTable: 'LOCATION', targetColumn: 'BIN_ID' }]
					}
				]
			});

			// The marker takes the place of a foreign-key column's link icon.
			await user.click(within(requireTableNode('SALES.ORDERS')).getByTestId('AddLinkIcon'));
			expect(postedAfterReady()).toEqual([{ command: 'addTables', tables: [{ schema: 'SALES', table: 'REGION' }] }]);

			await user.click(within(requireTableNode('PARTS.PART')).getByTestId('AddLinkIcon'));
			let dialog = within(screen.getByRole('dialog'));
			await user.click(dialog.getByRole('checkbox', { name: 'PARTS.LOCATION' }));
			await user.click(dialog.getByRole('button', { name: 'Add' }));

			expect(postedAfterReady().slice(1)).toEqual([{ command: 'addTables', tables: [{ schema: 'PARTS', table: 'LOCATION' }] }]);
		});
	});

	describe('canvas interactions', () => {
		it('a click on a table reports it; a click on one of its columns, or on a schema box, does not', async () => {
			let user = userEvent.setup();
			await renderDiagram();

			await user.click(within(requireTableNode('SALES.ORDERS')).getByText('CUSNO'));
			let schemaNode = document.querySelector<HTMLElement>('.react-flow__node[data-id="SALES"]') as HTMLElement;
			fireEvent.click(within(schemaNode).getAllByText('SALES')[0]);
			expect(postedAfterReady()).toEqual([]);

			// A bare click, not userEvent's full pointer sequence: the header is the drag handle, and d3-drag's
			// mousedown handler dereferences event.view, which a jsdom-synthesized mousedown leaves null.
			fireEvent.click(tableHeader('SALES.ORDERS'));
			expect(postedAfterReady()).toEqual([{ command: 'tableClicked', tableId: 'SALES.ORDERS' }]);
		});

		it('the filter dims tables that don\'t match, and dims nothing once cleared', async () => {
			let user = userEvent.setup();
			await renderDiagram();

			await user.type(screen.getByRole('textbox', { name: 'Filter tables' }), 'cust');

			expect(isDimmed('SALES.CUSTOMER')).toBe(false);
			expect(isDimmed('PARTS.PART')).toBe(true);

			await user.click(screen.getByRole('button', { name: 'Clear filter' }));

			expect(isDimmed('PARTS.PART')).toBe(false);
			expect(isDimmed('SALES.CUSTOMER')).toBe(false);
		});

		it('a right-click on a table header offers to copy the table name', async () => {
			let user = userEvent.setup();
			await renderDiagram();
			await navigator.clipboard.writeText('untouched');

			fireEvent.contextMenu(tableHeader('SALES.ORDERS'));

			expect(screen.queryByRole('menuitem', { name: 'Copy Long Name' })).toBeNull();
			await user.click(screen.getByRole('menuitem', { name: 'Copy Name' }));
			expect(await navigator.clipboard.readText()).toBe('ORDERS');
		});

		it('a right-click on a column offers to copy its name forms, above the table actions', async () => {
			let user = userEvent.setup();
			await renderDiagram();
			await navigator.clipboard.writeText('untouched');

			fireEvent.contextMenu(within(requireTableNode('SALES.ORDERS')).getByText('CUSNO'));

			let items = screen.getAllByRole('menuitem').map(item => item.textContent);
			expect(items.slice(0, 3)).toEqual(['Copy Name', 'Copy Long Name', 'Copy Description']);
			expect(items).toContain('Remove');

			await user.click(screen.getByRole('menuitem', { name: 'Copy Long Name' }));
			expect(await navigator.clipboard.readText()).toBe('CUSTOMER_NUMBER');

			fireEvent.contextMenu(within(requireTableNode('SALES.ORDERS')).getByText('CUSNO'));
			await user.click(screen.getByRole('menuitem', { name: 'Copy Name' }));
			expect(await navigator.clipboard.readText()).toBe('CUSNO');
		});

		it('a right-click hides the tooltip of the column it lands on', async () => {
			let user = userEvent.setup();
			await renderDiagram();
			let cell = within(requireTableNode('SALES.ORDERS')).getByText('CUSNO');

			await user.hover(cell);
			await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeNull());

			fireEvent.contextMenu(cell);

			expect(screen.getByRole('menu')).toBeTruthy();
			await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
		});

		// MUI only reports a tooltip closing when it thinks it's open, and every tooltip is held shut while
		// the menu is: columns the pointer crossed then must not all open at once when the menu closes.
		it('opens no tooltips for columns crossed while the menu was open, once it closes', async () => {
			let user = userEvent.setup();
			await renderDiagram();
			let orders = within(requireTableNode('SALES.ORDERS'));

			fireEvent.contextMenu(orders.getByText('CUSNO'));
			await user.hover(orders.getByText('ORDNO'));
			await user.hover(within(requireTableNode('SALES.CUSTOMER')).getByText('CUSNO'));
			await new Promise(resolve => setTimeout(resolve, TOOLTIP_ENTER_DELAY_MS + 100));

			await user.click(orders.getByText('ORDNO'));
			await new Promise(resolve => setTimeout(resolve, 50));

			expect(screen.queryAllByRole('tooltip').length).toBeLessThanOrEqual(1);
		});

		it('a table\'s context menu opens its schema, exports it, and removes it immediately', async () => {
			let user = userEvent.setup();
			await renderDiagram();

			fireEvent.contextMenu(tableHeader('SALES.ORDERS'));
			await user.click(screen.getByRole('menuitem', { name: 'Open Schema' }));

			fireEvent.contextMenu(tableHeader('SALES.ORDERS'));
			await user.click(screen.getByRole('menuitem', { name: 'Remove' }));

			fireEvent.contextMenu(tableHeader('SALES.CUSTOMER'));
			await user.click(screen.getByRole('menuitem', { name: 'Export...' }));
			let dialog = within(screen.getByRole('dialog'));
			expect(dialog.getByText('Export 1 Table')).toBeTruthy();
			await user.click(dialog.getByLabelText('DBML'));
			await user.click(dialog.getByRole('button', { name: 'Clipboard' }));

			// Removal is a request - the table stays until the host's modelUpdated says otherwise.
			expect(tableNode('SALES.ORDERS')).not.toBeNull();
			expect(postedAfterReady()).toEqual([
				{ command: 'openSchemaForTable', tableId: 'SALES.ORDERS' },
				{ command: 'removeTable', tableId: 'SALES.ORDERS' },
				{ command: 'exportTables', tableIds: ['SALES.CUSTOMER'], format: 'dbml', destination: 'clipboard' }
			]);
		});

		it('offers Disable Imported Changes only for a table with an import behind it, and Enable once the host says one is off', async () => {
			let user = userEvent.setup();
			await renderDiagram();

			fireEvent.contextMenu(tableHeader('SALES.CUSTOMER'));
			expect(screen.queryByRole('menuitem', { name: 'Disable Imported Changes' })).toBeNull();
			expect(screen.getByRole('menuitem', { name: 'Remove' })).toBeTruthy();
			await user.keyboard('{Escape}');

			connect();
			postFromHost<DiagramInboundMessage>({
				command: 'schemaTablesLoaded',
				tablesBySchema: { PARTS: [{ schema: 'PARTS', table: 'PART' }] },
				schemaList: [{ name: 'PARTS', hidden: false, added: false }],
				disabledImportTables: [{ schema: 'parts', table: 'part' }]
			});

			fireEvent.contextMenu(tableHeader('PARTS.PART'));
			await user.click(screen.getByRole('menuitem', { name: 'Disable Imported Changes' }));
			fireEvent.contextMenu(tableHeader('PARTS.PART'));
			await user.click(screen.getByRole('menuitem', { name: 'Enable Imported Changes' }));

			expect(postedAfterReady()).toEqual([
				{ command: 'disableImportedTableData', tableId: 'PARTS.PART' },
				{ command: 'enableImportedTableData', tableId: 'PARTS.PART' }
			]);
		});

		it('removing a schema goes through its header', async () => {
			let user = userEvent.setup();
			await renderDiagram();

			let schemaNode = document.querySelector<HTMLElement>('.react-flow__node[data-id="PARTS"]') as HTMLElement;
			fireEvent.contextMenu(within(schemaNode).getAllByText('PARTS')[0]);
			await user.click(screen.getByRole('menuitem', { name: 'Remove' }));

			expect(postedAfterReady()).toEqual([{ command: 'removeSchema', schemaId: 'PARTS' }]);
		});
	});

	describe('diagram menu', () => {
		it('Sync asks the host, and a Keep/Remove answer confirms with only the tables marked Remove', async () => {
			let user = userEvent.setup();
			await renderDiagram();

			await openDiagramMenu(user, 'Sync with Database');
			postFromHost<DiagramInboundMessage>({
				command: 'syncOrphansFound',
				orphans: [{ tableId: 'SALES.ORDERS', schema: 'SALES', table: 'ORDERS' }, { tableId: 'PARTS.PART', schema: 'PARTS', table: 'PART' }]
			});

			let dialog = within(screen.getByRole('dialog'));
			expect(dialog.getByText('Tables No Longer Found')).toBeTruthy();
			await user.click(dialog.getAllByRole('button', { name: 'Remove' })[1]);
			await user.click(dialog.getByRole('button', { name: 'OK' }));

			expect(postedAfterReady()).toEqual([{ command: 'syncDiagram' }, { command: 'confirmSync', tableIds: ['PARTS.PART'] }]);
			await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
		});

		it('cancelling the Sync prompt tells the host', async () => {
			let user = userEvent.setup();
			await renderDiagram();

			postFromHost<DiagramInboundMessage>({ command: 'syncOrphansFound', orphans: [{ tableId: 'PARTS.PART', schema: 'PARTS', table: 'PART' }] });
			await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

			expect(postedAfterReady()).toEqual([{ command: 'cancelSync' }]);
		});

		it('the import-removal prompt confirms or cancels the same way', async () => {
			let user = userEvent.setup();
			await renderDiagram();

			postFromHost<DiagramInboundMessage>({ command: 'importRemovalOrphanFound', orphans: [{ tableId: 'PARTS.PART', schema: 'PARTS', table: 'PART' }] });
			let dialog = within(screen.getByRole('dialog'));
			expect(dialog.getByText('Nothing Left Backing These Tables')).toBeTruthy();
			// Keep is the default, so OK straight away removes nothing.
			await user.click(dialog.getByRole('button', { name: 'OK' }));

			postFromHost<DiagramInboundMessage>({ command: 'importRemovalOrphanFound', orphans: [{ tableId: 'PARTS.PART', schema: 'PARTS', table: 'PART' }] });
			await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

			expect(postedAfterReady()).toEqual([{ command: 'confirmImportRemoval', removeTableIds: [] }, { command: 'cancelImportRemoval' }]);
		});

		it('Rearrange Tables asks the host to relayout', async () => {
			let user = userEvent.setup();
			await renderDiagram();

			await openDiagramMenu(user, 'Rearrange Tables');

			expect(postedAfterReady()).toEqual([{ command: 'rearrangeTables' }]);
		});

		it('Export sends the current filter, and offers Filtered Tables Only only while there is one', async () => {
			let user = userEvent.setup();
			await renderDiagram();

			await openDiagramMenu(user, 'Export...');
			let dialog = within(screen.getByRole('dialog'));
			expect((dialog.getByRole('radio', { name: 'Filtered Tables Only' }) as HTMLInputElement).disabled).toBe(true);
			await user.click(dialog.getByRole('button', { name: 'Cancel' }));
			// The rest of the page stays aria-hidden until the dialog's exit transition finishes.
			await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

			await user.type(screen.getByRole('textbox', { name: 'Filter tables' }), 'part');
			await openDiagramMenu(user, 'Export...');
			dialog = within(screen.getByRole('dialog'));
			await user.click(dialog.getByRole('radio', { name: 'Filtered Tables Only' }));
			await user.click(dialog.getByRole('button', { name: 'Save' }));

			expect(postedAfterReady()).toEqual([{ command: 'exportDiagram', format: 'drawio', scope: 'filtered', filterText: 'part', destination: 'file' }]);
		});
	});
});
