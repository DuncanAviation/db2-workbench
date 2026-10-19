import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import type { Row } from '../../src/interfaces/row';
import { ResultHeadingLabel } from '../../src/models/result-heading-label';
import type { SystemColumn } from '../../src/models/system-column';
import { ColumnNameUtils } from '../../src/utils/column-name-utils';
import type { LoadTableDataMessage, RunDataEditStatementsMessage, SchemasInboundMessage, SchemasInitialState, SchemasOutboundMessage, SchemasSystemTable, SchemasTreeInboundMessage, TableDataLoadedMessage } from '../../src/webview-messages/schemas-messages';
import { useFakeLayout } from '../test-support/fake-layout';
import type { FakeLayoutHandle } from '../test-support/fake-layout';
import { postFromHost } from '../test-support/host-messages';
import { renderWebview } from '../test-support/render-webview';
import { postedMessages } from '../test-support/vscode-api-stub';
import { App } from './app';
import { systemTable as sharedSystemTable } from './test-fixtures';
import { DataEditDefaults } from '../../src/utils/data-edit-defaults';
import type { DataEditSettings } from '../../src/utils/data-edit-defaults';

// The Data tab's edit mode end to end, at the app level, because the flow is split three ways: the
// Data tab (table-data-tab.tsx) builds the INSERT/UPDATE/DELETE text from rows and key columns, the app
// (app.tsx) owns the pending list and routes the host's index-keyed progress back to statement ids, and
// the Run SQL panel (run-sql-panel.tsx) shows it all and gates Run/Clear/Cancel. These statements run
// against real tables, so the tests pin the exact SQL that would be sent, not just that something was.
//
// What this does not prove: that DB2 accepts the SQL (the host runs it - see the data-queries
// integration tests for FakeDml, which applies exactly this shape), or the grid's real CSS layout (the
// viewport comes from fake-layout.ts). The date/time picker path through FieldInput is not exercised.

const SCHEMA = 'PARTS';
const TABLE = 'PART';

function systemTable(schema: string, name: string, overrides: Partial<SchemasSystemTable> = {}): SchemasSystemTable {
	return sharedSystemTable(schema, name, { description: `${name} master`, ...overrides });
}

function systemColumn(fields: Partial<SystemColumn> & Pick<SystemColumn, 'systemName' | 'sqlName' | 'dataType'>): SystemColumn {
	return {
		schema: SCHEMA, tableName: TABLE, colNo: 1, heading: '', text: '', nulls: 'Y', identity: 'NO', generated: '', cycle: '',
		hasDefault: 'N', hidden: 'N', updatable: 'YES',
		...fields
	};
}

// PARTNO is the key and required on insert (NOT NULL, no default); DESCR is nullable; QTY is NOT NULL
// but has a default, so it isn't required either. PARTNO is CHAR, which DB2 blank-pads on the way out.
const COLUMNS: SystemColumn[] = [
	systemColumn({ colNo: 1, systemName: 'PARTNO', sqlName: 'PART_NUMBER', dataType: 'CHAR', length: 10, nulls: 'N' }),
	systemColumn({ colNo: 2, systemName: 'DESCR', sqlName: 'DESCRIPTION', dataType: 'VARCHAR', length: 40 }),
	systemColumn({ colNo: 3, systemName: 'QTY', sqlName: 'QUANTITY', dataType: 'DECIMAL', length: 7, scale: 0, nulls: 'N', hasDefault: 'Y' })
];

const ROWS: Row[] = [
	{ PARTNO: 'A100      ', DESCR: 'Bolt', QTY: 5 },
	{ PARTNO: 'B200      ', DESCR: 'Nut', QTY: 12 },
	{ PARTNO: 'C300      ', DESCR: null, QTY: 0 }
];

function tableData(overrides: Partial<TableDataLoadedMessage> = {}): TableDataLoadedMessage {
	return {
		command: 'tableDataLoaded',
		schema: SCHEMA,
		table: TABLE,
		offset: 0,
		rows: ROWS,
		columns: COLUMNS,
		// What the host sends under the default Short Name setting (see SchemasProvider.postTableData).
		columnLabels: ColumnNameUtils.buildLabelMap(new Map(COLUMNS.map(column => [column.systemName, column])), COLUMNS.map(column => column.systemName), [ResultHeadingLabel.SHORT_NAME]),
		hasMore: false,
		keyColumns: [{ systemName: 'PARTNO', isRrn: false }],
		...overrides
	};
}

function initialState(tableOverrides: Partial<SchemasSystemTable> = {}): SchemasInitialState {
	return {
		connectionName: 'Production',
		tablesBySchema: {
			[SCHEMA]: [{ connected: systemTable(SCHEMA, TABLE, tableOverrides) }, { connected: systemTable(SCHEMA, 'BIN') }]
		},
		viewsBySchema: {},
		functionsBySchema: {},
		proceduresBySchema: {},
		schemaList: [{ name: SCHEMA, hidden: false, added: false }],
		currentSortSequence: '*HEX',
		currentSortSequenceLibrary: '',
		dataEditSettings: DataEditDefaults.DEFAULT_SETTINGS,
		initialSelectedTable: { schema: SCHEMA, table: TABLE }
	};
}

interface OpenOptions {
	table?: Partial<SchemasSystemTable>;
	data?: Partial<TableDataLoadedMessage>;
	editMode?: boolean;
	panelWidths?: SchemasInitialState['panelWidths'];
	dataEditSettings?: Partial<DataEditSettings>;
}

/** Opens PARTS.PART's Data tab, answers its first loadTableData, and (by default) enters edit mode. */
async function openDataTab(options: OpenOptions = {}): Promise<UserEvent> {
	let user = userEvent.setup();
	renderWebview(<App />, { initialState: { ...initialState(options.table), panelWidths: options.panelWidths, dataEditSettings: { ...DataEditDefaults.DEFAULT_SETTINGS, ...options.dataEditSettings } }, withDatePickers: true });

	await user.click(screen.getByRole('tab', { name: 'Data' }));
	postFromHost<SchemasInboundMessage>(tableData(options.data));

	if (options.editMode ?? true) {
		await user.click(screen.getByRole('button', { name: 'Edit Data' }));
	}

	return user;
}

function posted(): SchemasOutboundMessage[] {
	return postedMessages<SchemasOutboundMessage>();
}

function loadRequests(): LoadTableDataMessage[] {
	return posted().filter((message): message is LoadTableDataMessage => message.command === 'loadTableData');
}

function runRequests(): RunDataEditStatementsMessage[] {
	return posted().filter((message): message is RunDataEditStatementsMessage => message.command === 'runDataEditStatements');
}

/** Data rows only - the virtual window's spacer rows are left out. */
function dataRows(): HTMLElement[] {
	let [, body] = within(screen.getByRole('table')).getAllByRole('rowgroup');
	return within(body).queryAllByRole('row').filter(row => within(row).queryAllByRole('cell').length > 1);
}

function inputs(row: HTMLElement): HTMLInputElement[] {
	return within(row).queryAllByRole('textbox') as HTMLInputElement[];
}

/** The grid row whose first cell (PARTNO) shows `partNo`, read-only or as an edit field. */
function rowFor(partNo: string): HTMLElement {
	let match = dataRows().find(row => {
		let first = within(row).getAllByRole('cell')[0];
		let input = within(first).queryByRole('textbox') as HTMLInputElement | null;
		return input ? input.value === partNo : (first.textContent ?? '').trim() === partNo;
	});

	if (!match) {
		throw new Error(`No grid row for ${partNo}`);
	}

	return match;
}

function field(partNo: string, systemName: 'PARTNO' | 'DESCR' | 'QTY'): HTMLInputElement {
	return inputs(rowFor(partNo))[COLUMNS.findIndex(column => column.systemName === systemName)];
}

/** Add Row's split-button arrow, then its "Add Row in Dialog" - the button itself adds in the grid. */
async function openAddRowDialog(user: UserEvent) {
	await user.click(screen.getByRole('button', { name: 'More Add Row options' }));
	await user.click(screen.getByRole('menuitem', { name: 'Add Row in Dialog' }));
}

async function rowAction(user: UserEvent, partNo: string, label: string) {
	await user.click(within(rowFor(partNo)).getByRole('button', { name: 'Actions' }));
	await user.click(screen.getByRole('menuitem', { name: label }));
}

// A disabled item's reason renders as a caption under its label (see DataTable's renderActionMenuItems),
// so the two are read apart.
async function rowActionLabels(user: UserEvent, partNo: string): Promise<Array<{ label: string; disabled: boolean; reason?: string }>> {
	await user.click(within(rowFor(partNo)).getByRole('button', { name: 'Actions' }));
	let labels = within(screen.getByRole('menu')).getAllByRole('menuitem').map(item => {
		let reason = item.querySelector('.MuiListItemText-secondary')?.textContent ?? undefined;
		let label = item.querySelector('.MuiListItemText-primary')?.textContent ?? item.textContent ?? '';
		return { label, disabled: item.getAttribute('aria-disabled') === 'true', ...(reason ? { reason } : {}) };
	});
	await user.keyboard('{Escape}');
	return labels;
}

/** The right-click menu over `target` (a grid field or cell), read the same way as rowActionLabels. */
async function cellMenu(user: UserEvent, target: HTMLElement): Promise<Array<{ label: string; disabled: boolean; reason?: string }>> {
	await user.pointer({ keys: '[MouseRight]', target });
	let labels = within(screen.getByRole('menu')).getAllByRole('menuitem').map(item => {
		let reason = item.querySelector('.MuiListItemText-secondary')?.textContent ?? undefined;
		let label = item.querySelector('.MuiListItemText-primary')?.textContent ?? item.textContent ?? '';
		return { label, disabled: item.getAttribute('aria-disabled') === 'true', ...(reason ? { reason } : {}) };
	});
	await user.keyboard('{Escape}');
	await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
	return labels;
}

