import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { screen, waitFor } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { DiagramInboundMessage, DiagramInitialState, DiagramModel, DiagramOutboundMessage, DiagramTable } from '../../src/webview-messages/diagram-messages';
import { postFromHost } from '../test-support/host-messages';
import { renderWebview } from '../test-support/render-webview';
import { expectTreeVirtualized, scrollTreeToBottom, treeRow, treeRowTexts } from '../test-support/schema-tree-layout';
import { postedMessages } from '../test-support/vscode-api-stub';
import { SCHEMA_DRAG_HANDLE_CLASS } from './components/schema-group-node';
import { TABLE_DRAG_HANDLE_CLASS } from './components/table-node';
import { App } from './app';

// The diagram gestures app.spec.tsx can't cover, run in real Chromium (see vitest.browser.config.ts).
// Moving a table or schema and resizing a schema all go through d3-drag, which needs real pointer
// events and real element geometry - under jsdom its mousedown handler can't even read event.view.
// Here Playwright drives the real mouse, so each gesture runs the way it does in a webview panel: React
// Flow moves or resizes the node, and on release the app reports the result to the host.
//
// fitView scales the canvas to fit the diagram, so screen pixels are not model units. Each test reads
// the zoom React Flow actually chose and converts the dragged distance through it, rather than
// assuming one - the chosen zoom depends on the viewport and so is not a fixed number.

interface Point {
	x: number;
	y: number;
}

const DRAG_DISTANCE: Point = { x: 120, y: 90 };
// Resizing moves the box's own edges, so a smaller distance keeps the far corner on screen.
const RESIZE_DISTANCE: Point = { x: 60, y: 40 };
// Enough to move the schema's bottom-right corner out from under the overview map - see panCanvas.
const CORNER_CLEARANCE: Point = { x: -200, y: -150 };
// 2-3px per move. With 10 steps a node lands 9/10 of the way there, since React Flow measures a drag
// from the move that crossed its threshold, not from the mousedown - library behaviour, which a real
// hand's 1-2px moves make invisible. expectDragged allows for one step's worth of it.
const DRAG_STEPS = 40;

// The same limits schema-group-node.tsx gives its NodeResizer.
const MIN_SCHEMA_WIDTH = 120;
const MIN_SCHEMA_HEIGHT = 80;

function column(name: string, overrides: Partial<DiagramTable['columns'][number]> = {}): DiagramTable['columns'][number] {
	return { name, type: 'DECIMAL(7,0)', primaryKey: false, foreignKey: false, identity: false, notNull: true, unique: false, indexed: false, ...overrides };
}

// One schema offset from the origin, so a table's model position (absolute) and its React Flow position
// (relative to the schema group) differ - a drag that forgot the conversion would report the wrong one.
// The tables sit along the top, leaving the lower part of the box empty to pan from.
const SCHEMA_BOUNDS = { x: 100, y: 50, width: 900, height: 500 };
const CUSTOMER_POSITION: Point = { x: 140, y: 110 };
const ORDERS_POSITION: Point = { x: 560, y: 110 };

const MODEL: DiagramModel = {
	schemas: [{ id: 'SALES', name: 'SALES', color: '#3366cc', bounds: SCHEMA_BOUNDS }],
	tables: [
		{
			id: 'SALES.CUSTOMER', schemaId: 'SALES', name: 'CUSTOMER', position: CUSTOMER_POSITION,
			columns: [column('CUSTOMER_NUMBER', { shortName: 'CUSNO', longName: 'CUSTOMER_NUMBER', primaryKey: true })]
		},
		{
			id: 'SALES.ORDERS', schemaId: 'SALES', name: 'ORDERS', position: ORDERS_POSITION,
			columns: [column('ORDER_NUMBER', { shortName: 'ORDNO', longName: 'ORDER_NUMBER', primaryKey: true })]
		}
	],
	relationships: []
};

function initialState(model: DiagramModel = MODEL): DiagramInitialState {
	return { model: model, fileName: 'sales.drawio', columnLabels: ['Short Name', 'Long Name'] };
}

/** A table or schema group node - React Flow renders both the same way. */
function flowNode(id: string): HTMLElement {
	let node = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
	if (!node) {
		throw new Error(`node ${id} is not rendered`);
	}
	return node;
}

function child(id: string, selector: string, description: string): HTMLElement {
	let element = flowNode(id).querySelector<HTMLElement>(selector);
	if (!element) {
		throw new Error(`node ${id} has no ${description}`);
	}
	return element;
}

function tableHeader(id: string): HTMLElement {
	return child(id, `.${TABLE_DRAG_HANDLE_CLASS}`, 'drag handle');
}

function schemaTab(id: string): HTMLElement {
	return child(id, `.${SCHEMA_DRAG_HANDLE_CLASS}`, 'drag handle');
}

/** One of NodeResizer's corner handles on a schema group. */
function resizeHandle(id: string, corner: 'top.left' | 'bottom.right'): HTMLElement {
	return child(id, `.react-flow__resize-control.handle.${corner}`, `${corner} resize handle`);
}

function columnRow(id: string, text: string): HTMLElement {
	let match = [...flowNode(id).querySelectorAll<HTMLElement>('*')].find(element => element.children.length === 0 && element.textContent === text);
	if (!match) {
		throw new Error(`node ${id} has no "${text}" cell`);
	}
	return match;
}

function pane(): HTMLElement {
	return document.querySelector<HTMLElement>('.react-flow__pane') as HTMLElement;
}

function canvasTransform(): DOMMatrix {
	let viewport = document.querySelector<HTMLElement>('.react-flow__viewport') as HTMLElement;
	return new DOMMatrix(getComputedStyle(viewport).transform);
}

