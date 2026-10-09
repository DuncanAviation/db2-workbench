import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ResolvedColumn } from '../../src/schema-conversion/schema-format-converter';
import type { SchemasInboundMessage, SchemasInitialState, SchemasOutboundMessage, SchemasTreeInboundMessage, TreeTableEntry } from '../../src/webview-messages/schemas-messages';
import { useFakeLayout } from '../test-support/fake-layout';
import type { FakeLayoutHandle } from '../test-support/fake-layout';
import { postFromHost } from '../test-support/host-messages';
import { renderWebview } from '../test-support/render-webview';
import { postedMessages } from '../test-support/vscode-api-stub';
import { App } from './app';
import { routineParam, systemFunction, systemProcedure, systemTable, systemView } from './test-fixtures';
import { DataEditDefaults } from '../../src/utils/data-edit-defaults';

// The schema browser's half of schemas-messages.ts, at the app level: the host pushes that are not
// scoped to one table tab (selectTable, setFilter, schemaListUpdated, importsLoaded, importSchemaError),
// and the lazy per-tab load contract the table sub-tabs share - post a loadX for exactly this table,
// then accept only the reply addressed to it. The Columns tab stands in for that pattern here; Table
// Keys, Foreign Keys, Indexes and Advised Indexes follow the same shape, and sub-tabs.spec.tsx runs it
// against each of them along with their own actions (rename/drop index, create index from advice).
//
// Not covered here: the tree's own rows (virtualized - see shared/components/schema-tree.spec.tsx), and
// the Data tab's edit-mode flow (runDataEditStatements and its progress routing), which has its own
// spec in data-edit-flow.spec.tsx.

function connected(schema: string, name: string, description?: string): TreeTableEntry {
	return { connected: systemTable(schema, name, { description: description ?? '' }) };
}

const TABLES: Record<string, TreeTableEntry[]> = {
	SALES: [connected('SALES', 'CUSTOMER', 'Customer master'), connected('SALES', 'ORDERS', 'Order header')],
	PARTS: [connected('PARTS', 'PART', 'Part master')]
};

function initialState(overrides: Partial<SchemasInitialState> = {}): SchemasInitialState {
	return {
		connectionName: 'Production',
		tablesBySchema: TABLES,
		viewsBySchema: {},
		functionsBySchema: {},
		proceduresBySchema: {},
		schemaList: [{ name: 'SALES', hidden: false, added: false }, { name: 'PARTS', hidden: false, added: false }],
		currentSortSequence: '*HEX',
		currentSortSequenceLibrary: '',
		dataEditSettings: DataEditDefaults.DEFAULT_SETTINGS,
		...overrides
	};
}

function renderSchemas(overrides: Partial<SchemasInitialState> = {}) {
	return renderWebview(<App />, { initialState: initialState(overrides), withDatePickers: true });
}

function tableTabNames(): string[] {
	// The open-table tab strip is the first tablist; each table's sub-tabs (Info, Columns, ...) are the second.
	let [tableTabs] = screen.getAllByRole('tablist');
	// Each tab carries its own close button ('✕') inside it.
	return within(tableTabs).getAllByRole('tab').map(tab => (tab.textContent ?? '').replace('✕', ''));
}

function selectedSubTab(): string {
	let [, subTabs] = screen.getAllByRole('tablist');
	return within(subTabs).getByRole('tab', { selected: true }).textContent ?? '';
}

function column(fields: Partial<ResolvedColumn> & Pick<ResolvedColumn, 'systemName'>): ResolvedColumn {
	return { dataType: 'CHAR', nulls: 'N', isNew: false, importedFields: [], ...fields };
}

function posted(): SchemasOutboundMessage[] {
	return postedMessages<SchemasOutboundMessage>();
}