/** Walks up `levels` parents - throws rather than returning null, so a changed DOM shape fails loudly. */
function ancestor(element: HTMLElement, levels: number): HTMLElement {
	let current: HTMLElement | null = element;

	for (let i = 0; i < levels && current; i++) {
		current = current.parentElement;
	}

	if (!current) {
		throw new Error('Element has fewer ancestors than expected');
	}

	return current;
}

function panel(): HTMLElement {
	// The panel's title row sits directly inside the panel's own root Stack.
	return ancestor(screen.getByText('Run SQL'), 2);
}

function panelSql(): string[] {
	return [...panel().querySelectorAll('code')].map(code => code.textContent ?? '');
}

/** One pending statement's block in the panel: its chip, status icon, discard button, SQL and error. */
function statementItem(index: number): HTMLElement {
	return ancestor(panel().querySelectorAll('code')[index], 2);
}

function statementStatus(index: number): 'running' | 'success' | 'error' | undefined {
	let item = statementItem(index);

	if (within(item).queryByRole('progressbar')) {
		return 'running';
	}

	if (item.querySelector('[data-testid="CheckCircleIcon"]')) {
		return 'success';
	}

	if (item.querySelector('[data-testid="CancelIcon"]')) {
		return 'error';
	}

	return undefined;
}

function panelButton(name: string): HTMLButtonElement {
	return within(panel()).getByRole('button', { name }) as HTMLButtonElement;
}

