import * as assert from 'assert';
import { extension } from '../extension.js';
import { TestSupport } from './test-support.js';

/**
 * A logical file's detail (QSYS2.SYSFILES) and the DDS member it records, against the fake driver. As with
 * the other catalog tests, this proves the flow and the fixture's reading of the statement, not that SYSFILES
 * accepts this exact SQL live - its column names were taken from a live system's SYSFILES row.
 */
suite('Logical files against the fake driver', () => {
	// A fresh key per test: a closed key stays closed (see DbConnections.closedKeys), and teardown closes it.
	let sequence = 0;
	let options = { key: '', configId: TestSupport.CONFIG_ID };

	setup(() => {
		options = { key: `test://logical-files-${++sequence}`, configId: TestSupport.CONFIG_ID };
	});

	suiteSetup(async () => {
		await TestSupport.activate();
	});

	teardown(async () => {
		await TestSupport.closeSessions(options.key);
	});

	test('a logical file\'s SYSFILES row gives its based-on file and access path', async () => {
		let file = await extension.catalogQueries.getLogicalFile({ ...options, schema: 'sales', file: 'ordersl1' });

		assert.deepStrictEqual(file, {
			schema: 'SALES',
			name: 'ORDERSL1',
			text: 'Orders by customer',
			owner: 'QPGMR',
			alteredTimestamp: '2026-01-01 08:00:00',
			basedOn: [{ library: 'SALES', file: 'ORDERS', member: 'ORDERS', format: 'ORDERSL1R' }],
			accessPathType: 'KEYED',
			keyFieldCount: 1,
			keyFields: 'CUSTNO',
			maintenance: '*IMMED',
			selectOmit: true,
			joinLogical: false,
			dynamicSelection: false,
			formatName: 'ORDERSL1R'
		});
	});

	test('the key fields are looked up over the based-on file, never by index name alone', async () => {
		let recorder = TestSupport.recordStatements();

		await extension.catalogQueries.getLogicalFile({ ...options, schema: 'SALES', file: 'ORDERSL1' });

		let lookups = recorder.matching(/syspartitionindexstat/);
		assert.strictEqual(lookups.length, 1);
		assert.match(lookups[0].normalized, /where table_schema = \? and table_name = \?/);
	});

	// The Info and Columns tabs both ask for it, so the second ask must not reach the database.
	test('the detail is cached per file, and forceRefresh looks it up again', async () => {
		let recorder = TestSupport.recordStatements();
		let target = { ...options, schema: 'SALES', file: 'ORDERSL1' };

		let first = await extension.memoryCache.getLogicalFile(target);
		let second = await extension.memoryCache.getLogicalFile(target);
		assert.deepStrictEqual(second, first);
		assert.strictEqual(recorder.matching(/qsys2\.sysfiles/).length, 1);

		await extension.memoryCache.getLogicalFile({ ...target, forceRefresh: true });
		assert.strictEqual(recorder.matching(/qsys2\.sysfiles/).length, 2);
	});

	test('a file SYSFILES has no row for is undefined, not an error', async () => {
		assert.strictEqual(await extension.catalogQueries.getLogicalFile({ ...options, schema: 'SALES', file: 'NOFILE' }), undefined);
	});

	// Live, SYSFILES' SRCLIB/SRCFILE/SRCMBR were blank for a DDS logical file whose object description
	// named its member, so the source location comes from OBJECT_STATISTICS.
	test('the source member comes from the object description, and reads like a program source member', async () => {
		let recorded = await extension.catalogQueries.getFileSource({ ...options, schema: 'sales', file: 'ordersl1' });
		assert.deepStrictEqual(recorded, { found: true, source: { library: 'SALES', file: 'QDDSSRC', member: 'ORDERSL1' } });
		assert.ok(recorded.source != null);

		let [source] = await extension.programQueries.readSources(options, [recorded.source], { programLibrary: 'SALES' });

		assert.strictEqual(source.text, '     A          R ORDERSL1R                 PFILE(ORDERS)\n     A          K CUSTNO');
		assert.strictEqual(source.unavailable, undefined);
	});

	test('a file with no recorded member, and a file that does not exist, are told apart', async () => {
		assert.deepStrictEqual(await extension.catalogQueries.getFileSource({ ...options, schema: 'SALES', file: 'CUSTORD' }), { found: true, source: undefined });
		assert.deepStrictEqual(await extension.catalogQueries.getFileSource({ ...options, schema: 'SALES', file: 'NOFILE' }), { found: false });
	});
});