describe('schemas webview', () => {
	describe('opening tables', () => {
		it('with nothing selected, prompts to pick a table, under the connection name', () => {
			renderSchemas();

			expect(screen.getByText('Select a table, view, function or procedure from the tree to view its details')).toBeTruthy();
			expect(screen.getByText('Production')).toBeTruthy();
			expect(screen.queryAllByRole('tablist')).toHaveLength(0);
		});

		it('opens the initially selected table on its Info tab', () => {
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'ORDERS' } });

			expect(tableTabNames()).toEqual(['ORDERS']);
			expect(selectedSubTab()).toBe('Info');
			expect(screen.getByText('Order header')).toBeTruthy();
		});

		it('pre-fills the tree filter from the initial filter text', () => {
			renderSchemas({ initialFilterText: 'CUST' });

			expect((screen.getByPlaceholderText('Filter...') as HTMLInputElement).value).toBe('CUST');
		});

		it('selectTable opens a tab for a table and makes it active, without duplicating one already open', () => {
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'CUSTOMER' } });

			postFromHost<SchemasTreeInboundMessage>({ command: 'selectTable', schema: 'PARTS', table: 'PART' });
			expect(tableTabNames()).toEqual(['CUSTOMER', 'PART']);
			expect(screen.getByText('Part master')).toBeTruthy();

			postFromHost<SchemasTreeInboundMessage>({ command: 'selectTable', schema: 'SALES', table: 'CUSTOMER' });
			expect(tableTabNames()).toEqual(['CUSTOMER', 'PART']);
			expect(screen.getByText('Customer master')).toBeTruthy();
		});

		it('setFilter replaces the tree filter without opening anything', () => {
			renderSchemas();

			postFromHost<SchemasTreeInboundMessage>({ command: 'setFilter', filterText: 'ORD' });

			expect((screen.getByPlaceholderText('Filter...') as HTMLInputElement).value).toBe('ORD');
			expect(screen.getByText('Select a table, view, function or procedure from the tree to view its details')).toBeTruthy();
		});

		it('closing the last tab returns to the prompt, and the next table opens on Info again', async () => {
			let user = userEvent.setup();
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'CUSTOMER' } });

			await user.click(screen.getByRole('tab', { name: 'Columns' }));
			await user.click(screen.getByRole('button', { name: 'Close CUSTOMER' }));
			expect(screen.getByText('Select a table, view, function or procedure from the tree to view its details')).toBeTruthy();

			postFromHost<SchemasTreeInboundMessage>({ command: 'selectTable', schema: 'PARTS', table: 'PART' });
			expect(selectedSubTab()).toBe('Info');
		});
	});

	describe('views', () => {
		// Opening a view goes through the tree, whose rows are virtualized - fake-layout gives them a viewport.
		let layout: FakeLayoutHandle;

		beforeEach(() => {
			layout = useFakeLayout({ viewportHeight: 400, rowHeight: 34 });
		});

		afterEach(() => {
			layout.restore();
		});

		async function openView(user: ReturnType<typeof userEvent.setup>) {
			await user.click(screen.getByRole('button', { name: 'SALES' }));
			await user.click(screen.getByRole('button', { name: 'Views (1)' }));
			await user.click(screen.getByRole('button', { name: 'ORDERS (Orders view)' }));
		}

		it('opens a view named like a table as its own tab, on Info', async () => {
			let user = userEvent.setup();
			renderSchemas({
				initialSelectedTable: { schema: 'SALES', table: 'ORDERS' },
				viewsBySchema: { SALES: [systemView('SALES', 'ORDERS', { description: 'Orders view', sqlName: 'ORDERS_VIEW' })] }
			});

			await openView(user);

			expect(tableTabNames()).toEqual(['ORDERS', 'ORDERS']);
			let [, subTabs] = screen.getAllByRole('tablist');
			// Same order as a table's tabs: Info, then Columns, with the view-only Definition after.
			expect(within(subTabs).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Info', 'Columns', 'Definition', 'Data']);
			expect(selectedSubTab()).toBe('Info');
			expect(screen.getByText('ORDERS_VIEW')).toBeTruthy();
		});

		// "View Table Details" on a view: the host marks the target kind: 'view', which opens the view's tab
		// (with its Definition sub-tab), not a table tab of the same name.
		it('opens the initially selected view as a view tab', () => {
			renderSchemas({
				initialSelectedTable: { schema: 'SALES', table: 'ORDERS', kind: 'view' },
				viewsBySchema: { SALES: [systemView('SALES', 'ORDERS', { description: 'Orders view', sqlName: 'ORDERS_VIEW' })] }
			});

			expect(tableTabNames()).toEqual(['ORDERS']);
			expect(screen.getByRole('tab', { name: 'Definition' })).toBeTruthy();
			expect(screen.getByText('ORDERS_VIEW')).toBeTruthy();
		});

		it('selectTable with kind view opens the view beside a same-named table tab', () => {
			renderSchemas({
				initialSelectedTable: { schema: 'SALES', table: 'ORDERS' },
				viewsBySchema: { SALES: [systemView('SALES', 'ORDERS', { description: 'Orders view', sqlName: 'ORDERS_VIEW' })] }
			});
			expect(screen.queryByRole('tab', { name: 'Definition' })).toBeNull();

			postFromHost<SchemasTreeInboundMessage>({ command: 'selectTable', schema: 'SALES', table: 'ORDERS', kind: 'view' });

			expect(tableTabNames()).toEqual(['ORDERS', 'ORDERS']);
			expect(screen.getByRole('tab', { name: 'Definition' })).toBeTruthy();
			expect(screen.getByText('ORDERS_VIEW')).toBeTruthy();
		});

		it('loads the definition when its tab opens, formatted first, raw on request', async () => {
			let user = userEvent.setup();
			renderSchemas({ viewsBySchema: { SALES: [systemView('SALES', 'ORDERS', { description: 'Orders view' })] } });

			await openView(user);
			await user.click(screen.getByRole('tab', { name: 'Definition' }));

			expect(posted()).toEqual([{ command: 'loadViewDefinition', schema: 'SALES', table: 'ORDERS' }]);
			expect(screen.getByText('Loading definition...')).toBeTruthy();

			postFromHost<SchemasInboundMessage>({ command: 'viewDefinitionLoaded', schema: 'SALES', table: 'ORDERS', definition: 'select * from orders', formatted: 'SELECT\n\t*\nFROM orders' });

			let editor = () => screen.getByRole('textbox', { name: 'View definition' }) as HTMLTextAreaElement;
			expect(editor().value).toBe('SELECT\n\t*\nFROM orders');
			expect(editor().readOnly).toBe(true);
			expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();

			await user.click(screen.getByRole('button', { name: 'Raw' }));
			expect(editor().value).toBe('select * from orders');
		});

		it('Refresh re-asks for the definition past the cache', async () => {
			let user = userEvent.setup();
			renderSchemas({ viewsBySchema: { SALES: [systemView('SALES', 'ORDERS', { description: 'Orders view' })] } });

			await openView(user);
			await user.click(screen.getByRole('tab', { name: 'Definition' }));
			postFromHost<SchemasInboundMessage>({ command: 'viewDefinitionLoaded', schema: 'SALES', table: 'ORDERS', definition: 'select 1', formatted: 'SELECT 1' });

			await user.click(screen.getByRole('button', { name: 'Refresh' }));

			expect(posted().at(-1)).toEqual({ command: 'loadViewDefinition', schema: 'SALES', table: 'ORDERS', forceRefresh: true });
		});
	});

	describe('functions', () => {
		// Same as views: opening one from the tree needs the virtualized rows to have a viewport.
		let layout: FakeLayoutHandle;

		beforeEach(() => {
			layout = useFakeLayout({ viewportHeight: 400, rowHeight: 34 });
		});

		afterEach(() => {
			layout.restore();
		});

		// Two overloads of ORDER_TOTAL, told apart only by specific name, and a table function named like the
		// ORDERS table.
		const FUNCTIONS = {
			SALES: [
				systemFunction('SALES', 'ORDER_TOTAL', { signature: 'ORDER_TOTAL(INTEGER)' }),
				systemFunction('SALES', 'ORDER_TOTAL', { specificName: 'ORDER_TOTAL_CURRENCY', signature: 'ORDER_TOTAL(INTEGER, CHAR)' }),
				systemFunction('SALES', 'ORDERS', { functionType: 'T', description: 'Open orders' })
			]
		};

		function subTabNames(): string[] {
			let [, subTabs] = screen.getAllByRole('tablist');
			return within(subTabs).getAllByRole('tab').map(tab => tab.textContent ?? '');
		}

		it('opens an overload from the tree by specific name, its tab named by its signature', async () => {
			let user = userEvent.setup();
			renderSchemas({ functionsBySchema: FUNCTIONS });

			await user.click(screen.getByRole('button', { name: 'SALES' }));
			await user.click(screen.getByRole('button', { name: 'Functions (3)' }));
			await user.click(screen.getByRole('button', { name: 'ORDER_TOTAL(INTEGER, CHAR)' }));

			expect(tableTabNames()).toEqual(['ORDER_TOTAL(INTEGER, CHAR)']);
			// A scalar function has no Result Columns tab.
			expect(subTabNames()).toEqual(['Info', 'Parameters', 'Definition']);
			expect(posted()).toContainEqual({ command: 'loadRoutineDetail', schema: 'SALES', table: 'ORDER_TOTAL_CURRENCY' });
			expect(posted()).toContainEqual({ command: 'loadRoutineParams', schema: 'SALES', table: 'ORDER_TOTAL_CURRENCY' });
		});

		it('selectTable with kind function opens the function beside a same-named table tab', () => {
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'ORDERS' }, functionsBySchema: FUNCTIONS });

			postFromHost<SchemasTreeInboundMessage>({ command: 'selectTable', schema: 'SALES', table: 'ORDERS', kind: 'function' });

			expect(tableTabNames()).toEqual(['ORDERS', 'ORDERS']);
			expect(subTabNames()).toEqual(['Info', 'Parameters', 'Result Columns', 'Definition']);
		});

		it('splits a table function\'s rows between Parameters and Result Columns', async () => {
			let user = userEvent.setup();
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'ORDERS', kind: 'function' }, functionsBySchema: FUNCTIONS });
			let rows = [
				routineParam('SALES', 'ORDERS', 'IN_CUSTNO'),
				routineParam('SALES', 'ORDERS', 'ORDNO', { rowType: 'R', dataType: 'INTEGER', length: 4 })
			];

			await user.click(screen.getByRole('tab', { name: 'Parameters' }));
			postFromHost<SchemasInboundMessage>({ command: 'routineParamsLoaded', schema: 'SALES', table: 'ORDERS', params: rows });
			expect(screen.getByText('IN_CUSTNO')).toBeTruthy();
			expect(screen.queryByText('ORDNO')).toBeNull();

			await user.click(screen.getByRole('tab', { name: 'Result Columns' }));
			postFromHost<SchemasInboundMessage>({ command: 'routineParamsLoaded', schema: 'SALES', table: 'ORDERS', params: rows });
			expect(screen.getByText('ORDNO')).toBeTruthy();
			expect(screen.queryByText('IN_CUSTNO')).toBeNull();
		});

		it('shows the generated CREATE statement, and Refresh regenerates it past the cache', async () => {
			let user = userEvent.setup();
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'ORDER_TOTAL', kind: 'function' }, functionsBySchema: FUNCTIONS });

			await user.click(screen.getByRole('tab', { name: 'Definition' }));
			expect(screen.getByText('Generating SQL...')).toBeTruthy();
			expect(posted()).toContainEqual({ command: 'loadRoutineDdl', schema: 'SALES', table: 'ORDER_TOTAL', routineType: 'FUNCTION' });

			postFromHost<SchemasInboundMessage>({ command: 'routineDdlLoaded', schema: 'SALES', table: 'ORDER_TOTAL', ddl: 'CREATE OR REPLACE FUNCTION SALES.ORDER_TOTAL (IN_ORDNO INTEGER)' });

			let editor = screen.getByRole('textbox', { name: 'Function definition' }) as HTMLTextAreaElement;
			expect(editor.value).toBe('CREATE OR REPLACE FUNCTION SALES.ORDER_TOTAL (IN_ORDNO INTEGER)');
			expect(screen.queryByRole('button', { name: 'Raw' })).toBeNull();

			await user.click(screen.getByRole('button', { name: 'Refresh' }));
			expect(posted().at(-1)).toEqual({ command: 'loadRoutineDdl', schema: 'SALES', table: 'ORDER_TOTAL', routineType: 'FUNCTION', forceRefresh: true });
		});

		it('falls back to the body, formatted or raw, when the SQL cannot be generated', async () => {
			let user = userEvent.setup();
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'ORDER_TOTAL', kind: 'function' }, functionsBySchema: FUNCTIONS });

			await user.click(screen.getByRole('tab', { name: 'Definition' }));
			postFromHost<SchemasInboundMessage>({ command: 'routineDdlError', schema: 'SALES', table: 'ORDER_TOTAL', error: { message: 'Not authorized to object ORDER_TOTAL' } });
			expect(screen.getByText('Loading definition...')).toBeTruthy();

			postFromHost<SchemasInboundMessage>({
				command: 'routineDetailLoaded', schema: 'SALES', table: 'ORDER_TOTAL',
				detail: { schema: 'SALES', specificName: 'ORDER_TOTAL', externalName: '', parameterStyle: '', deterministic: 'NO', sqlDataAccess: 'READS', nullCall: 'YES',
					inParms: 1, outParms: 0, inoutParms: 0, resultSets: 0, created: '', lastAltered: '', definer: 'QSECOFR', definition: 'begin return 1; end' },
				formattedDefinition: 'BEGIN\n\tRETURN 1;\nEND'
			});

			let editor = () => screen.getByRole('textbox', { name: 'Function definition' }) as HTMLTextAreaElement;
			expect(editor().value).toBe('BEGIN\n\tRETURN 1;\nEND');
			expect(screen.getByText('The full SQL could not be generated (Not authorized to object ORDER_TOTAL), so only the stored body is shown.')).toBeTruthy();

			await user.click(screen.getByRole('button', { name: 'Raw' }));
			expect(editor().value).toBe('begin return 1; end');

			// Refresh tries the full statement again as well as the body.
			await user.click(screen.getByRole('button', { name: 'Refresh' }));
			expect(posted().slice(-2)).toEqual([
				{ command: 'loadRoutineDdl', schema: 'SALES', table: 'ORDER_TOTAL', routineType: 'FUNCTION', forceRefresh: true },
				{ command: 'loadRoutineDetail', schema: 'SALES', table: 'ORDER_TOTAL', forceRefresh: true }
			]);
		});

		it('names the program an external function runs instead of a body', async () => {
			let user = userEvent.setup();
			renderSchemas({
				initialSelectedTable: { schema: 'ARCHIVE', table: 'ARCHIVE_DATE', kind: 'function' },
				functionsBySchema: { ARCHIVE: [systemFunction('ARCHIVE', 'ARCHIVE_DATE', { body: 'EXTERNAL', language: 'RPGLE', functionOrigin: 'E' })] }
			});

			await user.click(screen.getByRole('tab', { name: 'Definition' }));
			postFromHost<SchemasInboundMessage>({ command: 'routineDdlError', schema: 'ARCHIVE', table: 'ARCHIVE_DATE', error: { message: 'GENERATE_SQL not found' } });
			postFromHost<SchemasInboundMessage>({
				command: 'routineDetailLoaded', schema: 'ARCHIVE', table: 'ARCHIVE_DATE',
				detail: { schema: 'ARCHIVE', specificName: 'ARCHIVE_DATE', externalName: 'ARCHIVE/ARCDATE(ARCDATE)', parameterStyle: 'SQL', deterministic: 'NO', sqlDataAccess: 'NONE', nullCall: 'YES',
					inParms: 1, outParms: 0, inoutParms: 0, resultSets: 0, created: '', lastAltered: '', definer: 'QSECOFR', definition: '' },
				formattedDefinition: ''
			});

			expect(screen.getByText('External function - runs ARCHIVE/ARCDATE(ARCDATE) (RPGLE).')).toBeTruthy();
			expect(screen.queryByRole('textbox', { name: 'Function definition' })).toBeNull();
		});
	});

	describe('procedures', () => {
		let layout: FakeLayoutHandle;

		beforeEach(() => {
			layout = useFakeLayout({ viewportHeight: 400, rowHeight: 34 });
		});

		afterEach(() => {
			layout.restore();
		});

		// A procedure named like a function in the same schema - the two are different objects with tabs of
		// their own.
		const FUNCTIONS = { SALES: [systemFunction('SALES', 'ORDER_TOTAL')] };
		const PROCEDURES = {
			SALES: [
				systemProcedure('SALES', 'ORDER_TOTAL', { description: 'Recalculate totals' }),
				systemProcedure('SALES', 'NEXT_ORDER_NUMBER', { specificName: 'NEXT_ORD00001' })
			]
		};

		function subTabNames(): string[] {
			let [, subTabs] = screen.getAllByRole('tablist');
			return within(subTabs).getAllByRole('tab').map(tab => tab.textContent ?? '');
		}

		it('opens a procedure from its own tree node by specific name', async () => {
			let user = userEvent.setup();
			renderSchemas({ functionsBySchema: FUNCTIONS, proceduresBySchema: PROCEDURES });

			await user.click(screen.getByRole('button', { name: 'SALES' }));
			await user.click(screen.getByRole('button', { name: 'Procedures (2)' }));
			await user.click(screen.getByRole('button', { name: 'NEXT_ORDER_NUMBER' }));

			expect(tableTabNames()).toEqual(['NEXT_ORDER_NUMBER']);
			expect(subTabNames()).toEqual(['Info', 'Parameters', 'Definition']);
			expect(posted()).toContainEqual({ command: 'loadRoutineDetail', schema: 'SALES', table: 'NEXT_ORD00001' });
		});

		it('selectTable with kind procedure opens the procedure beside a same-named function', () => {
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'ORDER_TOTAL', kind: 'function' }, functionsBySchema: FUNCTIONS, proceduresBySchema: PROCEDURES });

			postFromHost<SchemasTreeInboundMessage>({ command: 'selectTable', schema: 'SALES', table: 'ORDER_TOTAL', kind: 'procedure' });

			expect(tableTabNames()).toEqual(['ORDER_TOTAL', 'ORDER_TOTAL']);
		});

		it('opens an external procedure\'s Program Source on the module that defines its entry', async () => {
			let user = userEvent.setup();
			let external = systemProcedure('SALES', 'ORDER_HISTORY', { body: 'EXTERNAL', language: 'RPGLE' });
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'ORDER_HISTORY', kind: 'procedure' }, proceduresBySchema: { SALES: [external] } });

			expect(subTabNames()).toEqual(['Info', 'Parameters', 'Definition', 'Program Source']);
			await user.click(screen.getByRole('tab', { name: 'Program Source' }));
			expect(posted()).toContainEqual({ command: 'loadRoutineSource', schema: 'SALES', table: 'ORDER_HISTORY' });

			postFromHost<SchemasInboundMessage>({
				command: 'routineSourceLoaded', schema: 'SALES', table: 'ORDER_HISTORY', program: 'SALES/ORDSRV (*SRVPGM)', entry: 'ORDHIST', entryModuleFound: true,
				sources: [{ module: 'ORDSRV02', location: 'SALES/QRPGLESRC(ORDSRV02)', text: 'dcl-proc ordHist export;' }]
			});

			// The host sends only the entry's module, so there are no module tabs. The program itself isn't
			// repeated: it is the Info tab's External Name.
			expect(screen.queryByText(/SALES\/ORDSRV \(\*SRVPGM\)/)).toBeNull();
			expect(screen.queryByRole('tablist', { name: 'Modules' })).toBeNull();
			expect(screen.getByText('SALES/QRPGLESRC(ORDSRV02)')).toBeTruthy();
			expect((screen.getByRole('textbox', { name: 'Program source' }) as HTMLTextAreaElement).value).toBe('dcl-proc ordHist export;');
			expect(screen.queryByText(/Could not tell which module/)).toBeNull();
		});

		it('lists every module, and says so, when the one defining the entry could not be told apart', async () => {
			let user = userEvent.setup();
			let external = systemProcedure('SALES', 'ORDER_HISTORY', { body: 'EXTERNAL', language: 'RPGLE' });
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'ORDER_HISTORY', kind: 'procedure' }, proceduresBySchema: { SALES: [external] } });

			await user.click(screen.getByRole('tab', { name: 'Program Source' }));
			postFromHost<SchemasInboundMessage>({
				command: 'routineSourceLoaded', schema: 'SALES', table: 'ORDER_HISTORY', program: 'SALES/ORDSRV (*SRVPGM)', entry: 'ORDHIST', entryModuleFound: false,
				sources: [
					{ module: 'ORDSRV01', location: 'SALES/QRPGLESRC(ORDSRV01)', text: 'dcl-proc formatDate export;' },
					{ module: 'ORDSRV02', location: 'SALES/QRPGLESRC(ORDSRV02)', text: 'dcl-proc other export;' }
				]
			});

			expect(screen.getByText('Could not tell which module defines ORDHIST.')).toBeTruthy();
			expect(within(screen.getByRole('tablist', { name: 'Modules' })).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['ORDSRV01', 'ORDSRV02']);
		});

		it('names the library a *LIBL program was found in, the one thing the external name does not say', async () => {
			let user = userEvent.setup();
			let external = systemProcedure('SALES', 'ORDER_REPORT', { body: 'EXTERNAL', language: 'RPG' });
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'ORDER_REPORT', kind: 'procedure' }, proceduresBySchema: { SALES: [external] } });

			await user.click(screen.getByRole('tab', { name: 'Program Source' }));
			postFromHost<SchemasInboundMessage>({
				command: 'routineSourceLoaded', schema: 'SALES', table: 'ORDER_REPORT', program: 'SALES/ORDRPT (*PGM)', resolvedFromLibraryList: true,
				sources: [{ location: 'SALES/QRPGSRC(ORDRPT)', text: 'C SETON LR' }]
			});

			expect(screen.getByText('Found on the library list: SALES/ORDRPT (*PGM)')).toBeTruthy();
			expect(screen.queryByRole('tablist', { name: 'Modules' })).toBeNull();
		});

		it('says why a module\'s source was not read, in place of the editor', async () => {
			let user = userEvent.setup();
			let external = systemProcedure('SALES', 'ORDER_REPORT', { body: 'EXTERNAL', language: 'RPG' });
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'ORDER_REPORT', kind: 'procedure' }, proceduresBySchema: { SALES: [external] } });

			await user.click(screen.getByRole('tab', { name: 'Program Source' }));
			postFromHost<SchemasInboundMessage>({
				command: 'routineSourceLoaded', schema: 'SALES', table: 'ORDER_REPORT', program: 'SALES/ORDRPT (*PGM)',
				sources: [{ module: 'ORDRPT', location: 'QTEMP/QSQLPRE(ORDRPT)', unavailable: 'Compiled from a temporary copy in QTEMP.' }]
			});

			expect(screen.getByText('QTEMP/QSQLPRE(ORDRPT)')).toBeTruthy();
			expect(screen.getByText('Compiled from a temporary copy in QTEMP.')).toBeTruthy();
			expect(screen.queryByRole('textbox', { name: 'Program source' })).toBeNull();
		});

		it('says why an external procedure has no source to show', async () => {
			let user = userEvent.setup();
			let external = systemProcedure('SALES', 'ORDER_PURGE', { body: 'EXTERNAL', language: 'RPGLE' });
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'ORDER_PURGE', kind: 'procedure' }, proceduresBySchema: { SALES: [external] } });

			await user.click(screen.getByRole('tab', { name: 'Program Source' }));
			postFromHost<SchemasInboundMessage>({
				command: 'routineSourceLoaded', schema: 'SALES', table: 'ORDER_PURGE', program: 'OLDLIB/PURGESRV (*SRVPGM)', sources: [],
				unavailable: '*SRVPGM OLDLIB/PURGESRV was not found - it may have been deleted since the routine was created.'
			});

			expect(screen.getByText('*SRVPGM OLDLIB/PURGESRV was not found - it may have been deleted since the routine was created.')).toBeTruthy();
			expect(screen.queryByRole('textbox', { name: 'Program source' })).toBeNull();
		});

		it('shows a procedure\'s parameter counts and result sets, and none of a function\'s fields', () => {
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'ORDER_TOTAL', kind: 'procedure' }, proceduresBySchema: PROCEDURES });

			postFromHost<SchemasInboundMessage>({
				command: 'routineDetailLoaded', schema: 'SALES', table: 'ORDER_TOTAL',
				detail: { schema: 'SALES', specificName: 'ORDER_TOTAL', externalName: '', parameterStyle: 'SQL', deterministic: 'NO', sqlDataAccess: 'MODIFIES', nullCall: '',
					inParms: 2, outParms: 1, inoutParms: 0, resultSets: 3, created: '', lastAltered: '', definer: 'QSECOFR', definition: 'begin end' },
				formattedDefinition: 'BEGIN\nEND'
			});

			expect(screen.getByText('Result Sets')).toBeTruthy();
			expect(screen.getByText('3')).toBeTruthy();
			expect(screen.getByText('In/Out')).toBeTruthy();
			expect(screen.queryByText('Returns')).toBeNull();
			expect(screen.queryByText('Origin')).toBeNull();
			expect(screen.queryByText('Called On Null Input')).toBeNull();
		});
	});

	describe('lazy sub-tab loading (Columns)', () => {
		it('asks for exactly this table\'s columns when the tab opens, and shows loading until they arrive', async () => {
			let user = userEvent.setup();
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'CUSTOMER' } });

			expect(posted()).toEqual([]);

			await user.click(screen.getByRole('tab', { name: 'Columns' }));

			expect(posted()).toEqual([{ command: 'loadColumns', schema: 'SALES', table: 'CUSTOMER' }]);
			expect(screen.getByText('Loading columns...')).toBeTruthy();
		});

		it('ignores a reply addressed to another table, and renders the one addressed to it', async () => {
			let user = userEvent.setup();
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'CUSTOMER' } });
			await user.click(screen.getByRole('tab', { name: 'Columns' }));

			// Same table name in another schema: the match has to be on both, not on the name alone.
			postFromHost<SchemasInboundMessage>({ command: 'columnsLoaded', schema: 'ARCHIVE', table: 'CUSTOMER', columns: [column({ systemName: 'OLDCOL', sqlName: 'OLD_COLUMN' })] });
			expect(screen.getByText('Loading columns...')).toBeTruthy();

			postFromHost<SchemasInboundMessage>({
				command: 'columnsLoaded',
				schema: 'SALES',
				table: 'CUSTOMER',
				columns: [
					column({ colNo: 1, systemName: 'CUSNO', sqlName: 'CUSTOMER_NUMBER', dataType: 'DECIMAL' }),
					column({ colNo: 2, systemName: 'CUSNM', sqlName: 'CUSTOMER_NAME', dataType: 'VARCHAR', nulls: 'Y' })
				]
			});

			expect(screen.queryByText('Loading columns...')).toBeNull();
			expect(screen.getByText('CUSTOMER_NUMBER')).toBeTruthy();
			expect(screen.getByText('CUSNM')).toBeTruthy();
			expect(screen.queryByText('OLD_COLUMN')).toBeNull();
		});

		it('shows a load failure addressed to it', async () => {
			let user = userEvent.setup();
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'CUSTOMER' } });
			await user.click(screen.getByRole('tab', { name: 'Columns' }));

			postFromHost<SchemasInboundMessage>({ command: 'columnsError', schema: 'SALES', table: 'CUSTOMER', error: { message: 'SQL0551 Not authorized to object SYSCOLUMNS2' } });

			expect(screen.getByText('Failed to load columns', { exact: false })).toBeTruthy();
			expect(screen.getByText('SQL0551 Not authorized to object SYSCOLUMNS2', { exact: false })).toBeTruthy();
		});

		it('Refresh asks again with forceRefresh, bypassing the host cache', async () => {
			let user = userEvent.setup();
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'CUSTOMER' } });
			await user.click(screen.getByRole('tab', { name: 'Columns' }));
			postFromHost<SchemasInboundMessage>({ command: 'columnsLoaded', schema: 'SALES', table: 'CUSTOMER', columns: [column({ systemName: 'CUSNO' })] });

			await user.click(screen.getByRole('button', { name: 'Refresh' }));

			expect(posted()).toEqual([
				{ command: 'loadColumns', schema: 'SALES', table: 'CUSTOMER' },
				{ command: 'loadColumns', schema: 'SALES', table: 'CUSTOMER', forceRefresh: true }
			]);
			expect(screen.getByText('Loading columns...')).toBeTruthy();
		});

		it('keeps the selected sub-tab when another table is opened, and loads that table\'s columns', async () => {
			let user = userEvent.setup();
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'CUSTOMER' } });
			await user.click(screen.getByRole('tab', { name: 'Columns' }));

			postFromHost<SchemasTreeInboundMessage>({ command: 'selectTable', schema: 'PARTS', table: 'PART' });

			expect(selectedSubTab()).toBe('Columns');
			expect(posted()).toEqual([
				{ command: 'loadColumns', schema: 'SALES', table: 'CUSTOMER' },
				{ command: 'loadColumns', schema: 'PARTS', table: 'PART' }
			]);
		});
	});

	// The drag itself needs real layout - see app.browser.spec.tsx. jsdom measures the panel beside the tree
	// as 0 wide, which the handle treats as unknown, so only the minimum width limits these.
	describe('resizing the tree', () => {
		const divider = () => screen.getByRole('separator', { name: 'Resize schema tree' });
		const savedWidths = () => posted().flatMap(message => message.command === 'savePanelWidth' && message.panel === 'tree' ? [message.width] : []);

		it('opens at the width last saved, or the default before one is', () => {
			renderSchemas({ panelWidths: { tree: 400 } });
			expect(divider().getAttribute('aria-valuenow')).toBe('400');
		});

		it('opens at the default width before one is saved', () => {
			renderSchemas();
			expect(divider().getAttribute('aria-valuenow')).toBe('260');
		});

		it('resizes with the arrow keys, saving each width, and stops at the minimum', async () => {
			let user = userEvent.setup();
			renderSchemas({ panelWidths: { tree: 200 } });

			divider().focus();
			await user.keyboard('{ArrowRight}');
			await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');

			expect(divider().getAttribute('aria-valuenow')).toBe('180');
			expect(savedWidths()).toEqual([210, 180]);

			// Already at the minimum: nothing changes, so nothing is saved.
			await user.keyboard('{ArrowLeft}');
			expect(savedWidths()).toEqual([210, 180]);
		});

		it('goes back to the default width on a double-click', async () => {
			let user = userEvent.setup();
			renderSchemas({ panelWidths: { tree: 500 } });

			await user.dblClick(divider());

			expect(divider().getAttribute('aria-valuenow')).toBe('260');
			expect(savedWidths()).toEqual([260]);
		});

		it('has no divider while the tree is collapsed', async () => {
			let user = userEvent.setup();
			renderSchemas();

			await user.click(screen.getByRole('button', { name: 'Collapse schema tree' }));

			expect(screen.queryByRole('separator', { name: 'Resize schema tree' })).toBeNull();
		});
	});

	describe('app-level host pushes', () => {
		it('schemaListUpdated replaces the tables an open tab reads from', () => {
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'CUSTOMER' } });
			expect(screen.getByText('Customer master')).toBeTruthy();

			postFromHost<SchemasTreeInboundMessage>({
				command: 'schemaListUpdated',
				tablesBySchema: { ...TABLES, SALES: [connected('SALES', 'CUSTOMER', 'Customer master (renamed)'), TABLES.SALES[1]] },
				viewsBySchema: {},
				functionsBySchema: {},
				proceduresBySchema: {},
				schemaList: [{ name: 'SALES', hidden: false, added: false }]
			});

			expect(screen.getByText('Customer master (renamed)')).toBeTruthy();
		});

		it('an open tab survives its schema being hidden - the table is still queryable', () => {
			renderSchemas({ initialSelectedTable: { schema: 'SALES', table: 'CUSTOMER' } });

			postFromHost<SchemasTreeInboundMessage>({
				command: 'schemaListUpdated',
				tablesBySchema: { PARTS: TABLES.PARTS },
				viewsBySchema: {},
				functionsBySchema: {},
				proceduresBySchema: {},
				schemaList: [{ name: 'SALES', hidden: true, added: false }, { name: 'PARTS', hidden: false, added: false }]
			});

			expect(tableTabNames()).toEqual(['CUSTOMER']);
			expect(screen.getByText('Customer master')).toBeTruthy();
		});

		it('View Imports asks the host for the list, and shows what comes back', async () => {
			let user = userEvent.setup();
			renderSchemas();

			await user.click(screen.getByRole('button', { name: 'Schema tree options' }));
			await user.click(screen.getByRole('menuitem', { name: 'View Imports' }));

			expect(posted()).toEqual([{ command: 'loadImports' }]);

			postFromHost<SchemasTreeInboundMessage>({
				command: 'importsLoaded',
				imports: [{
					importId: 'import-1',
					sourceLabel: 'parts.dbml',
					sourceFormat: 'dbml',
					importedAt: '2026-09-23T12:00:00.000Z',
					tables: [{ schema: 'PARTS', table: 'PART_ALIAS', enabled: true }]
				}]
			});

			let dialog = within(screen.getByRole('dialog'));
			expect(dialog.getByText('PARTS.PART_ALIAS')).toBeTruthy();
			expect(dialog.getByRole('checkbox', { name: 'Apply PARTS.PART_ALIAS' })).toBeTruthy();
		});

		it('importSchemaError opens the error dialog with the failing source line', () => {
			renderSchemas();

			postFromHost<SchemasTreeInboundMessage>({
				command: 'importSchemaError',
				error: { message: 'Expected "}"', diags: [{ message: 'Expected "}" but found end of input', startLine: 2, startColumn: 5 }] },
				content: 'Table PART {\n  id int\n'
			});

			let dialog = within(screen.getByRole('dialog'));
			expect(dialog.getByText('Import Failed')).toBeTruthy();
			expect(dialog.getByText('Expected "}" but found end of input')).toBeTruthy();
			expect(dialog.getByText('Line 2, Col 5: id int')).toBeTruthy();
		});
	});
});
