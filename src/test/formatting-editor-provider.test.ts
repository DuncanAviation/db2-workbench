import * as assert from 'assert';
import { extension } from '../extension.js';
import type { SqlDocumentFormatter } from '../formatting/sql-document-formatter.js';
import { AlertUtils } from '../utils/alert-utils.js';
import type { FormattingEditorProvider } from '../views/formatting-editor-provider.js';
import type { FormattingEditorMessage } from '../webview-messages/formatting-editor-messages.js';
import { TestSupport } from './test-support.js';

/**
 * The SQL Formatting editor's Save, driven through the provider's own webview message handler - the
 * one the panel's Save button posts to. Each formatting option is its own setting, so a save is ten
 * separate writes: "saved" must only be said, and the panel only closed, once all of them have landed,
 * and a failed write must say so and leave the panel (and the user's edits) where they were.
 */
suite('FormattingEditorProvider', () => {
	const SAVED_OPTIONS: SqlDocumentFormatter.Options = {
		tabWidth: 3,
		useTabs: false,
		keywordCase: 'lower',
		denseOperators: true,
		removeComments: false,
		linesBetweenQueries: 2,
		expressionMaxWidth: 90,
		selectFieldWrapping: 'oneColumnPerLine',
		clauseLayout: 'expanded',
		indentJoins: true,
		indentWhere: true
	};

	let originalOptions: SqlDocumentFormatter.Options;
	let originalOnInfo: typeof AlertUtils.onInfo;
	let originalOnError: typeof AlertUtils.onError;
	let infos: { message: string; optionsAtTheTime: SqlDocumentFormatter.Options }[];
	let errors: unknown[];

	function provider(): FormattingEditorProvider {
		return extension.formattingEditorProvider;
	}

	function panelIsOpen(): boolean {
		return (<any>provider()).currentPanel !== undefined;
	}

	/** What the panel's Save button posts. */
	function save(options: SqlDocumentFormatter.Options) {
		let message: FormattingEditorMessage = { command: 'saveFormatting', options };
		(<any>provider()).handleWebviewMessage(message);
	}

	suiteSetup(async () => {
		await TestSupport.activate();
	});

	setup(() => {
		originalOptions = extension.configurations.formattingOptions;
		originalOnInfo = AlertUtils.onInfo;
		originalOnError = AlertUtils.onError;
		infos = [];
		errors = [];
		// Records what the user would be told, and what the settings held at that moment.
		AlertUtils.onInfo = message => infos.push({ message, optionsAtTheTime: extension.configurations.formattingOptions });
		AlertUtils.onError = error => errors.push(error);
		provider().show();
	});

	teardown(async () => {
		AlertUtils.onInfo = originalOnInfo;
		AlertUtils.onError = originalOnError;
		delete (<any>extension.configurations).setFormattingOptions;
		(<any>provider()).currentPanel?.dispose();
		await extension.configurations.setFormattingOptions(originalOptions);
	});

	test('says the options are saved only once every one of them has been written, then closes', async () => {
		save(SAVED_OPTIONS);

		await TestSupport.waitUntil('Save to finish', () => infos.length > 0, 15000);

		assert.deepStrictEqual(infos, [{ message: 'Formatting options saved.', optionsAtTheTime: SAVED_OPTIONS }]);
		assert.deepStrictEqual(errors, []);
		assert.strictEqual(panelIsOpen(), false);
	});

	test('a failed write says so and leaves the editor open', async () => {
		// Shadows the prototype method on this one instance; teardown deletes it again.
		(<any>extension.configurations).setFormattingOptions = () => Promise.reject(new Error('settings.json is read-only'));

		save(SAVED_OPTIONS);

		await TestSupport.waitUntil('Save to fail', () => errors.length > 0, 15000);

		assert.deepStrictEqual(errors, ['Could not save the formatting options: settings.json is read-only']);
		assert.deepStrictEqual(infos, []);
		assert.strictEqual(panelIsOpen(), true);
	});
});