/** The scale React Flow applied to the canvas. */
function canvasZoom(): number {
	return canvasTransform().a;
}

/** The pan offset React Flow applied to the canvas, in screen pixels. */
function canvasPan(): Point {
	let transform = canvasTransform();
	return { x: transform.e, y: transform.f };
}

function screenBox(element: HTMLElement): DOMRect {
	return element.getBoundingClientRect();
}

function movement(before: DOMRect, after: DOMRect): Point {
	return { x: after.left - before.left, y: after.top - before.top };
}

async function renderDiagram(model: DiagramModel = MODEL) {
	renderWebview(<ReactFlowProvider><App /></ReactFlowProvider>, { initialState: initialState(model) });

	// Tables only appear once React Flow's deferred onInit has moved the canvas off its initial
	// 'cluster' zoom tier, and only measure once the browser has laid them out.
	await waitFor(() => expect(screenBox(tableHeader(model.tables[0].id)).width).toBeGreaterThan(0));
}

/**
 * Asserts a measured on-screen movement is the dragged distance, give or take the first move React
 * Flow drops (see DRAG_STEPS) and a pixel of rounding. The lost step only ever makes a movement
 * shorter, so the shortfall is measured along the drag direction: an overshoot fails.
 */
function expectDragged(moved: Point, distance: Point) {
	for (let axis of ['x', 'y'] as const) {
		let shortfall = (distance[axis] - moved[axis]) * Math.sign(distance[axis]);
		expect(shortfall, `${axis} movement ${moved[axis]} for a ${distance[axis]}px drag`).toBeGreaterThanOrEqual(-1);
		expect(shortfall, `${axis} movement ${moved[axis]} for a ${distance[axis]}px drag`).toBeLessThanOrEqual(Math.abs(distance[axis]) / DRAG_STEPS + 1);
	}
}

/**
 * Presses the mouse on `source` (at its centre, or at `from` relative to its top-left corner), moves it
 * `distance` screen pixels in several steps, and releases. The release point is given relative to the
 * pane, which covers the whole canvas, so it doesn't depend on what happens to be under the pointer there.
 *
 * `force` skips Playwright's check that the pointer lands on `source` itself. That is also what lets a
 * drag start over an element with pointer-events: none - the browser's own hit testing then decides
 * what really receives the mousedown, exactly as it would for a user.
 */
async function drag(source: HTMLElement, distance: Point, from?: Point) {
	let sourceBox = screenBox(source);
	let paneBox = screenBox(pane());
	let sourcePosition = from ?? { x: sourceBox.width / 2, y: sourceBox.height / 2 };

	await userEvent.dragAndDrop(source, pane(), {
		sourcePosition: sourcePosition,
		targetPosition: {
			x: sourceBox.left + sourcePosition.x + distance.x - paneBox.left,
			y: sourceBox.top + sourcePosition.y + distance.y - paneBox.top
		},
		// Small intermediate moves, the way a real hand drags, rather than one jump to the end. The size
		// matters: React Flow only starts a drag once the pointer passes its 1px threshold, and measures
		// the drag from that point, so the whole first move is lost - see DRAG_STEPS.
		steps: DRAG_STEPS,
		force: true
	});
}

/** A point inside the schema box, below its tables, where a drag pans the canvas. */
function emptySchemaInterior(id: string): Point {
	return { x: 40, y: screenBox(flowNode(id)).height - 40 };
}

/**
 * Pans the canvas the way a user would, by dragging empty space. fitView leaves the diagram's
 * bottom-right corner under the overview map panel, which sits above the canvas and swallows a press on
 * the schema's bottom-right resize handle, so a test of that handle has to pan it clear first.
 */
async function panCanvas(distance: Point) {
	await drag(flowNode('SALES'), distance, emptySchemaInterior('SALES'));
}

// The zoom tier thresholds from src/diagram/diagram-zoom-tiers.ts, and the one below which a cluster-tier
// schema box drops its table count.
const COLLAPSED_TIER_BELOW = 0.55;
const CLUSTER_TIER_BELOW = 0.15;
const SCHEMA_NAME_ONLY_BELOW = 0.05;

/** Whether React Flow has rendered this node or line at all - a hidden one renders nothing. */
function isRendered(kind: 'node' | 'edge', id: string): boolean {
	return document.querySelector(`.react-flow__${kind}[data-id="${id}"]`) !== null;
}

/** A line's two ends in screen pixels, read off its rendered SVG path. */
function lineEnds(edgeId: string): { source: Point; target: Point } {
	let path = document.querySelector<SVGPathElement>(`.react-flow__edge[data-id="${edgeId}"] path.react-flow__edge-path`);
	if (!path) {
		throw new Error(`line ${edgeId} is not rendered`);
	}

	let toScreen = path.getScreenCTM() as DOMMatrix;
	let toPoint = (point: DOMPoint): Point => {
		let onScreen = point.matrixTransform(toScreen);
		return { x: onScreen.x, y: onScreen.y };
	};

	return { source: toPoint(path.getPointAtLength(0)), target: toPoint(path.getPointAtLength(path.getTotalLength())) };
}

/** A column's rendered row - the element its (invisible) React Flow handles sit inside. */
function rowBox(tableId: string, columnName: string): DOMRect {
	let handle = flowNode(tableId).querySelector<HTMLElement>(`[data-handleid="${columnName}-source-left"]`);
	if (!handle?.parentElement) {
		throw new Error(`table ${tableId} has no rendered row for ${columnName}`);
	}
	return screenBox(handle.parentElement);
}

function expectNear(actual: Point, expected: Point, tolerance: number, what: string) {
	expect(Math.abs(actual.y - expected.y), `${what}: y ${actual.y} vs ${expected.y}`).toBeLessThanOrEqual(tolerance);
	expect(Math.abs(actual.x - expected.x), `${what}: x ${actual.x} vs ${expected.x}`).toBeLessThanOrEqual(tolerance);
}

