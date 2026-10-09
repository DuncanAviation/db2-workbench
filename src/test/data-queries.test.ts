import * as assert from 'assert';
import { DataQueries } from '../database/queries/data-queries.js';
import { extension } from '../extension.js';
import { SystemColumn } from '../models/system-column.js';
import { RowEditUtils } from '../utils/row-edit-utils.js';
import { TestSupport } from './test-support.js';

/**
 * DataQueries - the schema browser Data tab's reads and its row edits - against the fake driver.
 *
 * This is the one layer in the extension that writes to a user's tables, and the only one where a
 * wrong statement is destructive rather than merely wrong on screen. Two different things are
 * asserted here, deliberately:
 *
 * - the generated statement text, exactly, for the parts a fixture cannot judge: the delimited
 *   identifiers, the LENGTH(...) placeholder for a LOB column, the RRN(...) fallback key, the
 *   ORDER BY written as select-list positions, and where the Edit Search WHERE body is spliced in;
 * - the effect of a row edit, by running the statement RowEditUtils generates and reading the table
 *   back, so an UPDATE or DELETE that matched more rows than intended is visible as a wrong table
 *   rather than as a passing test.
 *
 * What this tier still does not prove: that any of this SQL is valid DB2. FakeDml understands the
 * exact shape RowEditUtils emits and FakeDriver ignores WHERE and ORDER BY on a select (see both
 * files), so a clause that a real system would reject - or would honour differently - passes here.
 * Verifying a real edit against a live connection is still a manual step.
 */
