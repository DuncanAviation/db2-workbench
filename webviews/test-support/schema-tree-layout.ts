import { expect } from 'vitest';

// Real-browser checks on the shared SchemaTree (shared/components/schema-tree.tsx), for the browser suite
// only: they read real layout, which jsdom doesn't have. Both hosts - the schema browser and the diagram's
// table picker - mount the same tree into different layouts, and it's the host's layout that gives the
// tree's scroll container its bounded height, so each host's spec runs these against its own App.

/** Every rendered tree row - the virtualizer tags each one it renders with data-index. */
function renderedRows(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>('[data-index]')];
}

/** The rendered rows' text, top to bottom. */
export function treeRowTexts(): string[] {
	return renderedRows().map(row => row.textContent ?? '');
}

/** A rendered tree row's clickable part, found by its full text. */
export function treeRow(text: string): HTMLElement {
	let match = renderedRows().find(row => row.textContent === text);
	if (!match) {
		throw new Error(`no rendered tree row "${text}" among: ${treeRowTexts().join(', ')}`);
	}
	return match.querySelector<HTMLElement>('[role="button"]') ?? match;
}

/** The element that scrolls the tree: the virtualizer's scroll container, two levels above its rows. */
export function treeScrollContainer(): HTMLElement {
	let [firstRow] = renderedRows();
	let container = firstRow?.parentElement?.parentElement;
	if (!container) {
		throw new Error('the tree has no rendered rows');
	}
	return container;
}

/**
 * Asserts the tree is virtualizing: its scroll container has a real height that ends inside the
 * viewport, its content is far taller than that height, only a window of rows is rendered, and the page
 * itself doesn't scroll. `totalRows` is roughly how many rows the tree would have if it rendered them all.
 */
export function expectTreeVirtualized(totalRows: number) {
	let container = treeScrollContainer();
	let box = container.getBoundingClientRect();

	expect(box.height, 'the tree scroll container has a height').toBeGreaterThan(0);
	expect(box.bottom, 'the tree scroll container ends inside the viewport').toBeLessThanOrEqual(window.innerHeight + 1);
	expect(container.scrollHeight, 'the tree content is taller than its container, so it scrolls').toBeGreaterThan(container.clientHeight * 5);

	let rendered = renderedRows().length;
	expect(rendered, 'some rows are rendered').toBeGreaterThan(0);
	expect(rendered, `only a window of the ${totalRows} rows is rendered`).toBeLessThan(Math.min(100, totalRows / 10));

	let page = document.scrollingElement as HTMLElement;
	expect(page.scrollHeight, 'the page itself does not scroll - the tree does').toBeLessThanOrEqual(window.innerHeight);
}

/** Scrolls the tree's own container to its end, the way dragging its scrollbar would. */
export async function scrollTreeToBottom() {
	let container = treeScrollContainer();
	container.scrollTop = container.scrollHeight;
	// The browser fires the scroll event itself, before the next frame; the virtualizer re-renders on it.
	await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
