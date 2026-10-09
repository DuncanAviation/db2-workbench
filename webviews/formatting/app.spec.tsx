import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SqlDocumentFormatter } from '../../src/formatting/sql-document-formatter';
import type { FormattingEditorMessage, PreviewResultMessage } from '../../src/webview-messages/formatting-editor-messages';
import { useFakeTimeouts } from '../test-support/fake-timers';
import { postFromHost } from '../test-support/host-messages';
import { renderWebview } from '../test-support/render-webview';
import { postedMessages } from '../test-support/vscode-api-stub';
import { App } from './app';

// The formatting options editor's half of formatting-editor-messages.ts. The editor has no formatter
// of its own: every preview is a previewFormat round trip to the host, whose previewResult then
// replaces the SQL box's contents. What matters here is when a preview is asked for (option changes,
// debounced; paste; never on mount or on typing), and that every message carries the complete option
// set - the host saves saveFormatting's options as the whole setting.
//
// Timers are faked, so the 250ms debounce is stepped through rather than waited out.

const OPTIONS: SqlDocumentFormatter.Options = {
	tabWidth: 4,
	useTabs: true,
	keywordCase: 'upper',
	denseOperators: false,
	removeComments: false,
	linesBetweenQueries: 1,
	expressionMaxWidth: 80,
	selectFieldWrapping: 'wrapToWidth',
	clauseLayout: 'expanded',
	indentJoins: true,
	indentWhere: false
};

const INITIAL_SQL = 'SELECT *\nFROM SALES.CUSTOMER';
// What the host formatted INITIAL_SQL from: unformatted and with a comment, so a test can tell which
// of the two a preview was made from.
const SOURCE_SQL = 'select * -- every column\nfrom sales.customer';

function setupUser() {
	// userEvent's between-action pause is itself a setTimeout - see useFakeTimeouts().
	return userEvent.setup({ delay: null });
}

function renderEditor() {
	return renderWebview(<App />, { initialState: { options: OPTIONS, initialSql: INITIAL_SQL, sourceSql: SOURCE_SQL } });
}

function sqlBox(): HTMLTextAreaElement {
	// The only multi-line textbox; the option fields are single-line.
	return screen.getAllByRole('textbox').find(element => element.tagName === 'TEXTAREA' && !element.hasAttribute('aria-hidden')) as HTMLTextAreaElement;
}

function previews(): Extract<FormattingEditorMessage, { command: 'previewFormat' }>[] {
	return postedMessages<FormattingEditorMessage>().filter(message => message.command === 'previewFormat');
}

function advance(ms: number) {
	act(() => {
		vi.advanceTimersByTime(ms);
	});
}