/**
 * Turns the mouse wheel over the canvas until `done` holds. Negative `deltaY` zooms in. Each tick changes
 * the zoom by a fixed factor (2^(-deltaY/500) in React Flow), so a small delta can't jump over a narrow
 * zoom range in one tick.
 */
async function wheelUntil(done: () => boolean, deltaY: number, what: string) {
	for (let tick = 0; tick < 80 && !done(); tick++) {
		await userEvent.wheel(pane(), { delta: { y: deltaY } });
	}
	if (!done()) {
		throw new Error(`test setup: zoom ${canvasZoom()} never reached ${what}`);
	}
}

function posted(): DiagramOutboundMessage[] {
	return postedMessages<DiagramOutboundMessage>().filter(message => message.command !== 'ready');
}

const LAYOUT_COMMANDS: DiagramOutboundMessage['command'][] = ['moveTable', 'moveTables', 'moveSchema', 'resizeSchema'];

/** Only the messages that change the diagram's layout - a click on a table header also posts tableClicked. */
function layoutMessages(): DiagramOutboundMessage[] {
	return posted().filter(message => LAYOUT_COMMANDS.includes(message.command));
}

/** The one layout message a gesture should have posted, narrowed to the command expected. */
async function onlyLayoutMessage<TCommand extends DiagramOutboundMessage['command']>(command: TCommand): Promise<Extract<DiagramOutboundMessage, { command: TCommand }>> {
	await waitFor(() => expect(layoutMessages()).toHaveLength(1));
	let [message] = layoutMessages();
	expect(message.command).toBe(command);
	return message as Extract<DiagramOutboundMessage, { command: TCommand }>;
}

