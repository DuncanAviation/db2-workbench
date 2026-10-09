import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ResolvedForeignKey, ResolvedIndex, ResolvedTableKey } from '../../src/schema-conversion/schema-format-converter';
import type { SchemasIndexAdvice, SchemasInboundMessage, SchemasInitialState, SchemasOutboundMessage, SchemasTreeInboundMessage, SchemasTrigger, TreeTableEntry } from '../../src/webview-messages/schemas-messages';
import { postFromHost } from '../test-support/host-messages';
import { renderWebview } from '../test-support/render-webview';
import { postedMessages } from '../test-support/vscode-api-stub';
import { App } from './app';
import { importedTable, systemTable } from './test-fixtures';
import { DataEditDefaults } from '../../src/utils/data-edit-defaults';

// The schema browser's catalog sub-tabs other than Columns (which app.spec.tsx covers) and Data (which
// data-edit-flow.spec.tsx covers): Table Keys, Foreign Keys, Indexes, Advised Indexes and Triggers. Each loads
// lazily over the same contract - post a loadX for exactly this table, accept only the reply addressed
// to it, show its error, Refresh with forceRefresh - so that part runs once per tab from one table below.
// Indexes and Advised Indexes also build SQL for the host to run (rename, drop, create an advised index,
// delete a recommendation), and those statements are the contract that matters most here: the host runs
// them as given.

type User = ReturnType<typeof userEvent.setup>;

const SCHEMA = 'SALES';
const TABLE = 'CUSTOMER';

function tableKey(overrides: Partial<ResolvedTableKey> = {}): ResolvedTableKey {
	return { constraintName: 'CUSTOMER_PK', constraintType: 'PRIMARY KEY', columnName: 'CUSTOMER_NUMBER', systemColumnName: 'CUSNO', ordinalPosition: 1, isNew: false, ...overrides };
}

function foreignKey(overrides: Partial<ResolvedForeignKey> = {}): ResolvedForeignKey {
	return {
		constraintName: 'CUSTOMER_REGION_FK', columnName: 'REGION_CODE', systemColumnName: 'REGCD', ordinalPosition: 1, updateRule: 'RESTRICT', deleteRule: 'CASCADE',
		referencedSchema: 'SALES', referencedTable: 'REGION', referencedColumnName: 'REGION_CODE', referencedSystemColumnName: 'REGCD', isNew: false, ...overrides
	};
}

function index(overrides: Partial<ResolvedIndex> = {}): ResolvedIndex {
	return { indexSchema: SCHEMA, indexName: 'CUSTOMER_BY_NAME', indexType: 'BINARY RADIX', uniqueness: 'NOT UNIQUE', keyColumns: 'NAME', indexOwner: 'DBADMIN', isNew: false, ...overrides };
}

function advice(overrides: Partial<SchemasIndexAdvice> = {}): SchemasIndexAdvice {
	return {
		id: 42, schema: SCHEMA, table: TABLE, keyColumnsAdvised: 'REGION_CODE, NAME', indexType: 'RADIX', reasonAdvised: 'Local Selection', timesAdvised: 17,
		lastAdvised: '2026-09-20T12:00:00.000Z', sortSequence: '*HEX', sortSequenceLibrary: '', ...overrides
	};
}

function trigger(overrides: Partial<SchemasTrigger> = {}): SchemasTrigger {
	return {
		schema: SCHEMA, tableName: TABLE, triggerSchema: SCHEMA, triggerName: 'CUSTOMER_AUDIT', event: 'INSERT', timing: 'AFTER', orientation: 'ROW', mode: 'DB2ROW',
		actionOrder: 1, programLibrary: SCHEMA, programName: 'CUSAUDIT', operative: 'Y', enabled: 'Y', threadSafe: 'UNKNOWN', multithreadedJobAction: 'SYSVAL',
		allowRepeatedChange: 'YES', secure: 'N', definer: 'QSECOFR', created: '2026-09-20T12:00:00.000Z', ...overrides
	};
}

function initialState(entry: TreeTableEntry = { connected: systemTable(SCHEMA, TABLE) }, overrides: Partial<SchemasInitialState> = {}): SchemasInitialState {
	return {
		connectionName: 'Production',
		tablesBySchema: { [SCHEMA]: [entry] },
		viewsBySchema: {},
		functionsBySchema: {},
		proceduresBySchema: {},
		schemaList: [{ name: SCHEMA, hidden: false, added: false }],
		currentSortSequence: '*HEX',
		currentSortSequenceLibrary: '',
		dataEditSettings: DataEditDefaults.DEFAULT_SETTINGS,
		initialSelectedTable: { schema: SCHEMA, table: TABLE },
		...overrides
	};
}

function renderSchemas(entry?: TreeTableEntry, overrides: Partial<SchemasInitialState> = {}) {
	return renderWebview(<App />, { initialState: initialState(entry, overrides), withDatePickers: true });
}

