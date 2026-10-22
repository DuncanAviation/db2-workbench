import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ResultsSessionDetail, ResultsSqlHistory } from '../../../src/webview-messages/results-messages';
import { renderWebview } from '../../test-support/render-webview';
import { HistoryTab } from './history-tab';

function session(histories: ResultsSqlHistory[]): ResultsSessionDetail {
	return {
		uri: 'file:///c%3A/work/first.sql',
		name: 'first.sql',
		sessionKind: 'editor',
		host: 'TESTHOST',
		connectionName: 'Test Connection',
		userName: 'TESTUSER',
		state: 'ready',
		histories,
		rows: [],
		columns: [],
		columnLabels: {},
		columnDetails: {},
		columnDataTypes: {},
		procedureOutParameters: [],
		isCursorOpen: false,
		isFetchingAll: false,
		parameters: [],
		parameterValues: {}
	};
}

function renderHistory(histories: ResultsSqlHistory[]) {
	return renderWebview(
		<HistoryTab
			session={session(histories)}
			searchText=""
			onSearchTextChange={() => {}}
			selectedCategories={['message', 'userStatement', 'internalStatement']}
			onSelectedCategoriesChange={() => {}}
		/>
	);
}

describe('HistoryTab', () => {
	it('offers Copy error only on entries that failed', () => {
		renderHistory([
			{ date: '10:00:00', type: 'result', sql: 'SELECT * FROM ORDERS', rowCount: 3 },
			{ date: '10:00:01', type: 'error', sql: 'SELECT * FROM MISSING', error: { message: 'Table MISSING not found.' } },
			{ date: '10:00:02', type: 'result', sql: 'UPDATE ORDERS SET QTY = 1' }
		]);

		expect(screen.getAllByRole('button', { name: 'Copy error' })).toHaveLength(1);
	});

	it('copies the message and every line of the driver error chain', async () => {
		// setup() installs user-event's own clipboard on navigator, which readText() then reads back.
		const user = userEvent.setup();

		renderHistory([{
			date: '10:00:01',
			type: 'error',
			sql: 'SELECT * FROM MISSING',
			error: {
				message: '[odbc] Error executing the sql statement',
				driverErrors: [
					{ code: -204, state: '42704', message: 'SQL0204 - MISSING in TESTLIB type *FILE not found.' },
					{ code: -30038, state: 'HY000', message: 'Statement was not prepared.' }
				]
			}
		}]);

		await user.click(screen.getByRole('button', { name: 'Copy error' }));

		expect(await navigator.clipboard.readText()).toBe([
			'[odbc] Error executing the sql statement',
			'Code -204, State 42704: SQL0204 - MISSING in TESTLIB type *FILE not found.',
			'Code -30038, State HY000: Statement was not prepared.'
		].join('\n'));
		await waitFor(() => expect(screen.getByTestId('CheckIcon')).toBeTruthy());
	});
});
