import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { screen, waitFor } from '@testing-library/react';
import type { SchemasInitialState, SchemasOutboundMessage, TreeTableEntry } from '../../src/webview-messages/schemas-messages';
import { renderWebview } from '../test-support/render-webview';
import { postedMessages } from '../test-support/vscode-api-stub';
import { expectTreeVirtualized, scrollTreeToBottom, treeRow, treeRowTexts } from '../test-support/schema-tree-layout';
import { App } from './app';
import { systemTable } from './test-fixtures';
import { DataEditDefaults } from '../../src/utils/data-edit-defaults';

// The schema browser's tree in a real browser (see vitest.browser.config.ts). The tree virtualizes its
// rows, which only works if its scroll container gets a bounded height from the layout around it -
// without one the container grows to fit every row, the virtualizer sees them all as in view and renders
// thousands of rows, and the page scrolls instead of the tree. jsdom can't catch that: its row heights and
// viewport come from useFakeLayout(), not the stylesheet, so shared/components/schema-tree.spec.tsx tests
// which rows a window renders but not whether the layout gives it a window at all.

const TABLE_COUNT = 2000;

function tableName(index: number): string {
	return `TBL${String(index).padStart(4, '0')}`;
}

function initialState(): SchemasInitialState {
	let tables: TreeTableEntry[] = Array.from({ length: TABLE_COUNT }, (_, index) => ({ connected: systemTable('SALES', tableName(index + 1)) }));

	return {
		connectionName: 'Production',
		tablesBySchema: { SALES: tables },
		viewsBySchema: {},
		functionsBySchema: {},
		proceduresBySchema: {},
		schemaList: [{ name: 'SALES', hidden: false, added: false }],
		currentSortSequence: '*HEX',
		currentSortSequenceLibrary: '',
		dataEditSettings: DataEditDefaults.DEFAULT_SETTINGS,
	};
}

describe('schema browser tree in a real browser', () => {
	it('scrolls within a bounded height and renders only the rows in view', async () => {
		renderWebview(<App />, { initialState: initialState(), withDatePickers: true });

		await userEvent.click(treeRow('SALES'));
		await userEvent.click(treeRow(`Tables (${TABLE_COUNT})`));
		await waitFor(() => expect(treeRowTexts()).toContain(tableName(1)));

		expectTreeVirtualized(TABLE_COUNT);
	});

	it('renders the last table once the tree is scrolled to the bottom', async () => {
		renderWebview(<App />, { initialState: initialState(), withDatePickers: true });

		await userEvent.click(treeRow('SALES'));
		await userEvent.click(treeRow(`Tables (${TABLE_COUNT})`));
		await waitFor(() => expect(treeRowTexts()).toContain(tableName(1)));

		await scrollTreeToBottom();

		await waitFor(() => expect(treeRowTexts()).toContain(tableName(TABLE_COUNT)));
		expect(treeRowTexts()).not.toContain(tableName(1));
	});
});

// Dragging the divider beside the tree. jsdom has no layout and no real pointer input, so
// app.spec.tsx covers the keyboard, the saved width and the reset; this covers the drag itself, and
// the limit on the right, which comes from the width of the panel beside the tree.
describe('schema browser tree divider in a real browser', () => {
	const divider = () => screen.getByRole('separator', { name: 'Resize schema tree' });
	const treeWidth = () => (divider().previousElementSibling as HTMLElement).getBoundingClientRect().width;
	const savedWidths = () => postedMessages<SchemasOutboundMessage>().flatMap(message => message.command === 'savePanelWidth' && message.panel === 'tree' ? [message.width] : []);

	// Drags the divider to `x` on the page, in small steps the way a hand does. The pointer has to stay
	// inside the viewport, so a drag past a limit aims at the window's edge.
	async function dragTo(x: number) {
		let box = divider().getBoundingClientRect();
		let target = document.body.getBoundingClientRect();

		await userEvent.dragAndDrop(divider(), document.body, {
			sourcePosition: { x: box.width / 2, y: box.height / 2 },
			targetPosition: { x: x - target.left, y: box.top + box.height / 2 - target.top },
			steps: 10
		});
	}

	const dividerX = () => divider().getBoundingClientRect().left + divider().getBoundingClientRect().width / 2;

	it('follows the pointer, and saves the width once, when the drag ends', async () => {
		renderWebview(<App />, { initialState: initialState(), withDatePickers: true });
		let before = treeWidth();

		await dragTo(dividerX() + 150);

		await waitFor(() => expect(treeWidth()).toBeCloseTo(before + 150, -1));
		expect(savedWidths()).toHaveLength(1);
		expect(savedWidths()[0]).toBeCloseTo(treeWidth(), 0);
	});

	it('stops short of squeezing the panel beside the tree, and at the minimum on the left', async () => {
		renderWebview(<App />, { initialState: initialState(), withDatePickers: true });

		await dragTo(window.innerWidth - 2);
		await waitFor(() => expect(savedWidths()).toHaveLength(1));
		expect(window.innerWidth - treeWidth()).toBeGreaterThanOrEqual(319);

		await dragTo(2);
		await waitFor(() => expect(savedWidths()).toHaveLength(2));
		expect(treeWidth()).toBe(180);
	});
});