function posted(): SchemasOutboundMessage[] {
	return postedMessages<SchemasOutboundMessage>();
}

/** Everything posted after the tab's own load request. */
function postedAfterLoad(): SchemasOutboundMessage[] {
	return posted().slice(1);
}

function subTabNames(): string[] {
	let [, subTabs] = screen.getAllByRole('tablist');
	return within(subTabs).getAllByRole('tab').map(tab => tab.textContent ?? '');
}

async function openRowMenu(user: User, rowText: string) {
	let row = screen.getAllByRole('row').find(candidate => candidate.textContent?.includes(rowText));
	if (!row) {
		throw new Error(`no row containing "${rowText}"`);
	}
	await user.click(within(row).getByRole('button', { name: 'Actions' }));
}

async function chooseRowAction(user: User, rowText: string, action: string) {
	await openRowMenu(user, rowText);
	await user.click(screen.getByRole('menuitem', { name: action }));
}

/** Waits out a closing dialog - MUI keeps the rest of the page aria-hidden until its exit transition ends. */
async function waitForDialogToClose() {
	await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

// The one table the shared load contract below runs from - per tab, what it asks for, what a reply looks
// like, and what the reply renders.
interface CatalogTab {
	name: string;
	loadCommand: 'loadTableKeys' | 'loadForeignKeys' | 'loadIndexes' | 'loadIndexAdvice' | 'loadTriggers';
	loadingText: string;
	errorLabel: string;
	loaded: (schema: string, table: string) => SchemasInboundMessage;
	/** A reply with no rows. */
	empty: (schema: string, table: string) => SchemasInboundMessage;
	error: (schema: string, table: string, message: string) => SchemasInboundMessage;
	/** Text only the loaded reply's row puts on screen. */
	rowText: string;
	/** What the tab says in place of rows when the reply is empty - absent for a tab that shows a plain empty body. */
	emptyText?: string;
}

const CATALOG_TABS: CatalogTab[] = [
	{
		name: 'Table Keys', loadCommand: 'loadTableKeys', loadingText: 'Loading table keys...', errorLabel: 'Failed to load table keys', rowText: 'CUSTOMER_PK',
		loaded: (schema, table) => ({ command: 'tableKeysLoaded', schema, table, tableKeys: [tableKey()] }),
		empty: (schema, table) => ({ command: 'tableKeysLoaded', schema, table, tableKeys: [] }),
		error: (schema, table, message) => ({ command: 'tableKeysError', schema, table, error: { message } })
	},
	{
		name: 'Foreign Keys', loadCommand: 'loadForeignKeys', loadingText: 'Loading foreign keys...', errorLabel: 'Failed to load foreign keys', rowText: 'CUSTOMER_REGION_FK',
		loaded: (schema, table) => ({ command: 'foreignKeysLoaded', schema, table, foreignKeys: [foreignKey()] }),
		empty: (schema, table) => ({ command: 'foreignKeysLoaded', schema, table, foreignKeys: [] }),
		error: (schema, table, message) => ({ command: 'foreignKeysError', schema, table, error: { message } })
	},
	{
		name: 'Indexes', loadCommand: 'loadIndexes', loadingText: 'Loading indexes...', errorLabel: 'Failed to load indexes', rowText: 'CUSTOMER_BY_NAME',
		emptyText: 'No indexes found for this table',
		loaded: (schema, table) => ({ command: 'indexesLoaded', schema, table, indexes: [index()] }),
		empty: (schema, table) => ({ command: 'indexesLoaded', schema, table, indexes: [] }),
		error: (schema, table, message) => ({ command: 'indexesError', schema, table, error: { message } })
	},
	{
		name: 'Advised Indexes', loadCommand: 'loadIndexAdvice', loadingText: 'Loading index advice...', errorLabel: 'Failed to load index advice', rowText: 'Local Selection',
		emptyText: 'No index advisor recommendations for this table',
		loaded: (schema, table) => ({ command: 'indexAdviceLoaded', schema, table, indexAdvice: [advice()] }),
		empty: (schema, table) => ({ command: 'indexAdviceLoaded', schema, table, indexAdvice: [] }),
		error: (schema, table, message) => ({ command: 'indexAdviceError', schema, table, error: { message } })
	},
	{
		name: 'Triggers', loadCommand: 'loadTriggers', loadingText: 'Loading triggers...', errorLabel: 'Failed to load triggers', rowText: 'CUSTOMER_AUDIT',
		emptyText: 'No triggers found for this table',
		loaded: (schema, table) => ({ command: 'triggersLoaded', schema, table, triggers: [trigger()] }),
		empty: (schema, table) => ({ command: 'triggersLoaded', schema, table, triggers: [] }),
		error: (schema, table, message) => ({ command: 'triggersError', schema, table, error: { message } })
	}
];

const TABS_WITH_EMPTY_TEXT = CATALOG_TABS.filter((tab): tab is CatalogTab & { emptyText: string } => tab.emptyText !== undefined);

async function openTab(user: User, name: string) {
	await user.click(screen.getByRole('tab', { name }));
}

describe('schema browser catalog sub-tabs', () => {
	describe.each(CATALOG_TABS)('$name', tab => {
		it('asks for exactly this table when opened, and shows loading until the reply arrives', async () => {
			let user = userEvent.setup();
			renderSchemas();

			await openTab(user, tab.name);

			expect(posted()).toEqual([{ command: tab.loadCommand, schema: SCHEMA, table: TABLE }]);
			expect(screen.getByText(tab.loadingText)).toBeTruthy();
		});

		it('ignores a reply for the same table name in another schema, and renders the one addressed to it', async () => {
			let user = userEvent.setup();
			renderSchemas();
			await openTab(user, tab.name);

			postFromHost(tab.loaded('ARCHIVE', TABLE));
			expect(screen.getByText(tab.loadingText)).toBeTruthy();

			postFromHost(tab.loaded(SCHEMA, TABLE));
			expect(screen.queryByText(tab.loadingText)).toBeNull();
			expect(screen.getByText(tab.rowText)).toBeTruthy();
		});

		it('shows a load failure addressed to it, and ignores one that is not', async () => {
			let user = userEvent.setup();
			renderSchemas();
			await openTab(user, tab.name);

			postFromHost(tab.error('ARCHIVE', TABLE, 'SQL0204 ARCHIVE not found'));
			expect(screen.queryByText(tab.errorLabel, { exact: false })).toBeNull();

			postFromHost(tab.error(SCHEMA, TABLE, 'SQL0551 Not authorized'));
			expect(screen.getByText(tab.errorLabel, { exact: false })).toBeTruthy();
			expect(screen.getByText('SQL0551 Not authorized', { exact: false })).toBeTruthy();
		});

		it('Refresh asks again with forceRefresh, and shows loading until the new reply', async () => {
			let user = userEvent.setup();
			renderSchemas();
			await openTab(user, tab.name);
			postFromHost(tab.loaded(SCHEMA, TABLE));

			await user.click(screen.getByRole('button', { name: 'Refresh' }));

			expect(postedAfterLoad()).toEqual([{ command: tab.loadCommand, schema: SCHEMA, table: TABLE, forceRefresh: true }]);
			expect(screen.getByText(tab.loadingText)).toBeTruthy();
			expect(screen.queryByText(tab.rowText)).toBeNull();
		});

		// An empty tab has to stay refreshable: rows that appear after it opened (advice from queries run
		// since, an index just created) would otherwise never show without reopening the table.
		it('keeps Refresh when the reply is empty, and renders the rows the Refresh brings back', async () => {
			let user = userEvent.setup();
			renderSchemas();
			await openTab(user, tab.name);
			postFromHost(tab.empty(SCHEMA, TABLE));

			await user.click(screen.getByRole('button', { name: 'Refresh' }));

			expect(postedAfterLoad()).toEqual([{ command: tab.loadCommand, schema: SCHEMA, table: TABLE, forceRefresh: true }]);
			expect(screen.getByText(tab.loadingText)).toBeTruthy();

			postFromHost(tab.loaded(SCHEMA, TABLE));
			expect(screen.queryByText(tab.loadingText)).toBeNull();
			expect(screen.getByText(tab.rowText)).toBeTruthy();
		});

		it('asks again for the new table when another table is opened on the same sub-tab', async () => {
			let user = userEvent.setup();
			renderSchemas(undefined, {
				tablesBySchema: { [SCHEMA]: [{ connected: systemTable(SCHEMA, TABLE) }, { connected: systemTable(SCHEMA, 'REGION') }] }
			});
			await openTab(user, tab.name);
			postFromHost(tab.loaded(SCHEMA, TABLE));

			postFromHost<SchemasTreeInboundMessage>({ command: 'selectTable', schema: SCHEMA, table: 'REGION' });

			expect(postedAfterLoad()).toEqual([{ command: tab.loadCommand, schema: SCHEMA, table: 'REGION' }]);
			expect(screen.getByText(tab.loadingText)).toBeTruthy();
		});
	});

	describe.each(TABS_WITH_EMPTY_TEXT)('$name with no rows', tab => {
		it('says so under the column headers, alongside Refresh', async () => {
			let user = userEvent.setup();
			renderSchemas();
			await openTab(user, tab.name);

			postFromHost(tab.empty(SCHEMA, TABLE));

			let message = screen.getByText(tab.emptyText);
			// Inside the table, not in place of it - the headers and actions stay put.
			expect(message.closest('td')).not.toBeNull();
			expect(screen.getAllByRole('columnheader').length).toBeGreaterThan(0);
			expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
		});

		it('drops the message once a Refresh brings rows back', async () => {
			let user = userEvent.setup();
			renderSchemas();
			await openTab(user, tab.name);
			postFromHost(tab.empty(SCHEMA, TABLE));

			await user.click(screen.getByRole('button', { name: 'Refresh' }));
			postFromHost(tab.loaded(SCHEMA, TABLE));

			expect(screen.getByText(tab.rowText)).toBeTruthy();
			expect(screen.queryByText(tab.emptyText)).toBeNull();
		});
	});

	describe('which sub-tabs a table has', () => {
		it('offers Advised Indexes, Triggers and Data for a table that exists in the database', () => {
			renderSchemas();

			expect(subTabNames()).toEqual(['Info', 'Columns', 'Table Keys', 'Foreign Keys', 'Indexes', 'Advised Indexes', 'Triggers', 'Data']);
		});

		it('leaves out Advised Indexes, Triggers and Data for a table that only exists in an import', () => {
			renderSchemas({ imported: [importedTable(SCHEMA, TABLE)] });

			// Neither can be answered for a table the database doesn't have.
			expect(subTabNames()).toEqual(['Info', 'Columns', 'Table Keys', 'Foreign Keys', 'Indexes']);
		});

		it('flags a key that came from an import as New on an enhanced table, and has no flags column otherwise', async () => {
			let user = userEvent.setup();
			renderSchemas({ connected: systemTable(SCHEMA, TABLE), imported: [importedTable(SCHEMA, TABLE)] });
			await openTab(user, 'Table Keys');

			postFromHost<SchemasInboundMessage>({
				command: 'tableKeysLoaded', schema: SCHEMA, table: TABLE,
				tableKeys: [tableKey(), tableKey({ constraintName: 'CUSTOMER_EMAIL_UQ', constraintType: 'UNIQUE', columnName: 'EMAIL', systemColumnName: 'EMAIL', isNew: true })]
			});

			let newRow = screen.getAllByRole('row').find(row => row.textContent?.includes('CUSTOMER_EMAIL_UQ')) as HTMLElement;
			let realRow = screen.getAllByRole('row').find(row => row.textContent?.includes('CUSTOMER_PK')) as HTMLElement;
			expect(within(newRow).getByText('New')).toBeTruthy();
			expect(within(realRow).queryByText('New')).toBeNull();
		});

		it('has no flags column for a table with nothing imported', async () => {
			let user = userEvent.setup();
			renderSchemas();
			await openTab(user, 'Table Keys');

			postFromHost<SchemasInboundMessage>({ command: 'tableKeysLoaded', schema: SCHEMA, table: TABLE, tableKeys: [tableKey()] });

			let headers = screen.getAllByRole('columnheader').map(header => header.textContent ?? '');
			expect(headers[0]).toBe('Constraint Name');
		});
	});

	describe('Indexes actions', () => {
		async function renderIndexes(user: User, indexes: ResolvedIndex[] = [index()]) {
			renderSchemas();
			await openTab(user, 'Indexes');
			postFromHost<SchemasInboundMessage>({ command: 'indexesLoaded', schema: SCHEMA, table: TABLE, indexes });
		}

		it('Delete asks first, then sends the DROP INDEX for exactly that index', async () => {
			let user = userEvent.setup();
			await renderIndexes(user, [index(), index({ indexName: 'CUSTOMER_BY_REGION', keyColumns: 'REGION_CODE' })]);

			await chooseRowAction(user, 'CUSTOMER_BY_REGION', 'Delete');

			let dialog = screen.getByRole('dialog');
			expect(dialog.textContent).toContain('SALES.CUSTOMER_BY_REGION');
			expect(postedAfterLoad()).toEqual([]);

			await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

			expect(postedAfterLoad()).toEqual([{ command: 'deleteIndex', schema: SCHEMA, table: TABLE, sql: 'DROP INDEX SALES.CUSTOMER_BY_REGION' }]);
			await waitForDialogToClose();
		});

		it('Cancel on the delete confirmation sends nothing', async () => {
			let user = userEvent.setup();
			await renderIndexes(user);

			await chooseRowAction(user, 'CUSTOMER_BY_NAME', 'Delete');
			await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

			await waitForDialogToClose();
			expect(postedAfterLoad()).toEqual([]);
		});

		it('Rename starts from the current name and sends a RENAME INDEX to the trimmed new one', async () => {
			let user = userEvent.setup();
			await renderIndexes(user);

			await chooseRowAction(user, 'CUSTOMER_BY_NAME', 'Rename');
			let name = within(screen.getByRole('dialog')).getByRole('textbox', { name: 'Name' });
			expect((name as HTMLInputElement).value).toBe('CUSTOMER_BY_NAME');

			await user.clear(name);
			await user.type(name, '  CUSTOMER_NAME_IX  ');
			await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Rename' }));

			expect(postedAfterLoad()).toEqual([{ command: 'renameIndex', schema: SCHEMA, table: TABLE, sql: 'RENAME INDEX SALES.CUSTOMER_BY_NAME TO CUSTOMER_NAME_IX' }]);
			await waitForDialogToClose();
		});

		it('Rename refuses a blank name or one over the 128-character limit', async () => {
			let user = userEvent.setup();
			await renderIndexes(user);
			await chooseRowAction(user, 'CUSTOMER_BY_NAME', 'Rename');
			let dialog = screen.getByRole('dialog');
			let name = within(dialog).getByRole('textbox', { name: 'Name' });
			let rename = within(dialog).getByRole('button', { name: 'Rename' }) as HTMLButtonElement;

			await user.clear(name);
			await user.type(name, '   ');
			expect(within(dialog).getByText('Name is required')).toBeTruthy();
			expect(rename.disabled).toBe(true);

			await user.clear(name);
			// Pasted, not typed: 129 separate keystrokes take seconds under userEvent.
			await user.click(name);
			await user.paste('X'.repeat(129));
			expect(within(dialog).getByText('Name must be 128 characters or fewer')).toBeTruthy();
			expect(rename.disabled).toBe(true);

			await user.clear(name);
			await user.click(name);
			await user.paste('X'.repeat(128));
			expect(rename.disabled).toBe(false);
			expect(postedAfterLoad()).toEqual([]);
		});

		it('offers neither Rename nor Delete for an index that is not a real SQL index', async () => {
			let user = userEvent.setup();
			// A logical file or constraint-backed index has no SQL owner, and an imported one doesn't exist.
			await renderIndexes(user, [index({ indexName: 'CUSTOMER_LF', indexOwner: null }), index({ indexName: 'CUSTOMER_IMPORTED', isNew: true })]);

			for (let name of ['CUSTOMER_LF', 'CUSTOMER_IMPORTED']) {
				await openRowMenu(user, name);
				expect(screen.getByRole('menuitem', { name: 'Rename' }).getAttribute('aria-disabled')).toBe('true');
				expect(screen.getByRole('menuitem', { name: 'Delete' }).getAttribute('aria-disabled')).toBe('true');
				await user.keyboard('{Escape}');
				await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
			}
		});
	});

	describe('Advised Indexes actions', () => {
		const SUGGESTED_NAME = 'IDXADV_CUSTOMER_REGION_CODE_NAME';
		const SUGGESTED_SQL = `CREATE INDEX SALES.${SUGGESTED_NAME} ON SALES.CUSTOMER (REGION_CODE, NAME)`;

		async function renderAdvice(user: User, recommendations: SchemasIndexAdvice[] = [advice()], overrides: Partial<SchemasInitialState> = {}) {
			renderSchemas(undefined, overrides);
			await openTab(user, 'Advised Indexes');
			postFromHost<SchemasInboundMessage>({ command: 'indexAdviceLoaded', schema: SCHEMA, table: TABLE, indexAdvice: recommendations });
		}

		function createIndexDialog() {
			let dialog = screen.getByRole('dialog');
			let [name, sql] = within(dialog).getAllByRole('textbox') as HTMLInputElement[];
			return { dialog, name, sql };
		}

		it('Create Index proposes a name and the matching CREATE INDEX, and Run sends it with the advice\'s sort sequence', async () => {
			let user = userEvent.setup();
			await renderAdvice(user);

			await chooseRowAction(user, 'Local Selection', 'Create Index');
			let { dialog, name, sql } = createIndexDialog();
			expect(name.value).toBe(SUGGESTED_NAME);
			expect(sql.value).toBe(SUGGESTED_SQL);

			await user.click(within(dialog).getByRole('button', { name: 'Run' }));

			expect(postedAfterLoad()).toEqual([{ command: 'runGeneratedSql', schema: SCHEMA, table: TABLE, sql: SUGGESTED_SQL, sortSequence: '*HEX', sortSequenceLibrary: '' }]);
			await waitForDialogToClose();
		});

		it('keeps the statement in step with the name while the name is being edited', async () => {
			let user = userEvent.setup();
			await renderAdvice(user);
			await chooseRowAction(user, 'Local Selection', 'Create Index');
			let { dialog, name, sql } = createIndexDialog();

			await user.clear(name);
			await user.type(name, 'CUSTOMER_REGION_IX');

			expect(sql.value).toBe('CREATE INDEX SALES.CUSTOMER_REGION_IX ON SALES.CUSTOMER (REGION_CODE, NAME)');
			await user.click(within(dialog).getByRole('button', { name: 'Run' }));
			expect(postedAfterLoad()).toMatchObject([{ command: 'runGeneratedSql', sql: 'CREATE INDEX SALES.CUSTOMER_REGION_IX ON SALES.CUSTOMER (REGION_CODE, NAME)' }]);
		});

		it('runs the statement as edited by hand, which is what the dialog shows', async () => {
			let user = userEvent.setup();
			await renderAdvice(user);
			await chooseRowAction(user, 'Local Selection', 'Create Index');
			let { dialog, sql } = createIndexDialog();

			await user.clear(sql);
			await user.type(sql, 'CREATE UNIQUE INDEX SALES.CUSTOMER_UX ON SALES.CUSTOMER (REGION_CODE)');
			await user.click(within(dialog).getByRole('button', { name: 'Run' }));

			expect(postedAfterLoad()).toMatchObject([{ command: 'runGeneratedSql', sql: 'CREATE UNIQUE INDEX SALES.CUSTOMER_UX ON SALES.CUSTOMER (REGION_CODE)' }]);
		});

		it('with "Delete advised index" ticked, also sends the statement that deletes this recommendation', async () => {
			let user = userEvent.setup();
			await renderAdvice(user);
			await chooseRowAction(user, 'Local Selection', 'Create Index');
			let { dialog } = createIndexDialog();

			await user.click(within(dialog).getByRole('checkbox', { name: 'Delete advised index' }));
			await user.click(within(dialog).getByRole('button', { name: 'Run' }));

			expect(postedAfterLoad()).toEqual([{
				command: 'runGeneratedSql', schema: SCHEMA, table: TABLE, sql: SUGGESTED_SQL, sortSequence: '*HEX', sortSequenceLibrary: '',
				deleteAdviceSql: 'DELETE FROM QSYS2.SYSIXADV WHERE RRN(SYSIXADV) = 42'
			}]);
		});

		it('refuses to run with a blank index name', async () => {
			let user = userEvent.setup();
			await renderAdvice(user);
			await chooseRowAction(user, 'Local Selection', 'Create Index');
			let { dialog, name } = createIndexDialog();

			await user.clear(name);

			expect(within(dialog).getByText('Name is required')).toBeTruthy();
			expect((within(dialog).getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true);
		});

		it('warns when the advice was made under a different sort sequence, and sends that sequence with the statement', async () => {
			let user = userEvent.setup();
			await renderAdvice(user, [advice({ sortSequence: 'QLA1', sortSequenceLibrary: 'QSYS' })]);

			await chooseRowAction(user, 'Local Selection', 'Create Index');
			let { dialog } = createIndexDialog();
			expect(dialog.textContent).toContain('This index was advised under sort sequence QLA1');

			await user.click(within(dialog).getByRole('button', { name: 'Run' }));
			expect(postedAfterLoad()).toMatchObject([{ command: 'runGeneratedSql', sortSequence: 'QLA1', sortSequenceLibrary: 'QSYS' }]);
		});

		it('warns when only the sort sequence\'s library differs - the same name in another library is a different sort sequence', async () => {
			let user = userEvent.setup();
			await renderAdvice(user, [advice({ sortSequence: 'QLA1', sortSequenceLibrary: 'MYLIB' })], { currentSortSequence: 'QLA1', currentSortSequenceLibrary: 'QSYS' });

			await chooseRowAction(user, 'Local Selection', 'Create Index');

			expect(createIndexDialog().dialog.textContent).toContain('This index was advised under sort sequence QLA1');
		});

		it('does not warn when the advice matches the connection\'s sort sequence', async () => {
			let user = userEvent.setup();
			await renderAdvice(user, [advice({ sortSequence: 'QLA1', sortSequenceLibrary: 'QSYS' })], { currentSortSequence: 'QLA1', currentSortSequenceLibrary: 'QSYS' });

			await chooseRowAction(user, 'Local Selection', 'Create Index');

			expect(createIndexDialog().dialog.textContent).not.toContain('This index was advised under sort sequence');
		});

		it('Delete asks first, then sends the statement that deletes exactly that recommendation', async () => {
			let user = userEvent.setup();
			await renderAdvice(user, [advice(), advice({ id: 77, keyColumnsAdvised: 'EMAIL', reasonAdvised: 'Ordering' })]);

			await chooseRowAction(user, 'Ordering', 'Delete');
			let dialog = screen.getByRole('dialog');
			expect(dialog.textContent).toContain('EMAIL');
			expect(postedAfterLoad()).toEqual([]);

			await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

			expect(postedAfterLoad()).toEqual([{ command: 'deleteIndexAdvice', schema: SCHEMA, table: TABLE, sql: 'DELETE FROM QSYS2.SYSIXADV WHERE RRN(SYSIXADV) = 77' }]);
			await waitForDialogToClose();
		});

		it('Copy SQL puts the suggested CREATE INDEX on the clipboard and sends nothing', async () => {
			let user = userEvent.setup();
			await renderAdvice(user);
			// userEvent's clipboard stub outlives a test under globals: false, so start from a known value.
			await navigator.clipboard.writeText('sentinel');

			await chooseRowAction(user, 'Local Selection', 'Copy SQL');

			await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(SUGGESTED_SQL));
			expect(postedAfterLoad()).toEqual([]);
		});
	});

	describe('Triggers actions', () => {
		async function renderTriggers(user: User, triggers: SchemasTrigger[]) {
			renderSchemas();
			await openTab(user, 'Triggers');
			postFromHost<SchemasInboundMessage>({ command: 'triggersLoaded', schema: SCHEMA, table: TABLE, triggers });
		}

		it('spells out the program an external trigger runs', async () => {
			let user = userEvent.setup();
			await renderTriggers(user, [trigger()]);

			expect(screen.getByText('SALES/CUSAUDIT')).toBeTruthy();
		});

		function sourceText(): string {
			return (within(screen.getByRole('dialog')).getByRole('textbox', { name: 'Trigger source' }) as HTMLTextAreaElement).value;
		}

		it('View Source shows an SQL trigger\'s body straight away, and asks the host for nothing', async () => {
			let user = userEvent.setup();
			await renderTriggers(user, [trigger(), trigger({ triggerName: 'CUSTOMER_STAMP', mode: 'DB2SQL', actionStatement: 'BEGIN\n\tSET N.UPDDT = CURRENT DATE;\nEND' })]);

			await chooseRowAction(user, 'CUSTOMER_STAMP', 'View Source');

			expect(within(screen.getByRole('dialog')).getByText('SALES.CUSTOMER_STAMP')).toBeTruthy();
			expect(sourceText()).toBe('BEGIN\n\tSET N.UPDDT = CURRENT DATE;\nEND');
			expect(postedAfterLoad()).toEqual([]);

			await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
			await waitForDialogToClose();
		});

		it('View Source asks the host for an external trigger\'s program source, and shows one tab per module', async () => {
			let user = userEvent.setup();
			await renderTriggers(user, [trigger()]);

			await chooseRowAction(user, 'CUSTOMER_AUDIT', 'View Source');

			expect(postedAfterLoad()).toEqual([{ command: 'loadTriggerSource', schema: SCHEMA, table: TABLE, triggerName: 'CUSTOMER_AUDIT', programLibrary: SCHEMA, programName: 'CUSAUDIT' }]);
			expect(screen.getByText('Loading source...')).toBeTruthy();
			expect(within(screen.getByRole('dialog')).getByText('Program SALES/CUSAUDIT')).toBeTruthy();

			// A reply for another trigger on the same table is not this dialog's.
			postFromHost<SchemasInboundMessage>({ command: 'triggerSourceLoaded', schema: SCHEMA, table: TABLE, triggerName: 'OTHER', sources: [] });
			expect(screen.getByText('Loading source...')).toBeTruthy();

			postFromHost<SchemasInboundMessage>({
				command: 'triggerSourceLoaded', schema: SCHEMA, table: TABLE, triggerName: 'CUSTOMER_AUDIT', sources: [
					{ module: 'CUSAUD01', location: 'SALES/QRPGLESRC(CUSAUD01)', text: 'dcl-proc one;' },
					{ module: 'CUSAUD02', location: 'SALES/QRPGLESRC(CUSAUD02)', error: { message: 'Member CUSAUD02 not found.' } }
				]
			});

			let modules = within(screen.getByRole('dialog')).getByRole('tablist', { name: 'Modules' });
			expect(within(modules).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['CUSAUD01', 'CUSAUD02']);
			expect(screen.getByText('SALES/QRPGLESRC(CUSAUD01)')).toBeTruthy();
			expect(sourceText()).toBe('dcl-proc one;');

			// A module whose source couldn't be read says why, without hiding the ones that could.
			await user.click(within(modules).getByRole('tab', { name: 'CUSAUD02' }));
			expect(screen.getByText('Failed to read this source: Member CUSAUD02 not found.')).toBeTruthy();
		});

		it('shows a dispatching program\'s handler first, says how it was found, and labels every tab with its program', async () => {
			let user = userEvent.setup();
			await renderTriggers(user, [trigger({ programName: 'TG_MED' })]);

			await chooseRowAction(user, 'CUSTOMER_AUDIT', 'View Source');
			postFromHost<SchemasInboundMessage>({
				command: 'triggerSourceLoaded', schema: SCHEMA, table: TABLE, triggerName: 'CUSTOMER_AUDIT',
				sources: [{ module: 'TG_MED_M01', location: 'SALES/QSRCF(TG_MED_M01)', text: 'main() {}' }],
				handlers: [{
					program: 'SALES/CUSTRG (*SRVPGM)', object: 'CUSTRG', entry: 'TRIGGERSERVICE', via: 'CTL/TRGROUT',
					sources: [{ module: 'CUSTRG', location: 'SALES/QRPGLESRC(CUSTRG)', text: 'dcl-proc triggerService export;' }]
				}]
			});

			let dialog = within(screen.getByRole('dialog'));
			expect(dialog.getByText('Calls SALES/CUSTRG (*SRVPGM) procedure TRIGGERSERVICE for this table, through CTL/TRGROUT')).toBeTruthy();
			expect(dialog.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['CUSTRG', 'TG_MED: TG_MED_M01']);
			expect(sourceText()).toBe('dcl-proc triggerService export;');

			await user.click(dialog.getByRole('tab', { name: 'TG_MED: TG_MED_M01' }));
			expect(sourceText()).toBe('main() {}');
			expect(dialog.queryByRole('alert')).toBeNull();
		});

		it('still shows a handler whose routing row the dispatcher passes over, marked inactive', async () => {
			let user = userEvent.setup();
			await renderTriggers(user, [trigger({ programName: 'TG_MED' })]);

			await chooseRowAction(user, 'CUSTOMER_AUDIT', 'View Source');
			postFromHost<SchemasInboundMessage>({
				command: 'triggerSourceLoaded', schema: SCHEMA, table: TABLE, triggerName: 'CUSTOMER_AUDIT',
				sources: [{ module: 'TG_MED_M01', location: 'SALES/QSRCF(TG_MED_M01)', text: 'main() {}' }],
				handlers: [{
					program: 'SALES/CUSTRG (*SRVPGM)', object: 'CUSTRG', entry: 'TRIGGERSERVICE', via: 'CTL/TRGROUT',
					unselected: { column: 'TRACTIVE', value: 'Y', actual: 'N' },
					sources: [{ module: 'CUSTRG', location: 'SALES/QRPGLESRC(CUSTRG)', text: 'dcl-proc triggerService export;' }]
				}]
			});

			let dialog = within(screen.getByRole('dialog'));
			let alert = dialog.getByRole('alert');
			expect(alert.textContent).toBe('Inactive: TRACTIVE is \'N\' for CUSTRG in CTL/TRGROUT, and TG_MED only reads rows where TRACTIVE = \'Y\'');
			expect(alert.className).toMatch(/Warning/);
			expect(sourceText()).toBe('dcl-proc triggerService export;');
		});

		it('shows the notice on a copy read in place of a missing member, and a missing member with no copy as a message', async () => {
			let user = userEvent.setup();
			await renderTriggers(user, [trigger()]);

			await chooseRowAction(user, 'CUSTOMER_AUDIT', 'View Source');
			postFromHost<SchemasInboundMessage>({
				command: 'triggerSourceLoaded', schema: SCHEMA, table: TABLE, triggerName: 'CUSTOMER_AUDIT', sources: [
					{ module: 'CUSAUD01', location: 'SALES/QRPGLESRC(CUSAUD01)', text: 'dcl-proc one;', notice: { text: 'Compiled from TEST/QRPGLESRC(CUSAUD01), which no longer exists.', severity: 'warning' } },
					{ module: 'CUSAUD02', location: 'TEST/QRPGLESRC(CUSAUD02)', unavailable: 'No copy of that member was found in another library.' }
				]
			});

			let dialog = within(screen.getByRole('dialog'));
			expect(dialog.getByRole('alert').textContent).toContain('Compiled from TEST/QRPGLESRC(CUSAUD01), which no longer exists.');
			expect(sourceText()).toBe('dcl-proc one;');

			await user.click(dialog.getByRole('tab', { name: 'CUSAUD02' }));
			expect(dialog.getByText('No copy of that member was found in another library.')).toBeTruthy();
			expect(dialog.queryByText(/Failed to read/)).toBeNull();
		});

		it('says so when the program records no source location, and shows a failure to look it up', async () => {
			let user = userEvent.setup();
			await renderTriggers(user, [trigger(), trigger({ triggerName: 'CUSTOMER_PURGE', programName: 'CUSPURGE' })]);

			await chooseRowAction(user, 'CUSTOMER_AUDIT', 'View Source');
			postFromHost<SchemasInboundMessage>({ command: 'triggerSourceLoaded', schema: SCHEMA, table: TABLE, triggerName: 'CUSTOMER_AUDIT', sources: [] });
			expect(screen.getByText('No source location is recorded for program SALES/CUSAUDIT.')).toBeTruthy();

			await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
			await waitForDialogToClose();

			await chooseRowAction(user, 'CUSTOMER_PURGE', 'View Source');
			postFromHost<SchemasInboundMessage>({ command: 'triggerSourceError', schema: SCHEMA, table: TABLE, triggerName: 'CUSTOMER_PURGE', error: { message: 'PROGRAM_INFO failed' } });
			expect(screen.getByText('Failed to find the trigger program\'s source: PROGRAM_INFO failed')).toBeTruthy();
		});
	});
});
