import * as assert from 'assert';
import * as vscode from 'vscode';
import { Configurations } from '../configurations.js';
import type { SqlDocumentFormatter } from '../formatting/sql-document-formatter.js';
import { DataEditDefaults, DataEditSettings } from '../utils/data-edit-defaults.js';
import { TestSupport } from './test-support.js';

// Each formatting option is its own setting, and every write lands in the extension host's
// configuration service (and the test profile's settings.json) on its own schedule. The tests await
// setFormattingOptions(), which resolves once all ten writes have landed, rather than polling the getter
// against a deadline - a slow CI runner blew through the 2s one this used to have.
suite('Configurations', () => {
	suiteSetup(async () => {
		await vscode.extensions.getExtension('DuncanAviation.db2-workbench')?.activate();
	});

	let nonDefaultOptions: SqlDocumentFormatter.Options = {
		tabWidth: 2,
		useTabs: false,
		keywordCase: 'upper',
		denseOperators: true,
		removeComments: true,
		linesBetweenQueries: 3,
		expressionMaxWidth: 80,
		selectFieldWrapping: 'oneColumnPerLine',
		clauseLayout: 'expanded',
		indentJoins: true,
		indentWhere: true
	};

	test('setFormattingOptions round-trips through the getter once it resolves', async () => {
		let configurations = new Configurations();
		let originalOptions = configurations.formattingOptions;

		try {
			await configurations.setFormattingOptions(nonDefaultOptions);

			assert.deepStrictEqual(configurations.formattingOptions, nonDefaultOptions);
		} finally {
			await configurations.setFormattingOptions(originalOptions);
		}
	});

	test('the formattingOptions setter writes the same settings, without waiting for them', async () => {
		let configurations = new Configurations();
		let originalOptions = configurations.formattingOptions;

		try {
			// What the Formatting editor's Save does. The setter can't be awaited, so this polls - with a
			// deadline generous enough for a slow runner, since the writes take as long as they take.
			configurations.formattingOptions = nonDefaultOptions;

			await TestSupport.waitUntil('the formatting settings to land', () => JSON.stringify(configurations.formattingOptions) === JSON.stringify(nonDefaultOptions), 15000);
		} finally {
			await configurations.setFormattingOptions(originalOptions);
		}
	});

	test('restoreFormattingDefaults unsets every formatting.* override', async () => {
		let configurations = new Configurations();

		await configurations.setFormattingOptions(nonDefaultOptions);

		await configurations.restoreFormattingDefaults();

		assert.deepStrictEqual(configurations.formattingOptions, {
			tabWidth: 4,
			useTabs: true,
			keywordCase: 'preserve',
			denseOperators: false,
			removeComments: false,
			linesBetweenQueries: 1,
			expressionMaxWidth: 120,
			selectFieldWrapping: 'wrapToWidth',
			clauseLayout: 'compact',
			indentJoins: false,
			indentWhere: false
		});
	});

	// The Data tab's Settings dialog writes these, and settings.json has to hold only what was changed -
	// a value equal to the app's default left out, so a later release's default still reaches it.
	test('setDataEditSettings round-trips, NULL included, and leaves defaults out of settings.json', async () => {
		let configurations = new Configurations();
		let settings: DataEditSettings = { defaultValues: { CHAR: 'N/A', DATE: null, DECIMAL: '0' }, columnsWithTableDefault: 'appDefault', nullableColumns: 'null' };

		try {
			await configurations.setDataEditSettings(settings);

			assert.deepStrictEqual(configurations.dataEditSettings, { ...settings, defaultValues: { CHAR: 'N/A', DATE: null } });
			let inspected = vscode.workspace.getConfiguration('db2-workbench');
			assert.strictEqual(inspected.inspect(Configurations.Keys.DATA_EDIT_NULLABLE_COLUMNS)?.globalValue, undefined);
			assert.deepStrictEqual(inspected.inspect(Configurations.Keys.DATA_EDIT_DEFAULT_VALUES)?.globalValue, { CHAR: 'N/A', DATE: null });
		} finally {
			await configurations.setDataEditSettings(DataEditDefaults.DEFAULT_SETTINGS);
		}

		assert.deepStrictEqual(configurations.dataEditSettings, DataEditDefaults.DEFAULT_SETTINGS);
	});
});
