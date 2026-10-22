import * as assert from 'assert';
import * as vscode from 'vscode';
import { DbConnectionEvent } from '../events/db-connection-event.js';
import { extension } from '../extension.js';
import { WorkbenchViewProvider } from '../views/workbench-view-provider.js';
import { TestSupport } from './test-support.js';

/**
 * WorkbenchViewProvider's session store, driven the way the real thing is driven: by
 * DbConnectionEvents, with no webview involved.
 *
 * The provider never renders anything itself - it keeps one SqlSession per document uri, updates it
 * from events, and hands the result to whichever webview is listening. That store is the part worth
 * testing: the rows a tab shows, its history, its cursor state and which session is on screen all
 * come out of it, and it is reachable without resolving a WebviewView (which a headless run can't
 * rely on).
 *
 * Every handler here (onConnecting/onResult/onError/...) runs synchronously off the event emitter,
 * so by the time an awaited RESULT event resolves, the session it belongs to is already updated -
 * nothing here needs to poll for that. The two places that do poll are the ones VS Code drives
 * (switching the active editor), and they poll on a condition rather than sleeping.
 *
 * Not covered here: the render pipeline itself. render() pushes onto an rxjs Subject whose
 * subscriber posts to a webview, so with no webview resolved there is nothing to observe but the
 * session state these tests already assert on directly.
 */
