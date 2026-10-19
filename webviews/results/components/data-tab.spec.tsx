import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Row } from '../../../src/interfaces/row';
import type { ResultsOutboundMessage, ResultsSessionDetail } from '../../../src/webview-messages/results-messages';
import { useFakeLayout } from '../../test-support/fake-layout';
import type { FakeLayoutHandle } from '../../test-support/fake-layout';
import { renderWebview } from '../../test-support/render-webview';
import { postedMessages } from '../../test-support/vscode-api-stub';
import { DataTab } from './data-tab';

// The results grid: DataTable in its virtualized mode, plus the cursor paging built around it - Load
// More on scrolling near the bottom, Fetch all / Cancel, Refresh, and the host-side export hand-off.
//
// Viewport and scroll metrics come from fake-layout.ts, so these tests exercise the windowing and the
// scroll handler's arithmetic, not the CSS that gives the grid a bounded height in a real webview. jsdom
// has no canvas either, so measureColumnWidths() returns nothing and every column falls back to
// react-table's default size - column-width measurement is not covered here.

const VIEWPORT_HEIGHT = 320;
// DataTab's estimateSize. Its rows are not individually measured, so the estimate is the row height.
const ROW_HEIGHT = 32;

function rows(count: number, from: number = 1): Row[] {
	return Array.from({ length: count }, (_, index) => ({ ID: from + index, NAME: `Part ${from + index}`, NOTE: index % 2 === 0 ? null : 'ok' }));
}

function session(overrides: Partial<ResultsSessionDetail> = {}): ResultsSessionDetail {
	return {
		uri: 'file:///c%3A/work/parts.sql',
		name: 'parts.sql',
		sessionKind: 'editor',
		host: 'TESTHOST',
		connectionName: 'Test',
		userName: 'TESTUSER',
		state: 'ready',
		histories: [],
		rows: rows(5),
		columns: ['ID', 'NAME', 'NOTE'],
		columnLabels: {},
		columnDetails: {},
		columnDataTypes: { ID: 'SQL_INTEGER', NAME: 'SQL_VARCHAR', NOTE: 'SQL_VARCHAR' },
		procedureOutParameters: [],
		isCursorOpen: false,
		isFetchingAll: false,
		parameters: [],
		parameterValues: {},
		...overrides
	};
}

function renderDataTab(detail: ResultsSessionDetail) {
	return renderWebview(<DataTab session={detail} />);
}

/** Data rows only - the spacer rows padding the virtual window above and below are left out. */
function dataRows(): HTMLElement[] {
	let [, body] = within(screen.getByRole('table')).getAllByRole('rowgroup');
	return within(body).queryAllByRole('row').filter(row => within(row).queryAllByRole('cell').length > 1);
}

function firstCellTexts(): string[] {
	return dataRows().map(row => within(row).getAllByRole('cell')[0].textContent ?? '');
}

function scroller(): HTMLElement {
	return screen.getByRole('table').closest('.MuiTableContainer-root') as HTMLElement;
}

function posted(): ResultsOutboundMessage[] {
	return postedMessages<ResultsOutboundMessage>();
}

