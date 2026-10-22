import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWebview } from '../../test-support/render-webview';
import { EditSchemaListDialog } from './edit-schema-list-dialog';

// A job's library list as LIBRARY_LIST_INFO reports it: system and current entries the dialog must leave
// alone, QTEMP fixed inside the user portion, and three user libraries to reorder.
const LIBRARY_LIST = [
	{ name: 'QSYS', type: 'SYSTEM' },
	{ name: 'QSYS2', type: 'SYSTEM' },
	{ name: 'MYCUR', type: 'CURRENT' },
	{ name: 'QTEMP', type: 'USER' },
	{ name: 'APPL', type: 'USER' },
	{ name: 'SALES', type: 'USER' },
	{ name: 'ARCHV', type: 'USER' }
];

function renderLive(overrides: Partial<Parameters<typeof EditSchemaListDialog>[0] & { mode: 'live' }> = {}) {
	let onSave = vi.fn();
	let onCancel = vi.fn();
	let checkLibrary = vi.fn(async (library: string) => library !== 'NOSUCH');

	let result = renderWebview(
		<EditSchemaListDialog mode="live" open libraryList={LIBRARY_LIST} applying={false} checkLibrary={checkLibrary} onCancel={onCancel} onSave={onSave} {...overrides} />
	);

	return { ...result, onSave, onCancel, checkLibrary };
}

function rowNames(): string[] {
	let list = screen.getByRole('list', { name: 'Library list' });
	return within(list).getAllByRole('listitem').map(item => item.getAttribute('aria-label') ?? '');
}

