import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { Row } from '../../../src/interfaces/row';
import type { ResultsSessionDetail } from '../../../src/webview-messages/results-messages';
import { renderWebview } from '../../test-support/render-webview';
import { DataTab } from './data-tab';

// Column widths in a real browser (see vitest.browser.config.ts). jsdom has no canvas, so
// measureColumnWidths() returns nothing there and every column falls back to react-table's default
// size - only here do the measured widths actually reach the table.

// Headers longer than their values, so the header is what sizes each column. Enough of them that the
// table overflows the viewport and every column gets exactly its measured width, with no spare room
// spread across the columns to hide a measurement that came up short.
const COLUMNS = ['QUANTITY_ON_HAND', 'DESCRIPTION_OF_ITEM', 'WAREHOUSE_LOCATION_CODE', ...Array.from({ length: 20 }, (_, index) => `FILLER_COLUMN_${index}`)];

function session(): ResultsSessionDetail {
	let row: Row = Object.fromEntries(COLUMNS.map(column => [column, 'x']));

	return {
		uri: 'file:///c%3A/work/parts.sql',
		name: 'parts.sql',
		sessionKind: 'editor',
		host: 'TESTHOST',
		connectionName: 'Test',
		userName: 'TESTUSER',
		state: 'ready',
		histories: [],
		rows: [row],
		columns: COLUMNS,
		columnLabels: { QUANTITY_ON_HAND: ['QUANTITY_ON_HAND', 'Quantity currently on hand'] },
		columnDetails: {},
		columnDataTypes: {},
		procedureOutParameters: [],
		isCursorOpen: false,
		isFetchingAll: false,
		parameters: [],
		parameterValues: {}
	};
}

describe('results DataTab in a real browser', () => {
	it('sizes each column wide enough for its whole header, so no header is truncated', () => {
		renderWebview(<DataTab session={session()} />);

		let [head] = within(screen.getByRole('table')).getAllByRole('rowgroup');
		let overflowing = within(head).getAllByRole('columnheader').filter(header => {
			let style = getComputedStyle(header);
			let contentWidth = header.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
			// The sort label - the header's only child, holding the stacked label parts and the sort icon.
			return (header.firstElementChild as HTMLElement).getBoundingClientRect().width > contentWidth;
		});

		expect(overflowing.map(header => header.textContent)).toEqual([]);
	});

	// A fixed-layout table spreads unused width across its columns, which made a short column (a
	// DECIMAL(9,0) key, say) far wider than its content, and a right-aligned number far from its header.
	// The table is now only as wide as its columns.
	it('stops at its last column, leaving the spare width empty, when the columns don\'t fill the panel', () => {
		let narrowColumns = ['PARTNO', 'QTY', 'NOTES'];
		renderWebview(<DataTab session={{ ...session(), columns: narrowColumns, columnLabels: {}, rows: [{ PARTNO: 'A100', QTY: 5, NOTES: 'Hex bolt' }] }} />);

		let table = screen.getByRole('table');
		let [head] = within(table).getAllByRole('rowgroup');
		let widths = within(head).getAllByRole('columnheader').map(header => header.getBoundingClientRect().width);
		let containerWidth = (table.parentElement as HTMLElement).clientWidth;

		// Each is its own measured width - header text, sort icon and padding, well under a third of the
		// 1200px viewport each would get if the room were shared out - the last one included.
		expect(widths[0]).toBeLessThan(150);
		expect(widths[1]).toBeLessThan(150);
		expect(widths[2]).toBeLessThan(150);
		// The table ends where its columns do, well short of the panel's edge.
		let tableWidth = table.getBoundingClientRect().width;
		expect(Math.abs(tableWidth - widths.reduce((total, width) => total + width, 0))).toBeLessThan(2);
		expect(tableWidth).toBeLessThan(containerWidth / 2);
	});
});
