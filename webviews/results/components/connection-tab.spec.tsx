import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ResultsInboundMessage, ResultsOutboundMessage, ResultsSessionDetail } from '../../../src/webview-messages/results-messages';
import { postFromHost } from '../../test-support/host-messages';
import { renderWebview } from '../../test-support/render-webview';
import { postedMessages } from '../../test-support/vscode-api-stub';
import { ConnectionTab } from './connection-tab';

const URI = 'file:///c%3A/work/first.sql';
const JOB = { jobName: '123456/QUSER/QZDASOINIT', ip: '10.0.0.1', createdDate: '2026-01-01T08:00:00.000Z', sortSequence: '*HEX' };

function session(overrides: Partial<ResultsSessionDetail> = {}): ResultsSessionDetail {
	return {
		uri: URI,
		name: 'first.sql',
		sessionKind: 'editor',
		host: 'TESTHOST',
		connectionName: 'Test Connection',
		userName: 'TESTUSER',
		state: 'ready',
		connectionInfo: {
			jobDetails: JOB,
			workerJobDetails: { ...JOB, jobName: '123457/QUSER/QZDASOINIT' },
			schemas: [
				{ name: 'QSYS', type: 'SYSTEM' },
				{ name: 'QTEMP', type: 'USER' },
				{ name: 'APPL', type: 'USER' },
				{ name: 'SALES', type: 'USER' }
			]
		},
		histories: [],
		rows: [],
		columns: [],
		columnLabels: {},
		columnDetails: {},
		columnDataTypes: {},
		procedureOutParameters: [],
		isCursorOpen: false,
		isFetchingAll: false,
		parameters: [],
		parameterValues: {},
		...overrides
	};
}

describe('ConnectionTab', () => {
	it('lists the schema list in order with each entry\'s type', () => {
		renderWebview(<ConnectionTab session={session()} />);

		let entries = within(screen.getByRole('list', { name: 'Schema list' })).getAllByRole('listitem');
		expect(entries.map(entry => entry.textContent)).toEqual(['QSYSSystem', 'QTEMPUser', 'APPLUser', 'SALESUser']);
	});

	it('copies the schema list as a comma-delimited list of names, without the types', async () => {
		// setup() installs user-event's own clipboard on navigator, which readText() then reads back.
		const user = userEvent.setup();
		renderWebview(<ConnectionTab session={session()} />);

		await user.click(screen.getByRole('button', { name: 'Copy schema list' }));

		expect(await navigator.clipboard.readText()).toBe('QSYS, QTEMP, APPL, SALES');
	});

	it('posts the edited user portion, and closes the dialog once the host reports success', async () => {
		renderWebview(<ConnectionTab session={session()} />);

		await userEvent.click(screen.getByRole('button', { name: 'Edit schema list' }));
		await userEvent.click(screen.getByRole('button', { name: 'Move SALES up' }));
		await userEvent.click(screen.getByRole('button', { name: 'OK' }));

		expect(postedMessages<ResultsOutboundMessage>()).toEqual([{ command: 'setLibraryList', uri: URI, userLibraries: ['QTEMP', 'SALES', 'APPL'] }]);
		expect(screen.getByRole('button', { name: 'Applying...' })).toBeTruthy();

		// Another session's answer is not this dialog's.
		postFromHost<ResultsInboundMessage>({ command: 'libraryListResult', uri: 'file:///c%3A/work/other.sql' });
		expect(screen.getByRole('dialog')).toBeTruthy();

		postFromHost<ResultsInboundMessage>({ command: 'libraryListResult', uri: URI });
		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});

	it('asks the host whether a library exists before adding it', async () => {
		renderWebview(<ConnectionTab session={session()} />);

		await userEvent.click(screen.getByRole('button', { name: 'Edit schema list' }));
		await userEvent.type(screen.getByRole('textbox', { name: 'Library name' }), 'nosuch');
		await userEvent.click(screen.getByRole('button', { name: 'Add' }));

		expect(postedMessages<ResultsOutboundMessage>()).toEqual([{ command: 'checkLibrary', uri: URI, requestId: 0, library: 'NOSUCH' }]);

		postFromHost<ResultsInboundMessage>({ command: 'libraryCheckResult', uri: URI, requestId: 0, exists: false });
		expect(await screen.findByText('Library NOSUCH was not found')).toBeTruthy();

		await userEvent.clear(screen.getByRole('textbox', { name: 'Library name' }));
		await userEvent.type(screen.getByRole('textbox', { name: 'Library name' }), 'archive');
		await userEvent.click(screen.getByRole('button', { name: 'Add' }));

		postFromHost<ResultsInboundMessage>({ command: 'libraryCheckResult', uri: URI, requestId: 1, exists: true });
		expect(await screen.findByRole('listitem', { name: 'ARCHIVE' })).toBeTruthy();
	});

	it('keeps the dialog open on the user\'s edits when the host refuses the change', async () => {
		renderWebview(<ConnectionTab session={session()} />);

		await userEvent.click(screen.getByRole('button', { name: 'Edit schema list' }));
		await userEvent.click(screen.getByRole('button', { name: 'Remove APPL' }));
		await userEvent.click(screen.getByRole('button', { name: 'OK' }));

		postFromHost<ResultsInboundMessage>({
			command: 'libraryListResult',
			uri: URI,
			error: { message: 'SQL0443 - CPF2110 Library NOSUCH not found.', driverErrors: [{ code: -443, state: '38501', message: 'CPF2110 Library NOSUCH not found.' }] }
		});

		let dialog = within(screen.getByRole('dialog'));
		expect(dialog.getByText('The library list was not changed: SQL0443 - CPF2110 Library NOSUCH not found.')).toBeTruthy();
		expect(dialog.queryByRole('listitem', { name: 'APPL' })).toBeNull();
		expect(dialog.getByRole('button', { name: 'OK' }).hasAttribute('disabled')).toBe(false);
	});

	it('disables Edit while the session is executing or fetching', () => {
		let { rerender } = renderWebview(<ConnectionTab session={session({ state: 'executing' })} />);
		expect(screen.getByRole('button', { name: 'Edit schema list' }).hasAttribute('disabled')).toBe(true);

		rerender(<ConnectionTab session={session({ isFetchingAll: true })} />);
		expect(screen.getByRole('button', { name: 'Edit schema list' }).hasAttribute('disabled')).toBe(true);

		rerender(<ConnectionTab session={session()} />);
		expect(screen.getByRole('button', { name: 'Edit schema list' }).hasAttribute('disabled')).toBe(false);
	});

	it('offers no Edit on a schema browser or diagram session', () => {
		renderWebview(<ConnectionTab session={session({ sessionKind: 'schemas' })} />);
		expect(screen.queryByRole('button', { name: 'Edit schema list' })).toBeNull();
	});
});
