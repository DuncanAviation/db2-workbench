import * as assert from 'assert';
import { defineFakeDatabase, FakeDatabase } from '../database/drivers/fake/fake-database.js';
import { SAMPLE_DATABASE } from '../database/drivers/fake/fixtures/sample-database.js';
import { DbConnectionEvent } from '../events/db-connection-event.js';
import { extension } from '../extension.js';
import { TestSupport } from './test-support.js';

/**
 * Changing a session's library list: DbConnections.setLibraryList, and the worker sync after a library
 * command the user ran themselves. The contract under test is that the session's two jobs - main and
 * worker - never disagree, so every assertion reads both jobs' lists back from the driver rather than
 * trusting the session's ConnectionInfo. FakeLibraryList keeps one list per connection for exactly that.
 *
 * What the fake can't show: whether a CHGLIBL on the main connection disturbs an open cursor, and
 * whether SQL packages pick up the changed list. Those are live checks 1 and 2 in the plan.
 */
suite('Library list changes against the fake driver', () => {
	const LIBRARY_LIST_SQL = 'select ordinal_position, system_schema_name, type, text_description from qsys2.library_list_info order by ordinal_position';
	const QCMDEXC = /qcmdexc/;

	// QTEMP sits in the user portion, as it does on a real job, so keeping it in place is observable.
	const DATABASE: FakeDatabase = {
		...SAMPLE_DATABASE,
		schemas: [
			...defineFakeDatabase({ schemas: [{ name: 'QSYS', type: 'System' }, { name: 'QTEMP', type: 'User' }, { name: 'APPL' }] }).schemas,
			...SAMPLE_DATABASE.schemas
		]
	};

	suiteSetup(async () => {
		await TestSupport.activate();
	});

	teardown(async () => {
		await extension.memoryCache.deleteConnectionCache({ key: 'test://teardown', configId: TestSupport.CONFIG_ID });
		TestSupport.restoreDriver();
	});

	async function openSession(key: string, recorder: TestSupport.StatementRecorder): Promise<void> {
		await extension.connections.getConnectionInfo({ key: key, configId: TestSupport.CONFIG_ID });
		recorder.clear();
	}

	/** One job's library list as the driver reports it - the main job's, or the worker's. */
	async function readJobList(key: string, useWorkerConnection: boolean): Promise<string[]> {
		let rows = <Record<string, unknown>[]>await extension.connections.internalQuery({ key: key, configId: TestSupport.CONFIG_ID, sql: LIBRARY_LIST_SQL, useWorkerConnection: useWorkerConnection });
		return rows.map(row => String(row['SYSTEM_SCHEMA_NAME']));
	}

	async function assertBothJobs(key: string, expected: string[], message?: string): Promise<void> {
		assert.deepStrictEqual(await readJobList(key, false), expected, `main job: ${message ?? ''}`);
		assert.deepStrictEqual(await readJobList(key, true), expected, `worker job: ${message ?? ''}`);
	}

	async function sessionList(key: string): Promise<string[]> {
		return (await extension.connections.getConnectionInfo({ key: key, configId: TestSupport.CONFIG_ID }))?.schemas.map(schema => schema.name) ?? [];
	}

	test('a change runs on the main job and the worker job, keeps QTEMP in place, and reports the new list', async () => {
		let key = 'test://library-list-change';
		let recorder = TestSupport.recordStatements({ database: DATABASE });
		let events = TestSupport.recordEvents(key);

		try {
			await openSession(key, recorder);
			await assertBothJobs(key, ['QSYS', 'QTEMP', 'APPL', 'SALES']);
			recorder.clear();

			let info = await extension.connections.setLibraryList({ key: key, configId: TestSupport.CONFIG_ID }, ['SALES', 'archive', 'APPL']);

			// One plain CALL per job, the command bound as a value - never callProcedure(), which QCMDEXC's
			// two overloads would refuse.
			let commands = recorder.matching(QCMDEXC);
			assert.deepStrictEqual(commands.map(statement => [statement.sql, statement.parameters.map(String)]), [
				['CALL QSYS2.QCMDEXC(?)', ['CHGLIBL LIBL(QTEMP SALES ARCHIVE APPL)']],
				['CALL QSYS2.QCMDEXC(?)', ['CHGLIBL LIBL(QTEMP SALES ARCHIVE APPL)']]
			]);

			await assertBothJobs(key, ['QSYS', 'QTEMP', 'SALES', 'ARCHIVE', 'APPL']);

			let changed = events.ofType(DbConnectionEvent.EventType.LIBRARY_LIST_CHANGED);
			assert.strictEqual(changed.length, 1);
			assert.deepStrictEqual(changed[0].connectionInfo?.schemas.map(schema => schema.name), ['QSYS', 'QTEMP', 'SALES', 'ARCHIVE', 'APPL']);
			assert.strictEqual(changed[0].connectionInfo, info);
			assert.deepStrictEqual(await sessionList(key), ['QSYS', 'QTEMP', 'SALES', 'ARCHIVE', 'APPL']);

			// The statements reach the History tab as internal ones, so they leave the user's results alone.
			let commandResults = events.ofType(DbConnectionEvent.EventType.RESULT).filter(event => QCMDEXC.test(event.parseResults?.originalSql.toLowerCase() ?? ''));
			assert.strictEqual(commandResults.length, 2);
			assert.ok(commandResults.every(event => event.isInternal));

			// The session's eager lists follow the new list straight away - ARCHIVE was off it before.
			let tables = await extension.memoryCache.getTables({ key: key, configId: TestSupport.CONFIG_ID });
			assert.ok(tables.some(table => table.schema === 'ARCHIVE' && table.name === 'ORDERS2024'));
		} finally {
			events.stop();
			await TestSupport.closeSessions(key);
		}
	});

	test('a failure on the worker job puts the main job back, and nothing reports a change', async () => {
		let key = 'test://library-list-worker-failure';
		let commandCount = 0;
		let recorder = TestSupport.recordStatements({
			database: DATABASE,
			responses: [{
				// The second QCMDEXC of the change is the worker's.
				match: sql => QCMDEXC.test(sql.toLowerCase()) && ++commandCount === 2,
				error: { message: 'SQL0443 - CPF9999 Worker job refused the command.', driverErrors: [{ code: -443, state: '38501', message: 'CPF9999 Worker job refused the command.' }] }
			}]
		});
		let events = TestSupport.recordEvents(key);

		try {
			await openSession(key, recorder);

			await assert.rejects(
				extension.connections.setLibraryList({ key: key, configId: TestSupport.CONFIG_ID }, ['ARCHIVE']),
				/CPF9999 Worker job refused the command/
			);

			// Main changed, worker refused, main restored.
			assert.deepStrictEqual(recorder.matching(QCMDEXC).map(statement => String(statement.parameters[0])), [
				'CHGLIBL LIBL(QTEMP ARCHIVE)',
				'CHGLIBL LIBL(QTEMP ARCHIVE)',
				'CHGLIBL LIBL(QTEMP APPL SALES)'
			]);

			await assertBothJobs(key, ['QSYS', 'QTEMP', 'APPL', 'SALES']);
			assert.strictEqual(events.ofType(DbConnectionEvent.EventType.LIBRARY_LIST_CHANGED).length, 0);
			assert.deepStrictEqual(await sessionList(key), ['QSYS', 'QTEMP', 'APPL', 'SALES']);
		} finally {
			events.stop();
			await TestSupport.closeSessions(key);
		}
	});

	// What a missing library (CPF2110) or a limited-capability user's refusal looks like: the main job's
	// statement fails, so the worker is never touched.
	test('a failure on the main job leaves the worker untouched', async () => {
		let key = 'test://library-list-main-failure';
		let recorder = TestSupport.recordStatements({ database: DATABASE });
		let events = TestSupport.recordEvents(key);

		try {
			await openSession(key, recorder);

			await assert.rejects(
				extension.connections.setLibraryList({ key: key, configId: TestSupport.CONFIG_ID }, ['SALES', 'NOSUCH']),
				(error: any) => error.message.includes('CPF2110') && error.driverErrors?.[0]?.state === '38501'
			);

			assert.strictEqual(recorder.matching(QCMDEXC).length, 1);
			await assertBothJobs(key, ['QSYS', 'QTEMP', 'APPL', 'SALES']);
			assert.strictEqual(events.ofType(DbConnectionEvent.EventType.LIBRARY_LIST_CHANGED).length, 0);
		} finally {
			events.stop();
			await TestSupport.closeSessions(key);
		}
	});

	// What the dialog's Add asks before a name goes into the list - off the library list or not.
	test('a library is looked up by name, and one the system doesn\'t have comes back missing', async () => {
		let key = 'test://library-list-exists';
		let recorder = TestSupport.recordStatements({ database: DATABASE });

		try {
			await openSession(key, recorder);

			let found = await extension.catalogQueries.listExistingLibraries({ key: key, configId: TestSupport.CONFIG_ID }, ['ARCHIVE', 'NOSUCH']);
			assert.deepStrictEqual(found, ['ARCHIVE']);
			assert.strictEqual(recorder.matching(/from qsys2\.sysschemas where sys_name in/).length, 1);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	test('a name that isn\'t a system name is refused before anything runs', async () => {
		let key = 'test://library-list-invalid-name';
		let recorder = TestSupport.recordStatements({ database: DATABASE });

		try {
			await openSession(key, recorder);

			await assert.rejects(
				extension.connections.setLibraryList({ key: key, configId: TestSupport.CONFIG_ID }, ['SALES', 'X) DLTLIB LIB(SALES']),
				/is not a valid library name/
			);

			assert.strictEqual(recorder.matching(QCMDEXC).length, 0);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	test('a change is refused while the session is running a statement', async () => {
		let key = 'test://library-list-busy';
		let statementReached: () => void = () => undefined;
		let reached = new Promise<void>(resolve => statementReached = resolve);
		let recorder = TestSupport.recordStatements({
			database: DATABASE,
			responses: [{ match: /from sales\.customer/i, rows: [], delayMs: 300 }],
			onStatement: sql => {
				if(/from sales\.customer/i.test(sql)) {
					statementReached();
				}
			}
		});

		try {
			await openSession(key, recorder);

			let running = TestSupport.execute(key, 'select * from sales.customer');
			await reached;

			await assert.rejects(
				extension.connections.setLibraryList({ key: key, configId: TestSupport.CONFIG_ID }, ['SALES']),
				/can't be changed while a statement is running/
			);

			await running;
			assert.strictEqual(recorder.matching(QCMDEXC).length, 0);
		} finally {
			await TestSupport.closeSessions(key);
		}
	});

	test('a library command the user runs through a QCMDEXC CALL is mirrored to the worker and reported', async () => {
		let key = 'test://library-list-user-call';
		let recorder = TestSupport.recordStatements({ database: DATABASE });
		let events = TestSupport.recordEvents(key);

		try {
			await openSession(key, recorder);

			let result = await TestSupport.execute(key, 'CALL QSYS2.QCMDEXC(\'ADDLIBLE LIB(ARCHIVE) POSITION(*LAST)\')');
			assert.strictEqual(result.eventType, DbConnectionEvent.EventType.RESULT, result.error?.message);

			// The user's CALL took #9's plain path (QCMDEXC is overloaded), then the worker got the main
			// job's whole user portion through CHGLIBL.
			assert.deepStrictEqual(recorder.matching(QCMDEXC).map(statement => [statement.sql, statement.parameters.map(String)]), [
				['CALL QSYS2.QCMDEXC(?)', ['ADDLIBLE LIB(ARCHIVE) POSITION(*LAST)']],
				['CALL QSYS2.QCMDEXC(?)', ['CHGLIBL LIBL(QTEMP APPL SALES ARCHIVE)']]
			]);

			await assertBothJobs(key, ['QSYS', 'QTEMP', 'APPL', 'SALES', 'ARCHIVE']);

			let changed = await events.waitFor(DbConnectionEvent.EventType.LIBRARY_LIST_CHANGED);
			assert.deepStrictEqual(changed.connectionInfo?.schemas.map(schema => schema.name), ['QSYS', 'QTEMP', 'APPL', 'SALES', 'ARCHIVE']);
			assert.deepStrictEqual(await sessionList(key), ['QSYS', 'QTEMP', 'APPL', 'SALES', 'ARCHIVE']);
		} finally {
			events.stop();
			await TestSupport.closeSessions(key);
		}
	});

	// The scalar function goes through the cursor path, not the CALL path, and returns -1 for a command that
	// failed - in which case the list didn't change, and nothing should claim it did.
	test('the scalar function form is caught too, and a failed command reports no change', async () => {
		let key = 'test://library-list-user-function';
		let recorder = TestSupport.recordStatements({ database: DATABASE });
		let events = TestSupport.recordEvents(key);

		try {
			await openSession(key, recorder);

			await TestSupport.execute(key, 'values qsys2.qcmdexc(\'ADDLIBLE LIB(NOSUCH)\')');
			assert.strictEqual(events.ofType(DbConnectionEvent.EventType.LIBRARY_LIST_CHANGED).length, 0);
			assert.strictEqual(recorder.matching(/chglibl/).length, 0, 'an unchanged list is not copied to the worker');

			await TestSupport.execute(key, 'values qsys2.qcmdexc(\'RMVLIBLE LIB(APPL)\')');
			await events.waitFor(DbConnectionEvent.EventType.LIBRARY_LIST_CHANGED);
			await assertBothJobs(key, ['QSYS', 'QTEMP', 'SALES']);
		} finally {
			events.stop();
			await TestSupport.closeSessions(key);
		}
	});
});