describe('diagram webview in a real browser', () => {
	it('lays the canvas out at the real viewport size', async () => {
		await renderDiagram();

		// The whole point of this suite: elements have real sizes.
		expect(screenBox(pane()).width).toBe(window.innerWidth);
		expect(screenBox(flowNode('SALES.CUSTOMER')).width).toBeGreaterThan(0);
		expect(canvasZoom()).toBeGreaterThan(0);
	});

	describe('moving a table', () => {
		it('moves a table dragged by its header and reports its new absolute position', async () => {
			await renderDiagram();
			let zoom = canvasZoom();
			let before = screenBox(flowNode('SALES.CUSTOMER'));

			await drag(tableHeader('SALES.CUSTOMER'), DRAG_DISTANCE);

			let message = await onlyLayoutMessage('moveTable');
			expect(message.tableId).toBe('SALES.CUSTOMER');

			// The node followed the pointer on screen.
			let moved = movement(before, screenBox(flowNode('SALES.CUSTOMER')));
			expectDragged(moved, DRAG_DISTANCE);

			// And what the host is told is exactly where the node now is on screen, in model units: the
			// on-screen movement undone by the canvas zoom, added to the table's absolute starting position
			// (not its position relative to the schema group, which is what React Flow hands the handler).
			expect(message.position.x).toBeCloseTo(CUSTOMER_POSITION.x + moved.x / zoom, 1);
			expect(message.position.y).toBeCloseTo(CUSTOMER_POSITION.y + moved.y / zoom, 1);
		});

		it('leaves the other tables where they were', async () => {
			await renderDiagram();
			let ordersBefore = screenBox(flowNode('SALES.ORDERS'));

			await drag(tableHeader('SALES.CUSTOMER'), DRAG_DISTANCE);

			await onlyLayoutMessage('moveTable');
			expect(screenBox(flowNode('SALES.ORDERS'))).toEqual(ordersBefore);
		});

		it('does not move a table dragged by a column row, only by its header', async () => {
			await renderDiagram();
			let before = screenBox(flowNode('SALES.CUSTOMER'));

			// The dragHandle restriction in buildNodes: a mousedown outside the header starts no drag, so a
			// column click can't move the table and swallow the click with it.
			await drag(columnRow('SALES.CUSTOMER', 'CUSNO'), DRAG_DISTANCE);

			expect(layoutMessages()).toEqual([]);
			expect(screenBox(flowNode('SALES.CUSTOMER'))).toEqual(before);
		});

		it('moves every selected table together and reports them all in one moveTables', async () => {
			await renderDiagram();
			let zoom = canvasZoom();
			let customerBefore = screenBox(flowNode('SALES.CUSTOMER'));
			let ordersBefore = screenBox(flowNode('SALES.ORDERS'));

			// Ctrl+click is React Flow's multi-select outside macOS; dragging any selected table then drags
			// the whole selection. Only the one under the pointer is the drag's own node, so this is the
			// case handleNodeDragStop reads its third argument for.
			await userEvent.click(tableHeader('SALES.CUSTOMER'), { modifiers: ['Control'] });
			await userEvent.click(tableHeader('SALES.ORDERS'), { modifiers: ['Control'] });
			await drag(tableHeader('SALES.CUSTOMER'), DRAG_DISTANCE);

			let message = await onlyLayoutMessage('moveTables');
			let customerMoved = movement(customerBefore, screenBox(flowNode('SALES.CUSTOMER')));
			let ordersMoved = movement(ordersBefore, screenBox(flowNode('SALES.ORDERS')));
			expectDragged(customerMoved, DRAG_DISTANCE);
			// A rigid group: both moved by exactly the same amount.
			expect(ordersMoved.x).toBeCloseTo(customerMoved.x, 1);
			expect(ordersMoved.y).toBeCloseTo(customerMoved.y, 1);

			let positions = Object.fromEntries(message.tables.map(table => [table.tableId, table.position]));
			expect(Object.keys(positions).sort()).toEqual(['SALES.CUSTOMER', 'SALES.ORDERS']);
			expect(positions['SALES.CUSTOMER'].x).toBeCloseTo(CUSTOMER_POSITION.x + customerMoved.x / zoom, 1);
			expect(positions['SALES.CUSTOMER'].y).toBeCloseTo(CUSTOMER_POSITION.y + customerMoved.y / zoom, 1);
			expect(positions['SALES.ORDERS'].x).toBeCloseTo(ORDERS_POSITION.x + ordersMoved.x / zoom, 1);
			expect(positions['SALES.ORDERS'].y).toBeCloseTo(ORDERS_POSITION.y + ordersMoved.y / zoom, 1);
		});
	});

	describe('moving a schema', () => {
		it('moves a schema dragged by its title tab, carrying its tables, and reports its new position', async () => {
			await renderDiagram();
			let zoom = canvasZoom();
			let schemaBefore = screenBox(flowNode('SALES'));
			let customerBefore = screenBox(flowNode('SALES.CUSTOMER'));

			await drag(schemaTab('SALES'), DRAG_DISTANCE);

			let message = await onlyLayoutMessage('moveSchema');
			expect(message.schemaId).toBe('SALES');

			let moved = movement(schemaBefore, screenBox(flowNode('SALES')));
			expectDragged(moved, DRAG_DISTANCE);
			// Tables are React Flow children of the schema group, so they move with it on screen. The host
			// shifts their model positions itself (see moveSchema in diagram-model-editor.ts), so only the
			// schema's own position travels.
			let customerMoved = movement(customerBefore, screenBox(flowNode('SALES.CUSTOMER')));
			expect(customerMoved.x).toBeCloseTo(moved.x, 1);
			expect(customerMoved.y).toBeCloseTo(moved.y, 1);

			expect(message.position.x).toBeCloseTo(SCHEMA_BOUNDS.x + moved.x / zoom, 1);
			expect(message.position.y).toBeCloseTo(SCHEMA_BOUNDS.y + moved.y / zoom, 1);
		});

		it('pans the canvas instead of moving the schema when dragged from the empty inside of its box', async () => {
			await renderDiagram();
			let panBefore = canvasPan();
			let schemaBefore = screenBox(flowNode('SALES'));

			// Below the tables, inside the border. The box and React Flow's own node wrapper are both
			// pointer-events: none (see buildNodes), so the browser hands this mousedown to the pane behind.
			// If either stopped being none, this would start a node drag instead.
			await drag(flowNode('SALES'), DRAG_DISTANCE, emptySchemaInterior('SALES'));

			let panMoved = { x: canvasPan().x - panBefore.x, y: canvasPan().y - panBefore.y };
			expectDragged(panMoved, DRAG_DISTANCE);
			// The whole canvas moved, the schema with it - but nothing about the diagram itself changed.
			let schemaMoved = movement(schemaBefore, screenBox(flowNode('SALES')));
			expect(schemaMoved.x).toBeCloseTo(panMoved.x, 1);
			expect(schemaMoved.y).toBeCloseTo(panMoved.y, 1);
			expect(layoutMessages()).toEqual([]);
		});
	});

	describe('resizing a schema', () => {
		it('grows a schema from its bottom-right corner, keeping its origin', async () => {
			await renderDiagram();
			// Out from under the overview map (see panCanvas). Panning changes no model coordinates.
			await panCanvas(CORNER_CLEARANCE);
			let zoom = canvasZoom();
			let before = screenBox(flowNode('SALES'));

			await drag(resizeHandle('SALES', 'bottom.right'), RESIZE_DISTANCE);

			let message = await onlyLayoutMessage('resizeSchema');
			expect(message.schemaId).toBe('SALES');

			let after = screenBox(flowNode('SALES'));
			let grown = { x: after.width - before.width, y: after.height - before.height };
			expectDragged(grown, RESIZE_DISTANCE);
			expect(after.left).toBeCloseTo(before.left, 1);
			expect(after.top).toBeCloseTo(before.top, 1);

			expect(message.bounds.x).toBeCloseTo(SCHEMA_BOUNDS.x, 1);
			expect(message.bounds.y).toBeCloseTo(SCHEMA_BOUNDS.y, 1);
			expect(message.bounds.width).toBeCloseTo(SCHEMA_BOUNDS.width + grown.x / zoom, 1);
			expect(message.bounds.height).toBeCloseTo(SCHEMA_BOUNDS.height + grown.y / zoom, 1);
		});

		it('moves the origin as well as the size when resized from its top-left corner', async () => {
			await renderDiagram();
			let zoom = canvasZoom();
			let before = screenBox(flowNode('SALES'));

			// Why resizeSchema carries the full rectangle rather than just width/height (see the
			// onResizeEnd comment in schema-group-node.tsx): this handle moves the box's origin.
			await drag(resizeHandle('SALES', 'top.left'), RESIZE_DISTANCE);

			let message = await onlyLayoutMessage('resizeSchema');
			let after = screenBox(flowNode('SALES'));
			let moved = movement(before, after);
			expectDragged(moved, RESIZE_DISTANCE);
			// The opposite corner stays put.
			expect(after.right).toBeCloseTo(before.right, 1);
			expect(after.bottom).toBeCloseTo(before.bottom, 1);

			expect(message.bounds.x).toBeCloseTo(SCHEMA_BOUNDS.x + moved.x / zoom, 1);
			expect(message.bounds.y).toBeCloseTo(SCHEMA_BOUNDS.y + moved.y / zoom, 1);
			expect(message.bounds.width).toBeCloseTo(SCHEMA_BOUNDS.width - moved.x / zoom, 1);
			expect(message.bounds.height).toBeCloseTo(SCHEMA_BOUNDS.height - moved.y / zoom, 1);
		});

		it('stops shrinking at the minimum size', async () => {
			await renderDiagram();
			let before = screenBox(flowNode('SALES'));

			// Far past the opposite corner, which would turn the box inside out without a minimum. The
			// top-left handle keeps the bottom-right corner fixed, so the origin ends up the minimum size
			// back from it.
			await drag(resizeHandle('SALES', 'top.left'), { x: before.width, y: before.height });

			let message = await onlyLayoutMessage('resizeSchema');
			expect(message.bounds.width).toBeCloseTo(MIN_SCHEMA_WIDTH, 1);
			expect(message.bounds.height).toBeCloseTo(MIN_SCHEMA_HEIGHT, 1);
			expect(message.bounds.x).toBeCloseTo(SCHEMA_BOUNDS.x + SCHEMA_BOUNDS.width - MIN_SCHEMA_WIDTH, 1);
			expect(message.bounds.y).toBeCloseTo(SCHEMA_BOUNDS.y + SCHEMA_BOUNDS.height - MIN_SCHEMA_HEIGHT, 1);
		});
	});

	// React Flow's fitView() doesn't fit on the spot. It queues the fit and applies it on the next node
	// update, but only once every visible node has a `measured` size - until then the fit just waits, and
	// the canvas doesn't move. Tables only got `measured` from React Flow's ResizeObserver, which only fires
	// when an element mounts or changes size, and every modelUpdated rebuilds the nodes without it. So after
	// any edit, the Fit view button did nothing until some later zoom happened to remount a table.
	describe('fit view', () => {
		async function clickFitView() {
			await userEvent.click(screen.getByRole('button', { name: 'Fit view' }));
		}

		/** Waits for the canvas to settle back on the transform fitView gave it when the diagram opened. */
		async function expectFitted(fitted: DOMMatrix) {
			await waitFor(() => {
				let current = canvasTransform();
				expect(current.a).toBeCloseTo(fitted.a, 3);
				expect(current.e).toBeCloseTo(fitted.e, 0);
				expect(current.f).toBeCloseTo(fitted.f, 0);
			});
		}

		it('re-fits the diagram after the canvas has been panned', async () => {
			await renderDiagram();
			let fitted = canvasTransform();

			await panCanvas(DRAG_DISTANCE);
			expect(canvasPan().x).not.toBeCloseTo(fitted.e, 0);

			await clickFitView();
			await expectFitted(fitted);
		});

		it('still re-fits after an edit, once the host has sent the updated model', async () => {
			await renderDiagram();
			let fitted = canvasTransform();

			// A real edit round trip: move a table, then the modelUpdated the host answers every edit with
			// (a move, a resize, an add, an undo), which rebuilds every node. The table stays inside its
			// schema box, so the diagram's bounds - and so the fitted view - don't change.
			await drag(tableHeader('SALES.CUSTOMER'), { x: 40, y: 30 });
			let move = await onlyLayoutMessage('moveTable');
			let moved = structuredClone(MODEL);
			moved.tables = moved.tables.map(table => table.id === move.tableId ? { ...table, position: move.position } : table);
			postFromHost<DiagramInboundMessage>({ command: 'modelUpdated', model: moved });

			await panCanvas(DRAG_DISTANCE);
			expect(canvasPan().x).not.toBeCloseTo(fitted.e, 0);

			await clickFitView();
			await expectFitted(fitted);
		});

		it('re-fits after zooming in on one end of a diagram too wide to show its tables', async () => {
			// Two schemas far enough apart that fitting both lands on the 'cluster' tier, where every table
			// is hidden. Zooming in on one then shows its tables, while the other schema's table stays off
			// screen - and onlyRenderVisibleElements never mounts it, so nothing ever measures it.
			let wide = structuredClone(MODEL);
			wide.schemas.push({ id: 'FAR', name: 'FAR', color: '#cc6633', bounds: { x: 12000, y: 50, width: 900, height: 500 } });
			wide.tables.push({ id: 'FAR.PART', schemaId: 'FAR', name: 'PART', position: { x: 12040, y: 110 }, columns: [column('PART_NUMBER')] });
			renderWebview(<ReactFlowProvider><App /></ReactFlowProvider>, { initialState: { ...initialState(), model: wide } });
			await waitFor(() => expect(screenBox(schemaTab('SALES')).width).toBeGreaterThan(0));
			let fitted = canvasTransform();
			expect(document.querySelector('.react-flow__node[data-id="SALES.CUSTOMER"]')).toBeNull();

			// Wheel in over SALES until its tables are rendered - past the 'cluster' tier.
			for (let tick = 0; tick < 30 && !document.querySelector(`.react-flow__node[data-id="SALES.CUSTOMER"] .${TABLE_DRAG_HANDLE_CLASS}`); tick++) {
				await userEvent.wheel(schemaTab('SALES'), { delta: { y: -300 } });
			}
			await waitFor(() => expect(screenBox(tableHeader('SALES.CUSTOMER')).width).toBeGreaterThan(0));
			expect(document.querySelector('.react-flow__node[data-id="FAR.PART"]')).toBeNull();

			await clickFitView();
			await expectFitted(fitted);
		});
	});

	// The same shared SchemaTree as the schema browser's (see schemas/app.browser.spec.tsx), mounted beside
	// the canvas once connected - a different host layout, so its bounded height is checked separately.
	describe('table picker tree', () => {
		const PICKER_TABLE_COUNT = 2000;

		function pickerTableName(index: number): string {
			return `TBL${String(index).padStart(4, '0')}`;
		}

		async function connectWithManyTables() {
			await renderDiagram();
			postFromHost<DiagramInboundMessage>({ command: 'connectionChanged', connectionName: 'Production' });
			postFromHost<DiagramInboundMessage>({
				command: 'schemaTablesLoaded',
				tablesBySchema: { SALES: Array.from({ length: PICKER_TABLE_COUNT }, (_, index) => ({ schema: 'SALES', table: pickerTableName(index + 1) })) },
				schemaList: [{ name: 'SALES', hidden: false, added: false }],
				disabledImportTables: []
			});

			await waitFor(() => expect(treeRowTexts()).toContain('SALES'));
			await userEvent.click(treeRow('SALES'));
			await userEvent.click(treeRow(`Tables (${PICKER_TABLE_COUNT})`));
			await waitFor(() => expect(treeRowTexts()).toContain(pickerTableName(1)));
		}

		it('scrolls within a bounded height beside the canvas and renders only the rows in view', async () => {
			await connectWithManyTables();

			expectTreeVirtualized(PICKER_TABLE_COUNT);
		});

		it('renders the last table once the tree is scrolled to the bottom', async () => {
			await connectWithManyTables();

			await scrollTreeToBottom();

			await waitFor(() => expect(treeRowTexts()).toContain(pickerTableName(PICKER_TABLE_COUNT)));
			expect(treeRowTexts()).not.toContain(pickerTableName(1));
		});
	});

	// Where each relationship line meets its tables, checked against the rendered rows themselves. A line's
	// ends come from declared handle geometry (tableNodeHandles/tableMiddleHandles in table-node.tsx,
	// computed from layout-constants.ts); the rows it should meet are laid out independently by CSS. The two
	// have drifted apart before - a description line or a title line the font rendered a pixel taller than
	// the constant assumed - by a few pixels that only show while a table is moving. Comparing the line
	// against its own formula can't catch that, so every check here is against a row's real bounding box.
	//
	// There are two geometries to keep honest, not one. React Flow re-measures every handle from the DOM
	// whenever its ResizeObserver fires for a table, and that stands until the next render re-parses the
	// declared handles (see HANDLE_STYLE in table-node.tsx). So a line can be drawn from either, depending
	// on which came last. A drag ends in a render, so the drag test sees the declared geometry; a zoom that
	// stays on one tier doesn't, so the zoomed-in test sees the DOM-measured one. The first test can see
	// either.
	describe('relationship lines', () => {
		// CUSTOMER has a description (a taller header, so every row sits lower), ORDERS doesn't. Both lines
		// anchor rows well down their tables, where a per-row error would have added up. ORDERS is to the
		// right of CUSTOMER, so each line leaves ORDERS on its left and enters CUSTOMER on its right.
		const RELATED_MODEL: DiagramModel = {
			schemas: [{ id: 'SALES', name: 'SALES', color: '#3366cc', bounds: SCHEMA_BOUNDS }],
			tables: [
				{
					id: 'SALES.CUSTOMER', schemaId: 'SALES', name: 'CUSTOMER', description: 'Customer master', position: CUSTOMER_POSITION,
					columns: [column('CUSTOMER_NUMBER', { primaryKey: true }), column('NAME'), column('REGION_CODE')]
				},
				{
					id: 'SALES.ORDERS', schemaId: 'SALES', name: 'ORDERS', position: ORDERS_POSITION,
					columns: [column('ORDER_NUMBER', { primaryKey: true }), column('ORDER_DATE'), column('REGION_CODE', { foreignKey: true }), column('CUSTOMER_NUMBER', { foreignKey: true })]
				}
			],
			relationships: [
				{ id: 'orders-customer', fromTable: 'SALES.ORDERS', fromColumn: 'CUSTOMER_NUMBER', toTable: 'SALES.CUSTOMER', toColumn: 'CUSTOMER_NUMBER' },
				{ id: 'orders-region', fromTable: 'SALES.ORDERS', fromColumn: 'REGION_CODE', toTable: 'SALES.CUSTOMER', toColumn: 'REGION_CODE' }
			]
		};

		// Under a pixel either way: the ends are fractional screen positions. A whole model unit of drift -
		// the 1px table border this caught - is 1.16px at the fitted zoom and 2px at maxZoom, so it fails.
		const ANCHOR_TOLERANCE = 0.5;
		function expectAt(actual: Point, expected: Point, what: string) {
			expectNear(actual, expected, ANCHOR_TOLERANCE, what);
		}

		/** The middle of a row's left or right edge - where a line should meet it. */
		function rowEdge(tableId: string, columnName: string, side: 'left' | 'right'): Point {
			let row = rowBox(tableId, columnName);
			let table = screenBox(flowNode(tableId));
			return { x: side === 'left' ? table.left : table.right, y: row.top + row.height / 2 };
		}

		function expectLinesOnTheirRows() {
			for (let relationship of RELATED_MODEL.relationships) {
				let ends = lineEnds(relationship.id);
				expectAt(ends.source, rowEdge(relationship.fromTable, relationship.fromColumn, 'left'), `${relationship.id} at ${relationship.fromTable}.${relationship.fromColumn}`);
				expectAt(ends.target, rowEdge(relationship.toTable, relationship.toColumn, 'right'), `${relationship.id} at ${relationship.toTable}.${relationship.toColumn}`);
			}
		}

		async function renderRelated() {
			await renderDiagram(RELATED_MODEL);
			await waitFor(() => lineEnds('orders-customer'));
		}

		it('meets each end on the middle of its column row, below a header with or without a description', async () => {
			await renderRelated();

			expectLinesOnTheirRows();
		});

		it('still meets its rows zoomed right in, where any drift is magnified', async () => {
			await renderRelated();

			for (let tick = 0; tick < 10; tick++) {
				await userEvent.wheel(pane(), { delta: { y: -300 } });
			}
			await waitFor(() => expect(canvasZoom()).toBeCloseTo(2, 3));

			// maxZoom is 2 - anything off by a fraction of a model unit is now twice as far off on screen.
			// Pan so both tables' rows are on screen: the wheel zoomed about the pane's centre.
			let ordersRow = rowBox('SALES.ORDERS', 'CUSTOMER_NUMBER');
			if (ordersRow.top < 0 || ordersRow.bottom > window.innerHeight) {
				throw new Error(`test setup: the ORDERS row is off screen at ${ordersRow.top}`);
			}
			expectLinesOnTheirRows();
		});

		it('follows a table that has been dragged', async () => {
			await renderRelated();

			// Downwards, so the line has to climb to the other table and its ends are no longer level.
			await drag(tableHeader('SALES.ORDERS'), { x: 60, y: 120 });
			await onlyLayoutMessage('moveTable');

			expectLinesOnTheirRows();
		});

		it('meets each table in the middle of its side once zoomed out far enough to collapse the tables', async () => {
			await renderRelated();

			// The 'collapsed' tier (tierForZoom in src/diagram/diagram-zoom-tiers.ts): tables stay on screen
			// but show no column rows, so the lines fall back to one handle halfway down each table
			// (tableMiddleHandles). Small wheel steps, so the zoom can't jump straight past it into 'cluster'.
			for (let tick = 0; tick < 40 && canvasZoom() >= COLLAPSED_TIER_BELOW; tick++) {
				await userEvent.wheel(pane(), { delta: { y: 50 } });
			}
			await waitFor(() => expect(canvasZoom()).toBeLessThan(COLLAPSED_TIER_BELOW));
			expect(canvasZoom(), 'still above the cluster tier, where tables are hidden').toBeGreaterThan(CLUSTER_TIER_BELOW);

			// The tier itself only changes on onMoveEnd, once the wheel gesture has settled, so the lines move
			// to the middle handles a moment after the zoom crosses the threshold - wait for them.
			await waitFor(() => {
				for (let relationship of RELATED_MODEL.relationships) {
					let ends = lineEnds(relationship.id);
					let from = screenBox(flowNode(relationship.fromTable));
					let to = screenBox(flowNode(relationship.toTable));
					expectAt(ends.source, { x: from.left, y: from.top + from.height / 2 }, `${relationship.id} at ${relationship.fromTable}`);
					expectAt(ends.target, { x: to.right, y: to.top + to.height / 2 }, `${relationship.id} at ${relationship.toTable}`);
				}
			});
		});
	});

	// What the canvas shows at each zoom tier (tierForZoom in src/diagram/diagram-zoom-tiers.ts, which the
	// unit suite covers on its own). The tier is state in app.tsx, set from the zoom on onInit and on every
	// onMoveEnd, and each tier swaps what React Flow renders: column rows when expanded, one name block per
	// table when collapsed, and when clustered no tables at all, only a summary box per schema with one line
	// per related pair of schemas. React Flow renders nothing for a hidden node or line, so "not shown"
	// here means not in the DOM.
	//
	// The tier only changes on onMoveEnd, after a wheel gesture has settled, so every check waits for the
	// rendered result rather than stopping at the zoom value.
	describe('zoom tiers', () => {
		// Two schemas side by side, close enough that fitting both lands on the expanded tier, with one
		// relationship crossing between them - so there is a column-level line and a schema link to swap.
		const TIERS_MODEL: DiagramModel = {
			schemas: [
				{ id: 'SALES', name: 'SALES', color: '#3366cc', bounds: { x: 100, y: 50, width: 480, height: 300 } },
				{ id: 'STOCK', name: 'STOCK', color: '#cc6633', bounds: { x: 700, y: 50, width: 480, height: 300 } }
			],
			tables: [
				{
					id: 'SALES.CUSTOMER', schemaId: 'SALES', name: 'CUSTOMER', position: { x: 140, y: 110 },
					columns: [column('CUSTOMER_NUMBER', { primaryKey: true }), column('NAME')]
				},
				{
					id: 'STOCK.PART', schemaId: 'STOCK', name: 'PART', position: { x: 740, y: 110 },
					columns: [column('PART_NUMBER', { primaryKey: true }), column('CUSTOMER_NUMBER', { foreignKey: true })]
				}
			],
			relationships: [
				{ id: 'part-customer', fromTable: 'STOCK.PART', fromColumn: 'CUSTOMER_NUMBER', toTable: 'SALES.CUSTOMER', toColumn: 'CUSTOMER_NUMBER' }
			]
		};
		// schemaLinks() ids a pair by its two schema ids, sorted - see buildEdges in app.tsx.
		const SCHEMA_LINK = 'schema-link-SALES--STOCK';
		// Small enough steps to stop inside the cluster tier's count-showing range (0.05 to 0.15), which
		// is only a factor of 3 wide.
		const ZOOM_OUT = 100;
		const ZOOM_IN = -100;

		/** The name line inside a clustered schema's summary label (the label is also its drag handle). */
		function schemaName(id: string): HTMLElement {
			let name = schemaTab(id).firstElementChild;
			if (!(name instanceof HTMLElement)) {
				throw new Error(`schema ${id} has no name line in its label`);
			}
			return name;
		}

		function schemaText(id: string): string {
			return flowNode(id).textContent ?? '';
		}

		async function zoomToCollapsed() {
			await wheelUntil(() => canvasZoom() < COLLAPSED_TIER_BELOW, ZOOM_OUT, 'the collapsed tier');
			expect(canvasZoom(), 'overshot into the cluster tier').toBeGreaterThanOrEqual(CLUSTER_TIER_BELOW);
			await waitFor(() => expect(flowNode('SALES.CUSTOMER').querySelector('[data-handleid="CUSTOMER_NUMBER-source-left"]')).toBeNull());
		}

		async function zoomToCluster() {
			await wheelUntil(() => canvasZoom() < CLUSTER_TIER_BELOW, ZOOM_OUT, 'the cluster tier');
			expect(canvasZoom(), 'overshot the range where the table count shows').toBeGreaterThanOrEqual(SCHEMA_NAME_ONLY_BELOW);
			await waitFor(() => expect(isRendered('node', 'SALES.CUSTOMER')).toBe(false));
		}

		it('shows every column row, and the relationship line rather than the schema link, when expanded', async () => {
			await renderDiagram(TIERS_MODEL);
			expect(canvasZoom(), 'test setup: fitted onto the expanded tier').toBeGreaterThanOrEqual(COLLAPSED_TIER_BELOW);

			for (let table of TIERS_MODEL.tables) {
				for (let tableColumn of table.columns) {
					expect(rowBox(table.id, tableColumn.name).height, `${table.id}.${tableColumn.name} row`).toBeGreaterThan(0);
				}
			}
			// The header is one strip across the top, with the rows below it.
			expect(screenBox(tableHeader('SALES.CUSTOMER')).bottom).toBeLessThanOrEqual(rowBox('SALES.CUSTOMER', 'CUSTOMER_NUMBER').top + 0.5);

			await waitFor(() => lineEnds('part-customer'));
			expect(isRendered('edge', SCHEMA_LINK)).toBe(false);
		});

		it('replaces the column rows with one name block filling the table once collapsed', async () => {
			await renderDiagram(TIERS_MODEL);
			let expandedBox = screenBox(flowNode('SALES.CUSTOMER'));
			let expandedZoom = canvasZoom();

			await zoomToCollapsed();

			let table = flowNode('SALES.CUSTOMER');
			expect(table.querySelector('[data-handleid="NAME-source-left"]')).toBeNull();
			expect(table.textContent).toBe('CUSTOMER');
			// The table keeps its expanded footprint, scaled by the zoom (neighbours are spaced for it), and
			// the name block fills all of it rather than shrinking to a header strip.
			let collapsedBox = screenBox(table);
			let scale = canvasZoom() / expandedZoom;
			expect(collapsedBox.width).toBeCloseTo(expandedBox.width * scale, 0);
			expect(collapsedBox.height).toBeCloseTo(expandedBox.height * scale, 0);
			let block = screenBox(tableHeader('SALES.CUSTOMER'));
			expect(block.height).toBeCloseTo(collapsedBox.height, 0);

			// Tables are still shown, so the relationship line is too, and the schema link is not.
			lineEnds('part-customer');
			expect(isRendered('edge', SCHEMA_LINK)).toBe(false);
		});

		it('hides the tables and their lines once clustered, showing a summary box per schema joined by one link', async () => {
			await renderDiagram(TIERS_MODEL);

			await zoomToCollapsed();
			await zoomToCluster();

			for (let table of TIERS_MODEL.tables) {
				expect(isRendered('node', table.id), `${table.id} rendered`).toBe(false);
			}
			expect(isRendered('edge', 'part-customer')).toBe(false);
			await waitFor(() => expect(schemaText('SALES')).toBe('SALES1 table'));
			expect(schemaText('STOCK')).toBe('STOCK1 table');

			// The link runs between the two boxes' centres (schemaCenterHandles), not from a corner or an edge.
			let ends = lineEnds(SCHEMA_LINK);
			let centre = (id: string): Point => {
				let box = screenBox(flowNode(id));
				return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
			};
			// Which box is the source follows the sorted pair, so either way round is correct.
			let [first, second] = ends.source.x < ends.target.x ? [ends.source, ends.target] : [ends.target, ends.source];
			expectNear(first, centre('SALES'), 1, 'link at SALES');
			expectNear(second, centre('STOCK'), 1, 'link at STOCK');
		});

		it('keeps a clustered schema\'s name the same size on screen as the box shrinks, and drops the table count once too small', async () => {
			await renderDiagram(TIERS_MODEL);
			await zoomToCollapsed();
			await zoomToCluster();
			let clusterZoom = canvasZoom();
			let boxWidth = screenBox(flowNode('SALES')).width;
			let nameHeight = screenBox(schemaName('SALES')).height;

			await wheelUntil(() => canvasZoom() < SCHEMA_NAME_ONLY_BELOW, ZOOM_OUT, 'the name-only range');

			// The count is read live off the zoom, not the tier, so it goes without waiting for onMoveEnd.
			await waitFor(() => expect(schemaText('SALES')).toBe('SALES'));
			// The box shrank with the zoom, a factor of 3 or more by now, but the name is counter-scaled
			// (scale(1/zoom)) and reads at the same size on screen.
			let shrink = canvasZoom() / clusterZoom;
			expect(shrink).toBeLessThan(0.75);
			expect(screenBox(flowNode('SALES')).width).toBeCloseTo(boxWidth * shrink, 0);
			expect(screenBox(schemaName('SALES')).height).toBeCloseTo(nameHeight, 0);
		});

		it('brings the tables, their columns and the relationship line back when zoomed back in', async () => {
			await renderDiagram(TIERS_MODEL);
			await zoomToCollapsed();
			await zoomToCluster();
			await waitFor(() => lineEnds(SCHEMA_LINK));

			await wheelUntil(() => canvasZoom() >= COLLAPSED_TIER_BELOW, ZOOM_IN, 'the expanded tier');

			await waitFor(() => expect(rowBox('STOCK.PART', 'CUSTOMER_NUMBER').height).toBeGreaterThan(0));
			expect(rowBox('SALES.CUSTOMER', 'NAME').height).toBeGreaterThan(0);
			expect(schemaText('SALES')).toBe('SALES');
			lineEnds('part-customer');
			expect(isRendered('edge', SCHEMA_LINK)).toBe(false);
		});
	});
});