suite('DataQueries against the fake driver', () => {
	const CUSTOMER = /from "sales"\."customer"/;
	const ORDNOTE = /from "sales"\."ordnote"/;

	let openKeys: string[] = [];

	suiteSetup(async () => {
		await TestSupport.activate();

		// Cleared on the way in as well as on the way out. The cache is scoped to the connection
		// config, which every suite in this run shares, and a table cached as "no columns" is a hit -
		// so a suite that ran earlier decides what the columns here are, and listTableData returns an
		// empty page without querying anything when it decides they are none.
		await clearCache();
	});

	teardown(async () => {
		await TestSupport.closeSessions(...openKeys);
		await clearCache();
		openKeys = [];
		TestSupport.restoreDriver();
	});

	function clearCache(): Promise<void> {
		return extension.memoryCache.deleteConnectionCache({ key: 'test://data-cache', configId: TestSupport.CONFIG_ID });
	}

	/**
	 * Opens the session and returns the table's columns the way SchemasProvider.postTableData does -
	 * out of the cache rather than hand-built, so the SELECT list under test is built from the same
	 * SystemColumns the real caller passes.
	 *
	 * The driver has to be installed before this runs: a ConnectionWrapper keeps the driver instance
	 * its connection was opened with, so the rows a later statement writes to and the rows this one
	 * reads are only the same fixture copy when one driver served both.
	 */
	async function openTable(key: string, table: string): Promise<SystemColumn[]> {
		openKeys.push(key);
		await extension.connections.getConnectionInfo({ key: key, configId: TestSupport.CONFIG_ID });
		return extension.memoryCache.getColumns({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: table } });
	}

	function listTableData(key: string, options: Partial<DataQueries.ListTableDataOptions> & { table: string; columns: SystemColumn[] }): Promise<DataQueries.ListTableDataResult> {
		return extension.dataQueries.listTableData({
			key: key,
			configId: TestSupport.CONFIG_ID,
			schema: 'SALES',
			primaryKeyColumns: [],
			offset: 0,
			limit: 10,
			...options
		});
	}

	test('a keyed table is read by delimited name, ordered by its key position and paged', async () => {
		let key = 'test://data-keyed';
		let recorder = TestSupport.recordStatements();
		let columns = await openTable(key, 'CUSTOMER');
		recorder.clear();

		let result = await listTableData(key, { table: 'CUSTOMER', columns: columns, primaryKeyColumns: ['CUSTNO'], limit: 2 });

		assert.strictEqual(
			recorder.matching(CUSTOMER)[0]?.sql,
			'select "CUSTNO", "CUSTNM", "ACTIVE" from "SALES"."CUSTOMER" order by 1 asc offset 0 rows fetch first 2 rows only'
		);

		// hasMore is "the page came back full", which is what the Data tab's Load More turns on.
		assert.strictEqual(result.rows.length, 2);
		assert.strictEqual(result.hasMore, true);
		assert.deepStrictEqual(result.keyColumns, [{ systemName: 'CUSTNO', isRrn: false }]);

		let lastPage = await listTableData(key, { table: 'CUSTOMER', columns: columns, primaryKeyColumns: ['CUSTNO'], offset: 2, limit: 2 });
		assert.strictEqual(lastPage.rows.length, 1);
		assert.strictEqual(lastPage.hasMore, false);
	});

	// The fallback path: no primary key, so there is nothing to key a row edit by until RRN() supplies
	// one, and a LOB column whose value must not be dragged across the wire to draw a grid cell.
	test('a keyless table falls back to RRN, and a LOB column is read as its length', async () => {
		let key = 'test://data-keyless';
		let recorder = TestSupport.recordStatements();
		let columns = await openTable(key, 'ORDNOTE');
		recorder.clear();

		let result = await listTableData(key, { table: 'ORDNOTE', columns: columns });

		assert.strictEqual(
			recorder.matching(ORDNOTE)[0]?.sql,
			'select "ORDNO", length("NOTETX") as "NOTETX", "NOTEBY", RRN("ORDNOTE") as "$RRN" from "SALES"."ORDNOTE" order by 4 asc offset 0 rows fetch first 10 rows only'
		);

		assert.deepStrictEqual(result.keyColumns, [{ systemName: '$RRN', isRrn: true }]);
		assert.deepStrictEqual(result.rows.map(row => row['$RRN']), [1, 2, 3]);
	});

	test('an explicit sort replaces the key order, and the search clause is spliced in as written', async () => {
		let key = 'test://data-sorted';
		let recorder = TestSupport.recordStatements();
		let columns = await openTable(key, 'CUSTOMER');
		recorder.clear();

		await listTableData(key, {
			table: 'CUSTOMER',
			columns: columns,
			primaryKeyColumns: ['CUSTNO'],
			orderBy: [{ systemName: 'CUSTNM', direction: 'desc' }],
			where: '"ACTIVE" = \'Y\''
		});

		// The sort is written as a select-list position (CUSTNM is second), not as a name - and the
		// primary key's own "order by 1 asc" is gone rather than still leading it.
		assert.strictEqual(
			recorder.matching(CUSTOMER)[0]?.sql,
			'select "CUSTNO", "CUSTNM", "ACTIVE" from "SALES"."CUSTOMER" where "ACTIVE" = \'Y\' order by 2 desc offset 0 rows fetch first 10 rows only'
		);
	});

	// internalQuery reports a failing statement by firing an ERROR event and returning nothing, so
	// without listTableData's own onError an invalid Edit Search clause would reach the Data tab as an
	// empty page - "no matching rows" rather than "your WHERE clause is wrong".
	test('a failing read reports the driver error instead of an empty page', async () => {
		let key = 'test://data-error';
		TestSupport.useDriver({
			database: TestSupport.DATABASE,
			responses: [{
				match: /"SALES"\."CUSTOMER"/i,
				error: { message: 'Token NOTACOLUMN was not valid.', driverErrors: [{ code: -104, state: '42601', message: 'Token NOTACOLUMN was not valid.' }] }
			}]
		});

		let columns = await openTable(key, 'CUSTOMER');
		let result = await listTableData(key, { table: 'CUSTOMER', columns: columns, where: '"NOTACOLUMN" = 1' });

		assert.match(result.error?.message ?? '', /not valid/);
		assert.deepStrictEqual(result.error?.driverErrors?.[0]?.state, '42601');
		assert.deepStrictEqual(result.rows, []);
		assert.strictEqual(result.hasMore, false);
	});

	// The round trip the Data tab's edit mode actually performs: the webview builds the statements
	// with RowEditUtils, the host runs them in order, and the grid is then re-read. Asserting on the
	// re-read is the point - a statement whose WHERE matched three rows instead of one produces
	// exactly the same executedCount as a correct one.
	test('insert, update and delete run in order and change only the rows they key', async () => {
		let key = 'test://data-edit';
		let columns = await openTable(key, 'CUSTOMER');

		let statements = [
			RowEditUtils.buildInsertSql('SALES', 'CUSTOMER', [
				{ systemName: 'CUSTNO', dataType: 'INTEGER', value: '4' },
				{ systemName: 'CUSTNM', dataType: 'VARCHAR', value: 'O\'Brien Air' },
				{ systemName: 'ACTIVE', dataType: 'CHAR', value: 'Y' }
			]),
			RowEditUtils.buildUpdateSql('SALES', 'CUSTOMER', [{ systemName: 'CUSTNM', dataType: 'VARCHAR', value: 'Renamed Air' }], [{ systemName: 'CUSTNO', dataType: 'INTEGER', value: '2', isRrn: false }]),
			RowEditUtils.buildDeleteSql('SALES', 'CUSTOMER', [{ systemName: 'CUSTNO', dataType: 'INTEGER', value: '3', isRrn: false }])
		];

		let progress: string[] = [];
		let result = await extension.dataQueries.executeStatements({
			key: key,
			configId: TestSupport.CONFIG_ID,
			statements: statements,
			onProgress: (index, status) => progress.push(`${index}:${status}`)
		});

		assert.strictEqual(result.failed, false);
		assert.strictEqual(result.executedCount, 3);
		assert.deepStrictEqual(progress, ['0:running', '0:success', '1:running', '1:success', '2:running', '2:success']);

		let rows = (await listTableData(key, { table: 'CUSTOMER', columns: columns, primaryKeyColumns: ['CUSTNO'] })).rows;

		assert.deepStrictEqual(rows.map(row => row['CUSTNO']), [1, 2, 4], 'only the deleted row is gone, and the inserted one is there');
		assert.deepStrictEqual(rows.map(row => row['CUSTNM']), ['Prairie Air', 'Renamed Air', 'O\'Brien Air'], 'only the keyed row is renamed');
	});

	// Stopping matters more than reporting here: the statements after a failure are the rest of the
	// user's pending edits, and running them against a table the failed one left half-edited is how a
	// batch ends up partly applied.
	test('a failing statement stops the batch, and the statements after it never run', async () => {
		let key = 'test://data-edit-failure';
		let recorder = TestSupport.recordStatements({
			database: TestSupport.DATABASE,
			responses: [{
				match: /^update /i,
				error: { message: 'Row change not allowed.', driverErrors: [{ code: -7008, state: '55019', message: 'CUSTOMER in SALES not valid for operation.' }] }
			}]
		});

		await openTable(key, 'CUSTOMER');
		recorder.clear();

		let progress: string[] = [];
		let result = await extension.dataQueries.executeStatements({
			key: key,
			configId: TestSupport.CONFIG_ID,
			statements: [
				'INSERT INTO "SALES"."CUSTOMER" ("CUSTNO") VALUES (5)',
				'UPDATE "SALES"."CUSTOMER" SET "CUSTNM" = \'Blocked\' WHERE "CUSTNO" = 1',
				'DELETE FROM "SALES"."CUSTOMER" WHERE "CUSTNO" = 1'
			],
			onProgress: (index, status) => progress.push(`${index}:${status}`)
		});

		assert.strictEqual(result.failed, true);
		assert.strictEqual(result.executedCount, 1, 'executedCount is the index of the statement that failed');
		assert.match(result.error?.message ?? '', /not allowed/);
		assert.deepStrictEqual(result.error?.driverErrors?.[0]?.state, '55019');
		assert.deepStrictEqual(progress, ['0:running', '0:success', '1:running', '1:error']);
		assert.deepStrictEqual(recorder.matching(/^delete /), [], 'the statement after the failure must never reach the database');
	});

	// The destructive case the RRN fallback exists for: with no key column to name, the only thing
	// separating "delete this note" from "delete every note" is that RRN predicate.
	test('an RRN-keyed delete removes exactly the row it names', async () => {
		let key = 'test://data-edit-rrn';
		let columns = await openTable(key, 'ORDNOTE');

		let before = await listTableData(key, { table: 'ORDNOTE', columns: columns });
		let target = before.rows[1];

		let result = await extension.dataQueries.executeStatements({
			key: key,
			configId: TestSupport.CONFIG_ID,
			statements: [RowEditUtils.buildDeleteSql('SALES', 'ORDNOTE', [{ systemName: '$RRN', value: String(target['$RRN']), isRrn: true }])]
		});

		assert.strictEqual(result.failed, false);

		let after = await listTableData(key, { table: 'ORDNOTE', columns: columns });

		assert.deepStrictEqual(after.rows.map(row => row['ORDNO']), [1000, 1002]);

		// The surviving rows keep the RRNs they had. A fake that renumbered them would hide the bug
		// where a second delete, issued from a grid that was not re-read, removes the wrong row.
		assert.deepStrictEqual(after.rows.map(row => row['$RRN']), [1, 3]);
	});

	// A view is paged read-only: RRN() of a join view is an error on a real system (and in FakeDriver),
	// so no fallback key is selected, and the default order is the first column.
	test('a view is read without an RRN key, ordered by its first column', async () => {
		let key = 'test://data-view';
		let recorder = TestSupport.recordStatements();
		let columns = await openTable(key, 'CUSTORD');
		recorder.clear();

		let result = await listTableData(key, { table: 'CUSTORD', columns: columns, readOnly: true });

		assert.strictEqual(
			recorder.matching(/from "sales"\."custord"/)[0]?.sql,
			'select "ORDNO", "CUSTNM" from "SALES"."CUSTORD" order by 1 asc offset 0 rows fetch first 10 rows only'
		);

		assert.strictEqual(result.error, undefined);
		assert.deepStrictEqual(result.keyColumns, []);
		assert.deepStrictEqual(result.rows.map(row => row['CUSTNM']), ['Prairie Air', 'Example Air']);
	});

});
