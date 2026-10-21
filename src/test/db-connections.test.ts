import * as assert from 'assert';
import { defineFakeDatabase } from '../database/drivers/fake/fake-database.js';
import { DbConnectionEvent } from '../events/db-connection-event.js';
import { Event } from '../events/event.js';
import { extension } from '../extension.js';
import { ParameterParser } from '../utils/parameter-parser.js';
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

// An overloaded procedure name, shaped like QSYS2.QCMDEXC: node-odbc's callProcedure() counts the
// parameters of every overload (here 2 + 1) and refuses any CALL of it, so such a CALL has to run as a
// plain statement instead. FakeDriver.callProcedure makes node-odbc's check, so the first test fails on
// the old path.
suite('DbConnections running a CALL of an overloaded procedure', () => {
	const command = { name: 'COMMAND', mode: 'IN', dataType: 'VARCHAR', length: 32702 };

	const database = defineFakeDatabase({
		schemas: [{
			name: 'CMDLIB',
			procedures: [
				{ name: 'QCMDEXC', specificName: 'QCMDEXC', parameters: [command, { name: 'LENGTH', mode: 'IN', dataType: 'DECIMAL', length: 15 }] },
				{ name: 'QCMDEXC', specificName: 'QCMDEXC1', parameters: [command] },
				{ name: 'SINGLE', parameters: [command] }
			]
		}]
	});

	const callResponse = { match: /^\s*call /i, rows: [] };

	suiteSetup(async () => {
		await TestSupport.activate();
	});

	teardown(async () => {
		await extension.memoryCache.deleteConnectionCache({ key: 'test://teardown', configId: TestSupport.CONFIG_ID });
		TestSupport.restoreDriver();
	});

	/** callProcedure() records `call SCHEMA.NAME`; the plain statement records the CALL rebuilt with one marker per argument. */
	function calls(recorder: TestSupport.StatementRecorder): string[] {
		return recorder.matching(/^\s*call /).map(statement => statement.sql);
	}

	/** Runs a CALL with its arguments bound the way Commands binds them: the full positional list, literals included. */
	function executeCall(key: string, sql: string): Promise<DbConnectionEvent> {
		return TestSupport.execute(key, sql, { parameters: ParameterParser.buildCallParameters(sql, []) });
	}

	test('an overloaded procedure runs as a plain statement with one marker per argument, with either argument count', async () => {
		let key = 'test://call-overloaded';
		let recorder = TestSupport.recordStatements({ database: database, responses: [callResponse] });

		try {
			let one = await executeCall(key, `CALL CMDLIB.QCMDEXC('CHGLIBL LIBL(QTEMP QGPL)')`);
			let two = await executeCall(key, `call cmdlib.qcmdexc('DSPLIBL', 7)`);

			assert.strictEqual(one.eventType, DbConnectionEvent.EventType.RESULT, String(one.error?.message));
			assert.strictEqual(two.eventType, DbConnectionEvent.EventType.RESULT, String(two.error?.message));

			let statements = recorder.matching(/^\s*call /);
			assert.deepStrictEqual(statements.map(statement => statement.sql), ['CALL CMDLIB.QCMDEXC(?)', 'CALL CMDLIB.QCMDEXC(?, ?)']);
			assert.deepStrictEqual(statements.map(statement => statement.parameters), [['CHGLIBL LIBL(QTEMP QGPL)'], ['DSPLIBL', 7]]);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	test('a procedure that is not overloaded still goes through callProcedure()', async () => {
		let key = 'test://call-single';
		let recorder = TestSupport.recordStatements({ database: database, responses: [callResponse] });

		try {
			let result = await executeCall(key, `call cmdlib.single('X')`);

			assert.strictEqual(result.eventType, DbConnectionEvent.EventType.RESULT, String(result.error?.message));
			assert.deepStrictEqual(calls(recorder), ['call CMDLIB.SINGLE']);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	// The routine list was cached before the second overload existed: it says "not overloaded", so the
	// CALL goes to callProcedure(), which refuses it. That refusal re-reads the schema's routines once and
	// runs the CALL as a plain statement.
	test('a routine list cached before an overload existed is re-read once, and the CALL then runs', async () => {
		let key = 'test://call-stale-overloads';
		let routineReads = 0;
		let staleRoutines = {
			match: (sql: string) => /qsys2\.sysroutines/i.test(sql) && routineReads++ === 0,
			rows: [{
				SPECIFIC_SCHEMA: 'CMDLIB', SPECIFIC_NAME: 'QCMDEXC1', ROUTINE_SCHEMA: 'CMDLIB', ROUTINE_NAME: 'QCMDEXC', ROUTINE_TYPE: 'PROCEDURE',
				ROUTINE_BODY: 'SQL', EXTERNAL_LANGUAGE: 'SQL', LONG_COMMENT: '', IN_PARMS: 1, OUT_PARMS: 0, INOUT_PARMS: 0
			}]
		};
		let recorder = TestSupport.recordStatements({ database: database, responses: [staleRoutines, callResponse] });

		try {
			let result = await executeCall(key, `CALL CMDLIB.QCMDEXC('DSPLIBL')`);

			assert.strictEqual(result.eventType, DbConnectionEvent.EventType.RESULT, String(result.error?.message));
			assert.deepStrictEqual(calls(recorder), ['call CMDLIB.QCMDEXC', 'CALL CMDLIB.QCMDEXC(?)']);
			assert.ok(routineReads >= 2, 'the routine list should have been re-read');
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	test('a CALL\'s parameters come from the overload its argument count picks', async () => {
		let key = 'test://call-overload-params';
		TestSupport.recordStatements({ database: database });

		try {
			let one = await extension.memoryCache.getProcedureParams({ key: key, configId: TestSupport.CONFIG_ID, schema: 'CMDLIB', procedure: 'QCMDEXC', argumentCount: 1 });
			let two = await extension.memoryCache.getProcedureParams({ key: key, configId: TestSupport.CONFIG_ID, schema: 'CMDLIB', procedure: 'QCMDEXC', argumentCount: 2 });

			assert.deepStrictEqual(one.map(param => param.name), ['COMMAND']);
			assert.deepStrictEqual(two.map(param => param.name), ['COMMAND', 'LENGTH']);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});
});
