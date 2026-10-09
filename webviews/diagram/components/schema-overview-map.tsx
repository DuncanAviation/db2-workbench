import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Box } from '@mui/material';
import { useReactFlow, useStore } from '@xyflow/react';
import type { DiagramSchemaGroup } from '../../../src/webview-messages/diagram-messages';

export interface SchemaOverviewMapProps {
	schemas: DiagramSchemaGroup[];
	tableCountsBySchemaId: Map<string, number>;
}

const PANEL_WIDTH = 200;
const PANEL_HEIGHT = 150;
const PADDING = 4;
// Below this many pixels of pointer movement, a press+release is treated as a click (jump to the
// schema/point under the pointer) rather than a drag (continuous pan).
const DRAG_THRESHOLD = 3;

interface DragState {
	startX: number;
	startY: number;
	hasDragged: boolean;
	// The schema the press started on, if any - used for the click (non-drag) outcome only; a drag pans
	// continuously regardless of what it started on.
	targetSchema: DiagramSchemaGroup | null;
}

// Deliberately not React Flow's built-in <MiniMap> - validated against a 5,000-table stress test during
// this feature's research, the built-in one mirrors whatever's hidden/visible in the main canvas, which
// at scale means trying to draw thousands of individual table rects into a ~200x150px SVG - each ends up
// sub-pixel and the whole thing reads as blank. Schema bounds don't have that problem (they stay
// proportionally large no matter how many tables are inside them), so this always shows the schema-level
// overview, independent of the main canvas's own zoom-tier LOD.
//
// Also reimplements the built-in MiniMap's click-and-drag panning by hand (pointer capture on the svg,
// not d3-drag) - a plain click jumps/zooms to a schema (or recenters on empty space), a drag pans the
// main viewport continuously without changing zoom.
export function SchemaOverviewMap({schemas, tableCountsBySchemaId}: SchemaOverviewMapProps) {
	let viewportWidth = useStore(state => state.width);
	let viewportHeight = useStore(state => state.height);
	let transform = useStore(state => state.transform);
	let reactFlowInstance = useReactFlow();
	let dragRef = useRef<DragState | null>(null);

	if(schemas.length === 0) {
		return null;
	}

	let minX = Math.min(...schemas.map(schema => schema.bounds.x));
	let minY = Math.min(...schemas.map(schema => schema.bounds.y));
	let maxX = Math.max(...schemas.map(schema => schema.bounds.x + schema.bounds.width));
	let maxY = Math.max(...schemas.map(schema => schema.bounds.y + schema.bounds.height));
	let boundsWidth = Math.max(1, maxX - minX);
	let boundsHeight = Math.max(1, maxY - minY);

	let scale = Math.min((PANEL_WIDTH - PADDING * 2) / boundsWidth, (PANEL_HEIGHT - PADDING * 2) / boundsHeight);
	let offsetX = PADDING + (PANEL_WIDTH - PADDING * 2 - boundsWidth * scale) / 2;
	let offsetY = PADDING + (PANEL_HEIGHT - PADDING * 2 - boundsHeight * scale) / 2;

	function toPanel(x: number, y: number) {
		return {x: offsetX + (x - minX) * scale, y: offsetY + (y - minY) * scale};
	}

	function toGraph(panelX: number, panelY: number) {
		return {x: minX + (panelX - offsetX) / scale, y: minY + (panelY - offsetY) / scale};
	}

	let [, , zoom] = transform;
	let viewportGraphX = -transform[0] / zoom;
	let viewportGraphY = -transform[1] / zoom;
	let viewportTopLeft = toPanel(viewportGraphX, viewportGraphY);
	let viewportBottomRight = toPanel(viewportGraphX + viewportWidth / zoom, viewportGraphY + viewportHeight / zoom);

	function jumpToSchema(schema: DiagramSchemaGroup) {
		void reactFlowInstance.fitBounds(
			{x: schema.bounds.x, y: schema.bounds.y, width: schema.bounds.width, height: schema.bounds.height},
			{padding: 0.2, duration: 300}
		);
	}

	function panTo(panelX: number, panelY: number, duration: number) {
		let graph = toGraph(panelX, panelY);
		void reactFlowInstance.setCenter(graph.x, graph.y, {zoom: zoom, duration: duration});
	}

	function getLocalPoint(event: ReactPointerEvent<SVGSVGElement>) {
		let bounds = event.currentTarget.getBoundingClientRect();
		return {x: event.clientX - bounds.left, y: event.clientY - bounds.top};
	}

	function schemaAt(target: EventTarget): DiagramSchemaGroup | null {
		let schemaId = target instanceof SVGElement ? target.dataset.schemaId : undefined;
		return schemaId ? schemas.find(schema => schema.id === schemaId) ?? null : null;
	}

	function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
		event.currentTarget.setPointerCapture(event.pointerId);
		let point = getLocalPoint(event);
		dragRef.current = {startX: point.x, startY: point.y, hasDragged: false, targetSchema: schemaAt(event.target)};
	}

	function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
		let drag = dragRef.current;

		if(!drag) {
			return;
		}

		let point = getLocalPoint(event);

		if(!drag.hasDragged && Math.hypot(point.x - drag.startX, point.y - drag.startY) > DRAG_THRESHOLD) {
			drag.hasDragged = true;
		}

		if(drag.hasDragged) {
			panTo(point.x, point.y, 0);
		}
	}

	function handlePointerUp(_event: ReactPointerEvent<SVGSVGElement>) {
		let drag = dragRef.current;
		dragRef.current = null;

		if(!drag || drag.hasDragged) {
			return;
		}

		if(drag.targetSchema) {
			jumpToSchema(drag.targetSchema);
		} else {
			panTo(drag.startX, drag.startY, 200);
		}
	}

	return (
		<Box sx={{width: PANEL_WIDTH, height: PANEL_HEIGHT, backgroundColor: 'background.paper', border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden'}}>
			<svg
				width={PANEL_WIDTH}
				height={PANEL_HEIGHT}
				style={{cursor: 'pointer', touchAction: 'none'}}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
			>
				{schemas.map(schema => {
					let topLeft = toPanel(schema.bounds.x, schema.bounds.y);

					return (
						<rect
							key={schema.id}
							data-schema-id={schema.id}
							x={topLeft.x}
							y={topLeft.y}
							width={schema.bounds.width * scale}
							height={schema.bounds.height * scale}
							fill={`${schema.color}55`}
							stroke={schema.color}
							strokeWidth={1}
						>
							<title>{schema.name} - {tableCountsBySchemaId.get(schema.id) ?? 0} tables</title>
						</rect>
					);
				})}
				<rect
					x={viewportTopLeft.x}
					y={viewportTopLeft.y}
					width={Math.max(1, viewportBottomRight.x - viewportTopLeft.x)}
					height={Math.max(1, viewportBottomRight.y - viewportTopLeft.y)}
					fill="none"
					stroke="var(--vscode-focusBorder, #007fd4)"
					strokeWidth={1.5}
					pointerEvents="none"
				/>
			</svg>
		</Box>
	);
}
