import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConnectionConfig } from '../../src/models/connection-config';
import type { ConnectionEditorInboundMessage, ConnectionEditorInitialState, ConnectionEditorOutboundMessage } from '../../src/webview-messages/connection-editor-messages';
import { postFromHost } from '../test-support/host-messages';
import { renderWebview } from '../test-support/render-webview';
import { postedMessages } from '../test-support/vscode-api-stub';
import { App } from './app';

// The connection editor's half of connection-editor-messages.ts. The host side
// (ConnectionEditorProvider) writes a saveConnection payload over the stored ConnectionConfig
// wholesale - `connections[index] = message.connection` - so whatever this webview leaves out of that
// payload is not "unchanged", it is deleted from the user's settings. Several tests below are about
// exactly that.

const DEFAULT_CONNECTION_STRING = 'DRIVER=IBM i Access ODBC Driver;SYSTEM=${host};UID=${userName};PWD=${password}';

const SAVED: ConnectionConfig = {
	id: '1700000000000',
	name: 'Production',
	host: 'PRODHOST',
	userName: 'TESTUSER',
	defaultTableSchema: 'SALES',
	driver: 'odbc',
	resultBorderColor: '#ff0000',
	sqlImportIds: ['import-a']
};

// What ConnectionEditorProvider.show() passes for "New Connection".
const NEW: ConnectionConfig = { id: '', name: '', host: '', userName: '', defaultTableSchema: '' };

function renderEditor(config: ConnectionConfig, overrides: Partial<ConnectionEditorInitialState> = {}) {
	return renderWebview(<App />, {
		initialState: { config, defaultConnectionString: DEFAULT_CONNECTION_STRING, sqlImports: [], ...overrides }
	});
}

function lastPosted(): ConnectionEditorOutboundMessage {
	let messages = postedMessages<ConnectionEditorOutboundMessage>();
	expect(messages.length).toBeGreaterThan(0);
	return messages[messages.length - 1];
}

function savedConnection(): ConnectionConfig {
	let message = lastPosted();
	if (message.command !== 'saveConnection') {
		throw new Error(`expected saveConnection, got ${message.command}`);
	}
	return message.connection;
}

