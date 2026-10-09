import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { screen, waitFor } from '@testing-library/react';
import { Box, Stack } from '@mui/material';
import { renderWebview } from '../../test-support/render-webview';
import { RunSqlPanel } from './run-sql-panel';

// Dragging the Run SQL panel's divider in a real browser. Its divider is on the panel's left edge, the
// mirror of the tree's, so a drag to the left widens it - the direction is what this checks, along with
// the limit that keeps the tabs beside it usable. data-edit-flow.spec.tsx covers the keyboard, the saved
// width and the reset at the app level. Rendered beside a stand-in for the tabs rather than in the whole
// app, since entering edit mode needs a table's data loaded first.

const saved: number[] = [];

function Harness() {
	const [width, setWidth] = useState(360);

	return (
		<Stack direction="row" sx={{ height: '100vh' }}>
			<Box data-testid="tabs" sx={{ flexGrow: 1, minWidth: 0 }} />
			<RunSqlPanel
				statements={[]}
				statementStatuses={{}}
				statementErrors={{}}
				isRunning={false}
				collapsed={false}
				onToggleCollapsed={() => undefined}
				onCancelClick={() => undefined}
				onDeleteStatement={() => undefined}
				onRun={() => undefined}
				onClearDone={() => undefined}
				onClearAll={() => undefined}
				resizable={{ width: width, onResize: setWidth, onResizeEnd: next => saved.push(next) }}
			/>
		</Stack>
	);
}

describe('Run SQL panel divider in a real browser', () => {
	const divider = () => screen.getByRole('separator', { name: 'Resize run SQL panel' });
	const panelWidth = () => (divider().previousElementSibling as HTMLElement).getBoundingClientRect().width;
	const tabsWidth = () => screen.getByTestId('tabs').getBoundingClientRect().width;
	const dividerX = () => divider().getBoundingClientRect().left + divider().getBoundingClientRect().width / 2;

	// Drags the divider to `x` on the page in small steps, keeping the pointer inside the viewport.
	async function dragTo(x: number) {
		let box = divider().getBoundingClientRect();
		let target = document.body.getBoundingClientRect();

		await userEvent.dragAndDrop(divider(), document.body, {
			sourcePosition: { x: box.width / 2, y: box.height / 2 },
			targetPosition: { x: x - target.left, y: box.top + box.height / 2 - target.top },
			steps: 10
		});
	}

	it('widens as the divider is dragged left, and saves the width once', async () => {
		saved.length = 0;
		renderWebview(<Harness />);
		let before = panelWidth();

		await dragTo(dividerX() - 150);

		await waitFor(() => expect(panelWidth()).toBeCloseTo(before + 150, -1));
		expect(saved).toHaveLength(1);
		expect(saved[0]).toBeCloseTo(panelWidth(), 0);
	});

	it('stops short of squeezing the tabs beside it, and at its minimum on the right', async () => {
		saved.length = 0;
		renderWebview(<Harness />);

		await dragTo(2);
		await waitFor(() => expect(saved).toHaveLength(1));
		expect(tabsWidth()).toBeGreaterThanOrEqual(319);

		await dragTo(window.innerWidth - 2);
		await waitFor(() => expect(saved).toHaveLength(2));
		expect(panelWidth()).toBe(240);
	});
});
