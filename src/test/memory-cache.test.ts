import * as assert from 'assert';
import { defineFakeDatabase } from '../database/drivers/fake/fake-database.js';
import { RoutineQueries } from '../database/queries/routine-queries.js';
import { DbConnectionEvent } from '../events/db-connection-event.js';
import { extension } from '../extension.js';
import { SystemTable } from '../models/system-table.js';
import { TestSupport } from './test-support.js';

/**
 * MemoryCache and the catalog query layer underneath it, against the fake driver.
 *
 * What these tests cover: how rows are grouped and attributed back to the table that asked for them,
 * and when the cache decides it already has an answer. Both are invisible when they regress - the
 * wrong metadata still renders, it just describes the wrong table, or describes a table as it was
 * before the user changed it.
 *
 * What they do NOT cover, and what no test at this tier can: whether the SQL is valid DB2.
 * CatalogResponder is fixture code written by reading the very queries it answers, so it recognizes a
 * statement by which catalog it names and which tables its predicate binds - it never checks that the
 * SELECT list, the joins or the column names would survive contact with a real system. A misspelled
 * column in one of these catalog queries passes here and fails on a live connection. Live
 * verification of the query text is still owed; these tests do not retire it.
 */
suite('MemoryCache against the fake driver', () => {
	const COLUMNS = /syscolumns2/;
	const KEYS = /syscst a join qsys2\.syskeycst/;
	const FOREIGN_KEYS = /sysrefcst/;
	const ADVICE = /sysixadv/;

	suiteSetup(async () => {
		await TestSupport.activate();
	});

	teardown(async () => {
		// The cache is scoped to the connection config, which every test here shares, so a test that
		// left entries behind would hand the next one a cache hit it never asked for.
		await extension.memoryCache.deleteConnectionCache({ key: 'test://teardown', configId: TestSupport.CONFIG_ID });
		TestSupport.restoreDriver();
	});

	/** Opens the session and drops the connection-time catalog lookups, so a count starts from zero. */
	async function openSession(key: string, recorder: TestSupport.StatementRecorder): Promise<void> {
		await extension.connections.getConnectionInfo({ key: key, configId: TestSupport.CONFIG_ID });
		recorder.clear();
	}

	// The highest-value test in this file. listForeignKeys joins SYSCST to SYSREFCST to SYSKEYCST and
	// then back into SYSCST/SYSKEYCST a second time (aliases d and e) to resolve what the key points
	// at, pairing the two halves by ordinal position - and that chain has never been verified against a
	// live connection. The fixture's SHIPMENT -> ORDERS key is deliberately two columns wide,
	// references a unique rather than a primary key, and shares no column name between its two sides,
	// so a mapper that crossed the sides over or lost the ordinal pairing cannot produce these rows.
	test('a multi-column foreign key keeps its owning and referenced sides apart, paired by ordinal position', async () => {
		let key = 'test://cache-foreign-keys';

		try {
			let foreignKeys = await extension.memoryCache.getForeignKeys({
				key: key,
				configId: TestSupport.CONFIG_ID,
				tables: { schema: 'SALES', table: 'SHIPMENT' }
			});

			let ordered = [...foreignKeys].sort((first, second) => first.ordinalPosition - second.ordinalPosition);

			assert.deepStrictEqual(ordered.map(foreignKey => ({
				schema: foreignKey.schema,
				tableName: foreignKey.tableName,
				constraintName: foreignKey.constraintName,
				columnName: foreignKey.columnName,
				systemColumnName: foreignKey.systemColumnName,
				ordinalPosition: foreignKey.ordinalPosition,
				referencedSchema: foreignKey.referencedSchema,
				referencedTable: foreignKey.referencedTable,
				referencedColumnName: foreignKey.referencedColumnName,
				referencedSystemColumnName: foreignKey.referencedSystemColumnName
			})), [
				{
					schema: 'SALES', tableName: 'SHIPMENT', constraintName: 'SHIPMENT_ORDERS_FK',
					columnName: 'SHIPMENT_CUSTOMER', systemColumnName: 'SHPCUS', ordinalPosition: 1,
					referencedSchema: 'SALES', referencedTable: 'ORDERS',
					referencedColumnName: 'CUSTOMER_NUMBER', referencedSystemColumnName: 'CUSTNO'
				},
				{
					schema: 'SALES', tableName: 'SHIPMENT', constraintName: 'SHIPMENT_ORDERS_FK',
					columnName: 'SHIPMENT_ORDER_DATE', systemColumnName: 'SHPDT', ordinalPosition: 2,
					referencedSchema: 'SALES', referencedTable: 'ORDERS',
					referencedColumnName: 'ORDER_DATE', referencedSystemColumnName: 'ORDDT'
				}
			]);

			// The rules come from SYSREFCST rather than either SYSCST row, so they're worth pinning too.
			assert.deepStrictEqual(ordered.map(foreignKey => [foreignKey.updateRule, foreignKey.deleteRule]), [['RESTRICT', 'CASCADE'], ['RESTRICT', 'CASCADE']]);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// A foreign key belongs to the table that declares it, not to the one it points at. ORDERS declares
	// a key into CUSTOMER and is itself referenced by SHIPMENT: asking CUSTOMER must return nothing,
	// and asking ORDERS must return only its own outgoing key - which is what the diagram's
	// relationship lines and the Foreign Keys tab both assume.
	test('a foreign key is attributed to the table that declares it, not the one it references', async () => {
		let key = 'test://cache-foreign-key-direction';

		try {
			let owning = await extension.memoryCache.getForeignKeys({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } });

			assert.deepStrictEqual(owning.map(foreignKey => [foreignKey.tableName, foreignKey.constraintName, foreignKey.referencedTable]), [['ORDERS', 'ORDERS_CUSTOMER_FK', 'CUSTOMER']]);

			let referenced = await extension.memoryCache.getForeignKeys({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'CUSTOMER' } });
			assert.deepStrictEqual(referenced, [], 'CUSTOMER declares no foreign key of its own - it is only referenced by one');
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	test('several tables are fetched in one statement, and each row is grouped by its own table', async () => {
		let key = 'test://cache-batching';
		let recorder = TestSupport.recordStatements();

		try {
			await openSession(key, recorder);

			let columns = await extension.memoryCache.getColumns({
				key: key,
				configId: TestSupport.CONFIG_ID,
				tables: [{ schema: 'SALES', table: 'CUSTOMER' }, { schema: 'SALES', table: 'ORDERS' }, { schema: 'SALES', table: 'SHIPMENT' }]
			});

			// The point of the batch: three tables, one statement. One statement per table would still
			// return exactly these rows, which is why this has to be asserted on the driver rather than
			// on the result.
			assert.strictEqual(recorder.matching(COLUMNS).length, 1, `expected one SYSCOLUMNS2 statement for three tables, saw ${recorder.matching(COLUMNS).length}`);

			let byTable = new Map<string, string[]>();

			for(let column of columns) {
				byTable.set(column.tableName, [...(byTable.get(column.tableName) ?? []), column.systemName]);
			}

			assert.deepStrictEqual(byTable.get('CUSTOMER'), ['CUSTNO', 'CUSTNM', 'ACTIVE']);
			assert.deepStrictEqual(byTable.get('ORDERS'), ['ORDNO', 'CUSTNO', 'ORDDT', 'ORDAMT']);
			assert.deepStrictEqual(byTable.get('SHIPMENT'), ['SHPNO', 'SHPCUS', 'SHPDT', 'SHPCAR']);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	test('only the tables missing from cache reach the query, and the cached ones still come back', async () => {
		let key = 'test://cache-partial-batch';
		let recorder = TestSupport.recordStatements();

		try {
			await openSession(key, recorder);

			await extension.memoryCache.getColumns({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } });
			recorder.clear();

			let columns = await extension.memoryCache.getColumns({
				key: key,
				configId: TestSupport.CONFIG_ID,
				tables: [{ schema: 'SALES', table: 'ORDERS' }, { schema: 'SALES', table: 'CUSTOMER' }]
			});

			let statements = recorder.matching(COLUMNS);
			assert.strictEqual(statements.length, 1);

			// ORDERS is already cached, so it must not be in the predicate - otherwise a session that has
			// looked at one table pays for it again every time it asks about a set containing it.
			assert.deepStrictEqual(statements[0].parameters.map(parameter => String(parameter)), ['SALES', 'CUSTOMER']);

			// ...and the cached table's rows still come back in the same call, not just the fetched one's.
			assert.deepStrictEqual(new Set(columns.map(column => column.tableName)), new Set(['ORDERS', 'CUSTOMER']));
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// An empty array is not null, which is what makes "this table has no rows" a cache hit
	// rather than a miss. Worth pinning: a table with no keys, no indexes or no advice is the common
	// case, so getting this wrong would re-query most tables on every single request while looking
	// completely correct from the outside.
	test('a table cached as "no rows" is a hit, not a miss', async () => {
		let key = 'test://cache-empty-hit';
		let recorder = TestSupport.recordStatements();

		try {
			await openSession(key, recorder);

			// ARCHIVE.ORDERS2024 declares no keys at all.
			let first = await extension.memoryCache.getTableKeys({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'ARCHIVE', table: 'ORDERS2024' } });
			assert.deepStrictEqual(first, []);
			assert.strictEqual(recorder.matching(KEYS).length, 1, 'the first request has to actually query');

			recorder.clear();

			let second = await extension.memoryCache.getTableKeys({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'ARCHIVE', table: 'ORDERS2024' } });
			assert.deepStrictEqual(second, []);
			assert.strictEqual(recorder.matching(KEYS).length, 0, 'an empty result must be cached, not re-queried');
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// The other half of the test above. A failed lookup and an empty one look the same to the caller -
	// both come back as [] - but only the empty one may be remembered: caching a failure is what used to
	// leave a table with "no columns" (no autocomplete, an empty Data tab that never even queried) for
	// the life of the connection after one transient error. The statement is rigged to fail exactly
	// once, so the second request can only succeed if it actually reaches the driver again.
	test('a failed lookup comes back empty, is not cached, and the next request queries again', async () => {
		let key = 'test://cache-failure-not-cached';
		let failuresLeft = 1;
		let recorder = TestSupport.recordStatements({
			database: TestSupport.DATABASE,
			responses: [{
				match: sql => COLUMNS.test(sql.toLowerCase()) && failuresLeft-- > 0,
				error: { message: 'SYSCOLUMNS2 lookup rigged to fail once.' }
			}]
		});
		let events = TestSupport.recordEvents(key);

		try {
			await openSession(key, recorder);

			// The decision for callers, written down: a failed lookup resolves to [] rather than rejecting.
			// Autocomplete, heading labels and the schema browser all render an empty list as "nothing to
			// show", and the failure has already reached the user as the ERROR event asserted below.
			let failed = await extension.memoryCache.getColumns({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } });
			assert.deepStrictEqual(failed, []);
			assert.strictEqual(recorder.matching(COLUMNS).length, 1);

			let errors = events.ofType(DbConnectionEvent.EventType.ERROR);
			assert.strictEqual(errors.length, 1, 'the failure is reported once, through the ERROR event');
			assert.strictEqual(errors[0].isInternal, true);

			recorder.clear();

			let retried = await extension.memoryCache.getColumns({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } });
			assert.strictEqual(recorder.matching(COLUMNS).length, 1, 'a failed lookup must not be cached - the next request has to query again');
			assert.deepStrictEqual(retried.map(column => column.systemName), ['ORDNO', 'CUSTNO', 'ORDDT', 'ORDAMT']);

			// ...and the successful answer is what gets cached.
			recorder.clear();
			await extension.memoryCache.getColumns({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } });
			assert.strictEqual(recorder.matching(COLUMNS).length, 0);
		} finally {
			events.stop();
			await TestSupport.closeSessions(key);
		}
	});

	// Work that was already running when its session closed - a results render labelling its headings,
	// the connection-time warm-up - used to reopen the connection just by asking for it, and nothing ever
	// closed it again: two leaked IBM i jobs, and a config whose cache could no longer be dropped. A closed
	// key now stays closed until a user action allows it again.
	test('a lookup for a closed session returns nothing and does not reopen it, until the session is allowed to connect again', async () => {
		let key = 'test://cache-closed-session';
		let recorder = TestSupport.recordStatements();

		try {
			await openSession(key, recorder);
			await TestSupport.closeSessions(key);
			recorder.clear();

			let columns = await extension.memoryCache.getColumns({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } });

			assert.deepStrictEqual(columns, []);
			assert.strictEqual(extension.connections.hasActiveConnection(key), false, 'the closed session must stay closed');
			assert.strictEqual(recorder.matching(COLUMNS).length, 0, 'the lookup must not reach the driver for a session that is not open');

			// What a user action does (running SQL, opening the schema browser, choosing Connect): the same
			// key connects again, and the lookup that was refused a moment ago now queries - the refusal was
			// not cached as "no columns".
			extension.connections.allowConnect(key);

			let reopened = await extension.memoryCache.getColumns({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } });

			assert.strictEqual(extension.connections.hasActiveConnection(key), true);
			assert.strictEqual(recorder.matching(COLUMNS).length, 1);
			assert.deepStrictEqual(reopened.map(column => column.systemName), ['ORDNO', 'CUSTNO', 'ORDDT', 'ORDAMT']);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// SHIPMENT has no advised indexes in the fixture, so "empty" is the right answer here, not a
	// failure - and it must stay a cache hit now that a failure no longer is one.
	test('a lookup that legitimately returns no rows is still cached', async () => {
		let key = 'test://cache-empty-advice-hit';
		let recorder = TestSupport.recordStatements();

		try {
			await openSession(key, recorder);

			let first = await extension.memoryCache.getIndexAdvice({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'SHIPMENT' } });
			assert.deepStrictEqual(first, []);
			assert.strictEqual(recorder.matching(ADVICE).length, 1, 'the first request has to actually query');

			recorder.clear();

			let second = await extension.memoryCache.getIndexAdvice({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'SHIPMENT' } });
			assert.deepStrictEqual(second, []);
			assert.strictEqual(recorder.matching(ADVICE).length, 0, 'an empty answer must be cached, not re-queried');
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// A batched statement interleaves every table's rows, so nothing about the order they arrive in
	// says which table they belong to. This pins a canned response that returns them in the opposite
	// order from the request, plus a row for a table nobody asked about, and then reads the per-table
	// cache slots back - the one place the attribution is observable.
	test('rows are attributed by their own schema/table columns, not by the order the request named them', async () => {
		let key = 'test://cache-attribution';
		let recorder = TestSupport.recordStatements({
			database: TestSupport.DATABASE,
			responses: [{
				match: COLUMNS,
				rows: [
					{ DBNAME: 'SALES', TBNAME: 'ORDERS', COLNO: 1, SYS_CNAME: 'ORDNO', NAME: 'ORDER_NUMBER', COLTYPE: 'INTEGER' },
					// A row for a table that was never requested - the responder would never produce one,
					// but a real batched statement with a predicate bug could.
					{ DBNAME: 'SALES', TBNAME: 'SHIPMENT', COLNO: 1, SYS_CNAME: 'SHPNO', NAME: 'SHIPMENT_NUMBER', COLTYPE: 'INTEGER' },
					{ DBNAME: 'SALES', TBNAME: 'CUSTOMER', COLNO: 1, SYS_CNAME: 'CUSTNO', NAME: 'CUSTOMER_NUMBER', COLTYPE: 'INTEGER' }
				]
			}]
		});

		try {
			await openSession(key, recorder);

			await extension.memoryCache.getColumns({
				key: key,
				configId: TestSupport.CONFIG_ID,
				tables: [{ schema: 'SALES', table: 'CUSTOMER' }, { schema: 'SALES', table: 'ORDERS' }]
			});

			recorder.clear();

			// Both are now cache hits, so what comes back is exactly what each table's own slot was filled
			// with. Attributing by request order would have put ORDNO under CUSTOMER and vice versa.
			let customer = await extension.memoryCache.getColumns({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'CUSTOMER' } });
			let orders = await extension.memoryCache.getColumns({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } });

			assert.strictEqual(recorder.matching(COLUMNS).length, 0, 'both tables were already cached by the batch');
			assert.deepStrictEqual(customer.map(column => column.systemName), ['CUSTNO']);
			assert.deepStrictEqual(orders.map(column => column.systemName), ['ORDNO']);

			// The unrequested table's row filled no slot, so asking for it is still a miss and re-queries.
			await extension.memoryCache.getColumns({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'SHIPMENT' } });
			assert.strictEqual(recorder.matching(COLUMNS).length, 1);

			// That call returns whatever the statement returned - here all three canned rows, since this
			// fixture's response answers every SYSCOLUMNS2 statement regardless of its predicate. A real
			// predicate only returns the tables it asked about, so the flat return is the batch's rows;
			// attribution is what decides which of them each table's slot keeps. Reading the slot back on
			// the next (cache-hit) request is where that is observable.
			recorder.clear();
			let shipment = await extension.memoryCache.getColumns({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'SHIPMENT' } });

			assert.strictEqual(recorder.matching(COLUMNS).length, 0);
			assert.deepStrictEqual(shipment.map(column => column.systemName), ['SHPNO']);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// A table named without a schema (what autocomplete produces) is pinned to a concrete schema before
	// being cached, so it lands in the same slot a schema-qualified request for the same table uses.
	// Without that, autocomplete and the schema browser would each keep their own copy of every table.
	test('a table named without a schema caches under the schema it resolves to', async () => {
		let key = 'test://cache-bare-name';
		let recorder = TestSupport.recordStatements();

		try {
			await openSession(key, recorder);

			let bare = await extension.memoryCache.getColumns({ key: key, configId: TestSupport.CONFIG_ID, tables: { table: 'ORDERS' } });
			assert.deepStrictEqual(bare.map(column => column.schema), ['SALES', 'SALES', 'SALES', 'SALES']);

			recorder.clear();

			let qualified = await extension.memoryCache.getColumns({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } });
			assert.strictEqual(recorder.matching(COLUMNS).length, 0, 'the qualified request must hit the slot the bare one filled');
			assert.deepStrictEqual(qualified.map(column => column.systemName), bare.map(column => column.systemName));
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// forceRefresh exists because SYSIXADV is live state: running generated CREATE INDEX DDL, or
	// discarding a row of advice, changes what the catalog says while the cached copy still describes
	// the old state. The response's row array is mutated in place to stand in for that.
	test('index advice is cached per table, and forceRefresh rechecks the live catalog', async () => {
		let key = 'test://cache-advice-refresh';
		let adviceRows = [{ ID: 1, TABLE_SCHEMA: 'SALES', TABLE_NAME: 'ORDERS', KEY_COLUMNS_ADVISED: 'ORDDT', INDEX_TYPE: 'RADIX', REASON_ADVISED: 'Ordering/Grouping', TIMES_ADVISED: 12, LAST_ADVISED: '2026-01-01 08:00:00.000000', NLSSNAME: '*HEX', NLSSDBNAME: '' }];
		let recorder = TestSupport.recordStatements({ database: TestSupport.DATABASE, responses: [{ match: ADVICE, rows: adviceRows }] });

		try {
			await openSession(key, recorder);

			let first = await extension.memoryCache.getIndexAdvice({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } });
			assert.deepStrictEqual(first.map(advice => advice.keyColumnsAdvised), ['ORDDT']);
			assert.strictEqual(recorder.matching(ADVICE).length, 1);

			recorder.clear();
			await extension.memoryCache.getIndexAdvice({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } });
			assert.strictEqual(recorder.matching(ADVICE).length, 0, 'a second plain request is served from cache');

			// The live catalog changes underneath the cache.
			adviceRows.push({ ...adviceRows[0], ID: 2, KEY_COLUMNS_ADVISED: 'CUSTNO, ORDDT', TIMES_ADVISED: 3 });

			let stale = await extension.memoryCache.getIndexAdvice({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } });
			assert.deepStrictEqual(stale.map(advice => advice.keyColumnsAdvised), ['ORDDT'], 'without forceRefresh the cached copy is still what is returned');

			let refreshed = await extension.memoryCache.getIndexAdvice({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' }, forceRefresh: true });
			assert.strictEqual(recorder.matching(ADVICE).length, 1, 'forceRefresh must reach the catalog');
			assert.deepStrictEqual(refreshed.map(advice => advice.keyColumnsAdvised), ['ORDDT', 'CUSTNO, ORDDT']);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// The cache belongs to the connection config, not to the session that happened to fill it, so
	// closing one of two SQL tabs on the same connection must not empty it underneath the other. The
	// last one out clears it.
	test('the connection cache is dropped only once the last session on that config closes', async () => {
		let firstKey = 'test://cache-lifetime-a';
		let secondKey = 'test://cache-lifetime-b';
		let thirdKey = 'test://cache-lifetime-c';
		let recorder = TestSupport.recordStatements();

		try {
			await openSession(firstKey, recorder);
			await openSession(secondKey, recorder);

			await extension.memoryCache.getColumns({ key: firstKey, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } });
			assert.strictEqual(recorder.matching(COLUMNS).length, 1);

			recorder.clear();
			await extension.memoryCache.getColumns({ key: secondKey, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } });
			assert.strictEqual(recorder.matching(COLUMNS).length, 0, 'the second session shares the first session\'s cache');

			await TestSupport.closeSessions(firstKey);

			recorder.clear();
			await extension.memoryCache.getColumns({ key: secondKey, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } });
			assert.strictEqual(recorder.matching(COLUMNS).length, 0, 'closing one of two sessions must not clear the shared cache');

			await TestSupport.closeSessions(secondKey);

			recorder.clear();
			await extension.memoryCache.getColumns({ key: thirdKey, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } });
			assert.strictEqual(recorder.matching(COLUMNS).length, 1, 'the last session out clears the cache, so a new one re-queries');
		} finally {
			await TestSupport.closeSessions(firstKey, secondKey, thirdKey);
		}
	});

	// Different catalogs, same caching path (loadTableEntities) - so a regression that only affected
	// one entity kind would still be caught. Keys and foreign keys both read SYSCST, which is also the
	// case most likely to collide on a shared cache key.
	test('each catalog keeps its own per-table cache slot', async () => {
		let key = 'test://cache-per-entity';
		let recorder = TestSupport.recordStatements();

		try {
			await openSession(key, recorder);

			let tableKeys = await extension.memoryCache.getTableKeys({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } });
			assert.deepStrictEqual(tableKeys.map(tableKey => [tableKey.constraintName, tableKey.systemColumnName]), [
				['ORDERS_PK', 'ORDNO'],
				['ORDERS_CUST_DATE_UK', 'CUSTNO'],
				['ORDERS_CUST_DATE_UK', 'ORDDT']
			]);

			// Caching ORDERS' keys must not be mistaken for caching ORDERS' foreign keys, even though both
			// requests name the same table and both statements read SYSCST.
			recorder.clear();
			let foreignKeys = await extension.memoryCache.getForeignKeys({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } });

			assert.strictEqual(recorder.matching(FOREIGN_KEYS).length, 1);
			assert.deepStrictEqual(foreignKeys.map(foreignKey => foreignKey.constraintName), ['ORDERS_CUSTOMER_FK']);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// Views are listed the way tables are: the library-list scan for the tree's eager load, and a batch by
	// name for everything else - so a view in a schema off the list is only found when asked for.
	test('views list from the library list, or by schema name, each schema cached on its own', async () => {
		let key = 'test://cache-views';
		let recorder = TestSupport.recordStatements();

		try {
			await openSession(key, recorder);

			let libraryViews = await extension.memoryCache.getViews({ key: key, configId: TestSupport.CONFIG_ID });
			assert.deepStrictEqual(libraryViews.map(view => `${view.schema}.${view.name}`), ['SALES.CUSTORD']);
			assert.strictEqual(libraryViews[0].description, 'Orders with customer names');

			let archiveViews = await extension.memoryCache.getViewsForSchemas({ key: key, configId: TestSupport.CONFIG_ID }, ['ARCHIVE']);
			assert.deepStrictEqual(archiveViews.map(view => view.name), ['ORDERS2024V']);

			let queried = recorder.matching(/sysviews/).length;
			await extension.memoryCache.getViewsForSchemas({ key: key, configId: TestSupport.CONFIG_ID }, ['ARCHIVE']);
			assert.strictEqual(recorder.matching(/sysviews/).length, queried, 'a schema already listed should be a cache hit');
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// Content assist offers what getRelations lists and loads columns for a bare name through
	// findSchemaForTable - a view has to survive both, or "select * from custord" gets no column completions.
	test('relations list tables and views, and a bare view name resolves to its columns', async () => {
		let key = 'test://cache-relations';
		let recorder = TestSupport.recordStatements();

		try {
			await openSession(key, recorder);

			let relations = await extension.memoryCache.getRelations({ key: key, configId: TestSupport.CONFIG_ID, schema: 'SALES' });
			assert.deepStrictEqual(relations.map(relation => `${relation.name}:${relation.kind}`), [
				'CUSTOMER:table', 'ORDERS:table', 'SHIPMENT:table', 'ORDNOTE:table', 'CUSTTOT:table', 'CUSTORD:view'
			]);

			let columns = await extension.memoryCache.getColumns({ key: key, configId: TestSupport.CONFIG_ID, tables: { table: 'CUSTORD' } });
			assert.deepStrictEqual(columns.map(column => `${column.schema}.${column.tableName}.${column.systemName}`), [
				'SALES.CUSTORD.ORDNO', 'SALES.CUSTORD.CUSTNM'
			]);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// A bare name resolves to the first schema on the library list holding it, as DB2 does under system
	// naming - not the alphabetically first. The test library sits ahead of production here, and
	// SYSSCHEMAS is answered in name order (as the real statement's ORDER BY returns it), so a ranking
	// taken from the schema catalog rather than the library list lands on APPL.
	test('a bare table name resolves to the first schema on the library list that has it', async () => {
		let key = 'test://cache-bare-name-order';
		let database = defineFakeDatabase({
			schemas: [
				{ name: 'APPLT', tables: [{ name: 'CUSTOMER', columns: [{ systemName: 'TESTCOL', dataType: 'CHAR', length: 10 }] }] },
				{ name: 'APPL', tables: [{ name: 'CUSTOMER', columns: [{ systemName: 'PRODCOL', dataType: 'CHAR', length: 10 }] }] }
			]
		});

		TestSupport.recordStatements({
			database: database,
			responses: [{
				match: /from qsys2\.sysschemas/i,
				rows: [
					{ SYS_NAME: 'APPL', LABEL: '', SCHEMA_TYPE: 'User' },
					{ SYS_NAME: 'APPLT', LABEL: '', SCHEMA_TYPE: 'User' }
				]
			}]
		});

		try {
			let columns = await extension.memoryCache.getColumns({ key: key, configId: TestSupport.CONFIG_ID, tables: { table: 'CUSTOMER' } });
			assert.deepStrictEqual(columns.map(column => `${column.schema}.${column.tableName}.${column.systemName}`), ['APPLT.CUSTOMER.TESTCOL']);

			// Content assist's options carry the connection's default table schema; that must not narrow
			// the candidates a bare name is resolved from.
			let fromAssist = await extension.memoryCache.getColumns(<Parameters<typeof extension.memoryCache.getColumns>[0]>{ key: key, configId: TestSupport.CONFIG_ID, schema: 'APPL', tables: { table: 'CUSTOMER' } });
			assert.deepStrictEqual(fromAssist.map(column => `${column.schema}.${column.tableName}.${column.systemName}`), ['APPLT.CUSTOMER.TESTCOL']);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// A MULTI trigger's events live in their own flag columns, and an external trigger has no body - both
	// are mapped rather than passed through, so both are pinned here. Deleting the cache is the Triggers
	// tab's Refresh.
	test('triggers are read per table, a MULTI trigger names its events, and a deleted cache re-queries', async () => {
		let key = 'test://cache-triggers';
		let recorder = TestSupport.recordStatements();

		try {
			await openSession(key, recorder);
			let options = { key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } };

			let triggers = await extension.memoryCache.getTriggers(options);
			assert.deepStrictEqual(triggers.map(trigger => [trigger.triggerName, trigger.event, trigger.timing, `${trigger.programLibrary}/${trigger.programName}`]), [
				['ORDERS_AUDIT_INSERT', 'INSERT', 'AFTER', 'SALES/ORDAUDIT'],
				['ORDERS_STAMP', 'INSERT, UPDATE', 'BEFORE', 'SALES/ORDERS_STAMP']
			]);
			assert.strictEqual(triggers[0].actionStatement, undefined, 'an external trigger has no body');
			assert.strictEqual(triggers[0].condition, undefined);
			assert.strictEqual(triggers[1].actionStatement, 'BEGIN\n\tSET N.ORDDT = CURRENT DATE;\nEND');
			assert.strictEqual(triggers[1].condition, 'N.ORDAMT > 0');
			assert.strictEqual(triggers[1].updateCondition, 'ALWAYS');

			await extension.memoryCache.getTriggers(options);
			assert.strictEqual(recorder.matching(/systriggers/).length, 1);

			await extension.memoryCache.deleteTriggersCache(options);
			await extension.memoryCache.getTriggers(options);
			assert.strictEqual(recorder.matching(/systriggers/).length, 2);

			let none = await extension.memoryCache.getTriggers({ ...options, tables: { schema: 'SALES', table: 'SHIPMENT' } });
			assert.deepStrictEqual(none, []);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	test('a view\'s definition is read on its own, cached, and re-read on a forced refresh', async () => {
		let key = 'test://cache-view-definition';
		let recorder = TestSupport.recordStatements();

		try {
			await openSession(key, recorder);
			let options = { key: key, configId: TestSupport.CONFIG_ID, schema: 'SALES', view: 'CUSTORD' };

			let definition = await extension.memoryCache.getViewDefinition(options);
			assert.strictEqual(definition, 'SELECT O.ORDNO, C.CUSTNM FROM SALES.ORDERS O JOIN SALES.CUSTOMER C ON C.CUSTNO = O.CUSTNO');

			await extension.memoryCache.getViewDefinition(options);
			assert.strictEqual(recorder.matching(/select text from qsys2\.sysviews/).length, 1);

			await extension.memoryCache.getViewDefinition({ ...options, forceRefresh: true });
			assert.strictEqual(recorder.matching(/select text from qsys2\.sysviews/).length, 2);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// MQTDEF is left out of the table list, so the Definition tab reads it the way a view's is read.
	test('a materialized query table\'s definition is read on its own, cached, and re-read on a forced refresh', async () => {
		let key = 'test://cache-mqt-definition';
		let recorder = TestSupport.recordStatements();

		try {
			await openSession(key, recorder);
			let options = { key: key, configId: TestSupport.CONFIG_ID, schema: 'SALES', table: 'CUSTTOT' };

			let definition = await extension.memoryCache.getMqtDefinition(options);
			assert.strictEqual(definition, 'SELECT CUSTNO, COUNT(*) AS ORDCNT FROM SALES.ORDERS GROUP BY CUSTNO');

			await extension.memoryCache.getMqtDefinition(options);
			assert.strictEqual(recorder.matching(/select mqtdef from qsys2\.systables/).length, 1);

			await extension.memoryCache.getMqtDefinition({ ...options, forceRefresh: true });
			assert.strictEqual(recorder.matching(/select mqtdef from qsys2\.systables/).length, 2);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// An MQT is listed as a table - so every per-table tab, content assist and View Table Details serve it -
	// and only its type tells the tree to show it under its own node.
	test('materialized query tables are listed with the tables, typed M', async () => {
		let key = 'test://cache-mqts';
		let recorder = TestSupport.recordStatements();

		try {
			await openSession(key, recorder);

			let tables = await extension.memoryCache.getTables({ key: key, configId: TestSupport.CONFIG_ID, schema: 'SALES' });
			let mqt = tables.find(table => table.name === 'CUSTTOT');
			assert.ok(mqt, 'CUSTTOT should be listed with the tables');
			assert.ok(SystemTable.isMqt(mqt));
			assert.strictEqual(mqt.maintain, 'USER');
			assert.ok(tables.filter(table => table.name !== 'CUSTTOT').every(table => !SystemTable.isMqt(table)));

			let relations = await extension.memoryCache.getRelations({ key: key, configId: TestSupport.CONFIG_ID });
			assert.ok(relations.some(relation => relation.schema === 'SALES' && relation.name === 'CUSTTOT' && relation.kind === 'table'));

			let columns = await extension.memoryCache.getColumns({ key: key, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'CUSTTOT' } });
			assert.deepStrictEqual(columns.map(column => column.systemName), ['CUSTNO', 'ORDCNT']);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// The tree carries views in a map of their own, so nothing that walks tablesBySchema meets one.
	test('the schema tree lists views beside tables, never among them', async () => {
		let key = 'test://cache-tree-views';

		try {
			let state = await extension.schemaTrees.buildTreeState({ key: key, configId: TestSupport.CONFIG_ID });

			assert.deepStrictEqual(state.viewsBySchema['SALES']?.map(view => view.name), ['CUSTORD']);
			assert.ok(!state.tablesBySchema['SALES'].some(entry => entry.connected?.name === 'CUSTORD'));
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// Procedures and functions come from one SYSROUTINES list, so asking for both costs one query - and
	// neither leaks into the other, which is what kept functions showing up after CALL.
	test('procedures and functions are two filters over one cached routine list', async () => {
		let key = 'test://cache-routines';
		let recorder = TestSupport.recordStatements();

		try {
			await openSession(key, recorder);
			let options = { key: key, configId: TestSupport.CONFIG_ID };

			let procedures = await extension.memoryCache.getProcedures(options);
			let functions = await extension.memoryCache.getFunctions(options);

			assert.deepStrictEqual(procedures.map(procedure => `${procedure.name}/${procedure.specificName}`), ['NEXT_ORDER_NUMBER/NEXT_ORDER_NUMBER', 'ORDER_TOTAL/ORDER_TOTAL_RECALC', 'ORDER_TOTAL/ORDER_TOTAL_RECALC1', 'ORDER_HISTORY/ORDER_HISTORY', 'ORDER_REPORT/ORDER_REPORT', 'ORDER_PURGE/ORDER_PURGE', 'ORDER_EXPORT/ORDER_EXPORT']);
			assert.deepStrictEqual(functions.map(fn => `${fn.name}/${fn.specificName}`), ['ORDER_TOTAL/ORDER_TOTAL', 'ORDER_TOTAL/ORDER_TOTAL_CURRENCY', 'OPEN_ORDERS/OPEN_ORDERS']);
			assert.strictEqual(recorder.matching(/sysroutines/).length, 1);

			let archive = await extension.memoryCache.getRoutinesForSchemas(options, ['ARCHIVE']);
			assert.deepStrictEqual(archive.map(fn => fn.name), ['ARCHIVE_DATE']);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// A function's SYSPARMS rows are keyed by specific name, so each overload has its own; Refresh re-queries.
	test('routine parameters are read per specific name, results included, and forceRefresh re-queries', async () => {
		let key = 'test://cache-routine-params';
		let recorder = TestSupport.recordStatements();

		try {
			await openSession(key, recorder);
			let options = { key: key, configId: TestSupport.CONFIG_ID, tables: [{ schema: 'SALES', table: 'ORDER_TOTAL' }, { schema: 'SALES', table: 'ORDER_TOTAL_CURRENCY' }] };

			let params = await extension.memoryCache.getRoutineParams(options);
			assert.deepStrictEqual(params.map(param => `${param.specificName}:${param.rowType}:${param.dataType}`), [
				'ORDER_TOTAL:P:INTEGER', 'ORDER_TOTAL:C:DECIMAL',
				'ORDER_TOTAL_CURRENCY:P:INTEGER', 'ORDER_TOTAL_CURRENCY:P:CHAR', 'ORDER_TOTAL_CURRENCY:C:DECIMAL'
			]);
			assert.strictEqual(recorder.matching(/sysparms/).length, 1, 'both overloads in one batch');

			await extension.memoryCache.getRoutineParams(options);
			assert.strictEqual(recorder.matching(/sysparms/).length, 1);

			await extension.memoryCache.getRoutineParams({ ...options, forceRefresh: true });
			assert.strictEqual(recorder.matching(/sysparms/).length, 2);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	test('a routine\'s detail carries its body, and is cached until refreshed', async () => {
		let key = 'test://cache-routine-detail';
		let recorder = TestSupport.recordStatements();

		try {
			await openSession(key, recorder);
			let options = { key: key, configId: TestSupport.CONFIG_ID, schema: 'SALES', specificName: 'ORDER_TOTAL_CURRENCY' };

			let detail = await extension.memoryCache.getRoutineDetail(options);
			assert.strictEqual(detail?.definition, 'BEGIN RETURN SALES.ORDER_TOTAL(IN_ORDNO); END');
			assert.strictEqual(detail?.inParms, 2);

			// A body this short fits in the chunk the row itself carries - no follow-up reads.
			assert.strictEqual(recorder.matching(/definition_length/).length, 1);
			assert.strictEqual(recorder.matching(/substring\(routine_definition, \?/).length, 0);

			await extension.memoryCache.getRoutineDetail(options);
			assert.strictEqual(recorder.matching(/definition_length/).length, 1);

			await extension.memoryCache.getRoutineDetail({ ...options, forceRefresh: true });
			assert.strictEqual(recorder.matching(/definition_length/).length, 2);

			assert.strictEqual(await extension.memoryCache.getRoutineDetail({ ...options, specificName: 'NO_SUCH_FUNCTION' }), undefined);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// The body is a DBCLOB read through VARCHAR casts, one chunk at a time (a LOB fetched whole hangs
	// node-odbc), so one longer than a chunk has to come back whole and in order.
	test('a routine body longer than one chunk is read back whole, one follow-up read per chunk', async () => {
		let key = 'test://cache-routine-long-body';
		let body = `BEGIN ${'SET TOTAL = TOTAL + 1; '.repeat(800)}RETURN TOTAL; END`;
		let database = defineFakeDatabase({ schemas: [{ name: 'LONGLIB', functions: [{ name: 'LONG_FN', definition: body }] }] });
		let recorder = TestSupport.recordStatements({ database: database });

		try {
			await openSession(key, recorder);

			let detail = await extension.memoryCache.getRoutineDetail({ key: key, configId: TestSupport.CONFIG_ID, schema: 'LONGLIB', specificName: 'LONG_FN' });

			assert.strictEqual(detail?.definition, body);
			assert.strictEqual(recorder.matching(/substring\(routine_definition, \?/).length, Math.ceil(body.length / RoutineQueries.DEFINITION_CHUNK_LENGTH) - 1);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// Functions get a map of their own like views, one row per overload - and only an overload carries a
	// signature, since that's the one case its name doesn't say which function the row is.
	test('the schema tree lists functions per overload, labelling only the overloads', async () => {
		let key = 'test://cache-tree-functions';

		try {
			let state = await extension.schemaTrees.buildTreeState({ key: key, configId: TestSupport.CONFIG_ID });

			assert.deepStrictEqual(state.functionsBySchema['SALES']?.map(fn => [fn.specificName, fn.signature]), [
				['ORDER_TOTAL', 'ORDER_TOTAL(INTEGER)'],
				['ORDER_TOTAL_CURRENCY', 'ORDER_TOTAL(INTEGER, CHAR)'],
				['OPEN_ORDERS', undefined]
			]);
			assert.ok(!state.functionsBySchema['SALES'].some(fn => fn.name === 'NEXT_ORDER_NUMBER'), 'a procedure is not a function');
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// Procedures the same way, in a map of their own. ORDER_TOTAL is both a function and a procedure in
	// SALES - overloads are counted per kind, so the procedure pair is labelled against each other only.
	test('the schema tree lists procedures per overload, apart from same-named functions', async () => {
		let key = 'test://cache-tree-procedures';

		try {
			let state = await extension.schemaTrees.buildTreeState({ key: key, configId: TestSupport.CONFIG_ID });

			assert.deepStrictEqual(state.proceduresBySchema['SALES']?.map(procedure => [procedure.specificName, procedure.signature]), [
				['NEXT_ORDER_NUMBER', undefined],
				['ORDER_TOTAL_RECALC', 'ORDER_TOTAL()'],
				['ORDER_TOTAL_RECALC1', 'ORDER_TOTAL(INTEGER)'],
				['ORDER_HISTORY', undefined],
				['ORDER_REPORT', undefined],
				['ORDER_PURGE', undefined],
				['ORDER_EXPORT', undefined]
			]);
			assert.ok(state.proceduresBySchema['SALES'].every(procedure => procedure.routineType === 'PROCEDURE'));
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

});