describe('connection editor webview', () => {
	it('titles itself by whether the connection already exists', () => {
		renderEditor(NEW);
		expect(screen.getByRole('heading', { name: 'New Connection' })).toBeTruthy();
	});

	it('saves an untouched existing connection back exactly as it was given', async () => {
		let user = userEvent.setup();
		renderEditor(SAVED);

		expect(screen.getByRole('heading', { name: 'Edit Connection' })).toBeTruthy();
		await user.click(screen.getByRole('button', { name: 'Save' }));

		// Every field, including the ones this form has no control for: dropping one here deletes it
		// from settings, since the host replaces the stored config with this payload.
		expect(postedMessages<ConnectionEditorOutboundMessage>()).toEqual([{
			command: 'saveConnection',
			connection: { ...SAVED, connectionString: undefined }
		}]);
	});

	it('keeps a connection\'s driver when it is edited and saved', async () => {
		let user = userEvent.setup();
		renderEditor({ ...SAVED, driver: 'fake' });

		await user.clear(screen.getByRole('textbox', { name: 'Name' }));
		await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Renamed');
		await user.click(screen.getByRole('button', { name: 'Save' }));

		expect(savedConnection().name).toBe('Renamed');
		expect(savedConnection().driver).toBe('fake');
	});

	it('saves the edited field values', async () => {
		let user = userEvent.setup();
		renderEditor(NEW);

		await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Test');
		await user.type(screen.getByRole('textbox', { name: 'Host' }), 'TESTHOST');
		await user.type(screen.getByRole('textbox', { name: 'User Name' }), 'TESTUSER');
		await user.type(screen.getByRole('textbox', { name: 'Default Table Schema' }), 'LIB1');
		await user.click(screen.getByRole('button', { name: 'Save' }));

		expect(savedConnection()).toMatchObject({ id: '', name: 'Test', host: 'TESTHOST', userName: 'TESTUSER', defaultTableSchema: 'LIB1' });
	});

	describe('results border color', () => {
		it('a new connection saved without choosing a color gets no border color', async () => {
			let user = userEvent.setup();
			renderEditor(NEW);

			await user.click(screen.getByRole('button', { name: 'Save' }));

			// The color input has to show *some* value and shows black - but black was never chosen, and
			// saving it would draw a 2px black border around every result for this connection.
			expect(savedConnection().resultBorderColor).toBeUndefined();
		});

		it('keeps a color that was already set', async () => {
			let user = userEvent.setup();
			renderEditor(SAVED);

			await user.click(screen.getByRole('button', { name: 'Save' }));

			expect(savedConnection().resultBorderColor).toBe('#ff0000');
		});

		it('Remove clears it', async () => {
			let user = userEvent.setup();
			renderEditor(SAVED);

			await user.click(screen.getByRole('button', { name: 'Remove' }));
			await user.click(screen.getByRole('button', { name: 'Save' }));

			expect(savedConnection().resultBorderColor).toBeUndefined();
		});
	});

	describe('connection string', () => {
		it('shows the driver default, read-only, until customized', () => {
			renderEditor(SAVED);

			let field = screen.getByRole('textbox', { name: 'Connection String' }) as HTMLTextAreaElement;
			expect(field.value).toBe(DEFAULT_CONNECTION_STRING);
			expect(field.disabled).toBe(true);
		});

		it('customizing starts from the default, and the custom string is what gets saved', async () => {
			let user = userEvent.setup();
			renderEditor(SAVED);

			await user.click(screen.getByRole('switch', { name: 'Customize Connection String' }));
			let field = screen.getByRole('textbox', { name: 'Connection String' }) as HTMLTextAreaElement;
			expect(field.disabled).toBe(false);
			expect(field.value).toBe(DEFAULT_CONNECTION_STRING);

			await user.type(field, ';NAM=1');
			await user.click(screen.getByRole('button', { name: 'Save' }));

			expect(savedConnection().connectionString).toBe(`${DEFAULT_CONNECTION_STRING};NAM=1`);
		});

		it('turning customization back off saves no connection string, so the driver default applies', async () => {
			let user = userEvent.setup();
			renderEditor({ ...SAVED, connectionString: 'DSN=CUSTOM' });

			expect((screen.getByRole('textbox', { name: 'Connection String' }) as HTMLTextAreaElement).value).toBe('DSN=CUSTOM');

			await user.click(screen.getByRole('switch', { name: 'Customize Connection String' }));
			await user.click(screen.getByRole('button', { name: 'Save' }));

			expect(savedConnection().connectionString).toBeUndefined();
		});
	});

	describe('SQL schema imports', () => {
		it('lists no imports section at all when none are saved', () => {
			renderEditor(SAVED);

			expect(screen.queryByText('SQL Schema Imports')).toBeNull();
			expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
		});

		it('links and unlinks saved imports', async () => {
			let user = userEvent.setup();
			renderEditor(SAVED, { sqlImports: [{ id: 'import-a', name: 'Site metadata' }, { id: 'import-b', name: 'Part descriptions' }] });

			let first = screen.getByRole('checkbox', { name: 'Site metadata' }) as HTMLInputElement;
			let second = screen.getByRole('checkbox', { name: 'Part descriptions' }) as HTMLInputElement;
			expect(first.checked).toBe(true);
			expect(second.checked).toBe(false);

			await user.click(first);
			await user.click(second);
			await user.click(screen.getByRole('button', { name: 'Save' }));

			expect(savedConnection().sqlImportIds).toEqual(['import-b']);
		});
	});

	describe('test connection', () => {
		it('posts the in-progress values, including the driver, and waits for the host', async () => {
			let user = userEvent.setup();
			renderEditor({ ...SAVED, driver: 'fake' });

			await user.clear(screen.getByRole('textbox', { name: 'Host' }));
			await user.type(screen.getByRole('textbox', { name: 'Host' }), 'OTHERHOST');
			await user.click(screen.getByRole('button', { name: 'Test Connection' }));

			let message = lastPosted();
			expect(message.command).toBe('testConnection');
			// The host picks the driver to test with from this payload (extension.drivers.get(config)),
			// so without it a connection on another driver is tested with the default one instead.
			expect(message.command === 'testConnection' && message.connection).toMatchObject({ id: SAVED.id, host: 'OTHERHOST', driver: 'fake', connectionString: undefined });
			expect((screen.getByRole('button', { name: 'Test Connection' }) as HTMLButtonElement).disabled).toBe(true);
		});

		it('shows a successful result and re-enables the button', async () => {
			let user = userEvent.setup();
			renderEditor(SAVED);

			await user.click(screen.getByRole('button', { name: 'Test Connection' }));
			postFromHost<ConnectionEditorInboundMessage>({ command: 'testConnectionResult', success: true, message: 'Successfully connected to PRODHOST.' });

			expect(screen.getByRole('alert').textContent).toBe('Successfully connected to PRODHOST.');
			expect((screen.getByRole('button', { name: 'Test Connection' }) as HTMLButtonElement).disabled).toBe(false);
		});

		it('shows a failure with the driver\'s error detail', async () => {
			let user = userEvent.setup();
			renderEditor(SAVED);

			await user.click(screen.getByRole('button', { name: 'Test Connection' }));
			postFromHost<ConnectionEditorInboundMessage>({
				command: 'testConnectionResult',
				success: false,
				message: 'Unable to connect.',
				driverErrors: [{ message: '[IBM][System i Access ODBC Driver]Communication link failure', code: 10060, state: '08S01' }]
			});

			expect(screen.getByRole('alert').textContent).toBe('Unable to connect.');
			expect(screen.getByText('[IBM][System i Access ODBC Driver]Communication link failure')).toBeTruthy();
			expect(screen.getByText('08S01')).toBeTruthy();
		});
	});

	describe('set password', () => {
		function setPasswordButton(): HTMLButtonElement {
			return screen.getByRole('button', { name: 'Set Password' }) as HTMLButtonElement;
		}

		it('is offered on a new connection once it has a host and user name', async () => {
			let user = userEvent.setup();
			renderEditor(NEW);

			expect(setPasswordButton().disabled).toBe(true);
			await user.type(screen.getByRole('textbox', { name: 'Host' }), 'NEWHOST');
			expect(setPasswordButton().disabled).toBe(true);
			await user.type(screen.getByRole('textbox', { name: 'User Name' }), 'NEWUSER');
			expect(setPasswordButton().disabled).toBe(false);
		});

		// Passwords are stored by host and user name, so the host needs the values as typed, saved or not.
		// The password itself is prompted for by the host and never passes through the webview.
		it('posts the host and user name as typed, and nothing else', async () => {
			let user = userEvent.setup();
			renderEditor(SAVED);

			await user.clear(screen.getByRole('textbox', { name: 'User Name' }));
			await user.type(screen.getByRole('textbox', { name: 'User Name' }), 'OTHERUSER');
			await user.click(setPasswordButton());

			expect(postedMessages<ConnectionEditorOutboundMessage>()).toEqual([{ command: 'setPassword', host: 'PRODHOST', userName: 'OTHERUSER' }]);
		});

		it('says so once the host has stored the new password', async () => {
			let user = userEvent.setup();
			renderEditor(SAVED);

			await user.click(setPasswordButton());
			expect(screen.queryByRole('alert')).toBeNull();

			postFromHost<ConnectionEditorInboundMessage>({ command: 'passwordSet', message: 'Password set for TESTUSER@PRODHOST.' });

			expect(screen.getByRole('alert').textContent).toBe('Password set for TESTUSER@PRODHOST.');
		});
	});

	it('posts cancelEdit on Cancel, and nothing else', async () => {
		let user = userEvent.setup();
		renderEditor(SAVED);

		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(postedMessages<ConnectionEditorOutboundMessage>()).toEqual([{ command: 'cancelEdit' }]);
	});
});
