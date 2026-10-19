import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ResultsInboundMessage, ResultsInitialState, ResultsOutboundMessage, ResultsSessionDetail } from '../../src/webview-messages/results-messages';
import { postFromHost } from '../test-support/host-messages';
import { renderWebview } from '../test-support/render-webview';
import { postedMessages } from '../test-support/vscode-api-stub';
import { App } from './app';

// The results bundle's half of the host <-> webview contract in results-messages.ts: what it does
// with each ResultsInboundMessage, and the exact ResultsOutboundMessage it posts back. The host half
// (WorkbenchViewProvider) is covered by src/test/workbench-view-provider.test.ts. Neither side can see
// the other here, so a field renamed on one side only still fails exactly one of the two suites.

const FIRST_URI = 'file:///c%3A/work/first.sql';
const SECOND_URI = 'file:///c%3A/work/second.sql';

function session(overrides: Partial<ResultsSessionDetail> = {}): ResultsSessionDetail {
	return {
		uri: FIRST_URI,
		name: 'first.sql',
		sessionKind: 'editor',
		host: 'TESTHOST',
		connectionName: 'Test Connection',
		userName: 'TESTUSER',
		state: 'ready',
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

function initialState(overrides: Partial<ResultsInitialState> = {}): ResultsInitialState {
	return {
		appState: 'noResults',
		extensionName: 'DB2 Workbench',
		sessions: [],
		autoFocusResults: false,
		...overrides
	};
}

function rows(count: number, from: number = 1): Record<string, unknown>[] {
	return Array.from({ length: count }, (_, index) => ({ ID: from + index, NAME: `Row ${from + index}` }));
}

function renderResults(state: ResultsInitialState) {
	return renderWebview(<App />, { initialState: state, withDatePickers: true });
}

describe('results webview', () => {
	it('refuses to start without an initial state from the host', () => {
		// Also proves the harness clears __INITIAL_STATE__ between tests: every other test in this
		// file sets one, so a leak would make this render succeed.
		expect(() => render(<App />)).toThrow('Initial state was not provided by the extension host.');
	});

	it('with no connections, offers to add one and posts addConnection when asked', async () => {
		renderResults(initialState({ appState: 'noConnections' }));

		expect(screen.getByText('Welcome to DB2 Workbench. To begin, add a connection.')).toBeTruthy();

		await userEvent.click(screen.getByRole('button', { name: 'Add a Connection' }));

		expect(postedMessages<ResultsOutboundMessage>()).toEqual([{ command: 'addConnection' }]);
	});

	it('renders the active session and the session list from the initial state', () => {
		renderResults(initialState({
			appState: 'results',
			sessions: [{ uri: FIRST_URI, name: 'first.sql' }, { uri: SECOND_URI, name: 'second.sql' }],
			activeUri: FIRST_URI,
			activeSession: session({
				rows: rows(2),
				columns: ['ID', 'NAME'],
				histories: [{ date: '2026-09-23T12:00:00.000Z', type: 'result', rowCount: 2, sql: 'SELECT * FROM SALES.CUSTOMER' }]
			})
		}));

		expect(screen.getByRole('tab', { name: 'Data (2)' })).toBeTruthy();
		expect(screen.getByRole('tab', { name: 'History (1)' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'first.sql' }).classList.contains('Mui-selected')).toBe(true);
		expect(screen.getByRole('button', { name: 'second.sql' }).classList.contains('Mui-selected')).toBe(false);
	});

	it('posts selectSession with the chosen session uri', async () => {
		renderResults(initialState({
			appState: 'results',
			sessions: [{ uri: FIRST_URI, name: 'first.sql' }, { uri: SECOND_URI, name: 'second.sql' }],
			activeUri: FIRST_URI,
			activeSession: session()
		}));

		await userEvent.click(screen.getByRole('button', { name: 'second.sql' }));

		// The webview does not switch sessions itself - it asks, and waits for the host's sessionsState.
		expect(postedMessages<ResultsOutboundMessage>()).toEqual([{ command: 'selectSession', uri: SECOND_URI }]);
		expect(screen.getByRole('button', { name: 'first.sql' }).classList.contains('Mui-selected')).toBe(true);
	});

	it('sessionsState replaces the sessions and the active session wholesale', () => {
		renderResults(initialState({
			appState: 'results',
			sessions: [{ uri: FIRST_URI, name: 'first.sql' }],
			activeUri: FIRST_URI,
			activeSession: session({ rows: rows(2) })
		}));

		expect(screen.getByRole('tab', { name: 'Data (2)' })).toBeTruthy();

		postFromHost<ResultsInboundMessage>({
			command: 'sessionsState',
			appState: 'results',
			sessions: [{ uri: SECOND_URI, name: 'second.sql' }],
			activeUri: SECOND_URI,
			activeSession: session({ uri: SECOND_URI, name: 'second.sql', rows: rows(7) }),
			autoFocusResults: false
		});

		expect(screen.getByRole('tab', { name: 'Data (7)' })).toBeTruthy();
		expect(screen.queryByRole('tab', { name: 'Data (2)' })).toBeNull();
		expect(screen.getByRole('button', { name: 'second.sql' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'first.sql' })).toBeNull();
	});

	it('addRows appends to the active session rather than replacing its rows, and carries the cursor state', () => {
		// autoFocusResults with rows opens on the Data tab, whose toolbar offers "Fetch all" only while
		// the cursor is open - the visible trace of isCursorOpen. The rows themselves are virtualized and
		// render nothing in jsdom (no layout), so the row count comes from the tab label instead.
		renderResults(initialState({
			appState: 'results',
			sessions: [{ uri: FIRST_URI, name: 'first.sql' }],
			activeUri: FIRST_URI,
			activeSession: session({ rows: rows(2), columns: ['ID', 'NAME'], isCursorOpen: true }),
			autoFocusResults: true
		}));

		expect(screen.getByRole('tab', { name: 'Data (2)', selected: true })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Fetch all' })).toBeTruthy();

		postFromHost<ResultsInboundMessage>({ command: 'addRows', rows: rows(3, 3), isCursorOpen: true });

		expect(screen.getByRole('tab', { name: 'Data (5)' })).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Fetch all' })).toBeTruthy();

		postFromHost<ResultsInboundMessage>({ command: 'addRows', rows: rows(1, 6), isCursorOpen: false });

		expect(screen.getByRole('tab', { name: 'Data (6)' })).toBeTruthy();
		expect(screen.queryByRole('button', { name: 'Fetch all' })).toBeNull();
	});

	it('addRows with no active session is ignored, and the view keeps listening', () => {
		renderResults(initialState());

		expect(screen.getByText('Run a query to see results')).toBeTruthy();

		postFromHost<ResultsInboundMessage>({ command: 'addRows', rows: rows(3), isCursorOpen: false });

		expect(screen.getByText('Run a query to see results')).toBeTruthy();
		expect(screen.queryByRole('tab')).toBeNull();

		// The positive half: the listener is still attached and still applies the next message, so the
		// assertions above are about addRows being dropped, not about nothing being wired up at all.
		postFromHost<ResultsInboundMessage>({
			command: 'sessionsState',
			appState: 'results',
			sessions: [{ uri: FIRST_URI, name: 'first.sql' }],
			activeUri: FIRST_URI,
			activeSession: session({ rows: rows(1) }),
			autoFocusResults: false
		});

		expect(screen.getByRole('tab', { name: 'Data (1)' })).toBeTruthy();
	});
});
