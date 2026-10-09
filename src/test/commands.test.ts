import * as assert from 'assert';
import * as vscode from 'vscode';
import { DbConnectionEvent } from '../events/db-connection-event.js';
import { extension } from '../extension.js';
import { TestSupport } from './test-support.js';

/**
 * The execute commands, invoked the way a keybinding or a menu item invokes them - through
 * vscode.commands.executeCommand against a real SQL editor - rather than by calling the handlers.
 *
 * Two things here are only reachable at this tier. The first is which statements a command resolves
 * out of the editor: executeSql runs the one at the cursor, executeSelectedSql runs every statement
 * the selection touches, executeAllSql runs the file. The second is the exhaustMap contract - all
 * three commands push onto one Subject piped through exhaustMap, so a second execute arriving while
 * one is still running is DROPPED, not queued. That is a real user-facing rule (leaning on the
 * keybinding must not stack up runs against the database) and no unit test can see it, because it is
 * a property of the pipeline the command handlers are wired into rather than of the handlers.
 *
 * Note that executeCommand resolves as soon as the handler has pushed onto the Subject, not when the
 * statement has run - so every test here waits on the DbConnectionEvents that follow, never on the
 * command's own promise.
 */
suite('Commands', () => {
	const EXECUTING = DbConnectionEvent.EventType.EXECUTING;
	const RESULT = DbConnectionEvent.EventType.RESULT;

	let documents: vscode.TextDocument[] = [];

	/** Opens a SQL editor and leaves the cursor at `cursorOffset`, the way a user's would be. */
	async function openSqlEditor(content: string, cursorOffset = 0): Promise<vscode.TextDocument> {
		let document = await vscode.workspace.openTextDocument({ language: 'sql', content: content });
		documents.push(document);

		let editor = await vscode.window.showTextDocument(document, { preview: false });
		let position = document.positionAt(cursorOffset);
		editor.selection = new vscode.Selection(position, position);

		return document;
	}

	/** Selects from one offset to another, for the commands that read a highlighted range. */
	async function select(document: vscode.TextDocument, startOffset: number, endOffset: number): Promise<void> {
		let editor = await vscode.window.showTextDocument(document, { preview: false });
		editor.selection = new vscode.Selection(document.positionAt(startOffset), document.positionAt(endOffset));
	}

	/** The statements that actually reached the database, in the order they ran. */
	function executedSql(recorder: TestSupport.EventRecorder): (string | undefined)[] {
		return recorder.ofType(EXECUTING, { userStatementsOnly: true }).map(event => event.parseResults?.originalSql);
	}

	suiteSetup(async () => {
		await TestSupport.activate();
	});

	teardown(async () => {
		for(let document of documents) {
			extension.resultsViewProvider.closeSession(document.uri.toString());
			await TestSupport.closeSessions(document.uri.toString());
		}

		documents = [];
		TestSupport.restoreDriver();
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('executeSql runs only the statement the cursor is in', async () => {
		let content = 'select * from sales.customer;\nselect * from sales.orders;\nselect * from sales.shipment;';
		let document = await openSqlEditor(content, content.indexOf('sales.orders'));
		let recorder = TestSupport.recordEvents(document.uri.toString());

		try {
			await vscode.commands.executeCommand('db2-workbench.executeSql');
			await recorder.waitFor(RESULT, { userStatementsOnly: true });

			assert.deepStrictEqual(executedSql(recorder), ['select * from sales.orders']);
		} finally {
			recorder.stop();
		}
	});

	test('executeAllSql runs every statement in the file, in document order', async () => {
		let content = 'select * from sales.customer;\nselect * from sales.orders;\nselect * from sales.shipment;';
		let document = await openSqlEditor(content);
		let recorder = TestSupport.recordEvents(document.uri.toString());

		try {
			await vscode.commands.executeCommand('db2-workbench.executeAllSql');

			// runStatements awaits each statement in turn, so the last one arriving means all three did.
			await TestSupport.waitUntil('all three statements to run', () => executedSql(recorder).length === 3);

			assert.deepStrictEqual(executedSql(recorder), [
				'select * from sales.customer',
				'select * from sales.orders',
				'select * from sales.shipment'
			]);
		} finally {
			recorder.stop();
		}
	});

	// executeSql deliberately runs only the FIRST statement a highlighted selection touches;
	// executeSelectedSql runs all of them. Same selection, two commands, so the difference is the
	// command rather than the selection.
	test('executeSelectedSql runs every statement the selection touches, unlike executeSql', async () => {
		let content = 'select * from sales.customer;\nselect * from sales.orders;\nselect * from sales.shipment;';
		let document = await openSqlEditor(content);
		let recorder = TestSupport.recordEvents(document.uri.toString());

		try {
			// From inside the first statement to inside the second - touching two, not the third.
			await select(document, content.indexOf('sales.customer'), content.indexOf('sales.orders') + 'sales.orders'.length);

			await vscode.commands.executeCommand('db2-workbench.executeSelectedSql');
			await TestSupport.waitUntil('both selected statements to run', () => executedSql(recorder).length === 2);

			assert.deepStrictEqual(executedSql(recorder), ['select * from sales.customer', 'select * from sales.orders']);

			await vscode.commands.executeCommand('db2-workbench.executeSql');
			await TestSupport.waitUntil('the single-statement command to run', () => executedSql(recorder).length === 3);

			assert.deepStrictEqual(executedSql(recorder).slice(2), ['select * from sales.customer'], 'executeSql runs only the first statement the same selection touches');
		} finally {
			recorder.stop();
		}
	});

	// The exhaustMap contract. A slow statement holds the pipeline open while a second command is
	// issued; that second command must be dropped outright rather than queued to run afterwards.
	// Holding the keybinding down, or double-clicking the toolbar button, is the real case.
	test('a second execute arriving while one is in flight is dropped, not queued', async () => {
		// Installed before the session opens: a connection keeps the driver instance it was opened with.
		TestSupport.useDriver({
			database: TestSupport.DATABASE,
			responses: [{ match: /from\s+sales\.orders/i, rows: [{ ORDNO: 1 }], delayMs: 400 }]
		});

		let document = await openSqlEditor('select * from sales.orders');
		let recorder = TestSupport.recordEvents(document.uri.toString());

		try {
			// Both commands are issued before the first statement can finish. executeCommand resolves as
			// soon as the handler has pushed onto the Subject, so awaiting it does not await the run.
			await vscode.commands.executeCommand('db2-workbench.executeSql');
			await vscode.commands.executeCommand('db2-workbench.executeSql');

			await recorder.waitFor(RESULT, { userStatementsOnly: true });

			assert.strictEqual(executedSql(recorder).length, 1, 'the overlapping execute must be dropped while one is in flight');

			// ...and the pipeline is not left closed: a later command runs normally.
			//
			// RESULT is fired from inside the run, and READY from its `finally` - so even at READY the
			// exhaustMap inner has not quite completed, and a command issued in that gap is dropped just
			// like the overlapping one above. Re-issuing until one lands is the honest way to assert
			// "the pipeline reopens" without asserting on exactly when. It is a poll on a condition, not
			// a sleep: it stops on the first command that gets through.
			await recorder.waitFor(DbConnectionEvent.EventType.READY);

			let deadline = Date.now() + 5000;

			while(executedSql(recorder).length < 2 && Date.now() < deadline) {
				await vscode.commands.executeCommand('db2-workbench.executeSql');
				await new Promise(resolve => setTimeout(resolve, 25));
			}

			assert.strictEqual(executedSql(recorder).length, 2, 'the pipeline must accept a new execute once the previous one finishes');

			// Drain it before leaving. The pipeline is shared by every execute command in the extension,
			// so a run still in flight at the end of this test is one the NEXT test's command gets
			// dropped behind - which is the contract working exactly as intended, reported as an
			// unrelated failure.
			await TestSupport.waitUntil('the last execute to finish', () => recorder.ofType(RESULT, { userStatementsOnly: true }).length === 2);
		} finally {
			recorder.stop();
		}
	});

	// Fail-fast: one statement missing a parameter value blocks the whole batch, including the
	// statements ahead of it that would have run fine. A partially executed batch is the thing worth
	// preventing here - the user gets one warning and the Parameters tab, not three rows and an error.
	test('a batch with an unfilled parameter runs nothing at all and asks for the parameter', async () => {
		let content = 'select * from sales.customer;\nselect * from sales.orders where ordno = :orderNumber;';
		let document = await openSqlEditor(content);
		let recorder = TestSupport.recordEvents(document.uri.toString());

		try {
			// The session has to exist before the parameter check can focus its Parameters tab, and
			// running the first statement on its own is how a user would have got there.
			await TestSupport.execute(document.uri.toString(), 'select * from sales.customer');
			let baseline = executedSql(recorder).length;

			await vscode.commands.executeCommand('db2-workbench.executeAllSql');

			await TestSupport.waitUntil(
				'the blocked batch to ask for its parameter',
				() => (extension.resultsViewProvider.getSession(document.uri.toString())?.parameterFocusRequest?.nonce ?? 0) > 0
			);

			assert.strictEqual(executedSql(recorder).length, baseline, 'nothing in the batch may run while one of its statements is missing a value');
		} finally {
			recorder.stop();
		}
	});

	test('an execute command in a non-SQL editor runs nothing', async () => {
		let document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'select * from sales.customer' });
		documents.push(document);
		await vscode.window.showTextDocument(document, { preview: false });

		let recorder = TestSupport.recordEvents(document.uri.toString());

		try {
			await vscode.commands.executeCommand('db2-workbench.executeSql');

			// Nothing to wait on when the answer is "no event ever fires", so this asserts against the
			// one thing that would prove otherwise - a session being established for this document.
			assert.deepStrictEqual(recorder.events, []);
			assert.strictEqual(extension.resultsViewProvider.getSession(document.uri.toString()), undefined);
		} finally {
			recorder.stop();
		}
	});

	// View Table Details resolves the name at the cursor against tables and views alike, and hands the
	// schema browser the kind it found - a view opens its view tab. Only the resolved target is asserted,
	// so the schema browser itself is stubbed rather than opened.
	test('viewTableDetails resolves a table or a view at the cursor to a target of that kind', async () => {
		let original = extension.schemasProvider.show;
		let targets: unknown[] = [];
		extension.schemasProvider.show = async (_config, target) => {
			targets.push(target);
		};

		try {
			let content = 'select * from sales.custord join customer on 1 = 1 join nosuch on 1 = 1';

			for(let name of ['custord', 'customer', 'nosuch']) {
				await openSqlEditor(content, content.indexOf(name) + 1);
				await vscode.commands.executeCommand('db2-workbench.viewTableDetails');
			}

			assert.deepStrictEqual(targets, [
				{ kind: 'view', schema: 'SALES', table: 'CUSTORD' },
				{ kind: 'table', schema: 'SALES', table: 'CUSTOMER' },
				{ kind: 'filter', filterText: 'nosuch' }
			]);
		} finally {
			extension.schemasProvider.show = original;
		}
	});

	// A call opens its function by specific name; an overloaded name can't say which overload, so it opens
	// the tree filtered to the name. A "name(" that isn't a function falls through to the table path, and
	// a table before an INSERT's column list is never taken for a call.
	test('viewTableDetails on a function call opens that function, or a filter for an overloaded one', async () => {
		let original = extension.schemasProvider.show;
		let targets: unknown[] = [];
		extension.schemasProvider.show = async (_config, target) => {
			targets.push(target);
		};

		try {
			let calls = 'select sales.open_orders(custno), order_total(ordno), nosuchfn(1) from orders';

			for(let name of ['open_orders', 'order_total', 'nosuchfn']) {
				await openSqlEditor(calls, calls.indexOf(name) + 1);
				await vscode.commands.executeCommand('db2-workbench.viewTableDetails');
			}

			let insert = 'insert into orders (ordno) values (1)';
			await openSqlEditor(insert, insert.indexOf('orders') + 1);
			await vscode.commands.executeCommand('db2-workbench.viewTableDetails');

			assert.deepStrictEqual(targets, [
				{ kind: 'function', schema: 'SALES', table: 'OPEN_ORDERS' },
				{ kind: 'filter', filterText: 'order_total' },
				{ kind: 'table', schema: 'SALES', table: 'ORDERS' }
			]);
		} finally {
			extension.schemasProvider.show = original;
		}
	});

	// The name after CALL is a procedure, never the same-named function, resolved through the library list
	// the way the CALL runs. ORDER_TOTAL's two procedure overloads open the filter; a CALL of a procedure
	// that doesn't exist opens nothing.
	test('viewTableDetails on a CALL opens that procedure, or a filter for an overloaded one', async () => {
		let original = extension.schemasProvider.show;
		let targets: unknown[] = [];
		extension.schemasProvider.show = async (_config, target) => {
			targets.push(target);
		};

		try {
			for(let [statement, name] of [
				['call next_order_number(\'ORD\', ?)', 'next_order_number'],
				['{call sales.order_history(?)}', 'order_history'],
				['call order_total', 'order_total'],
				['call nosuchproc(1)', 'nosuchproc']
			]) {
				await openSqlEditor(statement, statement.indexOf(name) + 1);
				await vscode.commands.executeCommand('db2-workbench.viewTableDetails');
			}

			assert.deepStrictEqual(targets, [
				{ kind: 'procedure', schema: 'SALES', table: 'NEXT_ORDER_NUMBER' },
				{ kind: 'procedure', schema: 'SALES', table: 'ORDER_HISTORY' },
				{ kind: 'filter', filterText: 'order_total' }
			]);
		} finally {
			extension.schemasProvider.show = original;
		}
	});
});