describe('EditSchemaListDialog in live mode', () => {
	it('lists the library list in order, labelling each entry with its type', () => {
		renderLive();

		expect(rowNames()).toEqual(['QSYS', 'QSYS2', 'MYCUR', 'QTEMP', 'APPL', 'SALES', 'ARCHV']);

		let current = within(screen.getByRole('listitem', { name: 'MYCUR' }));
		expect(current.getByText('Current')).toBeTruthy();
		expect(within(screen.getByRole('listitem', { name: 'QSYS' })).getByText('System')).toBeTruthy();
		expect(within(screen.getByRole('listitem', { name: 'APPL' })).getByText('User')).toBeTruthy();
	});

	it('offers no move or remove on system, current and QTEMP entries', () => {
		renderLive();

		for (let name of ['QSYS', 'QSYS2', 'MYCUR', 'QTEMP']) {
			expect(within(screen.getByRole('listitem', { name })).queryAllByRole('button')).toEqual([]);
		}

		expect(within(screen.getByRole('listitem', { name: 'SALES' })).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Move SALES up', 'Move SALES down', 'Remove SALES']);
	});

	it('reorders user entries past nothing fixed, and posts the ordered user portion', async () => {
		let { onSave } = renderLive();

		// APPL is the first movable entry - QTEMP above it stays put - and ARCHV the last.
		expect(screen.getByRole('button', { name: 'Move APPL up' }).hasAttribute('disabled')).toBe(true);
		expect(screen.getByRole('button', { name: 'Move ARCHV down' }).hasAttribute('disabled')).toBe(true);

		await userEvent.click(screen.getByRole('button', { name: 'Move SALES up' }));
		await userEvent.click(screen.getByRole('button', { name: 'Move APPL down' }));

		expect(rowNames()).toEqual(['QSYS', 'QSYS2', 'MYCUR', 'QTEMP', 'SALES', 'ARCHV', 'APPL']);

		await userEvent.click(screen.getByRole('button', { name: 'OK' }));

		// Only the user portion, QTEMP where it sits; the system and current entries are never sent.
		expect(onSave).toHaveBeenCalledWith(['QTEMP', 'SALES', 'ARCHV', 'APPL']);
	});

	it('removes a user entry', async () => {
		let { onSave } = renderLive();

		await userEvent.click(screen.getByRole('button', { name: 'Remove APPL' }));
		await userEvent.click(screen.getByRole('button', { name: 'OK' }));

		expect(onSave).toHaveBeenCalledWith(['QTEMP', 'SALES', 'ARCHV']);
	});

	it('adds a library last, upper-cased, by button or Enter, once the host says it exists', async () => {
		let { onSave, checkLibrary } = renderLive();
		let input = screen.getByRole('textbox', { name: 'Library name' });

		await userEvent.type(input, 'lltesta');
		await userEvent.click(screen.getByRole('button', { name: 'Add' }));
		await screen.findByRole('listitem', { name: 'LLTESTA' });
		await userEvent.type(input, 'lltestb{Enter}');
		await screen.findByRole('listitem', { name: 'LLTESTB' });

		expect(checkLibrary.mock.calls).toEqual([['LLTESTA'], ['LLTESTB']]);
		expect(rowNames().slice(-2)).toEqual(['LLTESTA', 'LLTESTB']);
		expect((input as HTMLInputElement).value).toBe('');

		await userEvent.click(screen.getByRole('button', { name: 'OK' }));
		expect(onSave).toHaveBeenCalledWith(['QTEMP', 'APPL', 'SALES', 'ARCHV', 'LLTESTA', 'LLTESTB']);
	});

	it('refuses a library the system doesn\'t have, leaving it out of the list', async () => {
		let { onSave } = renderLive();
		let input = screen.getByRole('textbox', { name: 'Library name' });

		await userEvent.type(input, 'nosuch');
		await userEvent.click(screen.getByRole('button', { name: 'Add' }));

		expect(await screen.findByText('Library NOSUCH was not found')).toBeTruthy();
		expect(rowNames()).not.toContain('NOSUCH');
		expect((input as HTMLInputElement).value).toBe('nosuch');

		// Editing the name clears the refusal.
		await userEvent.type(input, '2');
		expect(screen.queryByText('Library NOSUCH was not found')).toBeNull();

		await userEvent.click(screen.getByRole('button', { name: 'OK' }));
		expect(onSave).toHaveBeenCalledWith(['QTEMP', 'APPL', 'SALES', 'ARCHV']);
	});

	it('rejects a name that isn\'t a system name, or is already on the list, without asking the host', async () => {
		let { checkLibrary } = renderLive();
		let input = screen.getByRole('textbox', { name: 'Library name' });

		await userEvent.type(input, 'BAD) NAME');
		expect(screen.getByText(/Up to 10 characters/)).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Add' }).hasAttribute('disabled')).toBe(true);

		await userEvent.clear(input);
		await userEvent.type(input, 'sales');
		expect(screen.getByText('SALES is already on the library list')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Add' }).hasAttribute('disabled')).toBe(true);

		await userEvent.type(input, '{Enter}');
		expect(rowNames()).toEqual(['QSYS', 'QSYS2', 'MYCUR', 'QTEMP', 'APPL', 'SALES', 'ARCHV']);
		expect(checkLibrary).not.toHaveBeenCalled();
	});

	it('locks the edits while applying, and shows a refusal with its driver chain', () => {
		renderLive({
			applying: true,
			error: {
				message: 'SQL0443 - CPF2110 Library NOSUCH not found.',
				driverErrors: [{ code: -443, state: '38501', message: 'CPF2110 Library NOSUCH not found.' }]
			}
		});

		expect(screen.getByRole('button', { name: 'Applying...' }).hasAttribute('disabled')).toBe(true);
		expect(screen.getByRole('button', { name: 'Remove APPL' }).hasAttribute('disabled')).toBe(true);
		expect(screen.getByText('The library list was not changed: SQL0443 - CPF2110 Library NOSUCH not found.')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Copy error' })).toBeTruthy();
	});

	// The error sits below the list, which can push it out of sight.
	it('scrolls a refusal into view when it arrives', async () => {
		let scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;

		try {
			let { rerender } = renderLive();
			expect(scrollIntoView).not.toHaveBeenCalled();

			rerender(
				<EditSchemaListDialog
					mode="live"
					open
					libraryList={LIBRARY_LIST}
					applying={false}
					error={{ message: 'SQL0443 - CPF2110 Library NOSUCH not found.' }}
					checkLibrary={async () => true}
					onCancel={() => undefined}
					onSave={() => undefined}
				/>
			);

			await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
			expect((scrollIntoView.mock.contexts[0] as Element).textContent).toContain('The library list was not changed: SQL0443 - CPF2110 Library NOSUCH not found.');
		} finally {
			delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
		}
	});
});

describe('EditSchemaListDialog in overrides mode', () => {
	it('still hides, adds and deletes, with no reordering', async () => {
		let onSave = vi.fn();

		renderWebview(
			<EditSchemaListDialog
				mode="overrides"
				open
				schemaList={[{ name: 'SALES', hidden: false, added: false }, { name: 'EXTRA', hidden: false, added: true }]}
				onCancel={() => undefined}
				onSave={onSave}
			/>
		);

		expect(screen.queryByRole('button', { name: /Move/ })).toBeNull();

		await userEvent.click(screen.getAllByRole('button', { name: 'Hide' })[0]);
		await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
		await userEvent.click(screen.getByRole('button', { name: 'Add Schema' }));
		await userEvent.type(screen.getByPlaceholderText('Schema name'), 'NEWLIB');
		await userEvent.click(screen.getByRole('button', { name: 'OK' }));

		expect(onSave).toHaveBeenCalledWith({ hiddenSchemas: ['SALES'], newSchemas: ['NEWLIB'], deletedSchemas: ['EXTRA'] });
	});
});
