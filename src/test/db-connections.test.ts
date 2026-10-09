import * as assert from 'assert';
import { defineFakeDatabase } from '../database/drivers/fake/fake-database.js';
import { DbConnectionEvent } from '../events/db-connection-event.js';
import { Event } from '../events/event.js';
import { extension } from '../extension.js';
import { TestSupport } from './test-support.js';

// The first integration tests that run the real extension against a database - a fake one. Everything
// under test here is production code: DbConnections, the event pipeline, the cursor/paging path and
// MemoryCache. Only the driver is swapped (DB2_WORKBENCH_DRIVER=fake, see .vscode-test.mjs).
suite('DbConnections against the fake driver', () => {
	suiteSetup(async () => {
		await TestSupport.activate();
	});

	teardown(async () => {
		TestSupport.restoreDriver();
	});

	test('opening a session reports CONNECTING then CONNECTED, with the fixture\'s schema list', async () => {
		let key = 'test://connect';
		let recorder = TestSupport.recordEvents(key);

		try {
			await extension.connections.getConnectionInfo({ key: key, configId: TestSupport.CONFIG_ID });

			let connected = await recorder.waitFor(DbConnectionEvent.EventType.CONNECTED);
			assert.ok(recorder.ofType(DbConnectionEvent.EventType.CONNECTING).length > 0, 'expected a CONNECTING event before CONNECTED');

			// Both of these come from real connection-time queries answered by CatalogResponder - if
			// either regressed, no session could open at all.
			assert.deepStrictEqual(connected.connectionInfo?.schemas.map(schema => schema.name), ['SALES']);
			assert.strictEqual(connected.connectionInfo?.jobDetails.languageId, 'ENU');
		} finally {
			recorder.stop();
			await TestSupport.closeSessions(key);
		}
	});

	// A tab shut while its connection is still being established: close() finds no wrapper yet, so there
	// is nothing for it to close. Without the closed-key tombstone the connect then landed anyway and
	// left a connection no session owns.
	test('a session closed while it is still connecting is discarded when the connect lands', async () => {
		let key = 'test://close-while-connecting';
		let recorder = TestSupport.recordEvents(key);

		// Closes from inside the CONNECTING event, which fires before the connect has even started. close()
		// runs synchronously up to its first await, so the tombstone is in place before the connect lands.
		let subscription = extension.eventManager.onEvent(event => {
			if(event.type === Event.Type.DB_CONNECTION && (<DbConnectionEvent>event).key === key && (<DbConnectionEvent>event).eventType === DbConnectionEvent.EventType.CONNECTING) {
				void extension.connections.close({ key: key });
			}
		});

		try {
			let info = await extension.connections.getConnectionInfo({ key: key, configId: TestSupport.CONFIG_ID });

			assert.strictEqual(info, undefined, 'a session closed mid-connect must not be handed back');
			assert.strictEqual(extension.connections.hasActiveConnection(key), false);
			assert.strictEqual(recorder.ofType(DbConnectionEvent.EventType.CLOSED).length, 1, 'the discarded connection is closed, and says so');
		} finally {
			subscription.dispose();
			recorder.stop();
			await TestSupport.closeSessions(key);
		}
	});

	// Running a statement is always a user action, so it reopens a session that was closed earlier - the
	// same file run again after its tab was closed and reopened.
	test('executing on a closed session reconnects it', async () => {
		let key = 'test://execute-after-close';

		try {
			await TestSupport.execute(key, 'select * from sales.customer');
			await TestSupport.closeSessions(key);

			let result = await TestSupport.execute(key, 'select * from sales.orders');

			assert.strictEqual(result.eventType, DbConnectionEvent.EventType.RESULT);
			assert.strictEqual(extension.connections.hasActiveConnection(key), true);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	test('executing a query reports EXECUTING then RESULT, carrying rows and column metadata', async () => {
		let key = 'test://execute';

		try {
			let result = await TestSupport.execute(key, 'select * from sales.customer');

			assert.strictEqual(result.eventType, DbConnectionEvent.EventType.RESULT);
			assert.strictEqual(result.result?.length, 3);
			assert.deepStrictEqual(result.result?.columns.map(column => column.name), ['CUSTNO', 'CUSTNM', 'ACTIVE']);
			assert.strictEqual(result.parseResults?.statementType, 'sql');
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	test('a cursor pages: the first result leaves it open, and fetching drains it', async () => {
		let key = 'test://paging';
		let recorder = TestSupport.recordEvents(key);

		try {
			// 25 fixture rows against the default fetch size of 100 would arrive in one batch. It has to
			// be the db2-workbench.cursorFetchSize setting rather than the fake driver's own fallback:
			// DbConnections.execute passes the setting to openCursor explicitly, so the driver's value
			// is never consulted - which is the real paging path.
			await TestSupport.setCursorFetchSize(10);

			let first = await TestSupport.execute(key, 'select * from sales.orders');
			assert.strictEqual(first.result?.length, 10);
			assert.strictEqual(first.isCursorOpen, true);

			await extension.connections.fetch({ key: key, configId: TestSupport.CONFIG_ID });
			let fetched = recorder.ofType(DbConnectionEvent.EventType.FETCHED);
			assert.strictEqual(fetched[fetched.length - 1].result?.length, 10);

			await extension.connections.fetchAll({ key: key, configId: TestSupport.CONFIG_ID });
			let total = recorder.ofType(DbConnectionEvent.EventType.FETCHED).reduce((sum, event) => sum + (event.result?.length ?? 0), 0);

			// 10 delivered with the RESULT, the rest through FETCHED events.
			assert.strictEqual(total, 15);
		} finally {
			recorder.stop();
			await TestSupport.setCursorFetchSize(100);
			await TestSupport.closeSessions(key);
		}
	});

	test('a failing statement reports ERROR with the driver\'s reported error chain', async () => {
		let key = 'test://error';

		try {
			// The fixture stays in place: opening the session needs the connection-time catalog lookups
			// answered before any statement can fail.
			TestSupport.useDriver({
				database: TestSupport.DATABASE,
				responses: [{
					match: /from\s+sales\.missing/i,
					error: { message: 'Table MISSING in SALES type *FILE not found.', driverErrors: [{ code: -204, state: '42704', message: 'MISSING in SALES type *FILE not found.' }] }
				}]
			});

			let result = await TestSupport.execute(key, 'select * from sales.missing');

			assert.strictEqual(result.eventType, DbConnectionEvent.EventType.ERROR);
			assert.match(result.error?.message ?? '', /not found/);
			assert.strictEqual((<{ driverErrors?: { state: string }[] }>result.error)?.driverErrors?.[0].state, '42704');
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	test('two sessions on the same connection share one set of cached catalog lookups', async () => {
		let firstKey = 'test://cache-a';
		let secondKey = 'test://cache-b';

		let recorder = TestSupport.recordEvents(firstKey);

		try {
			let first = await extension.memoryCache.getColumns({ key: firstKey, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } });
			let errors = recorder.ofType(DbConnectionEvent.EventType.ERROR).map(event => event.error?.message);
			assert.deepStrictEqual(first.map(column => column.systemName), ['ORDNO', 'CUSTNO', 'ORDDT', 'ORDAMT'], `errors on this session: ${errors.join(' | ')}`);

			// The second session has never queried anything itself. If MemoryCache were keyed by session
			// key rather than by connection identity, it would query SYSCOLUMNS2 again - so that one
			// statement is rigged to fail while everything else (including opening the session) still
			// works.
			TestSupport.useDriver({
				database: TestSupport.DATABASE,
				responses: [{
					match: /syscolumns2/i,
					error: { message: 'SYSCOLUMNS2 was queried again - the column cache is not shared across sessions on one connection.' }
				}]
			});

			let second = await extension.memoryCache.getColumns({ key: secondKey, configId: TestSupport.CONFIG_ID, tables: { schema: 'SALES', table: 'ORDERS' } });
			assert.deepStrictEqual(second.map(column => column.sqlName), first.map(column => column.sqlName));
		} finally {
			recorder.stop();
			await TestSupport.closeSessions(firstKey, secondKey);
		}
	});
});

// A procedure name that exists in several schemas: left to itself, node-odbc looks an unqualified CALL
// up with no schema, counts every copy's parameters and refuses the call. The schema handed to the
// driver must be the first library list schema, in list order, that holds the procedure.
suite('DbConnections resolving an unqualified CALL\'s schema', () => {
	const procedure = { name: 'SHARED_PROC', parameters: [{ name: 'IN_CODE', mode: 'IN', dataType: 'CHAR', length: 2 }] };

	// ZLIB comes before ALIB on the library list, so list order and alphabetical order disagree; OFFLIB
	// holds the procedure too but isn't on the list at all.
	const database = defineFakeDatabase({
		schemas: [
			{ name: 'OFFLIB', onLibraryList: false, procedures: [procedure] },
			{ name: 'EMPTYLIB' },
			{ name: 'ZLIB', procedures: [procedure] },
			{ name: 'ALIB', procedures: [procedure] }
		]
	});

	// The fixture has no rows for the CALL itself - an empty answer is all these tests need.
	const driverOptions = { database: database, responses: [{ match: /^call /i, rows: [] }] };

	suiteSetup(async () => {
		await TestSupport.activate();
	});

	teardown(async () => {
		TestSupport.restoreDriver();
	});

	test('an unqualified CALL runs from the first library list schema that holds the procedure', async () => {
		let key = 'test://call-unqualified';
		let recorder = TestSupport.recordStatements(driverOptions);

		try {
			let result = await TestSupport.execute(key, `call shared_proc('RX')`);

			assert.strictEqual(result.eventType, DbConnectionEvent.EventType.RESULT);
			assert.deepStrictEqual(recorder.matching(/^call /).map(statement => statement.normalized), ['call zlib.shared_proc']);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	test('a qualified CALL runs from the schema it names, uppercased, even one off the library list', async () => {
		let key = 'test://call-qualified';
		let recorder = TestSupport.recordStatements(driverOptions);

		try {
			let result = await TestSupport.execute(key, `call offlib.shared_proc('RX')`);

			assert.strictEqual(result.eventType, DbConnectionEvent.EventType.RESULT);
			// Raw text, not normalized: the lowercase schema as typed must reach the driver uppercased
			assert.deepStrictEqual(recorder.matching(/^call /).map(statement => statement.sql), ['call OFFLIB.SHARED_PROC']);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});
});