suite('WorkbenchViewProvider sessions', () => {
	const DEFAULT_HISTORY_COUNT = 20;

	function session(key: string): WorkbenchViewProvider.SqlSession {
		let found = extension.resultsViewProvider.getSession(key);
		assert.ok(found, `expected a session for ${key}`);
		return <WorkbenchViewProvider.SqlSession>found;
	}

	/** The statements the user actually ran, in order - the session's own catalog lookups are excluded. */
	function userStatements(key: string): (string | undefined)[] {
		return session(key).histories
			.filter(history => !history.isInternal && history.type === WorkbenchViewProvider.SqlHistoryType.RESULT)
			.map(history => history.sql);
	}

	suiteSetup(async () => {
		await TestSupport.activate();
	});

	teardown(async () => {
		await TestSupport.setHistoryCount(DEFAULT_HISTORY_COUNT);
		await TestSupport.setCursorFetchSize(100);
		TestSupport.restoreDriver();
	});

	test('each document uri gets its own session, with its own rows and history', async () => {
		let firstKey = 'test://session-a.sql';
		let secondKey = 'test://session-b.sql';

		try {
			await TestSupport.execute(firstKey, 'select * from sales.customer');
			await TestSupport.execute(secondKey, 'select * from sales.orders');

			assert.strictEqual(session(firstKey).rows.length, 3);
			assert.strictEqual(session(secondKey).rows.length, 25);

			// Two tabs on one connection share a cache (see memory-cache.test.ts) but never a session:
			// each one's history is its own.
			assert.deepStrictEqual(userStatements(firstKey), ['select * from sales.customer']);
			assert.deepStrictEqual(userStatements(secondKey), ['select * from sales.orders']);
		} finally {
			extension.resultsViewProvider.closeSession(firstKey);
			extension.resultsViewProvider.closeSession(secondKey);
			await TestSupport.closeSessions(firstKey, secondKey);
		}
	});

	// The connection tab renders session.connectionInfo, so a library list change has to land there - from
	// the live dialog's setLibraryList and from a library command the user ran - without touching the rows
	// the last statement left behind.
	test('a library list change updates the session\'s connection info and leaves its rows alone', async () => {
		let key = 'test://session-library-list.sql';

		try {
			await TestSupport.execute(key, 'select * from sales.customer');
			assert.deepStrictEqual(session(key).connectionInfo?.schemas.map(schema => schema.name), ['SALES']);

			await extension.connections.setLibraryList({ key: key, configId: TestSupport.CONFIG_ID }, ['ARCHIVE', 'SALES']);
			assert.deepStrictEqual(session(key).connectionInfo?.schemas.map(schema => `${schema.name}:${schema.type}`), ['ARCHIVE:USER', 'SALES:USER']);
			assert.strictEqual(session(key).rows.length, 3);

			await TestSupport.execute(key, 'CALL QSYS2.QCMDEXC(\'RMVLIBLE LIB(ARCHIVE)\')');
			assert.deepStrictEqual(session(key).connectionInfo?.schemas.map(schema => schema.name), ['SALES']);
		} finally {
			extension.resultsViewProvider.closeSession(key);
			await TestSupport.closeSessions(key);
		}
	});

	test('a second statement on a session replaces its rows rather than appending to them', async () => {
		let key = 'test://session-replace.sql';

		try {
			await TestSupport.execute(key, 'select * from sales.orders');
			assert.strictEqual(session(key).rows.length, 25);

			await TestSupport.execute(key, 'select * from sales.customer');

			assert.strictEqual(session(key).rows.length, 3, 'the new result must replace the old rows, not extend them');
			assert.deepStrictEqual(userStatements(key), ['select * from sales.orders', 'select * from sales.customer']);
		} finally {
			extension.resultsViewProvider.closeSession(key);
			await TestSupport.closeSessions(key);
		}
	});

	test('the session tracks cursor state across Load More and Fetch All', async () => {
		let key = 'test://session-cursor.sql';

		try {
			await TestSupport.setCursorFetchSize(10);

			await TestSupport.execute(key, 'select * from sales.orders');
			assert.strictEqual(session(key).rows.length, 10);
			assert.strictEqual(session(key).isCursorOpen, true);

			// "Load More".
			await extension.connections.fetch({ key: key, configId: TestSupport.CONFIG_ID });
			assert.strictEqual(session(key).rows.length, 20, 'a fetch appends to the session rather than replacing it');
			assert.strictEqual(session(key).isCursorOpen, true);

			await extension.connections.fetchAll({ key: key, configId: TestSupport.CONFIG_ID });
			assert.strictEqual(session(key).rows.length, 25);
			assert.strictEqual(session(key).isCursorOpen, false, 'the cursor is drained, so Load More must stop being offered');
			assert.strictEqual(session(key).state, WorkbenchViewProvider.SqlSessionState.READY);
		} finally {
			extension.resultsViewProvider.closeSession(key);
			await TestSupport.closeSessions(key);
		}
	});

	test('history is bounded by the historyCount setting, keeping the newest entries', async () => {
		let key = 'test://session-history.sql';

		try {
			await TestSupport.setHistoryCount(3);

			// Five statements, three slots. Distinct SELECT lists rather than five copies of one
			// statement, so "the newest three" is provable rather than just plausible - the fake driver
			// answers any select against a declared table with that table's rows regardless of the list.
			let statements = [
				'select custno from sales.customer',
				'select custnm from sales.customer',
				'select active from sales.customer',
				'select custno, custnm from sales.customer',
				'select custno, active from sales.customer'
			];

			for(let statement of statements) {
				await TestSupport.execute(key, statement);
			}

			assert.strictEqual(session(key).histories.length, 3, 'the bound applies to the whole history, connection entries included');
			assert.deepStrictEqual(userStatements(key), statements.slice(-3));
		} finally {
			extension.resultsViewProvider.closeSession(key);
			await TestSupport.closeSessions(key);
		}
	});

	test('a failed statement is recorded in history with its driver error, and leaves the session usable', async () => {
		let key = 'test://session-error.sql';

		try {
			TestSupport.useDriver({
				database: TestSupport.DATABASE,
				responses: [{
					match: /from\s+sales\.missing/i,
					error: { message: 'Table MISSING in SALES type *FILE not found.', driverErrors: [{ code: -204, state: '42704', message: 'MISSING in SALES type *FILE not found.' }] }
				}]
			});

			let event = await TestSupport.execute(key, 'select * from sales.missing');
			assert.strictEqual(event.eventType, DbConnectionEvent.EventType.ERROR);

			let errors = session(key).histories.filter(history => history.type === WorkbenchViewProvider.SqlHistoryType.ERROR);
			assert.strictEqual(errors.length, 1);
			assert.strictEqual(errors[0].sql, 'select * from sales.missing');
			assert.match((<Error>errors[0].error)?.message ?? '', /not found/);

			// A failure must not leave the session stuck reporting EXECUTING - the next statement has to
			// be runnable, and it is the same session that runs it.
			assert.strictEqual(session(key).state, WorkbenchViewProvider.SqlSessionState.READY);

			await TestSupport.execute(key, 'select * from sales.customer');
			assert.strictEqual(session(key).rows.length, 3);
		} finally {
			extension.resultsViewProvider.closeSession(key);
			await TestSupport.closeSessions(key);
		}
	});

	test('the active session follows whichever session last ran something', async () => {
		let firstKey = 'test://session-active-a.sql';
		let secondKey = 'test://session-active-b.sql';

		try {
			await TestSupport.execute(firstKey, 'select * from sales.customer');
			assert.strictEqual(extension.resultsViewProvider.activeSessionUri, firstKey);

			await TestSupport.execute(secondKey, 'select * from sales.orders');
			assert.strictEqual(extension.resultsViewProvider.activeSessionUri, secondKey);

			// Manual selection in the sidebar's session list.
			extension.resultsViewProvider.activateSession(firstKey);
			assert.strictEqual(extension.resultsViewProvider.activeSessionUri, firstKey);

			// A key with no session is ignored rather than blanking the view - a panel that is still
			// connecting, or failed to connect, has no session yet.
			extension.resultsViewProvider.activateSession('test://session-active-never-ran.sql');
			assert.strictEqual(extension.resultsViewProvider.activeSessionUri, firstKey);
		} finally {
			extension.resultsViewProvider.closeSession(firstKey);
			extension.resultsViewProvider.closeSession(secondKey);
			await TestSupport.closeSessions(firstKey, secondKey);
		}
	});

	// The one rule here that VS Code drives rather than the extension: switching to another SQL editor
	// switches the results view with it, but only when that document already has a session. A .sql file
	// that has never run anything must leave whatever is on screen alone.
	test('switching to another SQL editor activates its session, and a session-less editor leaves the view alone', async () => {
		let documents: vscode.TextDocument[] = [];
		// Locally the switch below lands in about 50ms, but it once timed out on a CI runner at 5s with
		// nothing to say why. Every active-editor change VS Code reports is recorded here, with the session
		// the provider shows straight after it (its own listener was registered first, so has already run),
		// so a failure - or a switch that is merely slow - says whether the editor change arrived at all.
		let startedAt = Date.now();
		let editorChanges: string[] = [];
		let editorChangeListener = vscode.window.onDidChangeActiveTextEditor(editor => {
			editorChanges.push(`${Date.now() - startedAt}ms: ${editor?.document.uri.toString() ?? 'no editor'} (${editor?.document.languageId ?? '-'}), active session now ${extension.resultsViewProvider.activeSessionUri}`);
		});

		try {
			let first = await vscode.workspace.openTextDocument({ language: 'sql', content: 'select * from sales.customer' });
			let second = await vscode.workspace.openTextDocument({ language: 'sql', content: 'select * from sales.orders' });
			let sessionless = await vscode.workspace.openTextDocument({ language: 'sql', content: 'select * from sales.shipment' });
			documents.push(first, second, sessionless);

			let describeState = () => [
				`first=${first.uri.toString()}, second=${second.uri.toString()}, sessionless=${sessionless.uri.toString()}`,
				`active session: ${extension.resultsViewProvider.activeSessionUri}`,
				`sessions exist: first=${extension.resultsViewProvider.getSession(first.uri.toString()) !== undefined}, second=${extension.resultsViewProvider.getSession(second.uri.toString()) !== undefined}`,
				`active editor: ${vscode.window.activeTextEditor?.document.uri.toString() ?? 'none'}`,
				`visible editors: ${vscode.window.visibleTextEditors.map(editor => editor.document.uri.toString()).join(', ') || 'none'}`,
				`window focused: ${vscode.window.state.focused}`,
				`active-editor changes since the test started:\n${editorChanges.map(change => `  ${change}`).join('\n') || '  none'}`
			].join('\n');

			await TestSupport.execute(first.uri.toString(), 'select * from sales.customer');
			await TestSupport.execute(second.uri.toString(), 'select * from sales.orders');
			assert.strictEqual(extension.resultsViewProvider.activeSessionUri, second.uri.toString());

			let switchStartedAt = Date.now();
			await vscode.window.showTextDocument(first, { preview: false });
			await TestSupport.waitUntil(
				'the active session to follow the active editor',
				() => extension.resultsViewProvider.activeSessionUri === first.uri.toString(),
				15000,
				describeState
			);
			if(Date.now() - switchStartedAt > 1000) {
				console.log(`The active session took ${Date.now() - switchStartedAt}ms to follow the active editor (about 50ms locally).\n${describeState()}`);
			}

			// Nothing to wait on for the negative case - onDidChangeActiveTextEditor fires and the
			// provider deliberately does nothing - so wait for the editor itself to change, then assert
			// the session did not.
			await vscode.window.showTextDocument(sessionless, { preview: false });
			await TestSupport.waitUntil(
				'the session-less document to become the active editor',
				() => vscode.window.activeTextEditor?.document.uri.toString() === sessionless.uri.toString(),
				15000,
				describeState
			);

			assert.strictEqual(extension.resultsViewProvider.activeSessionUri, first.uri.toString(), 'a SQL file that has never run anything must not blank the results view');
		} finally {
			editorChangeListener.dispose();

			for(let document of documents) {
				extension.resultsViewProvider.closeSession(document.uri.toString());
				await TestSupport.closeSessions(document.uri.toString());
			}

			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		}
	});

	// closeSession() is called directly rather than by closing a tab: the tab-close path is one line
	// in the constructor that calls exactly this, and closing an untitled document with content can
	// raise a save prompt a headless run can't answer.
	test('closing a session forgets it without disturbing its sibling', async () => {
		let closedKey = 'test://session-closed.sql';
		let survivingKey = 'test://session-surviving.sql';

		try {
			await TestSupport.execute(closedKey, 'select * from sales.customer');
			await TestSupport.execute(survivingKey, 'select * from sales.orders');

			extension.resultsViewProvider.closeSession(closedKey);

			assert.strictEqual(extension.resultsViewProvider.getSession(closedKey), undefined);
			assert.strictEqual(session(survivingKey).rows.length, 25, 'the other tab on the same connection is untouched');

			// closeSession() tears the connection down through forgetClose(), which is deliberately
			// fire-and-forget, so the teardown is still in flight when this returns. Await the same close
			// before reopening: a statement that arrives mid-teardown finds the connection no longer OPEN
			// and is refused. Nothing real hits that window - the tab is gone by then - but a test that
			// raced it would be asserting on the race rather than on the reopen.
			await TestSupport.closeSessions(closedKey);

			// Reopening the same uri starts clean rather than resurrecting the old rows and history.
			await TestSupport.execute(closedKey, 'select * from sales.customer');
			assert.deepStrictEqual(userStatements(closedKey), ['select * from sales.customer']);
		} finally {
			extension.resultsViewProvider.closeSession(closedKey);
			extension.resultsViewProvider.closeSession(survivingKey);
			await TestSupport.closeSessions(closedKey, survivingKey);
		}
	});
});