// A closing MUI dialog keeps the rest of the page aria-hidden until its exit transition ends, which
// hides every role query behind it - wait that out before the next query.
async function dialogsClosed() {
	await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

async function run(user: UserEvent, expectedSummary: string) {
	await user.click(panelButton('Run'));
	let dialog = within(screen.getByRole('dialog'));
	expect(dialog.getByText(`This will run ${expectedSummary}.`)).toBeTruthy();
	await user.click(dialog.getByRole('button', { name: 'Run' }));
	await dialogsClosed();
}

function progress(index: number, status: 'running' | 'success' | 'error') {
	postFromHost<SchemasTreeInboundMessage>({ command: 'runDataEditStatementProgress', index, status });
}

function result(executedCount: number, failed: boolean, message?: string) {
	postFromHost<SchemasTreeInboundMessage>({ command: 'runDataEditStatementsResult', executedCount, failed, error: message ? { message } : undefined });
}

const DELETE_A100 = 'DELETE FROM "PARTS"."PART" WHERE "PARTNO" = \'A100\'';
const DELETE_B200 = 'DELETE FROM "PARTS"."PART" WHERE "PARTNO" = \'B200\'';
const DELETE_C300 = 'DELETE FROM "PARTS"."PART" WHERE "PARTNO" = \'C300\'';

describe('schemas Data tab edit flow', () => {
	let layout: FakeLayoutHandle;

	beforeEach(() => {
		layout = useFakeLayout({ viewportHeight: 600 });
	});

	afterEach(() => {
		layout.restore();
	});

	describe('loading', () => {
		it('asks for the first page of exactly this table when the Data tab opens, and ignores another table\'s rows', async () => {
			let user = userEvent.setup();
			renderWebview(<App />, { initialState: initialState(), withDatePickers: true });

			await user.click(screen.getByRole('tab', { name: 'Data' }));
			expect(loadRequests()).toEqual([{ command: 'loadTableData', schema: SCHEMA, table: TABLE, offset: 0, limit: 100, where: '' }]);
			expect(screen.getByText('Loading data...')).toBeTruthy();

			// Same table name in another schema - the match is on both.
			postFromHost<SchemasInboundMessage>(tableData({ schema: 'ARCHIVE' }));
			expect(screen.getByText('Loading data...')).toBeTruthy();

			postFromHost<SchemasInboundMessage>(tableData());
			expect(dataRows()).toHaveLength(3);
		});

		it('keeps the loaded rows (and makes no new request) when switching sub-tabs and back', async () => {
			let user = await openDataTab({ editMode: false });

			await user.click(screen.getByRole('tab', { name: 'Info' }));
			await user.click(screen.getByRole('tab', { name: 'Data' }));

			expect(loadRequests()).toHaveLength(1);
			expect(dataRows()).toHaveLength(3);
		});

		it('re-queries with ORDER BY on a header click instead of sorting the loaded page itself', async () => {
			let user = await openDataTab({ editMode: false });

			await user.click(screen.getByRole('button', { name: 'DESCR' }));

			expect(loadRequests()[1]).toEqual({ command: 'loadTableData', schema: SCHEMA, table: TABLE, offset: 0, limit: 100, orderBy: { systemName: 'DESCR', direction: 'asc' }, where: '' });
		});
	});

	// The drag itself needs real layout - see components/run-sql-panel.browser.spec.tsx.
	describe('resizing the Run SQL panel', () => {
		const divider = () => screen.getByRole('separator', { name: 'Resize run SQL panel' });
		const savedWidths = () => posted().flatMap(message => message.command === 'savePanelWidth' && message.panel === 'runSql' ? [message.width] : []);

		it('opens at the width last saved, or the default before one is', async () => {
			await openDataTab({ panelWidths: { runSql: 500 } });
			expect(divider().getAttribute('aria-valuenow')).toBe('500');
		});

		it('opens at the default width before one is saved, separately from the tree', async () => {
			await openDataTab({ panelWidths: { tree: 400 } });
			expect(divider().getAttribute('aria-valuenow')).toBe('360');
		});

		it('widens as its divider moves left, with the arrow keys, and goes back to the default on a double-click', async () => {
			let user = await openDataTab();

			divider().focus();
			await user.keyboard('{ArrowLeft}');
			expect(divider().getAttribute('aria-valuenow')).toBe('370');

			await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
			expect(divider().getAttribute('aria-valuenow')).toBe('320');

			await user.dblClick(divider());
			expect(divider().getAttribute('aria-valuenow')).toBe('360');
			expect(savedWidths()).toEqual([370, 320, 360]);
		});

		it('has no divider while the panel is collapsed', async () => {
			let user = await openDataTab();

			await user.click(screen.getByRole('button', { name: 'Collapse run SQL panel' }));

			expect(screen.queryByRole('separator', { name: 'Resize run SQL panel' })).toBeNull();
		});
	});

	describe('entering and leaving edit mode', () => {
		it('Edit Data opens an empty Run SQL panel and swaps in Add Row and Cancel Edit, without posting anything', async () => {
			let user = await openDataTab({ editMode: false });
			expect(screen.queryByText('Run SQL')).toBeNull();
			expect(screen.queryByRole('button', { name: 'Actions' })).toBeNull();
			let before = posted().length;

			await user.click(screen.getByRole('button', { name: 'Edit Data' }));

			expect(within(panel()).getByText('No pending changes')).toBeTruthy();
			expect(screen.queryByRole('button', { name: 'Edit Data' })).toBeNull();
			expect(screen.getByRole('button', { name: 'Cancel Edit' })).toBeTruthy();
			expect(screen.getByRole('button', { name: 'Add Row' })).toBeTruthy();
			expect(within(rowFor('A100')).getByRole('button', { name: 'Actions' })).toBeTruthy();
			expect(panelButton('Run').disabled).toBe(true);
			expect(panelButton('Clear').disabled).toBe(true);
			expect(posted()).toHaveLength(before);
		});

		it('shows CHAR values right-trimmed in the edit fields, and leaves other types alone', async () => {
			await openDataTab();

			expect(inputs(dataRows()[0]).map(input => input.value)).toEqual(['A100', 'Bolt', '5']);
			expect(inputs(dataRows()[2]).map(input => input.value)).toEqual(['C300', '', '0']);
		});

		// A VARCHAR isn't padded, so its trailing blanks are data - trimming them would rewrite the value
		// on the first unrelated edit to the field.
		it('keeps a VARCHAR\'s trailing spaces, which are data rather than padding', async () => {
			let user = await openDataTab({ data: { rows: [{ ...ROWS[0], DESCR: 'Bolt  ' }, ...ROWS.slice(1)] } });

			expect(field('A100', 'DESCR').value).toBe('Bolt  ');

			await user.type(field('A100', 'DESCR'), 's');
			expect(panelSql()).toEqual(['UPDATE "PARTS"."PART" SET "DESCR" = \'Bolt  s\' WHERE "PARTNO" = \'A100\'']);
		});

		it('Cancel with nothing pending leaves edit mode without asking', async () => {
			let user = await openDataTab();

			await user.click(panelButton('Cancel'));

			expect(screen.queryByRole('dialog')).toBeNull();
			expect(screen.queryByText('Run SQL')).toBeNull();
			expect(screen.getByRole('button', { name: 'Edit Data' })).toBeTruthy();
		});

		it('Cancel with pending statements asks first, and backing out keeps them', async () => {
			let user = await openDataTab();
			await rowAction(user, 'A100', 'Delete Row');
			await rowAction(user, 'B200', 'Delete Row');

			await user.click(screen.getByRole('button', { name: 'Cancel Edit' }));
			let dialog = within(screen.getByRole('dialog'));
			expect(dialog.getByText('Discard 2 statements that have not yet been run?')).toBeTruthy();
			await user.click(dialog.getByRole('button', { name: 'Cancel' }));
			await dialogsClosed();

			expect(panelSql()).toEqual([DELETE_A100, DELETE_B200]);
		});

		it('confirming the discard drops every pending statement and leaves edit mode', async () => {
			let user = await openDataTab();
			await rowAction(user, 'A100', 'Delete Row');

			await user.click(panelButton('Cancel'));
			let dialog = within(screen.getByRole('dialog'));
			expect(dialog.getByText('Discard 1 statement that has not yet been run?')).toBeTruthy();
			await user.click(dialog.getByRole('button', { name: 'Discard' }));
			await dialogsClosed();

			expect(screen.queryByText('Run SQL')).toBeNull();
			expect(runRequests()).toEqual([]);

			// Back in, nothing carried over.
			await user.click(screen.getByRole('button', { name: 'Edit Data' }));
			expect(within(panel()).getByText('No pending changes')).toBeTruthy();
		});

		it('closing the table tab goes through the same discard confirmation', async () => {
			let user = await openDataTab();
			await rowAction(user, 'A100', 'Delete Row');

			await user.click(screen.getByRole('button', { name: `Close ${TABLE}` }));
			let dialog = within(screen.getByRole('dialog'));
			expect(dialog.getByText('Discard 1 statement that has not yet been run?')).toBeTruthy();
			await user.click(dialog.getByRole('button', { name: 'Cancel' }));
			await dialogsClosed();
			expect(screen.getByRole('tab', { name: new RegExp(`^${TABLE}`) })).toBeTruthy();
			expect(panelSql()).toEqual([DELETE_A100]);

			await user.click(screen.getByRole('button', { name: `Close ${TABLE}` }));
			await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard' }));
			await dialogsClosed();

			expect(screen.getByText('Select a table, view, function or procedure from the tree to view its details')).toBeTruthy();
			expect(screen.queryByText('Run SQL')).toBeNull();
		});

		it('the collapse toggle hides the panel\'s contents without dropping them', async () => {
			let user = await openDataTab();
			await rowAction(user, 'A100', 'Delete Row');

			await user.click(screen.getByRole('button', { name: 'Collapse run SQL panel' }));
			expect(screen.queryByText('Run SQL')).toBeNull();

			await user.click(screen.getByRole('button', { name: 'Expand run SQL panel' }));
			expect(panelSql()).toEqual([DELETE_A100]);
		});
	});

	describe('building statements', () => {
		it('Delete Row queues a DELETE keyed on the trimmed key value, strikes the row through, and offers Cancel Delete', async () => {
			let user = await openDataTab();

			await rowAction(user, 'A100', 'Delete Row');

			expect(panelSql()).toEqual([DELETE_A100]);
			expect(within(statementItem(0)).getByText('Delete')).toBeTruthy();
			let firstCell = within(rowFor('A100')).getAllByRole('cell')[0];
			expect(getComputedStyle(firstCell).textDecoration).toContain('line-through');
			// A row pending deletion is no longer editable inline.
			expect(inputs(rowFor('A100'))).toEqual([]);
			expect(getComputedStyle(within(rowFor('B200')).getAllByRole('cell')[0]).textDecoration).not.toContain('line-through');

			expect(await rowActionLabels(user, 'A100')).toEqual([{ label: 'Cancel Delete', disabled: false }]);
			await rowAction(user, 'A100', 'Cancel Delete');

			expect(within(panel()).getByText('No pending changes')).toBeTruthy();
			expect(inputs(rowFor('A100'))).toHaveLength(3);
		});

		// "= NULL" matches no row, so either key would otherwise make the statement silently do nothing.
		it('keys an all-blank CHAR value as \'\' and a NULL value with IS NULL', async () => {
			let user = await openDataTab({
				data: {
					rows: [...ROWS, { PARTNO: '          ', DESCR: 'Blank key', QTY: 1 }],
					keyColumns: [{ systemName: 'PARTNO', isRrn: false }, { systemName: 'DESCR', isRrn: false }]
				}
			});

			await rowAction(user, '', 'Delete Row');
			await rowAction(user, 'C300', 'Delete Row');

			expect(panelSql()).toEqual([
				'DELETE FROM "PARTS"."PART" WHERE "PARTNO" = \'\' AND "DESCR" = \'Blank key\'',
				'DELETE FROM "PARTS"."PART" WHERE "PARTNO" = \'C300\' AND "DESCR" IS NULL'
			]);
		});

		it('keys on RRN(table) when the table has no real key', async () => {
			let user = await openDataTab({
				data: {
					rows: ROWS.map((row, index) => ({ ...row, $RRN: index + 41 })),
					keyColumns: [{ systemName: '$RRN', isRrn: true }]
				}
			});

			await rowAction(user, 'B200', 'Delete Row');

			expect(panelSql()).toEqual(['DELETE FROM "PARTS"."PART" WHERE RRN("PART") = 42']);
		});

		it('ANDs every column of a composite key into the WHERE clause', async () => {
			let user = await openDataTab({ data: { keyColumns: [{ systemName: 'PARTNO', isRrn: false }, { systemName: 'QTY', isRrn: false }] } });

			await rowAction(user, 'B200', 'Delete Row');

			expect(panelSql()).toEqual(['DELETE FROM "PARTS"."PART" WHERE "PARTNO" = \'B200\' AND "QTY" = 12']);
		});

		it('inline editing keeps one UPDATE per row, with only the changed columns, and focus stays in the field while typing', async () => {
			let user = await openDataTab();

			await user.clear(field('A100', 'DESCR'));
			await user.type(field('A100', 'DESCR'), 'Hex bolt');
			await user.clear(field('A100', 'QTY'));
			await user.type(field('A100', 'QTY'), '40');

			expect(panelSql()).toEqual(['UPDATE "PARTS"."PART" SET "DESCR" = \'Hex bolt\', "QTY" = 40 WHERE "PARTNO" = \'A100\'']);
			expect(within(statementItem(0)).getByText('Update')).toBeTruthy();
			expect(field('A100', 'DESCR').value).toBe('Hex bolt');
			expect(await rowActionLabels(user, 'A100')).toEqual([{ label: 'Edit Row', disabled: false }, { label: 'Duplicate Row', disabled: false }, { label: 'Cancel Update', disabled: false }]);
		});

		it('keeps a leading space typed into a value, and in a fetched key, since either can be real data', async () => {
			let user = await openDataTab({ data: { rows: [...ROWS, { PARTNO: ' E500     ', DESCR: 'Spacer', QTY: 1 }] } });

			await user.type(field('A100', 'DESCR'), '{Home} ');
			await rowAction(user, ' E500', 'Delete Row');

			expect(panelSql()).toEqual([
				'UPDATE "PARTS"."PART" SET "DESCR" = \' Bolt\' WHERE "PARTNO" = \'A100\'',
				'DELETE FROM "PARTS"."PART" WHERE "PARTNO" = \' E500\''
			]);
		});

		it('clearing a character value sets it to the empty string, not NULL', async () => {
			let user = await openDataTab();

			await user.clear(field('B200', 'DESCR'));

			expect(panelSql()).toEqual(['UPDATE "PARTS"."PART" SET "DESCR" = \'\' WHERE "PARTNO" = \'B200\'']);
			expect(field('B200', 'DESCR').placeholder).toBe('');
		});

		it('clearing a number sets it to NULL, since a number has no empty value', async () => {
			let columns = COLUMNS.map(column => column.systemName === 'QTY' ? { ...column, nulls: 'Y' } : column);
			let user = await openDataTab({ data: { columns } });

			await user.clear(field('B200', 'QTY'));

			expect(panelSql()).toEqual(['UPDATE "PARTS"."PART" SET "QTY" = NULL WHERE "PARTNO" = \'B200\'']);
		});

		// The right-click menu opens with the cell's own actions above the row's.
		it('Set NULL from a field\'s right-click menu sets it to NULL and shows it as <null>', async () => {
			let user = await openDataTab();

			expect(await cellMenu(user, field('B200', 'DESCR'))).toEqual([
				{ label: 'Set NULL', disabled: false },
				{ label: 'Edit Row', disabled: false },
				{ label: 'Duplicate Row', disabled: false },
				{ label: 'Delete Row', disabled: false },
				{ label: 'Add Row', disabled: false },
				{ label: 'Add Row in Dialog', disabled: false },
				{ label: 'Edit Search', disabled: false },
				{ label: 'Cancel Edit', disabled: false },
				{ label: 'Refresh', disabled: false },
				{ label: 'Export...', disabled: false },
				{ label: 'Settings...', disabled: false }
			]);

			await user.pointer({ keys: '[MouseRight]', target: field('B200', 'DESCR') });
			await user.click(screen.getByRole('menuitem', { name: 'Set NULL' }));

			expect(panelSql()).toEqual(['UPDATE "PARTS"."PART" SET "DESCR" = NULL WHERE "PARTNO" = \'B200\'']);
			expect(field('B200', 'DESCR').value).toBe('');
			expect(field('B200', 'DESCR').placeholder).toBe('<null>');

			// Typing replaces the NULL.
			await user.type(field('B200', 'DESCR'), 'Washer');
			expect(panelSql()).toEqual(['UPDATE "PARTS"."PART" SET "DESCR" = \'Washer\' WHERE "PARTNO" = \'B200\'']);
		});

		// An action that can't be done is left out, not shown disabled.
		it('Set NULL is left out of the menu on a NOT NULL column or a field already NULL', async () => {
			let user = await openDataTab();

			expect((await cellMenu(user, field('A100', 'QTY'))).map(item => item.label)).not.toContain('Set NULL');
			expect((await cellMenu(user, field('C300', 'DESCR'))).map(item => item.label)).not.toContain('Set NULL');
			expect(field('C300', 'DESCR').placeholder).toBe('<null>');
		});

		// The Menu key and Shift+F10 fire contextmenu on the focused field with no pointer position.
		it('the keyboard\'s context menu key opens the same menu on the focused field', async () => {
			await openDataTab();

			fireEvent.contextMenu(field('B200', 'DESCR'));

			expect(within(screen.getByRole('menu')).getAllByRole('menuitem')[0].textContent).toBe('Set NULL');
		});

		it('a row\'s right-click menu has no Set NULL outside an edit field, or on a row pending deletion', async () => {
			let user = await openDataTab();
			await rowAction(user, 'A100', 'Delete Row');

			let labels = await cellMenu(user, within(rowFor('A100')).getAllByRole('cell')[1]);

			expect(labels.map(item => item.label)).not.toContain('Set NULL');
		});

		it('typing a value back to what the database has drops that column, and the statement once nothing is left', async () => {
			let user = await openDataTab();

			await user.type(field('A100', 'DESCR'), 's');
			await user.type(field('A100', 'QTY'), '0');
			expect(panelSql()).toEqual(['UPDATE "PARTS"."PART" SET "DESCR" = \'Bolts\', "QTY" = 50 WHERE "PARTNO" = \'A100\'']);

			await user.type(field('A100', 'QTY'), '{Backspace}');
			expect(panelSql()).toEqual(['UPDATE "PARTS"."PART" SET "DESCR" = \'Bolts\' WHERE "PARTNO" = \'A100\'']);

			await user.type(field('A100', 'DESCR'), '{Backspace}');
			expect(within(panel()).getByText('No pending changes')).toBeTruthy();
		});

		it('an edited key column goes in SET, the WHERE keeps the original key, and later edits still find the row', async () => {
			let user = await openDataTab();

			// Held on to: once cleared, the row no longer shows A100 to be found by.
			let partNo = field('A100', 'PARTNO');
			await user.clear(partNo);
			await user.type(partNo, 'A101');
			await user.clear(field('A101', 'DESCR'));
			await user.type(field('A101', 'DESCR'), 'Renamed');

			expect(panelSql()).toEqual(['UPDATE "PARTS"."PART" SET "PARTNO" = \'A101\', "DESCR" = \'Renamed\' WHERE "PARTNO" = \'A100\'']);
		});

		it('never makes LOB, identity or non-updatable columns editable', async () => {
			await openDataTab({
				data: {
					columns: [
						...COLUMNS,
						systemColumn({ colNo: 4, systemName: 'PARTID', sqlName: 'PART_ID', dataType: 'INTEGER', identity: 'YES' }),
						systemColumn({ colNo: 5, systemName: 'DRAWING', sqlName: 'DRAWING', dataType: 'BLOB' }),
						systemColumn({ colNo: 6, systemName: 'CHGTS', sqlName: 'CHANGED_AT', dataType: 'VARCHAR', updatable: 'NO' })
					],
					rows: ROWS.map((row, index) => ({ ...row, PARTID: index + 1, DRAWING: 2048, CHGTS: 'auto' }))
				}
			});

			let cells = within(rowFor('A100')).getAllByRole('cell');
			expect(inputs(rowFor('A100'))).toHaveLength(3);
			expect(cells[3].textContent).toBe('1');
			expect(cells[4].textContent).toBe('[LOB, 2.0 KB]');
			expect(cells[5].textContent).toBe('auto');
		});

		it('Edit Row keeps an earlier inline change when a different field is changed in the dialog', async () => {
			let user = await openDataTab();
			await user.clear(field('A100', 'DESCR'));
			await user.type(field('A100', 'DESCR'), 'Hex bolt');

			await rowAction(user, 'A100', 'Edit Row');
			let dialog = within(screen.getByRole('dialog'));
			expect(dialog.getByText('Editing row where PARTNO = A100')).toBeTruthy();
			expect((dialog.getByRole('textbox', { name: 'DESCR' }) as HTMLInputElement).value).toBe('Hex bolt');
			await user.clear(dialog.getByRole('textbox', { name: 'QTY' }));
			await user.type(dialog.getByRole('textbox', { name: 'QTY' }), '9');
			await user.click(dialog.getByRole('button', { name: 'Update Run' }));
			await dialogsClosed();

			expect(panelSql()).toEqual(['UPDATE "PARTS"."PART" SET "DESCR" = \'Hex bolt\', "QTY" = 9 WHERE "PARTNO" = \'A100\'']);
		});

		it('Edit Row changed back to the database\'s values removes the pending update instead of submitting a no-op', async () => {
			let user = await openDataTab();
			await user.type(field('B200', 'DESCR'), 's');

			await rowAction(user, 'B200', 'Edit Row');
			let dialog = within(screen.getByRole('dialog'));
			await user.type(dialog.getByRole('textbox', { name: 'DESCR' }), '{Backspace}');
			await user.click(dialog.getByRole('button', { name: 'Update Run' }));
			await dialogsClosed();

			expect(within(panel()).getByText('No pending changes')).toBeTruthy();
		});

		it('Edit Row on an untouched row cannot submit until something changes', async () => {
			let user = await openDataTab();

			await rowAction(user, 'C300', 'Edit Row');
			let dialog = within(screen.getByRole('dialog'));
			let submit = dialog.getByRole('button', { name: 'Add to Run' }) as HTMLButtonElement;
			expect(submit.disabled).toBe(true);

			await user.type(dialog.getByRole('textbox', { name: 'DESCR' }), 'Washer');
			expect(submit.disabled).toBe(false);
			await user.click(submit);
			await dialogsClosed();

			expect(panelSql()).toEqual(['UPDATE "PARTS"."PART" SET "DESCR" = \'Washer\' WHERE "PARTNO" = \'C300\'']);
		});

		// A type whose default is NULL leaves a NOT NULL column of it for the user to fill in.
		it('Add Row requires a NOT NULL column whose type defaults to NULL, then pins the new row at the top of the grid', async () => {
			let columns = COLUMNS.map(column => column.systemName === 'QTY' ? { ...column, hasDefault: 'N' } : column);
			let user = await openDataTab({ data: { columns }, dataEditSettings: { defaultValues: { DECIMAL: null } } });

			await openAddRowDialog(user);
			let dialog = within(screen.getByRole('dialog'));
			let submit = dialog.getByRole('button', { name: 'Add to Run' }) as HTMLButtonElement;
			await user.type(dialog.getByRole('textbox', { name: /^PARTNO/ }), 'D400');
			await user.type(dialog.getByRole('textbox', { name: 'DESCR' }), 'Washer');
			expect(submit.disabled).toBe(true);

			await user.type(dialog.getByRole('textbox', { name: /^QTY/ }), '3');
			expect(submit.disabled).toBe(false);
			await user.click(submit);
			await dialogsClosed();

			expect(panelSql()).toEqual(['INSERT INTO "PARTS"."PART" ("PARTNO", "DESCR", "QTY") VALUES (\'D400\', \'Washer\', 3)']);
			expect(within(statementItem(0)).getByText('Insert')).toBeTruthy();
			expect(inputs(dataRows()[0]).map(input => input.value)).toEqual(['D400', 'Washer', '3']);
			expect(dataRows()).toHaveLength(4);
			expect(await rowActionLabels(user, 'D400')).toEqual([{ label: 'Edit Row', disabled: false }, { label: 'Duplicate Row', disabled: false }, { label: 'Cancel Add', disabled: false }]);
		});

		// The split button's own click adds in the grid; the dialog is the arrow's option.
		it('Add Row adds a row at the top of the grid from the defaults, its first field focused, and each new one goes above the last', async () => {
			let user = await openDataTab();

			await user.click(screen.getByRole('button', { name: 'Add Row' }));

			expect(screen.queryByRole('dialog')).toBeNull();
			expect(dataRows()).toHaveLength(4);
			let newRow = inputs(dataRows()[0]);
			expect(newRow.map(input => [input.value, input.placeholder])).toEqual([['', ''], ['', '<null>'], ['', '<default>']]);
			expect(document.activeElement).toBe(newRow[0]);
			expect(panelSql()).toEqual(['INSERT INTO "PARTS"."PART" ("PARTNO", "DESCR") VALUES (\'\', NULL)']);

			await user.keyboard('D400');
			expect(panelSql()).toEqual(['INSERT INTO "PARTS"."PART" ("PARTNO", "DESCR") VALUES (\'D400\', NULL)']);

			await user.click(screen.getByRole('button', { name: 'Add Row' }));
			expect(dataRows().slice(0, 2).map(row => inputs(row)[0].value)).toEqual(['', 'D400']);
			expect(document.activeElement).toBe(inputs(dataRows()[0])[0]);
			expect(panelSql()).toHaveLength(2);
		});

		// The copy keeps every value, the key included - DB2 rejects a duplicate key, so the user changes it.
		it('Duplicate Row adds a pending insert at the top of the grid with the row\'s values', async () => {
			let user = await openDataTab();

			await rowAction(user, 'B200', 'Duplicate Row');

			expect(panelSql()).toEqual(['INSERT INTO "PARTS"."PART" ("PARTNO", "DESCR", "QTY") VALUES (\'B200\', \'Nut\', 12)']);
			expect(within(statementItem(0)).getByText('Insert')).toBeTruthy();
			expect(dataRows()).toHaveLength(4);
			expect(inputs(dataRows()[0]).map(input => input.value)).toEqual(['B200', 'Nut', '12']);

			await user.clear(inputs(dataRows()[0])[0]);
			await user.keyboard('B201');
			expect(panelSql()).toEqual(['INSERT INTO "PARTS"."PART" ("PARTNO", "DESCR", "QTY") VALUES (\'B201\', \'Nut\', 12)']);
		});

		it('Duplicate Row copies a pending update\'s values, and a pending insert\'s', async () => {
			let user = await openDataTab();
			await user.type(field('B200', 'DESCR'), '!');

			await rowAction(user, 'B200', 'Duplicate Row');
			expect(panelSql()).toEqual([
				'UPDATE "PARTS"."PART" SET "DESCR" = \'Nut!\' WHERE "PARTNO" = \'B200\'',
				'INSERT INTO "PARTS"."PART" ("PARTNO", "DESCR", "QTY") VALUES (\'B200\', \'Nut!\', 12)'
			]);

			await user.clear(inputs(dataRows()[0])[0]);
			await user.keyboard('D400');
			await rowAction(user, 'D400', 'Duplicate Row');
			expect(panelSql()).toHaveLength(3);
			expect(panelSql()[2]).toBe('INSERT INTO "PARTS"."PART" ("PARTNO", "DESCR", "QTY") VALUES (\'D400\', \'Nut!\', 12)');
		});

		// Left out the way Add Row leaves it out, so DB2 generates it.
		it('Duplicate Row leaves an identity column out of the INSERT', async () => {
			let columns = [systemColumn({ colNo: 0, systemName: 'ID', sqlName: 'ID', dataType: 'INTEGER', nulls: 'N', identity: 'YES', updatable: 'NO' }), ...COLUMNS];
			let rows = ROWS.map((row, index) => ({ ID: index + 1, ...row }));
			let user = await openDataTab({ data: { columns, rows, keyColumns: [{ systemName: 'ID', isRrn: false }] } });

			await user.click(within(dataRows()[1]).getByRole('button', { name: 'Actions' }));
			await user.click(screen.getByRole('menuitem', { name: 'Duplicate Row' }));

			expect(panelSql()).toEqual(['INSERT INTO "PARTS"."PART" ("PARTNO", "DESCR", "QTY") VALUES (\'B200\', \'Nut\', 12)']);
		});

		it('a row added in the grid flags a required column it leaves NULL until it is filled in', async () => {
			let columns = COLUMNS.map(column => column.systemName === 'QTY' ? { ...column, hasDefault: 'N' } : column);
			let user = await openDataTab({ data: { columns }, dataEditSettings: { defaultValues: { DECIMAL: null } } });

			await user.click(screen.getByRole('button', { name: 'Add Row' }));
			expect(within(statementItem(0)).getByText('QTY is required')).toBeTruthy();
			expect(panelButton('Run').disabled).toBe(true);

			await user.type(inputs(dataRows()[0])[2], '3');
			expect(within(statementItem(0)).queryByText('QTY is required')).toBeNull();
			expect(panelSql()).toEqual(['INSERT INTO "PARTS"."PART" ("PARTNO", "DESCR", "QTY") VALUES (\'\', NULL, 3)']);
		});

		it('Add Row labels each field with every configured heading label, slash-joined', async () => {
			let columns = COLUMNS.map(column => ({ ...column, heading: column.systemName === 'DESCR' ? 'Part description' : '' }));
			let columnLabels = ColumnNameUtils.buildLabelMap(new Map(columns.map(column => [column.systemName, column])), columns.map(column => column.systemName), [ResultHeadingLabel.SHORT_NAME, ResultHeadingLabel.DESCRIPTION]);
			let user = await openDataTab({ data: { columns, columnLabels } });

			await openAddRowDialog(user);
			let dialog = within(screen.getByRole('dialog'));

			expect(dialog.getByRole('textbox', { name: 'DESCR / Part description' })).toBeTruthy();
			expect(dialog.getByRole('textbox', { name: 'QTY' })).toBeTruthy();
		});

		it('a pending insert\'s own cells and Edit Row rewrite that same INSERT, and Cancel Add removes it', async () => {
			let user = await openDataTab();
			await openAddRowDialog(user);
			await user.type(within(screen.getByRole('dialog')).getByRole('textbox', { name: /^PARTNO/ }), 'D400');
			await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add to Run' }));
			await dialogsClosed();

			await user.type(field('D400', 'QTY'), '3');
			expect(panelSql()).toEqual(['INSERT INTO "PARTS"."PART" ("PARTNO", "DESCR", "QTY") VALUES (\'D400\', NULL, 3)']);

			await rowAction(user, 'D400', 'Edit Row');
			let dialog = within(screen.getByRole('dialog'));
			expect((dialog.getByRole('textbox', { name: 'QTY' }) as HTMLInputElement).value).toBe('3');
			await user.type(dialog.getByRole('textbox', { name: 'DESCR' }), 'Washer');
			await user.click(dialog.getByRole('button', { name: 'Update Run' }));
			await dialogsClosed();
			expect(panelSql()).toEqual(['INSERT INTO "PARTS"."PART" ("PARTNO", "DESCR", "QTY") VALUES (\'D400\', \'Washer\', 3)']);

			await rowAction(user, 'D400', 'Cancel Add');
			expect(within(panel()).getByText('No pending changes')).toBeTruthy();
			expect(dataRows()).toHaveLength(3);
		});

		it('Add Row and its dialog option are disabled for a table DB2 reports as not insertable', async () => {
			await openDataTab({ table: { insertable: 'NO' } });

			expect((screen.getByRole('button', { name: 'Add Row' }) as HTMLButtonElement).disabled).toBe(true);
			expect((screen.getByRole('button', { name: 'More Add Row options' }) as HTMLButtonElement).disabled).toBe(true);
			expect((screen.getByRole('button', { name: 'Cancel Edit' }) as HTMLButtonElement).disabled).toBe(false);
		});

		it('the panel\'s discard button removes one statement and restores its row', async () => {
			let user = await openDataTab();
			await rowAction(user, 'A100', 'Delete Row');
			await rowAction(user, 'B200', 'Delete Row');

			await user.click(within(statementItem(0)).getByRole('button', { name: 'Discard statement' }));

			expect(panelSql()).toEqual([DELETE_B200]);
			expect(inputs(rowFor('A100'))).toHaveLength(3);
		});
	});

	// A NOT NULL column left blank is SQL DB2 is certain to reject, so it is caught before Run: an UPDATE
	// can't blank any NOT NULL column (a default only fills a column an INSERT leaves out), an INSERT
	// can't leave out one without a default.
	describe('required columns', () => {
		function headerTexts(): string[] {
			return screen.getAllByRole('columnheader').map(header => (header.textContent ?? '').trim());
		}

		function isInvalid(input: HTMLInputElement): boolean {
			return input.getAttribute('aria-invalid') === 'true';
		}

		/** The tinted background SqlStatementBlock gets for a statement that can't run. */
		function statementTinted(index: number): boolean {
			let background = getComputedStyle(ancestor(panel().querySelectorAll('code')[index], 1)).backgroundColor;
			return background !== '' && background !== 'rgba(0, 0, 0, 0)';
		}

		it('marks the NOT NULL columns\' headers while editing, and only then', async () => {
			let user = await openDataTab({ editMode: false });
			expect(headerTexts().slice(0, 3)).toEqual(['PARTNO', 'DESCR', 'QTY']);

			await user.click(screen.getByRole('button', { name: 'Edit Data' }));
			expect(headerTexts().slice(0, 3)).toEqual(['PARTNO *', 'DESCR', 'QTY *']);
		});

		it('clearing one inline marks the cell and the statement, says why under it, and holds Run until it is filled', async () => {
			let user = await openDataTab();

			await user.clear(field('A100', 'QTY'));

			expect(isInvalid(field('A100', 'QTY'))).toBe(true);
			expect(isInvalid(field('A100', 'DESCR'))).toBe(false);
			expect(isInvalid(field('B200', 'QTY'))).toBe(false);
			expect(statementTinted(0)).toBe(true);
			expect(within(statementItem(0)).getByText('QTY is required')).toBeTruthy();
			expect(panelButton('Run').disabled).toBe(true);

			await user.type(field('A100', 'QTY'), '7');

			expect(isInvalid(field('A100', 'QTY'))).toBe(false);
			expect(statementTinted(0)).toBe(false);
			expect(within(panel()).queryByText('QTY is required')).toBeNull();
			expect(panelButton('Run').disabled).toBe(false);
		});

		it('one invalid statement holds the whole run, and discarding it frees Run again', async () => {
			let user = await openDataTab();
			await rowAction(user, 'B200', 'Delete Row');
			await user.clear(field('A100', 'QTY'));

			expect(within(statementItem(1)).getByText('QTY is required')).toBeTruthy();
			expect(panelButton('Run').disabled).toBe(true);

			await user.click(within(statementItem(1)).getByRole('button', { name: 'Discard statement' }));
			expect(panelButton('Run').disabled).toBe(false);
		});

		it('names the column the way its header does', async () => {
			let columnLabels = ColumnNameUtils.buildLabelMap(new Map(COLUMNS.map(column => [column.systemName, column])), COLUMNS.map(column => column.systemName), [ResultHeadingLabel.SHORT_NAME, ResultHeadingLabel.LONG_NAME]);
			let user = await openDataTab({ data: { columnLabels } });

			await user.clear(field('A100', 'QTY'));

			expect(within(statementItem(0)).getByText('QTY / QUANTITY is required')).toBeTruthy();
		});

		async function addD400(user: UserEvent, qty?: string) {
			await openAddRowDialog(user);
			let dialog = within(screen.getByRole('dialog'));
			await user.type(dialog.getByRole('textbox', { name: /^PARTNO/ }), 'D400');

			if (qty) {
				await user.type(dialog.getByRole('textbox', { name: /^QTY/ }), qty);
			}

			await user.click(dialog.getByRole('button', { name: 'Add to Run' }));
			await dialogsClosed();
		}

		it('a pending insert\'s cell flags a cleared required number', async () => {
			let columns = COLUMNS.map(column => column.systemName === 'QTY' ? { ...column, hasDefault: 'N' } : column);
			let user = await openDataTab({ data: { columns } });
			await addD400(user, '3');

			let qty = inputs(dataRows()[0])[2];
			await user.clear(qty);

			expect(isInvalid(qty)).toBe(true);
			expect(panelSql()).toEqual(['INSERT INTO "PARTS"."PART" ("PARTNO", "DESCR", "QTY") VALUES (\'D400\', NULL, NULL)']);
			expect(within(statementItem(0)).getByText('QTY is required')).toBeTruthy();
			expect(panelButton('Run').disabled).toBe(true);
		});

		it('a pending insert leaves a cleared NOT NULL number with a default out, so DB2 fills it', async () => {
			let user = await openDataTab();
			await addD400(user, '3');

			let qty = inputs(dataRows()[0])[2];
			await user.clear(qty);

			expect(isInvalid(qty)).toBe(false);
			expect(panelSql()).toEqual(['INSERT INTO "PARTS"."PART" ("PARTNO", "DESCR") VALUES (\'D400\', NULL)']);
			expect(panelButton('Run').disabled).toBe(false);
		});

		// A cleared CHAR is blanks, which a NOT NULL column takes - nothing to flag.
		it('a cleared NOT NULL character field is the empty string, not missing', async () => {
			let user = await openDataTab();

			await user.clear(field('A100', 'PARTNO'));

			expect(panelSql()).toEqual(['UPDATE "PARTS"."PART" SET "PARTNO" = \'\' WHERE "PARTNO" = \'A100\'']);
			expect(within(statementItem(0)).queryByText(/is required/)).toBeNull();
			expect(panelButton('Run').disabled).toBe(false);
		});

		it('Edit Row marks every NOT NULL field and won\'t submit one cleared', async () => {
			let user = await openDataTab();

			await rowAction(user, 'A100', 'Edit Row');
			let dialog = within(screen.getByRole('dialog'));
			let submit = dialog.getByRole('button', { name: 'Add to Run' }) as HTMLButtonElement;
			let qty = dialog.getByRole('textbox', { name: /^QTY/ }) as HTMLInputElement;
			expect(qty.required).toBe(true);
			expect((dialog.getByRole('textbox', { name: /^PARTNO/ }) as HTMLInputElement).required).toBe(true);
			expect((dialog.getByRole('textbox', { name: 'DESCR' }) as HTMLInputElement).required).toBe(false);

			await user.clear(qty);
			expect(submit.disabled).toBe(true);

			await user.type(qty, '6');
			expect(submit.disabled).toBe(false);
		});

		it('Edit Row\'s Set NULL button sets a field to NULL, and is only there where it can be used', async () => {
			let user = await openDataTab();

			await rowAction(user, 'A100', 'Edit Row');
			let dialog = within(screen.getByRole('dialog'));
			// Only DESCR - PARTNO and QTY are NOT NULL.
			let setNullButtons = dialog.getAllByRole('button', { name: 'Set NULL' });
			expect(setNullButtons).toHaveLength(1);

			await user.click(setNullButtons[0]);
			let descr = dialog.getByRole('textbox', { name: 'DESCR' }) as HTMLInputElement;
			expect(descr.placeholder).toBe('<null>');
			// Gone once the field is NULL, with focus handed to the field instead of lost.
			expect(dialog.queryByRole('button', { name: 'Set NULL' })).toBeNull();
			expect(document.activeElement).toBe(descr);

			await user.click(dialog.getByRole('button', { name: 'Add to Run' }));
			await dialogsClosed();
			expect(panelSql()).toEqual(['UPDATE "PARTS"."PART" SET "DESCR" = NULL WHERE "PARTNO" = \'A100\'']);
		});

		// Every Add Row field starts NULL: a nullable one shows <null>, and a NOT NULL one with a default
		// shows <default>, since it's left out of the INSERT for DB2 to fill.
		// A required character field starts as the empty string, so it needn't be typed into - blanks
		// satisfy NOT NULL. Everything else starts NULL: <null>, or <default> for a NOT NULL column with a
		// default, which is left out of the INSERT for DB2 to fill.
		it('Add Row starts a required character field empty and the rest NULL, so the row can go as it stands', async () => {
			let user = await openDataTab();

			await openAddRowDialog(user);
			let dialog = within(screen.getByRole('dialog'));
			let partNo = dialog.getByRole('textbox', { name: /^PARTNO/ }) as HTMLInputElement;

			expect([partNo.value, partNo.placeholder]).toEqual(['', '']);
			expect((dialog.getByRole('textbox', { name: 'DESCR' }) as HTMLInputElement).placeholder).toBe('<null>');
			expect((dialog.getByRole('textbox', { name: /^QTY/ }) as HTMLInputElement).placeholder).toBe('<default>');

			await user.type(dialog.getByRole('textbox', { name: 'DESCR' }), 'Washer');
			await user.click(dialog.getByRole('button', { name: 'Add to Run' }));
			await dialogsClosed();

			expect(panelSql()).toEqual(['INSERT INTO "PARTS"."PART" ("PARTNO", "DESCR") VALUES (\'\', \'Washer\')']);
		});

		it('Add Row starts every column at its type\'s default when the settings say so, and Use Table Default hands one back to DB2', async () => {
			let user = await openDataTab({ dataEditSettings: { defaultValues: { CHAR: 'NONE' }, columnsWithTableDefault: 'appDefault', nullableColumns: 'appDefault' } });

			await openAddRowDialog(user);
			let dialog = within(screen.getByRole('dialog'));
			let qty = dialog.getByRole('textbox', { name: /^QTY/ }) as HTMLInputElement;

			// PARTNO is the user's CHAR default, DESCR (nullable VARCHAR) and QTY (with a table default) the app's.
			expect([(dialog.getByRole('textbox', { name: /^PARTNO/ }) as HTMLInputElement).value, (dialog.getByRole('textbox', { name: 'DESCR' }) as HTMLInputElement).value, qty.value]).toEqual(['NONE', '', '0']);

			await user.click(dialog.getByRole('button', { name: 'Use Table Default' }));
			expect(qty.placeholder).toBe('<default>');

			await user.click(dialog.getByRole('button', { name: 'Add to Run' }));
			await dialogsClosed();
			expect(panelSql()).toEqual(['INSERT INTO "PARTS"."PART" ("PARTNO", "DESCR") VALUES (\'NONE\', \'\')']);
		});

		// DB2 for i keeps blank CHAR fields routinely - one the edit doesn't touch isn't in the UPDATE.
		it('Edit Row lets a row through whose NOT NULL character column already holds blanks', async () => {
			let columns = COLUMNS.map(column => column.systemName === 'DESCR' ? { ...column, dataType: 'CHAR', nulls: 'N' } : column);
			let user = await openDataTab({ data: { columns, rows: [...ROWS, { PARTNO: 'E500      ', DESCR: '                                        ', QTY: 1 }] } });

			await rowAction(user, 'E500', 'Edit Row');
			let dialog = within(screen.getByRole('dialog'));
			await user.type(dialog.getByRole('textbox', { name: /^QTY/ }), '0');
			await user.click(dialog.getByRole('button', { name: 'Add to Run' }));
			await dialogsClosed();

			expect(panelSql()).toEqual(['UPDATE "PARTS"."PART" SET "QTY" = 10 WHERE "PARTNO" = \'E500\'']);
			expect(within(statementItem(0)).queryByText(/is required/)).toBeNull();
		});
	});

	describe('running', () => {
		it('confirms with a per-kind summary, then sends the statements in the order they were queued', async () => {
			let user = await openDataTab();
			await rowAction(user, 'A100', 'Delete Row');
			await user.type(field('B200', 'DESCR'), 's');
			await rowAction(user, 'C300', 'Delete Row');

			await run(user, '2 Deletes, 1 Update');

			expect(runRequests()).toEqual([{ command: 'runDataEditStatements', statements: [DELETE_A100, 'UPDATE "PARTS"."PART" SET "DESCR" = \'Nuts\' WHERE "PARTNO" = \'B200\'', DELETE_C300] }]);
		});

		it('backing out of the Run confirmation sends nothing', async () => {
			let user = await openDataTab();
			await rowAction(user, 'A100', 'Delete Row');

			await user.click(panelButton('Run'));
			await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
			await dialogsClosed();

			expect(runRequests()).toEqual([]);
			expect(panelButton('Run').disabled).toBe(false);
		});

		it('locks every way of adding or removing a statement while the run is in flight', async () => {
			let user = await openDataTab();
			await rowAction(user, 'A100', 'Delete Row');
			await run(user, '1 Delete');

			expect(panelButton('Run').disabled).toBe(true);
			expect(panelButton('Cancel').disabled).toBe(true);
			expect(panelButton('Clear').disabled).toBe(true);
			expect((within(statementItem(0)).getByRole('button', { name: 'Discard statement' }) as HTMLButtonElement).disabled).toBe(true);
			expect((screen.getByRole('button', { name: 'Add Row' }) as HTMLButtonElement).disabled).toBe(true);
			expect((screen.getByRole('button', { name: 'Cancel Edit' }) as HTMLButtonElement).disabled).toBe(true);
			expect(await rowActionLabels(user, 'A100')).toEqual([{ label: 'Cancel Delete', disabled: true, reason: 'A run is in progress' }]);
			expect(await rowActionLabels(user, 'B200')).toEqual([{ label: 'Edit Row', disabled: true, reason: 'A run is in progress' }, { label: 'Duplicate Row', disabled: true, reason: 'A run is in progress' }, { label: 'Delete Row', disabled: true, reason: 'A run is in progress' }]);

			// Closing the tab is refused outright, not just confirmed.
			await user.click(screen.getByRole('button', { name: `Close ${TABLE}` }));
			expect(screen.queryByRole('dialog')).toBeNull();
			expect(panelSql()).toEqual([DELETE_A100]);

			result(1, false);
			expect(panelButton('Cancel').disabled).toBe(false);
			expect((screen.getByRole('button', { name: 'Add Row' }) as HTMLButtonElement).disabled).toBe(false);
		});

		it('locks inline editing while the run is in flight, so a statement already sent cannot change under it', async () => {
			let user = await openDataTab();
			await user.type(field('B200', 'DESCR'), 's');
			await run(user, '1 Update');

			expect(field('B200', 'DESCR').disabled).toBe(true);
			expect(field('A100', 'DESCR').disabled).toBe(true);
			await user.type(field('B200', 'DESCR'), '{Backspace}x');
			await user.type(field('A100', 'DESCR'), 'x');

			expect(panelSql()).toEqual(['UPDATE "PARTS"."PART" SET "DESCR" = \'Nuts\' WHERE "PARTNO" = \'B200\'']);

			result(1, false);
			postFromHost<SchemasInboundMessage>(tableData());
			expect(field('B200', 'DESCR').disabled).toBe(false);
		});

		it('routes each progress message to the statement at that index of the batch that was sent', async () => {
			let user = await openDataTab();
			await rowAction(user, 'A100', 'Delete Row');
			await rowAction(user, 'B200', 'Delete Row');
			await run(user, '2 Deletes');

			expect([statementStatus(0), statementStatus(1)]).toEqual([undefined, undefined]);
			progress(0, 'running');
			expect([statementStatus(0), statementStatus(1)]).toEqual(['running', undefined]);
			progress(0, 'success');
			progress(1, 'running');
			expect([statementStatus(0), statementStatus(1)]).toEqual(['success', 'running']);
			// An index past the end of the batch belongs to nothing.
			progress(2, 'error');
			expect([statementStatus(0), statementStatus(1)]).toEqual(['success', 'running']);
		});

		it('a clean run keeps the statements listed as done, drops them from the grid, and reloads the table', async () => {
			let user = await openDataTab();
			await rowAction(user, 'A100', 'Delete Row');
			await run(user, '1 Delete');
			let loadsBefore = loadRequests().length;

			progress(0, 'running');
			progress(0, 'success');
			result(1, false);

			expect(panelSql()).toEqual([DELETE_A100]);
			expect(statementStatus(0)).toBe('success');
			expect((within(statementItem(0)).getByRole('button', { name: 'Discard statement' }) as HTMLButtonElement).disabled).toBe(true);
			// Nothing left to run - a done statement is never sent again.
			expect(panelButton('Run').disabled).toBe(true);
			expect(loadRequests().slice(loadsBefore)).toEqual([{ command: 'loadTableData', schema: SCHEMA, table: TABLE, offset: 0, limit: 100, where: '' }]);

			// The reload shows the table as the database now has it, and the done DELETE no longer marks anything.
			postFromHost<SchemasInboundMessage>(tableData({ rows: ROWS.slice(1) }));
			expect(dataRows()).toHaveLength(2);
			expect(await rowActionLabels(user, 'B200')).toEqual([{ label: 'Edit Row', disabled: false }, { label: 'Duplicate Row', disabled: false }, { label: 'Delete Row', disabled: false }]);
		});

		it('a done UPDATE stops marking its row once the reload shows the committed value', async () => {
			let user = await openDataTab();
			await user.type(field('B200', 'DESCR'), 's');
			await run(user, '1 Update');
			progress(0, 'success');
			result(1, false);

			postFromHost<SchemasInboundMessage>(tableData({ rows: [ROWS[0], { ...ROWS[1], DESCR: 'Nuts' }, ROWS[2]] }));

			expect(field('B200', 'DESCR').value).toBe('Nuts');
			expect(await rowActionLabels(user, 'B200')).toEqual([{ label: 'Edit Row', disabled: false }, { label: 'Duplicate Row', disabled: false }, { label: 'Delete Row', disabled: false }]);
			// Editing the row again starts a new statement rather than reopening the done one.
			await user.type(field('B200', 'DESCR'), '!');
			expect(panelSql()).toEqual([
				'UPDATE "PARTS"."PART" SET "DESCR" = \'Nuts\' WHERE "PARTNO" = \'B200\'',
				'UPDATE "PARTS"."PART" SET "DESCR" = \'Nuts!\' WHERE "PARTNO" = \'B200\''
			]);
			expect([statementStatus(0), statementStatus(1)]).toEqual(['success', undefined]);
		});

		it('a failure shows the error on the statement that failed, and Run retries only what is not done', async () => {
			let user = await openDataTab();
			await rowAction(user, 'A100', 'Delete Row');
			await rowAction(user, 'B200', 'Delete Row');
			await rowAction(user, 'C300', 'Delete Row');
			await run(user, '3 Deletes');

			progress(0, 'running');
			progress(0, 'success');
			progress(1, 'running');
			progress(1, 'error');
			result(1, true, 'SQL0532 Delete prevented by referential constraint');

			expect([statementStatus(0), statementStatus(1), statementStatus(2)]).toEqual(['success', 'error', undefined]);
			expect(within(statementItem(1)).getByText('SQL0532 Delete prevented by referential constraint')).toBeTruthy();
			expect(within(statementItem(0)).queryByText(/SQL0532/)).toBeNull();
			expect(within(statementItem(2)).queryByText(/SQL0532/)).toBeNull();

			// A100's DELETE committed, so the table reloads; the failed and never-run statements stay
			// pending on the rows it returns.
			expect(loadRequests()).toHaveLength(2);
			postFromHost<SchemasInboundMessage>(tableData({ rows: ROWS.slice(1) }));
			expect(await rowActionLabels(user, 'B200')).toEqual([{ label: 'Cancel Delete', disabled: false }]);
			expect(await rowActionLabels(user, 'C300')).toEqual([{ label: 'Cancel Delete', disabled: false }]);

			await run(user, '2 Deletes');

			expect(runRequests()).toEqual([
				{ command: 'runDataEditStatements', statements: [DELETE_A100, DELETE_B200, DELETE_C300] },
				{ command: 'runDataEditStatements', statements: [DELETE_B200, DELETE_C300] }
			]);
			// The retried statement's old failure is cleared while it runs again.
			expect(statementStatus(1)).toBeUndefined();
			expect(within(panel()).queryByText(/SQL0532/)).toBeNull();

			// Progress indexes now count within the second batch, not the original list.
			progress(0, 'running');
			expect([statementStatus(0), statementStatus(1), statementStatus(2)]).toEqual(['success', 'running', undefined]);
		});

		it('a failure on the very first statement changed nothing, so the table is not reloaded', async () => {
			let user = await openDataTab();
			await rowAction(user, 'A100', 'Delete Row');
			await run(user, '1 Delete');
			let loadsBefore = loadRequests().length;

			progress(0, 'running');
			progress(0, 'error');
			result(0, true, 'SQL0913 Row or object PART in PARTS type *FILE in use');

			expect(loadRequests()).toHaveLength(loadsBefore);
			expect(statementStatus(0)).toBe('error');
			expect(within(statementItem(0)).getByText('SQL0913 Row or object PART in PARTS type *FILE in use')).toBeTruthy();
			expect(panelButton('Run').disabled).toBe(false);
		});

		it('falls back to a generic message when a failure carries no error detail', async () => {
			let user = await openDataTab();
			await rowAction(user, 'A100', 'Delete Row');
			await run(user, '1 Delete');

			progress(0, 'error');
			result(0, true);

			expect(within(statementItem(0)).getByText('Failed')).toBeTruthy();
		});

		it('only reloads the tables whose statements actually ran', async () => {
			let user = await openDataTab();
			await rowAction(user, 'A100', 'Delete Row');
			await run(user, '1 Delete');

			// A result for a batch that ran nothing of this table's.
			result(0, true, 'boom');

			expect(loadRequests()).toHaveLength(1);
		});
	});

	describe('Clear and leaving after a run', () => {
		async function runFirstOfTwo(user: UserEvent) {
			await rowAction(user, 'A100', 'Delete Row');
			await rowAction(user, 'B200', 'Delete Row');
			await run(user, '2 Deletes');
			progress(0, 'success');
			progress(1, 'error');
			result(1, true, 'boom');
		}

		it('Clear Done removes only the statements that already ran', async () => {
			let user = await openDataTab();
			await runFirstOfTwo(user);

			await user.click(panelButton('Clear'));
			let dialog = within(screen.getByRole('dialog'));
			expect(dialog.getByText('There is 1 statement that has not run yet.')).toBeTruthy();
			await user.click(dialog.getByRole('button', { name: 'Clear Done' }));
			await dialogsClosed();

			expect(panelSql()).toEqual([DELETE_B200]);
			expect(screen.getByText('Run SQL')).toBeTruthy();
		});

		it('Clear All empties the list but stays in edit mode', async () => {
			let user = await openDataTab();
			await runFirstOfTwo(user);

			await user.click(panelButton('Clear'));
			await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear All' }));
			await dialogsClosed();

			expect(within(panel()).getByText('No pending changes')).toBeTruthy();
			expect(screen.getByRole('button', { name: 'Cancel Edit' })).toBeTruthy();
		});

		it('Clear with nothing left to run clears straight away, and offers no Clear Done when nothing is done', async () => {
			let user = await openDataTab();
			await rowAction(user, 'A100', 'Delete Row');
			await run(user, '1 Delete');
			progress(0, 'success');
			result(1, false);

			await user.click(panelButton('Clear'));
			expect(screen.queryByRole('dialog')).toBeNull();
			expect(within(panel()).getByText('No pending changes')).toBeTruthy();

			// Answers the reload the clean run asked for.
			postFromHost<SchemasInboundMessage>(tableData({ rows: ROWS.slice(1) }));
			await rowAction(user, 'B200', 'Delete Row');
			await user.click(panelButton('Clear'));
			let dialog = within(screen.getByRole('dialog'));
			expect(dialog.queryByRole('button', { name: 'Clear Done' })).toBeNull();
			expect(dialog.getByRole('button', { name: 'Clear All' })).toBeTruthy();
		});

		it('leaving edit mode counts only the statements not yet run', async () => {
			let user = await openDataTab();
			await runFirstOfTwo(user);

			await user.click(panelButton('Cancel'));
			expect(within(screen.getByRole('dialog')).getByText('Discard 1 statement that has not yet been run?')).toBeTruthy();
		});

		it('leaving edit mode after everything ran does not ask', async () => {
			let user = await openDataTab();
			await rowAction(user, 'A100', 'Delete Row');
			await run(user, '1 Delete');
			progress(0, 'success');
			result(1, false);

			await user.click(panelButton('Cancel'));

			expect(screen.queryByRole('dialog')).toBeNull();
			expect(screen.queryByText('Run SQL')).toBeNull();
		});
	});
	// The Data tab's Settings... dialog: db2-workbench.dataEdit.*, saved through the host and read by Add Row.
	describe('settings', () => {
		function savedSettings(): DataEditSettings[] {
			return posted().flatMap(message => message.command === 'saveDataEditSettings' ? [message.settings] : []);
		}

		async function openSettings(user: UserEvent) {
			await user.click(screen.getByRole('button', { name: 'Settings...' }));
			return within(screen.getByRole('dialog'));
		}

		function typeRow(dialog: ReturnType<typeof within>, type: string): HTMLElement {
			return dialog.getByRole('listitem', { name: type });
		}

		function typeValue(dialog: ReturnType<typeof within>, type: string): HTMLInputElement {
			return within(typeRow(dialog, type)).getByRole('textbox') as HTMLInputElement;
		}

		it('is the last table action, and past the button limit in edit mode goes into the "⋮" menu', async () => {
			let user = await openDataTab({ editMode: false });
			expect(screen.getByRole('button', { name: 'Settings...' })).toBeTruthy();

			await user.click(screen.getByRole('button', { name: 'Edit Data' }));
			expect(screen.queryByRole('button', { name: 'Settings...' })).toBeNull();
			await user.click(screen.getByRole('button', { name: 'More actions' }));
			expect(screen.getByRole('menuitem', { name: 'Settings...' })).toBeTruthy();
		});

		it('lists every type at the app\'s default until the user sets one, with a reset only for their own', async () => {
			let user = await openDataTab({ editMode: false, dataEditSettings: { defaultValues: { DECIMAL: '1' } } });
			let dialog = await openSettings(user);

			expect(dialog.getAllByRole('listitem').map(item => item.getAttribute('aria-label'))).toEqual(DataEditDefaults.APP_DEFAULTS.map(entry => entry.type));
			expect([typeValue(dialog, 'CHAR').value, typeValue(dialog, 'TIMESTAMP').value, typeValue(dialog, 'TIME').value, typeValue(dialog, 'DECIMAL').value])
				.toEqual(['', '0001-01-01 00:00:00.000000', '00:00:00', '1']);
			expect(typeValue(dialog, 'BINARY').placeholder).toBe('<null>');
			expect(within(typeRow(dialog, 'CHAR')).getByText('App default')).toBeTruthy();
			expect(within(typeRow(dialog, 'DECIMAL')).queryByText('App default')).toBeNull();
			expect(dialog.getAllByRole('button', { name: /^Reset / }).map(button => button.getAttribute('aria-label'))).toEqual(['Reset DECIMAL to App Default']);
		});

		it('saves the edited settings - NULL included, and a value reset or set back to the app\'s left out', async () => {
			let user = await openDataTab({ editMode: false, dataEditSettings: { defaultValues: { DECIMAL: '1', INTEGER: '5' } } });
			let dialog = await openSettings(user);

			await user.type(typeValue(dialog, 'CHAR'), 'N/A');
			await user.click(within(typeRow(dialog, 'DATE')).getByRole('button', { name: 'Set NULL' }));
			await user.click(dialog.getByRole('button', { name: 'Reset DECIMAL to App Default' }));
			await user.clear(typeValue(dialog, 'INTEGER'));
			await user.type(typeValue(dialog, 'INTEGER'), '0');
			await user.click(dialog.getByRole('combobox', { name: 'Nullable columns' }));
			await user.click(screen.getByRole('option', { name: 'App Default' }));
			await user.click(dialog.getByRole('button', { name: 'Save' }));
			await dialogsClosed();

			expect(savedSettings()).toEqual([{ defaultValues: { CHAR: 'N/A', DATE: null }, columnsWithTableDefault: 'tableDefault', nullableColumns: 'appDefault' }]);
		});

		it('Cancel saves nothing', async () => {
			let user = await openDataTab({ editMode: false });
			let dialog = await openSettings(user);

			await user.type(typeValue(dialog, 'CHAR'), 'N/A');
			await user.click(dialog.getByRole('button', { name: 'Cancel' }));
			await dialogsClosed();

			expect(savedSettings()).toEqual([]);
		});

		it('Add Row uses what was just saved, and whatever the host reports changed after that', async () => {
			let user = await openDataTab({ editMode: false });
			let dialog = await openSettings(user);
			await user.type(typeValue(dialog, 'CHAR'), 'NEW');
			await user.click(dialog.getByRole('button', { name: 'Save' }));
			await dialogsClosed();

			await user.click(screen.getByRole('button', { name: 'Edit Data' }));
			await openAddRowDialog(user);
			expect((within(screen.getByRole('dialog')).getByRole('textbox', { name: /^PARTNO/ }) as HTMLInputElement).value).toBe('NEW');
			await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
			await dialogsClosed();

			// Changed in Ctrl+, or another panel.
			postFromHost<SchemasTreeInboundMessage>({ command: 'dataEditSettingsChanged', settings: { ...DataEditDefaults.DEFAULT_SETTINGS, defaultValues: { CHAR: 'HOST' } } });
			await openAddRowDialog(user);
			expect((within(screen.getByRole('dialog')).getByRole('textbox', { name: /^PARTNO/ }) as HTMLInputElement).value).toBe('HOST');
		});
	});

	describe('search', () => {
		// The chip stands for SQL that runs, so it names the column by its short name whatever
		// resultHeadingLabels says; its tooltip is what follows the setting.
		it('shows each applied criterion as a "[field] [operator] [value]" chip, with the configured labels as its tooltip', async () => {
			let columnLabels = ColumnNameUtils.buildLabelMap(new Map(COLUMNS.map(column => [column.systemName, column])), COLUMNS.map(column => column.systemName), [ResultHeadingLabel.LONG_NAME, ResultHeadingLabel.SHORT_NAME]);
			let user = await openDataTab({ data: { columnLabels }, editMode: false });

			await user.click(screen.getByRole('button', { name: 'Edit Search' }));
			let dialog = within(screen.getByRole('dialog'));
			await user.click(dialog.getByRole('combobox', { name: 'Column' }));
			await user.click(screen.getByRole('option', { name: 'DESCRIPTION / DESCR' }));
			await user.type(dialog.getByRole('textbox', { name: 'Value' }), 'Bolt');
			await user.click(dialog.getByRole('button', { name: 'Run' }));
			await dialogsClosed();

			let chips = document.querySelectorAll('.MuiChip-root');
			expect([...chips].map(chip => chip.textContent)).toEqual(['DESCR = Bolt']);

			await user.hover(chips[0]);
			expect((await screen.findByRole('tooltip')).textContent).toBe('DESCRIPTION / DESCR');
		});
	});
	describe('export', () => {
		// The Data tab's headers are rendered JSX, so without the label map the built-in export would head
		// every column with its raw id (the short name) whatever resultHeadingLabels says.
		it('heads the CSV columns by the configured heading labels', async () => {
			let columnLabels = ColumnNameUtils.buildLabelMap(new Map(COLUMNS.map(column => [column.systemName, column])), COLUMNS.map(column => column.systemName), [ResultHeadingLabel.LONG_NAME]);
			let user = await openDataTab({ data: { columnLabels }, editMode: false });
			await navigator.clipboard.writeText('untouched');

			await user.click(screen.getByRole('button', { name: 'Export...' }));
			await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Clipboard' }));

			let copied = await navigator.clipboard.readText();
			expect(copied.split(/\r?\n/)[0]).toBe('PART_NUMBER,DESCRIPTION,QUANTITY');
		});
	});
});
