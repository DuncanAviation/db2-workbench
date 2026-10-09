import * as assert from 'assert';
import * as vscode from 'vscode';
import { TestSupport } from './test-support.js';
import { WindowFocusLog } from './window-focus-log.js';

// Thin end-to-end proof that the wiring works (activation, DocumentFormattingEditProvider/
// DocumentRangeFormattingEditProvider registration, the formatSql command's delegation to VS
// Code's native format commands, and Configurations reading live settings overrides) --
// exhaustive algorithm coverage lives in src/formatting/sql-pretty-printer.spec.ts and friends,
// which run against plain strings without needing a real Extension Host.
suite('SQL Formatting Provider', () => {
	// Writing a setting and formatting against it is a couple of real round trips through the extension
	// host - comfortably over mocha's 2s default on a cold run, where the test profile's settings.json
	// is also being created for the first time.
	const CONFIGURATION_TIMEOUT_MS = 20000;

	suiteSetup(async function() {
		this.timeout(CONFIGURATION_TIMEOUT_MS);
		await vscode.extensions.getExtension('DuncanAviation.db2-workbench')?.activate();
	});

	/** How long a format command's edit gets to reach the extension host's copy of the document. */
	const FORMAT_TIMEOUT_MS = 5000;

	// Asks the registered provider for its edits and applies them, the way a format command would, and
	// hands back the formatted text. This is how every test except the native-command one formats.
	//
	// Twice, a run has left every test in this file unformatted together: the provider answered fine
	// each time, and the native command simply didn't apply its edits. Why is still open (see
	// runFormatDocumentCommand). Asking the provider directly takes the document and range as
	// arguments, so nothing about the window or the editor's state comes into it, while still going
	// through the real registration and the live db2-workbench.formatting.* settings.
	// Every test here expects a change, so no edits at all is always a failure.
	async function formatThroughProvider(editor: vscode.TextEditor, kind: 'document' | 'selection'): Promise<string> {
		let document = editor.document;
		let formattingOptions = {tabSize: <number>editor.options.tabSize, insertSpaces: <boolean>editor.options.insertSpaces};
		let edits = kind === 'document'
			? await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>('vscode.executeFormatDocumentProvider', document.uri, formattingOptions)
			: await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>('vscode.executeFormatRangeProvider', document.uri, editor.selection, formattingOptions);

		assert.ok((edits?.length ?? 0) > 0, `Asked for a ${kind} format, the provider returned no edits: it is not registered, or not answering, for ${document.uri.toString()} (language: ${document.languageId}).`);

		let workspaceEdit = new vscode.WorkspaceEdit();
		workspaceEdit.set(document.uri, edits ?? []);
		assert.ok(await vscode.workspace.applyEdit(workspaceEdit), `The provider's edits for ${document.uri.toString()} could not be applied.`);

		return document.getText();
	}

	// Runs VS Code's native Format Document command against `editor` and hands back the formatted text.
	// Only the test that proves the command wiring uses this; see formatThroughProvider for why.
	//
	// The command runs ONCE, and the wait is on the document changing. The command resolves in the
	// renderer, and the edit reaches this process's copy of the document as a separate message, so
	// reading straight after it returns is a race. A timeout reports everything needed to tell the
	// flake's possible causes apart; see describeUnformatted.
	async function runFormatDocumentCommand(editor: vscode.TextEditor): Promise<string> {
		let document = editor.document;
		let before = document.getText();

		assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), document.uri.toString(), 'Format Document acts on the active editor, and the document under test is not in it');

		// Moves focus to the editor within VS Code, in case an earlier test left it on a panel or view.
		await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');

		// Taken just before the command, since the state at the timeout can't say whether the window was
		// focused when the command ran.
		let stateBefore = {...vscode.window.state};
		let startedAtMs = WindowFocusLog.elapsedMs();

		// A command that formatted the wrong editor would change some other document instead.
		let otherChanges = new Set<string>();
		let listener = vscode.workspace.onDidChangeTextDocument(change => {
			if(change.document !== document && change.document.uri.scheme !== 'output') {
				otherChanges.add(change.document.uri.toString());
			}
		});

		try {
			await vscode.commands.executeCommand('editor.action.formatDocument');

			try {
				await TestSupport.waitUntil(`Format Document to change ${document.uri.toString()}`, () => document.getText() !== before, FORMAT_TIMEOUT_MS);
			} catch(error) {
				throw new Error(`${(<Error>error).message} ${await describeUnformatted(editor, before, stateBefore, startedAtMs, otherChanges)}`);
			}
		} finally {
			listener.dispose();
		}

		return document.getText();
	}

	/** How much longer a timed-out command gets, to tell an edit that arrives late from one that never does. */
	const LATE_EDIT_GRACE_MS = 5000;

	// What was and wasn't ready when Format Document left its document untouched. Each part rules one
	// explanation in or out:
	// - the provider, asked directly: whether our side answered at all;
	// - focus before the command, and whether it changed during the wait. An unfocused window alone
	//   does not stop the command: runs unfocused from start to end have passed. Focus is recorded
	//   anyway, in case it matters together with something else;
	// - other documents changed: the command went to the wrong editor;
	// - a late edit: the command is slow rather than dropped.
	async function describeUnformatted(editor: vscode.TextEditor, before: string, stateBefore: vscode.WindowState, startedAtMs: number, otherChanges: Set<string>): Promise<string> {
		let document = editor.document;

		let late: string;
		let provider: string;
		try {
			let lateStart = Date.now();
			await TestSupport.waitUntil('a late edit', () => document.getText() !== before, LATE_EDIT_GRACE_MS);
			late = `The edit did arrive, ${FORMAT_TIMEOUT_MS + Date.now() - lateStart}ms after the command: slow, not dropped.`;
			// The document is already formatted by now, so asking the provider again would prove nothing.
			provider = 'The provider answered, since its edit landed.';
		} catch {
			late = `Still unchanged ${LATE_EDIT_GRACE_MS}ms after the timeout: the command dropped its edits.`;

			let formattingOptions = {tabSize: 4, insertSpaces: false};
			let edits = await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>('vscode.executeFormatDocumentProvider', document.uri, formattingOptions);
			provider = (edits?.length ?? 0) > 0
				? `Asked directly, the provider returns ${edits?.length} edit(s), so it is registered and answering; the command did not apply them.`
				: 'Asked directly, the provider returns no edits: it is not registered, or not answering, for this document.';
		}

		let focus = `Before the command: focused=${stateBefore.focused}, active=${stateBefore.active}.`
			+ ` Now: focused=${vscode.window.state.focused}, active=${vscode.window.state.active}.`
			+ ` Lost focus during the wait: ${WindowFocusLog.lostFocusSince(startedAtMs)}.`;

		let visible = vscode.window.visibleTextEditors.some(open => open.document === document);
		let others = otherChanges.size > 0 ? `Other documents changed during the wait: ${[...otherChanges].join(', ')}.` : 'No other document changed.';

		return `${late} ${provider} ${focus} ${others} Document still in a visible editor: ${visible}.`
			+ ` Active editor: ${vscode.window.activeTextEditor?.document.uri.toString() ?? 'none'}. Language: ${document.languageId}.`
			+ `\nWindow focus so far this run:\n${WindowFocusLog.describe()}`;
	}

	async function openEditor(content: string): Promise<vscode.TextEditor> {
		let document = await vscode.workspace.openTextDocument({language: 'sql', content});
		return vscode.window.showTextDocument(document);
	}

	// Format Document over a fresh document, through the provider.
	async function formatWholeDocument(content: string): Promise<string> {
		return formatThroughProvider(await openEditor(content), 'document');
	}

	test('formats a whole document via the native Format Document command', async () => {
		let text = await runFormatDocumentCommand(await openEditor('select id from employees where active = 1'));

		// Keywords keep the case they were typed in: db2-workbench.formatting.keywordCase defaults to
		// "preserve", so a lowercase statement stays lowercase. Uppercasing is covered by the
		// configuration-override test below, which sets the setting it depends on rather than assuming
		// a default.
		assert.ok(/select id/i.test(text), 'expected the formatted text to keep its SELECT clause');
		assert.ok(/\nfrom employees/i.test(text), 'expected FROM to be broken onto its own line');
		assert.ok(/\nwhere active = 1/i.test(text), 'expected WHERE to be broken onto its own line');
	});

	test('formats a selection and extracts embedded host-code SQL, replacing the variable with a named parameter', async () => {
		let content = 'String sql = "SELECT * FROM foo WHERE id = " + custId + "";';
		let document = await vscode.workspace.openTextDocument({language: 'sql', content});
		let editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		let text = await formatThroughProvider(editor, 'selection');
		assert.ok(text.includes(':custId'), 'expected the extracted variable to become a named parameter');
		assert.ok(!text.includes('String sql'), 'expected the host language\'s own declaration syntax to be dropped');
	});

	test('expands a partial selection to the whole enclosing statement', async () => {
		let content = 'select id from employees where active = 1;\nselect id from departments;';
		let document = await vscode.workspace.openTextDocument({language: 'sql', content});
		let editor = await vscode.window.showTextDocument(document);
		let idIndex = content.indexOf('id');
		editor.selection = new vscode.Selection(document.positionAt(idIndex), document.positionAt(idIndex + 'id'.length));
		let text = await formatThroughProvider(editor, 'selection');
		assert.ok(text.includes('select id\nfrom employees'), 'expected the whole first statement to be reformatted onto multiple lines, not just the selected "id"');
		assert.ok(text.includes('select id from departments;'), 'expected the untouched second statement to stay unformatted');
	});

	test('preserves blank lines above a formatted statement the same way it already preserves them below', async () => {
		let content = 'select id from employees;\n\n\nselect id from departments where active = 1;\n\n\nselect id from locations;';
		let document = await vscode.workspace.openTextDocument({language: 'sql', content});
		let editor = await vscode.window.showTextDocument(document);
		let idIndex = content.indexOf('departments');
		editor.selection = new vscode.Selection(document.positionAt(idIndex), document.positionAt(idIndex + 'departments'.length));
		let text = await formatThroughProvider(editor, 'selection');
		assert.ok(text.includes('select id from employees;\n\n\nselect id\nfrom departments'), 'expected the blank lines above the reformatted statement to survive untouched');
		assert.ok(text.includes('where active = 1;\n\n\nselect id from locations;'), 'expected the blank lines below the reformatted statement to survive untouched');
	});

	test('strips leading indentation on the first line of an embedded-SQL paste, not just blank lines', async () => {
		let content = '\t\t\t`select rcid, rcdsts, usrtype, fnam, lnam, mnam, prfnam, email ` +\n\t\t\t`from appuser ` +\n\t\t\t`where 1 = 1 `;';
		let document = await vscode.workspace.openTextDocument({language: 'sql', content});
		let editor = await vscode.window.showTextDocument(document);
		editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(content.length));
		let text = await formatThroughProvider(editor, 'selection');
		assert.ok(!/^[ \t]/.test(text), 'expected the leading indentation before the pasted statement to be stripped, not preserved like a blank line');
		assert.ok(/^select/i.test(text), 'expected the formatted statement to start cleanly with SELECT');
	});

	test('formats a whole document that is nothing but a pasted embedded-SQL snippet, same as Format Selection would', async () => {
		let content = '\t\t\t`select rcid, rcdsts, usrtype, fnam, lnam, mnam, prfnam, email ` +\n\t\t\t`from appuser ` +\n\t\t\t`where 1 = 1 `';
		let document = await vscode.workspace.openTextDocument({language: 'sql', content});
		let editor = await vscode.window.showTextDocument(document);
		let text = await formatThroughProvider(editor, 'document');
		assert.ok(!text.includes('`'), 'expected the template-literal backticks to be stripped by Format Document, same as Format Selection');
		assert.ok(!text.includes(' +\n'), 'expected the host-language concatenation operator to be gone, not just reformatted');
		assert.ok(/^select/i.test(text), 'expected the formatted statement to start cleanly with SELECT');
	});

	test('does not drop a second, unrelated statement when the first is an embedded-SQL paste', async () => {
		let content = '\t\t`select rcid ` +\n\t\t`from appuser ` +\n\t\t`where 1 = 1 `\n\t\t;\n\nselect id\nfrom departments;';
		let document = await vscode.workspace.openTextDocument({language: 'sql', content});
		let editor = await vscode.window.showTextDocument(document);
		let text = await formatThroughProvider(editor, 'document');
		assert.ok(/from\s+departments/i.test(text), 'expected the second, unrelated statement to survive formatting, not be dropped as if it were host-code declaration syntax');
	});

	test('keeps a semicolon after an embedded-SQL statement when another statement follows, but drops it when nothing follows', async () => {
		let content = '\t\t`select rcid ` +\n\t\t`from appuser `\n\t\t;\n\nselect id\nfrom departments;';
		let document = await vscode.workspace.openTextDocument({language: 'sql', content});
		let editor = await vscode.window.showTextDocument(document);
		let text = await formatThroughProvider(editor, 'document');
		assert.ok(/appuser;/i.test(text), 'expected the semicolon between the two statements to survive, not be merged into one statement');
		assert.strictEqual(text.split(';').length - 1, 2, 'expected exactly two semicolons total: one separating the statements, one terminating the last');
	});

	test('reads a live db2-workbench.formatting.* configuration override', async function() {
		this.timeout(CONFIGURATION_TIMEOUT_MS);

		let configuration = vscode.workspace.getConfiguration('db2-workbench');
		await configuration.update('formatting.keywordCase', 'lower', vscode.ConfigurationTarget.Global);

		try {
			let text = await formatWholeDocument('SELECT id FROM employees');
			assert.ok(text.includes('select'), 'expected the "lower" keywordCase override to take effect');
		} finally {
			await configuration.update('formatting.keywordCase', undefined, vscode.ConfigurationTarget.Global);
		}
	});
});