describe('formatting editor webview', () => {
	let restoreTimers: () => void;

	beforeEach(() => {
		restoreTimers = useFakeTimeouts();
	});

	afterEach(() => {
		restoreTimers();
	});

	it('shows the seed SQL and the saved options', () => {
		renderEditor();

		expect(sqlBox().value).toBe(INITIAL_SQL);
		expect((screen.getByRole('checkbox', { name: 'Use Tabs' }) as HTMLInputElement).checked).toBe(true);
		expect((screen.getByRole('checkbox', { name: 'Indent Joins' }) as HTMLInputElement).checked).toBe(true);
		expect((screen.getByRole('checkbox', { name: 'Indent Where' }) as HTMLInputElement).checked).toBe(false);
		expect((screen.getByRole('checkbox', { name: 'Dense Operators' }) as HTMLInputElement).checked).toBe(false);
		expect(screen.getByRole('combobox', { name: 'Keyword Case' }).textContent).toBe('Upper');
		expect((screen.getByRole('spinbutton', { name: 'Max Width' }) as HTMLInputElement).value).toBe('80');
		// Tab Width does nothing while tabs are in use, so it is disabled rather than silently ignored.
		expect((screen.getByRole('spinbutton', { name: 'Tab Width' }) as HTMLInputElement).disabled).toBe(true);
	});

	it('does not ask for a preview on mount - the host already formatted the seed SQL', () => {
		renderEditor();

		advance(1000);

		expect(postedMessages()).toEqual([]);
		expect(sqlBox().value).toBe(INITIAL_SQL);
	});

	it('an option change asks for a preview after the debounce, with every option and the source text', async () => {
		let user = setupUser();
		renderEditor();

		await user.click(screen.getByRole('checkbox', { name: 'Dense Operators' }));

		advance(249);
		expect(previews()).toEqual([]);

		advance(1);
		expect(previews()).toEqual([{ command: 'previewFormat', sql: SOURCE_SQL, options: { ...OPTIONS, denseOperators: true } }]);
	});

	it('changes made inside the debounce window coalesce into one preview carrying all of them', async () => {
		let user = setupUser();
		renderEditor();

		await user.click(screen.getByRole('checkbox', { name: 'Dense Operators' }));
		await user.click(screen.getByRole('checkbox', { name: 'Remove Comments' }));
		await user.click(screen.getByRole('combobox', { name: 'Keyword Case' }));
		await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Lower' }));

		advance(250);

		expect(previews()).toEqual([{ command: 'previewFormat', sql: SOURCE_SQL, options: { ...OPTIONS, denseOperators: true, removeComments: true, keywordCase: 'lower' } }]);
	});

	it('unchecking Remove Comments formats the source again, so the comments come back', async () => {
		let user = setupUser();
		renderEditor();
		let removeComments = screen.getByRole('checkbox', { name: 'Remove Comments' });

		await user.click(removeComments);
		advance(250);
		postFromHost<PreviewResultMessage>({ command: 'previewResult', text: 'SELECT *\nFROM SALES.CUSTOMER' });

		await user.click(removeComments);
		advance(250);

		expect(previews().map(preview => preview.sql)).toEqual([SOURCE_SQL, SOURCE_SQL]);
		expect(previews()[1].options.removeComments).toBe(false);
	});

	it('an edit made after a preview becomes the new source, and a later option change keeps it', async () => {
		let user = setupUser();
		renderEditor();
		let removeComments = screen.getByRole('checkbox', { name: 'Remove Comments' });

		await user.click(removeComments);
		advance(250);
		postFromHost<PreviewResultMessage>({ command: 'previewResult', text: 'SELECT *\nFROM SALES.CUSTOMER' });

		await user.click(sqlBox());
		await user.keyboard('{Control>}{End}{/Control} WHERE ID = 1');
		await user.click(removeComments);
		advance(250);

		// The comment was gone when the user edited, so their edit is kept as written, not merged back
		// with the original source.
		expect(previews()[1].sql).toBe('SELECT *\nFROM SALES.CUSTOMER WHERE ID = 1');

		postFromHost<PreviewResultMessage>({ command: 'previewResult', text: 'SELECT *\nFROM SALES.CUSTOMER\nWHERE ID = 1' });
		await user.click(screen.getByRole('checkbox', { name: 'Dense Operators' }));
		advance(250);

		expect(previews()[2].sql).toBe('SELECT *\nFROM SALES.CUSTOMER WHERE ID = 1');
	});

	it('writes the host\'s previewResult into the SQL box in place', () => {
		renderEditor();

		postFromHost<PreviewResultMessage>({ command: 'previewResult', text: 'SELECT\n\t*\nFROM\n\tSALES.CUSTOMER' });

		expect(sqlBox().value).toBe('SELECT\n\t*\nFROM\n\tSALES.CUSTOMER');
	});

	it('typing in the SQL box never asks for a preview, and the next one uses the typed text', async () => {
		let user = setupUser();
		renderEditor();

		await user.click(sqlBox());
		await user.keyboard('{Control>}{End}{/Control} WHERE ID = 1');
		advance(1000);
		expect(previews()).toEqual([]);

		await user.click(screen.getByRole('checkbox', { name: 'Indent Joins' }));
		advance(250);

		expect(previews()).toHaveLength(1);
		expect(previews()[0].sql).toBe(`${INITIAL_SQL} WHERE ID = 1`);
	});

	it('pasting into the SQL box asks for a preview of the pasted-in text', async () => {
		let user = setupUser();
		renderEditor();

		await user.clear(sqlBox());
		await user.paste('select a,b from t');
		advance(0);

		expect(previews()).toEqual([{ command: 'previewFormat', sql: 'select a,b from t', options: OPTIONS }]);
	});

	it('Save posts the complete option set as edited', async () => {
		let user = setupUser();
		renderEditor();

		await user.click(screen.getByRole('checkbox', { name: 'Use Tabs' }));
		let tabWidth = screen.getByRole('spinbutton', { name: 'Tab Width' });
		await user.clear(tabWidth);
		await user.type(tabWidth, '2');
		await user.click(screen.getByRole('button', { name: 'Save' }));

		let saves = postedMessages<FormattingEditorMessage>().filter(message => message.command === 'saveFormatting');
		expect(saves).toEqual([{ command: 'saveFormatting', options: { ...OPTIONS, useTabs: false, tabWidth: 2 } }]);
	});

	it('Cancel posts cancelEdit', async () => {
		let user = setupUser();
		renderEditor();

		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(postedMessages()).toEqual([{ command: 'cancelEdit' }]);
	});
});