describe('results DataTab', () => {
	let layout: FakeLayoutHandle;

	beforeEach(() => {
		layout = useFakeLayout({ viewportHeight: VIEWPORT_HEIGHT });
	});

	afterEach(() => {
		layout.restore();
	});

	describe('content', () => {
		it('says so when the result set is empty', () => {
			renderDataTab(session({ rows: [] }));

			expect(screen.getByText('No data to display')).toBeTruthy();
			expect(screen.queryByRole('table')).toBeNull();
		});

		it('warns about duplicate column names, whether or not there are rows', () => {
			let { unmount } = renderDataTab(session({ duplicateColumns: ['ID'] }));
			expect(screen.getByText(/Duplicate column name in this result set: ID\./)).toBeTruthy();
			unmount();

			renderDataTab(session({ rows: [], duplicateColumns: ['ID', 'NAME'] }));
			expect(screen.getByText(/Duplicate column names in this result set: ID, NAME\./)).toBeTruthy();
		});

		it('names duplicate columns by their configured heading label, not the raw result key', () => {
			renderDataTab(session({ rows: [], duplicateColumns: ['PART_IDENTIFIER'], columnLabels: { PART_IDENTIFIER: ['PARTID', 'Part Identifier'] } }));
			expect(screen.getByText(/Duplicate column name in this result set: PARTID\./)).toBeTruthy();
		});

		it('stacks each column\'s heading label parts, and shows <null> for a null value', () => {
			renderDataTab(session({ columnLabels: { ID: ['PARTID', 'Part Identifier'] } }));

			let [head] = within(screen.getByRole('table')).getAllByRole('rowgroup');
			let idHeader = within(head).getAllByRole('columnheader')[0];
			expect([...idHeader.querySelectorAll('div > div')].map(part => part.textContent)).toEqual(['PARTID', 'Part Identifier']);

			expect(within(dataRows()[0]).getAllByRole('cell')[2].textContent).toBe('<null>');
			expect(within(dataRows()[1]).getAllByRole('cell')[2].textContent).toBe('ok');
		});

		it('describes a column in its header tooltip from the host-built details', async () => {
			let user = userEvent.setup();
			renderDataTab(session({ columnDetails: { ID: { shortName: 'PARTID', longName: 'PART_IDENTIFIER', type: 'INTEGER' } } }));

			await user.hover(screen.getByText('ID'));

			let tooltip = await screen.findByRole('tooltip');
			expect(tooltip.textContent).toContain('Short Name: PARTID');
			expect(tooltip.textContent).toContain('Type: INTEGER');
		});

		it('right-aligns the cells of a column the driver reports as numeric, and only that column, leaving every header left-aligned', () => {
			renderDataTab(session());

			let [head] = within(screen.getByRole('table')).getAllByRole('rowgroup');
			let alignments = (cells: HTMLElement[]) => cells.map(cell => cell.classList.contains('MuiTableCell-alignRight'));

			expect(alignments(within(head).getAllByRole('columnheader'))).toEqual([false, false, false]);
			expect(alignments(within(dataRows()[0]).getAllByRole('cell'))).toEqual([true, false, false]);
		});

		it('locks column widths with a fixed layout, so the window can\'t resize them while scrolling', () => {
			renderDataTab(session());

			let table = screen.getByRole('table');
			expect(table.style.tableLayout).toBe('fixed');
			expect(table.querySelectorAll('colgroup > col')).toHaveLength(3);
		});
	});

	describe('windowing', () => {
		it('renders only the rows in view plus overscan', () => {
			renderDataTab(session({ rows: rows(1000) }));

			// 320px / 32px = 10 rows in view, plus DataTab's overscan of 10.
			expect(firstCellTexts()).toEqual(Array.from({ length: 20 }, (_, index) => String(index + 1)));
		});

		it('moves the window as the grid scrolls, padding above it for the rows scrolled past', () => {
			renderDataTab(session({ rows: rows(1000) }));

			layout.scroll(scroller(), { top: 500 * ROW_HEIGHT });

			expect(firstCellTexts()).toEqual(Array.from({ length: 30 }, (_, index) => String(491 + index)));

			let [, body] = within(screen.getByRole('table')).getAllByRole('rowgroup');
			let spacer = within(body).getAllByRole('row')[0];
			expect(spacer.style.height).toBe(`${490 * ROW_HEIGHT}px`);
		});

		it('sorts across every loaded row, not just the rendered window', async () => {
			let user = userEvent.setup();
			renderDataTab(session({ rows: rows(1000) }));

			// One click: react-table sorts a numeric column descending first (its sortDescFirst default).
			await user.click(screen.getByRole('button', { name: 'ID' }));

			expect(firstCellTexts().slice(0, 3)).toEqual(['1000', '999', '998']);
		});
	});

	describe('Load More', () => {
		// scrollTop + clientHeight within 100px of scrollHeight counts as "near the bottom".
		function scrollNearBottom(top: number) {
			layout.scroll(scroller(), { top, scrollHeight: top + VIEWPORT_HEIGHT + 50 });
		}

		it('asks for the next page when scrolled near the bottom of an open cursor', () => {
			renderDataTab(session({ rows: rows(100), isCursorOpen: true }));

			scrollNearBottom(1000);

			expect(posted()).toEqual([{ command: 'loadMore' }]);
		});

		it('does not ask again until the page it asked for has arrived', () => {
			let first = session({ rows: rows(100), isCursorOpen: true });
			let { rerender } = renderDataTab(first);

			scrollNearBottom(1000);
			scrollNearBottom(1010);
			expect(posted()).toEqual([{ command: 'loadMore' }]);

			rerender(<DataTab session={{ ...first, rows: [...first.rows, ...rows(100, 101)] }} />);
			scrollNearBottom(4000);

			expect(posted()).toEqual([{ command: 'loadMore' }, { command: 'loadMore' }]);
		});

		it('does nothing away from the bottom, once the cursor is exhausted, or for a horizontal scroll', () => {
			renderDataTab(session({ rows: rows(100), isCursorOpen: true }));

			layout.scroll(scroller(), { top: 200, scrollHeight: 5000 });
			expect(posted()).toEqual([]);

			// Same scrollTop as before, only now "near the bottom" - what a sideways scroll looks like to
			// the handler, since the scroll event fires for horizontal movement too.
			layout.scroll(scroller(), { top: 200, scrollHeight: 200 + VIEWPORT_HEIGHT });
			expect(posted()).toEqual([]);

			// The positive half, so the silence above is about those two cases rather than a dead handler.
			scrollNearBottom(300);
			expect(posted()).toEqual([{ command: 'loadMore' }]);
		});

		it('never asks for more once the cursor is closed', () => {
			renderDataTab(session({ rows: rows(100), isCursorOpen: false }));

			scrollNearBottom(1000);

			expect(posted()).toEqual([]);
			expect(dataRows().length).toBeGreaterThan(0);
		});
	});

	describe('table actions', () => {
		it('offers Fetch all only while the cursor is open, and posts fetchAll', async () => {
			let user = userEvent.setup();
			let { unmount } = renderDataTab(session());
			expect(screen.queryByRole('button', { name: 'Fetch all' })).toBeNull();
			unmount();

			renderDataTab(session({ isCursorOpen: true }));
			await user.click(screen.getByRole('button', { name: 'Fetch all' }));

			expect(posted()).toEqual([{ command: 'fetchAll' }]);
		});

		it('turns into Cancel fetching while a fetch-all runs, and posts cancelFetchAll', async () => {
			let user = userEvent.setup();
			renderDataTab(session({ isCursorOpen: true, isFetchingAll: true }));

			await user.click(screen.getByRole('button', { name: 'Cancel fetching...' }));

			expect(posted()).toEqual([{ command: 'cancelFetchAll' }]);
		});

		it('Refresh re-runs the statement through the host', async () => {
			let user = userEvent.setup();
			renderDataTab(session());

			await user.click(screen.getByRole('button', { name: 'Refresh' }));

			expect(posted()).toEqual([{ command: 'executeSql' }]);
		});

		it('hands export to the host, with rows only for what the host cannot see itself', async () => {
			let user = userEvent.setup();
			renderDataTab(session({ isCursorOpen: true }));

			await user.click(screen.getByRole('button', { name: 'Export...' }));
			let dialog = within(screen.getByRole('dialog'));
			await user.click(dialog.getByLabelText('All results (fetches remaining rows first)'));
			await user.click(dialog.getByRole('button', { name: 'Save' }));
			// The closing dialog leaves the rest of the page aria-hidden until its exit transition ends.
			await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

			await user.type(screen.getByPlaceholderText('Filter...'), 'Part 3');
			await user.click(screen.getByRole('button', { name: 'Export...' }));
			dialog = within(screen.getByRole('dialog'));
			await user.click(dialog.getByLabelText('Filtered results (1 rows)'));
			await user.click(dialog.getByRole('button', { name: 'Clipboard' }));

			expect(posted()).toEqual([
				{ command: 'exportData', destination: 'file', what: 'all', format: 'csv' },
				{ command: 'exportData', destination: 'clipboard', what: 'filtered', format: 'csv', filteredRows: [{ ID: 3, NAME: 'Part 3', NOTE: null }] }
			]);
		});
	});
});
