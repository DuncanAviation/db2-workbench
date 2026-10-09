import * as assert from 'assert';
import { extension } from '../extension.js';
import { SqlImportConfig } from '../models/sql-import-config.js';
import { TestSupport } from './test-support.js';

/**
 * SqlSchemaImports - the orchestrator on top of the SQL schema import feature's pure helpers.
 *
 * The helpers underneath (statement wrapping, row conversion, read-only validation, the persisted
 * config shape) are covered by their own `*.spec.ts` files. What is only reachable here is the part
 * that owns state and talks to the database: which statement actually runs and when, what is held
 * between the dialog's two steps, what lands in the tree versus in the per-table fragment cache, and
 * the rules that decide whether a saved import runs again or is left alone.
 *
 * Those rules are worth this tier because getting one wrong is expensive rather than wrong-looking: a
 * saved import runs the user's own SQL, with their credentials, against production, automatically,
 * every time a connection opens. "Runs once per host", "a failure is not retried" and "a cached
 * section is not re-queried" are the difference between a metadata lookup and a statement on a loop.
 *
 * Saved imports auto-run on connect, so every test here clears both the saved entries and the
 * connection's links on the way out - otherwise the next suite's first session runs them too.
 */
suite('SqlSchemaImports against the fake driver', () => {
	const TABLES_SQL = 'select * from qgpl.meta_tables';
	const COLUMNS_SQL = 'select * from qgpl.meta_columns';
	const RELATIONSHIPS_SQL = 'select * from qgpl.meta_relationships';

	const TABLES_MAPPING = { SCHEMA_NAME: 'schema', TABLE_NAME: 'tableSystemName', DESCRIPTION: 'tableDescription' } as const;
	const COLUMNS_MAPPING = { SCHEMA_NAME: 'schema', TABLE_NAME: 'tableSystemName', COLUMN_NAME: 'columnSystemName', DESCRIPTION: 'columnDescription' } as const;
	const RELATIONSHIPS_MAPPING = {
		CHILD_SCHEMA: 'childSchema',
		CHILD_TABLE: 'childTableSystemName',
		CHILD_COLUMN: 'childColumnSystemName',
		PARENT_SCHEMA: 'parentSchema',
		PARENT_TABLE: 'parentTableSystemName',
		PARENT_COLUMN: 'parentColumnSystemName'
	} as const;

	// A second import, so a connection can link two and the order they run in is observable.
	const SECOND_TABLES_SQL = 'select * from qgpl.meta_tables_two';
	const SECOND_TABLE_ROWS = [{ SCHEMA_NAME: 'SITE', TABLE_NAME: 'WORKLOG', DESCRIPTION: 'Work order log' }];

	const TABLES_PATTERN = /meta_tables\b/;
	const SECOND_TABLES_PATTERN = /meta_tables_two/;
	const COLUMNS_PATTERN = /meta_columns/;
	const RELATIONSHIPS_PATTERN = /meta_relationships/;

	// The import's own table - one DB2 has never heard of, which is the case the whole feature exists
	// for. SALES.CUSTOMER is real, so a Columns row against it proves an import can also add to a table
	// the catalog already knows.
	const TABLE_ROWS = [
		{ SCHEMA_NAME: 'SITE', TABLE_NAME: 'WORKORDER', DESCRIPTION: 'Work orders' },
		{ SCHEMA_NAME: 'SALES', TABLE_NAME: 'CUSTOMER', DESCRIPTION: 'Customers, per the site catalog' }
	];

	let openKeys: string[] = [];
	let importIds: string[] = [];

	suiteSetup(async () => {
		await TestSupport.activate();
	});

	teardown(async () => {
		for(let importId of importIds) {
			extension.sqlSchemaImports.dropImport(TestSupport.CONFIG_ID, importId);
		}

		// Drops this host's rows, its fragment cache and the "already run" guard, which is what the last
		// session on a connection does - see deleteHostCache.
		extension.sqlSchemaImports.deleteHostCache(TestSupport.CONNECTION.host);

		await TestSupport.closeSessions(...openKeys);
		await TestSupport.setSqlImports([]);
		await TestSupport.linkSqlImports();
		await TestSupport.setSqlImportRowLimit(50000);

		openKeys = [];
		importIds = [];
		TestSupport.restoreDriver();
	});

	function open(key: string): string {
		openKeys.push(key);
		return key;
	}

	/** A saved import as settings holds it - what auto-runs when a linked connection opens. */
	function savedImport(importId: string, overrides: Partial<SqlImportConfig> = {}): SqlImportConfig {
		return {
			id: importId,
			name: `Import ${importId}`,
			tables: { sql: TABLES_SQL, mapping: { ...TABLES_MAPPING } },
			...overrides
		};
	}

	/**
	 * Installs the saved imports, links them to the one test connection, and remembers them for
	 * teardown. Link them before opening a session: linking while one is open is its own path
	 * (applyConnectionChange runs the newly linked imports there and then).
	 */
	async function saveAndLink(...configs: SqlImportConfig[]): Promise<void> {
		importIds.push(...configs.map(config => config.id));
		await TestSupport.setSqlImports(configs);
		await TestSupport.linkSqlImports(...configs.map(config => config.id));
	}

	function importedTableNames(): string[] {
		return extension.schemaTrees.getImportedTables(TestSupport.CONFIG_ID).map(table => `${table.schema}.${table.name}`);
	}

	// Validation runs before the database does. The check itself is covered by sql-import-validator.spec;
	// what matters here is that a rejected statement never reaches the connection - this is the guard
	// standing between a hand-edited settings entry and a DELETE running on the user's credentials.
	test('a statement that is not read-only is rejected before anything runs', async () => {
		let key = open('test://import-validate');
		let recorder = TestSupport.recordStatements();

		let result = await extension.sqlSchemaImports.run({
			key: key,
			configId: TestSupport.CONFIG_ID,
			statements: [{ section: 'tables', sql: 'delete from qgpl.meta_tables' }]
		});

		assert.strictEqual(result.kind, 'error');
		assert.strictEqual(result.kind === 'error' ? result.section : undefined, 'tables', 'the dialog puts the error under the section that produced it');
		assert.deepStrictEqual(recorder.matching(/meta_tables/), [], 'a rejected statement must never reach the database');
	});

	// The cap is asked for as rowLimit + 1 precisely so "there was more" is knowable. Both halves are
	// asserted: the statement really asks for one extra row, and the extra row is not kept.
	test('a run asks for one row more than the cap, and reports the result as truncated', async () => {
		let key = open('test://import-truncated');
		await TestSupport.setSqlImportRowLimit(2);

		let recorder = TestSupport.recordStatements({
			database: TestSupport.DATABASE,
			responses: [{
				match: TABLES_PATTERN,
				rows: [
					{ SCHEMA_NAME: 'SITE', TABLE_NAME: 'ONE', DESCRIPTION: '' },
					{ SCHEMA_NAME: 'SITE', TABLE_NAME: 'TWO', DESCRIPTION: '' },
					{ SCHEMA_NAME: 'SITE', TABLE_NAME: 'THREE', DESCRIPTION: '' }
				]
			}]
		});

		let result = await extension.sqlSchemaImports.run({
			key: key,
			configId: TestSupport.CONFIG_ID,
			statements: [{ section: 'tables', sql: TABLES_SQL }]
		});

		assert.strictEqual(result.kind, 'ran');
		assert.match(recorder.matching(TABLES_PATTERN)[0]?.normalized ?? '', /fetch first 3 rows only/);

		let section = result.kind === 'ran' ? result.sections[0] : undefined;
		assert.strictEqual(section?.truncated, true);
		assert.strictEqual(section?.rowCount, 2, 'the row over the cap is reported as truncation, not as data');
		assert.deepStrictEqual(section?.resultColumns, ['SCHEMA_NAME', 'TABLE_NAME', 'DESCRIPTION']);
	});

	// Step 2's two guards. Both exist because the rows are already in hand: importing anyway would write
	// data the user didn't mean into the tree, where nothing distinguishes it from data they did mean.
	test('an import with a required field unmapped, or a field mapped twice, is refused', async () => {
		let key = open('test://import-mapping-guards');
		TestSupport.useDriver({ database: TestSupport.DATABASE, responses: [{ match: TABLES_PATTERN, rows: TABLE_ROWS }] });

		let run = await extension.sqlSchemaImports.run({ key: key, configId: TestSupport.CONFIG_ID, statements: [{ section: 'tables', sql: TABLES_SQL }] });
		assert.strictEqual(run.kind, 'ran');
		let runId = run.kind === 'ran' ? run.runId : '';

		let missing = await extension.sqlSchemaImports.import({
			runId: runId,
			name: 'Missing a required field',
			mappings: { tables: { SCHEMA_NAME: 'schema' } }
		});

		assert.strictEqual(missing.kind, 'error');
		assert.match(missing.kind === 'error' ? missing.error.message : '', /required/i);

		let duplicated = await extension.sqlSchemaImports.import({
			runId: runId,
			name: 'Two columns on one field',
			mappings: { tables: { SCHEMA_NAME: 'schema', TABLE_NAME: 'tableSystemName', DESCRIPTION: 'tableSystemName' } }
		});

		assert.strictEqual(duplicated.kind, 'error');
		assert.match(duplicated.kind === 'error' ? duplicated.error.message : '', /once/i);

		// Neither refusal consumed the run: the dialog's whole point is that the user fixes the mapping
		// and imports the same rows without re-running the statements.
		assert.deepStrictEqual(importedTableNames(), []);
	});

	// The division this class is built around: Tables goes into the tree, Columns and Relationships go
	// into the per-table fragment cache. Seeding them at import time is what makes the tabs free
	// afterwards, and "free" is only provable by watching the driver.
	test('an import lands its tables in the tree and seeds its other sections, which are then never re-queried', async () => {
		let key = open('test://import-seeded');
		let recorder = TestSupport.recordStatements({
			database: TestSupport.DATABASE,
			responses: [
				{ match: TABLES_PATTERN, rows: TABLE_ROWS },
				{
					match: COLUMNS_PATTERN,
					rows: [
						{ SCHEMA_NAME: 'SITE', TABLE_NAME: 'WORKORDER', COLUMN_NAME: 'WONUM', DESCRIPTION: 'Work order number' },
						{ SCHEMA_NAME: 'SALES', TABLE_NAME: 'CUSTOMER', COLUMN_NAME: 'CUSTNO', DESCRIPTION: 'Site meaning of the customer number' }
					]
				},
				{
					match: RELATIONSHIPS_PATTERN,
					rows: [{ CHILD_SCHEMA: 'SITE', CHILD_TABLE: 'WORKORDER', CHILD_COLUMN: 'WOCUST', PARENT_SCHEMA: 'SALES', PARENT_TABLE: 'CUSTOMER', PARENT_COLUMN: 'CUSTNO' }]
				}
			]
		});

		let run = await extension.sqlSchemaImports.run({
			key: key,
			configId: TestSupport.CONFIG_ID,
			statements: [
				{ section: 'tables', sql: TABLES_SQL },
				{ section: 'columns', sql: COLUMNS_SQL },
				{ section: 'relationships', sql: RELATIONSHIPS_SQL }
			]
		});

		assert.strictEqual(run.kind, 'ran');
		let runId = run.kind === 'ran' ? run.runId : '';

		let outcome = await extension.sqlSchemaImports.import({
			runId: runId,
			name: 'Site metadata',
			mappings: { tables: { ...TABLES_MAPPING }, columns: { ...COLUMNS_MAPPING }, relationships: { ...RELATIONSHIPS_MAPPING } }
		});

		assert.strictEqual(outcome.kind, 'imported');
		importIds.push(...extension.sqlSchemaImports.getImportIds(TestSupport.CONFIG_ID));

		assert.deepStrictEqual(importedTableNames(), ['SITE.WORKORDER', 'SALES.CUSTOMER']);

		// Each section ran exactly once, at step 1 - which is also what makes the "never again" assertion
		// below meaningful rather than a recorder that was never going to see anything.
		assert.strictEqual(recorder.matching(COLUMNS_PATTERN).length, 1);
		assert.strictEqual(recorder.matching(RELATIONSHIPS_PATTERN).length, 1);

		recorder.clear();

		let fragments = await extension.sqlSchemaImports.getTableFragments(
			{ key: key, configId: TestSupport.CONFIG_ID },
			[{ schema: 'SITE', table: 'WORKORDER' }, { schema: 'SALES', table: 'CUSTOMER' }]
		);

		assert.deepStrictEqual(fragments.get('SITE.WORKORDER')?.[0]?.columns.map(column => column.name), ['WONUM']);
		assert.deepStrictEqual(fragments.get('SITE.WORKORDER')?.[0]?.foreignKeys.map(foreignKey => foreignKey.referencedTable), ['CUSTOMER']);
		assert.deepStrictEqual(fragments.get('SALES.CUSTOMER')?.[0]?.columns.map(column => column.name), ['CUSTNO']);

		assert.deepStrictEqual(recorder.statements, [], 'a section converted at import time must never be queried again');
	});

	// A run's rows are held only between the two dialog steps. Holding them any longer would be a cache
	// of a result the user has already used, keyed by a run id nothing will ever present again.
	test('a run\'s rows are dropped once it has been imported', async () => {
		let key = open('test://import-run-discarded');
		TestSupport.useDriver({ database: TestSupport.DATABASE, responses: [{ match: TABLES_PATTERN, rows: TABLE_ROWS }] });

		let run = await extension.sqlSchemaImports.run({ key: key, configId: TestSupport.CONFIG_ID, statements: [{ section: 'tables', sql: TABLES_SQL }] });
		let runId = run.kind === 'ran' ? run.runId : '';

		await extension.sqlSchemaImports.import({ runId: runId, name: 'Site metadata', mappings: { tables: { ...TABLES_MAPPING } } });
		importIds.push(...extension.sqlSchemaImports.getImportIds(TestSupport.CONFIG_ID));

		let second = await extension.sqlSchemaImports.import({ runId: runId, name: 'Site metadata', mappings: { tables: { ...TABLES_MAPPING } } });

		assert.strictEqual(second.kind, 'error');
		assert.match(second.kind === 'error' ? second.error.message : '', /no longer available/);
	});

	// The automatic path, driven the way the product drives it: a connection opens and its saved imports
	// run behind the table scan. Nothing here calls ensureLoaded - that fire-and-forget hand-off from
	// DbConnections is part of what is being asserted.
	test('a saved import linked to a connection runs by itself when that connection opens', async () => {
		let key = open('test://import-auto-run');
		await saveAndLink(savedImport('auto-run-import'));

		TestSupport.useDriver({ database: TestSupport.DATABASE, responses: [{ match: TABLES_PATTERN, rows: TABLE_ROWS }] });

		await extension.connections.getConnectionInfo({ key: key, configId: TestSupport.CONFIG_ID });
		await TestSupport.waitUntil('the saved import to reach the tree', () => importedTableNames().length === 2);

		assert.deepStrictEqual(importedTableNames(), ['SITE.WORKORDER', 'SALES.CUSTOMER']);
	});

	// The rows belong to the host, not to the session that happened to ask for them. Two sessions on one
	// system must cost one run of the user's statement, not two - this is the same rule MemoryCache
	// follows for catalog lookups, and the reason it matters more here is that the statement is theirs.
	test('a saved import runs once per host however many sessions open', async () => {
		let firstKey = open('test://import-host-a');
		let secondKey = open('test://import-host-b');
		await saveAndLink(savedImport('host-dedupe-import'));

		let recorder = TestSupport.recordStatements({ database: TestSupport.DATABASE, responses: [{ match: TABLES_PATTERN, rows: TABLE_ROWS }] });

		await extension.sqlSchemaImports.ensureLoaded({ key: firstKey, configId: TestSupport.CONFIG_ID });
		await extension.sqlSchemaImports.ensureLoaded({ key: secondKey, configId: TestSupport.CONFIG_ID });

		assert.strictEqual(recorder.matching(TABLES_PATTERN).length, 1, 'the second session must reuse the first run\'s rows');
		assert.deepStrictEqual(importedTableNames(), ['SITE.WORKORDER', 'SALES.CUSTOMER']);
	});

	// A failed statement is remembered as failed. Re-running it on every connect would turn one bad
	// saved entry into a warning on a loop, on a connection that works perfectly well without it.
	test('a saved import that fails is not retried, and leaves the tree alone', async () => {
		let key = open('test://import-failure');
		await saveAndLink(savedImport('failing-import'));

		let recorder = TestSupport.recordStatements({
			database: TestSupport.DATABASE,
			responses: [{ match: TABLES_PATTERN, error: { message: 'META_TABLES in QGPL type *FILE not found.', driverErrors: [{ code: -204, state: '42704', message: 'Not found.' }] } }]
		});

		await extension.sqlSchemaImports.ensureLoaded({ key: key, configId: TestSupport.CONFIG_ID });
		await extension.sqlSchemaImports.ensureLoaded({ key: key, configId: TestSupport.CONFIG_ID });

		assert.strictEqual(recorder.matching(TABLES_PATTERN).length, 1, 'a failed import must not be re-run on the next connect');
		assert.deepStrictEqual(importedTableNames(), []);
	});

	// Drift: the statement still runs, but no longer returns a column the saved mapping names. A
	// required one makes every row wrong rather than thinner, so nothing is applied at all - the stored
	// tables stay as they were rather than being replaced by a half-read version of themselves.
	test('a saved import whose statement stopped returning a required column is not applied', async () => {
		let key = open('test://import-drift');
		await saveAndLink(savedImport('drifted-import'));

		let recorder = TestSupport.recordStatements({
			database: TestSupport.DATABASE,
			// TABLE_NAME is gone - the column the required tableSystemName target is mapped to.
			responses: [{ match: TABLES_PATTERN, rows: [{ SCHEMA_NAME: 'SITE', DESCRIPTION: 'Work orders' }] }]
		});

		await extension.sqlSchemaImports.ensureLoaded({ key: key, configId: TestSupport.CONFIG_ID });

		// The statement ran and came back with rows: this is drift being caught, not an import that
		// never got as far as the database.
		assert.strictEqual(recorder.matching(TABLES_PATTERN).length, 1);
		assert.deepStrictEqual(importedTableNames(), [], 'a table read without its system name has nothing to be keyed by');
	});

	// The lazy path, which is what a saved import leaves behind: the Tables statement has run, and the
	// Columns statement runs per batch of tables the moment something asks for them. The empty answer is
	// the case worth pinning - a table the statement said nothing about must be cached as "nothing",
	// not left absent and re-queried every time its tab is opened.
	test('a lazily loaded section queries once per batch, and a table with no rows is cached as empty', async () => {
		let key = open('test://import-lazy');
		await saveAndLink(savedImport('lazy-import', { columns: { sql: COLUMNS_SQL, mapping: { ...COLUMNS_MAPPING } } }));

		let recorder = TestSupport.recordStatements({
			database: TestSupport.DATABASE,
			responses: [
				{ match: TABLES_PATTERN, rows: TABLE_ROWS },
				{ match: COLUMNS_PATTERN, rows: [{ SCHEMA_NAME: 'SITE', TABLE_NAME: 'WORKORDER', COLUMN_NAME: 'WONUM', DESCRIPTION: 'Work order number' }] }
			]
		});

		await extension.sqlSchemaImports.ensureLoaded({ key: key, configId: TestSupport.CONFIG_ID });
		recorder.clear();

		let targets = [{ schema: 'SITE', table: 'WORKORDER' }, { schema: 'SALES', table: 'CUSTOMER' }];
		let first = await extension.sqlSchemaImports.getTableFragments({ key: key, configId: TestSupport.CONFIG_ID }, targets);

		assert.strictEqual(recorder.matching(COLUMNS_PATTERN).length, 1, 'both tables must be asked for in one statement');
		assert.deepStrictEqual(first.get('SITE.WORKORDER')?.[0]?.columns.map(column => column.name), ['WONUM']);
		assert.deepStrictEqual(first.get('SALES.CUSTOMER')?.[0]?.columns, [], 'a table the rows said nothing about still gets an entry');

		recorder.clear();
		await extension.sqlSchemaImports.getTableFragments({ key: key, configId: TestSupport.CONFIG_ID }, targets);

		assert.deepStrictEqual(recorder.matching(COLUMNS_PATTERN), [], 'a cached section must not be queried again, including for the table that had nothing');
	});

	// The one outcome that is neither success nor failure: the session closed before this import's turn
	// came round, so its statement never ran. DbConnections declines to reopen a closed key (see its
	// closedKeys), which is deliberate - nothing would ever close the connection it reopened - and the
	// import has to tell that apart from a statement that actually failed. Treating it as a failure
	// would warn about something the user did on purpose, and remember it, so the import would stay
	// unrun for as long as that host's cache lived.
	//
	// Two imports, because a session can only close mid-loop while an earlier import is still running:
	// the first one's statement is slow, and closing the session the moment it reaches the driver puts
	// the close inside that window, exactly where it happens in use (a tab shut while the connection is
	// warming up).
	test('a saved import whose session closes before its turn is skipped, and still runs next time', async () => {
		let key = open('test://import-skipped');
		await saveAndLink(
			savedImport('skipped-first-import'),
			savedImport('skipped-second-import', { tables: { sql: SECOND_TABLES_SQL, mapping: { ...TABLES_MAPPING } } })
		);

		let closed = false;

		let recorder = TestSupport.recordStatements({
			database: TestSupport.DATABASE,
			responses: [
				{ match: TABLES_PATTERN, rows: TABLE_ROWS, delayMs: 400 },
				{ match: SECOND_TABLES_PATTERN, rows: SECOND_TABLE_ROWS }
			],
			onStatement: sql => {
				// Once: the same statement runs again on the reconnect below, and closing the session a
				// second time would be testing the close rather than what follows it.
				if(TABLES_PATTERN.test(sql) && !closed) {
					closed = true;
					// Fire-and-forget, like the tab close it stands for: close() tombstones the key as its
					// first act, and the 400ms this statement is still running is the window the second
					// import's statement then arrives in.
					void extension.connections.close({ key: key });
				}
			}
		});

		// The connection-time warm-up runs the loop - nothing here calls ensureLoaded.
		await extension.connections.getConnectionInfo({ key: key, configId: TestSupport.CONFIG_ID });
		await TestSupport.waitUntil('the first import to reach the tree', () => importedTableNames().length === 2);

		assert.deepStrictEqual(recorder.matching(SECOND_TABLES_PATTERN), [], 'the second import must not reopen the connection its session just closed');

		// The skip is not remembered as an answer for this host. Both imports run again on the next
		// connection - the first because closing the last session dropped this host's cached rows, the
		// second because a skipped run was never recorded as one at all.
		recorder.clear();
		extension.connections.allowConnect(key);
		await extension.sqlSchemaImports.ensureLoaded({ key: key, configId: TestSupport.CONFIG_ID });

		assert.strictEqual(recorder.matching(SECOND_TABLES_PATTERN).length, 1, 'a skipped import must run on the next connection rather than being remembered as failed');
		assert.ok(importedTableNames().includes('SITE.WORKLOG'), 'and its tables reach the tree');
	});

	// What the last session closing does. The rows go because the database may have changed by the next
	// connection; the definitions stay, because a table whose import definition was dropped would lose
	// its imported columns permanently instead of loading them again.
	test('dropping a host\'s cache re-runs its sections next time, without forgetting the imports themselves', async () => {
		let key = open('test://import-host-cache');
		await saveAndLink(savedImport('host-cache-import', { columns: { sql: COLUMNS_SQL, mapping: { ...COLUMNS_MAPPING } } }));

		let recorder = TestSupport.recordStatements({
			database: TestSupport.DATABASE,
			responses: [
				{ match: TABLES_PATTERN, rows: TABLE_ROWS },
				{ match: COLUMNS_PATTERN, rows: [{ SCHEMA_NAME: 'SITE', TABLE_NAME: 'WORKORDER', COLUMN_NAME: 'WONUM', DESCRIPTION: 'Work order number' }] }
			]
		});

		let targets = [{ schema: 'SITE', table: 'WORKORDER' }];

		await extension.sqlSchemaImports.ensureLoaded({ key: key, configId: TestSupport.CONFIG_ID });
		await extension.sqlSchemaImports.getTableFragments({ key: key, configId: TestSupport.CONFIG_ID }, targets);

		extension.sqlSchemaImports.deleteHostCache(TestSupport.CONNECTION.host);
		recorder.clear();

		// The import is still registered, so its column statement runs again rather than the table coming
		// back with nothing.
		let fragments = await extension.sqlSchemaImports.getTableFragments({ key: key, configId: TestSupport.CONFIG_ID }, targets);

		assert.strictEqual(recorder.matching(COLUMNS_PATTERN).length, 1);
		assert.deepStrictEqual(fragments.get('SITE.WORKORDER')?.[0]?.columns.map(column => column.name), ['WONUM']);

		// ...and the Tables statement runs again on the next connect, since the guard went with the rows.
		recorder.clear();
		await extension.sqlSchemaImports.ensureLoaded({ key: key, configId: TestSupport.CONFIG_ID });
		assert.strictEqual(recorder.matching(TABLES_PATTERN).length, 1);
	});
});
