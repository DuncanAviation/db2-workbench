import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWebview } from '../../test-support/render-webview';
import { SqlErrorDisplay } from './sql-error-display';

describe('SqlErrorDisplay', () => {
	it('Copy error copies the labelled message as shown, then every driver error line', async () => {
		// setup() installs user-event's own clipboard on navigator, which readText() then reads back.
		const user = userEvent.setup();

		renderWebview(
			<SqlErrorDisplay
				label="Failed to load columns"
				error={{
					message: 'Error executing the sql statement',
					driverErrors: [{ code: -551, state: '42501', message: 'SQL0551 - Not authorized to object CUSTOMER in TESTLIB type *FILE.' }]
				}}
			/>
		);

		expect(screen.getByText('Failed to load columns: Error executing the sql statement')).toBeTruthy();

		await user.click(screen.getByRole('button', { name: 'Copy error' }));

		expect(await navigator.clipboard.readText()).toBe([
			'Failed to load columns: Error executing the sql statement',
			'Code -551, State 42501: SQL0551 - Not authorized to object CUSTOMER in TESTLIB type *FILE.'
		].join('\n'));
	});
});
