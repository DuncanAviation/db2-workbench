import { memo } from 'react';
import { Box, Tooltip } from '@mui/material';
import { Handle, NodeResizer, Position, useStore } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { shouldShowSchemaTableCount } from '../../../src/diagram/diagram-zoom-tiers';

export interface SchemaGroupNodeData {
	name: string;
	color: string;
	tableCount: number;
	// True at the most-zoomed-out tier, once tables are hidden and this schema shows as a summary box
	// instead of a light border wrapping its (visible) tables.
	summary: boolean;
	// True once the filter field has text and NONE of this schema's tables match it - same "dim, don't
	// hide" treatment as a non-matching table itself (see table-node.tsx), so an entirely-filtered-out
	// schema doesn't sit at full visual weight next to schemas that actually have matches inside them.
	dimmed: boolean;
	onResizeEnd: (schemaId: string, bounds: {x: number; y: number; width: number; height: number}) => void;
	[key: string]: unknown;
}

const BASE_LABEL_FONT_SIZE = 12;
// Leaves a little breathing room inside the box rather than letting the label touch its edges exactly.
const LABEL_PADDING_PX = 12;
// Small enough to still be a usable target, not so small the box could collapse to nothing.
const MIN_SCHEMA_WIDTH = 120;
const MIN_SCHEMA_HEIGHT = 80;

// React Flow's per-node `dragHandle` prop (set on the node object in app.tsx's buildNodes) takes a CSS
// selector, not an element reference - this class is the contract between the two files. Only an element
// matching it can start a whole-box drag; everywhere else inside the node either resizes (the
// NodeResizer's own handles) or falls through to the pane underneath (see the fill boxes' pointer-events
// below), so a click-drag inside a large schema box pans the canvas instead of dragging the box.
export const SCHEMA_DRAG_HANDLE_CLASS = 'db2-schema-drag-handle';

// Invisible, like table-node.tsx's column handles - edges connect to these, a user never drags from one
// directly.
const HANDLE_STYLE = {opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1, pointerEvents: 'none' as const};

// Used for the cluster-tier "is there any relationship between these two schemas" line
// (see app.tsx/diagram-schema-links.ts) - a single source/target pair at the box's geometric center,
// since unlike a table's per-column handles there's no specific side that makes more sense than another
// here. Position.Top's formula ({x: x + width/2, y}) leaves y untouched and centers x by half the
// declared width, so declaring x: 0 / width: <the box's current width> and y: <half its current height>
// lands exactly on true center regardless of how the schema box has been resized.
export const SCHEMA_CENTER_SOURCE_ID = 'schema-center-source';
export const SCHEMA_CENTER_TARGET_ID = 'schema-center-target';

// Shared by both this node's tooltips (summary tier when the count isn't already shown on the box
// itself, and the normal tier's tab, whose tooltip previously showed only the name) - one place for the
// wording so the two can't drift apart.
function schemaTooltipText(name: string, tableCount: number): string {
	return `${name} - ${tableCount} table${tableCount === 1 ? '' : 's'}`;
}

export function schemaCenterHandles(width: number, height: number) {
	return [
		{id: SCHEMA_CENTER_SOURCE_ID, type: 'source' as const, position: Position.Top, x: 0, y: height / 2, width, height: 1},
		{id: SCHEMA_CENTER_TARGET_ID, type: 'target' as const, position: Position.Top, x: 0, y: height / 2, width, height: 1}
	];
}

// A real React Flow parent node (table nodes reference it via parentId) - dragging this drags every
// table inside it as a unit for free, via React Flow's own parent/child node handling.
//
// Reads live zoom via useStore (not a coarse tier threaded down from the parent, unlike table nodes) -
// there's only ever a handful of schema groups on screen, so per-node re-render on every zoom tick is
// cheap here, and it's what lets the label counter-scale smoothly instead of snapping between discrete
// sizes. The label's own font size is divided by zoom so it reads the same on screen no matter how small
// the box has become - "readable at all zoom levels" isn't true otherwise.
//
// That constant screen size is exactly what can make the label wider than the box once zoomed out far
// enough, though - the box keeps shrinking with zoom, the text doesn't. Rather than a floating external
// callout (real added complexity: screen-space positioning, a layer above the canvas, collision
// avoidance between nearby schemas' callouts), this just truncates with an ellipsis and relies on the
// tooltip for the full name - schema names are short by DB2 convention anyway (10 characters, platform-
// enforced), so this rarely even engages in practice.
function SchemaGroupNodeComponent({id, data, width}: NodeProps & {data: SchemaGroupNodeData}) {
	let zoom = useStore(state => state.transform[2]);
	let scale = 1 / zoom;
	// The box's actual on-screen width - the label lives inside a scale(1/zoom) wrapper, which makes its
	// own local units correspond 1:1 with screen pixels, so this is the right budget to truncate against.
	let labelMaxWidth = Math.max(0, (width ?? 0) * zoom - LABEL_PADDING_PX);

	let truncatedTextSx = {overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: labelMaxWidth} as const;

	// onResizeEnd's params are already the model's absolute {x, y, width, height} shape - a top/left
	// handle drag moves the origin as well as the size, and that's passed straight through here rather
	// than only reporting width/height, since DiagramSchemaGroup.bounds needs the full rectangle.
	let resizer = (
		<NodeResizer
			nodeId={id}
			color={data.color}
			minWidth={MIN_SCHEMA_WIDTH}
			minHeight={MIN_SCHEMA_HEIGHT}
			onResizeEnd={(_event, params) => data.onResizeEnd(id, params)}
		/>
	);

	// Always rendered (not just at the summary tier) - a real DOM <Handle> element has to exist for React
	// Flow to resolve a connection to it at all, even though the position that actually matters comes
	// from schemaCenterHandles' declarative geometry, not this element's own CSS position - see
	// table-node.tsx's $middle handle for the same reasoning (and the bug hitting this exact gap fixed
	// there earlier).
	let centerHandles = (
		<>
			<Handle id={SCHEMA_CENTER_SOURCE_ID} type="source" position={Position.Top} style={HANDLE_STYLE} />
			<Handle id={SCHEMA_CENTER_TARGET_ID} type="target" position={Position.Top} style={HANDLE_STYLE} />
		</>
	);

	if(data.summary) {
		let showCount = shouldShowSchemaTableCount(zoom);

		return (
			<>
				{resizer}
				{centerHandles}
				{/* pointer-events: none - at this zoomed-out tier the whole box is otherwise a big
				click-drag target that would fight with panning the canvas. The label below opts back in
				with pointer-events: auto (and is the dragHandle app.tsx wires up for this node), so
				dragging the box is still possible, just only from the label itself. */}
				<Box sx={{
					width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
					borderRadius: 2, border: '2px solid', borderColor: data.color, backgroundColor: `${data.color}22`,
					boxSizing: 'border-box', overflow: 'hidden', pointerEvents: 'none',
					opacity: data.dimmed ? 0.35 : 1, transition: 'opacity 120ms ease'
				}}>
					<Tooltip title={showCount ? data.name : schemaTooltipText(data.name, data.tableCount)}>
						<Box className={SCHEMA_DRAG_HANDLE_CLASS} sx={{transform: `scale(${scale})`, textAlign: 'center', color: data.color, cursor: 'grab', pointerEvents: 'auto'}}>
							<Box sx={{fontSize: BASE_LABEL_FONT_SIZE * 1.4, fontWeight: 700, ...truncatedTextSx}}>{data.name}</Box>
							{showCount && (
								<Box sx={{fontSize: BASE_LABEL_FONT_SIZE, color: 'text.secondary', ...truncatedTextSx}}>{data.tableCount} table{data.tableCount === 1 ? '' : 's'}</Box>
							)}
						</Box>
					</Tooltip>
				</Box>
			</>
		);
	}

	return (
		<>
			{resizer}
			{centerHandles}
			{/* pointer-events: none - a click-drag anywhere in the box's interior (not on a table, not on
			the title below) now falls through to the pane underneath and pans the canvas instead of
			moving the box. Without this, a large schema full of tables would leave no empty area to pan
			from without accidentally dragging the whole group. */}
			<Box sx={{
				width: '100%', height: '100%', borderRadius: 2, border: '2px solid', borderColor: data.color,
				backgroundColor: 'transparent', boxSizing: 'border-box', pointerEvents: 'none',
				opacity: data.dimmed ? 0.35 : 1, transition: 'opacity 120ms ease'
			}}>
				<Tooltip title={schemaTooltipText(data.name, data.tableCount)}>
					{/* Deliberately padded well beyond the text itself - reported hard to hit otherwise, since
					the border/gap space around densely-packed tables can be only a few pixels wide. This tab
					is never covered by a table (it sits above the box's own top edge), so it's a reliable,
					generously-sized target regardless of how tables happen to be arranged inside. It's also
					the ONLY thing that drags the box now (see SCHEMA_DRAG_HANDLE_CLASS/pointer-events above) -
					pointer-events: auto opts it back in to receiving the mouse events its parent gave up. */}
					<Box className={SCHEMA_DRAG_HANDLE_CLASS} sx={{
						// bottom: '100%' (not a fixed top: -Npx) so the tab's own bottom edge sits exactly flush
						// against the box's top border regardless of the tab's actual rendered height (font
						// size/padding changes here can't silently reopen the overlap this was fixed for).
						position: 'absolute', bottom: '100%', left: 8, transform: `scale(${scale})`, transformOrigin: 'bottom left',
						px: 1.25, py: 0.5, borderRadius: 1, border: '1px solid', borderColor: data.color,
						backgroundColor: 'background.default', fontSize: '0.8rem', fontWeight: 700, color: data.color,
						cursor: 'grab', pointerEvents: 'auto', ...truncatedTextSx
					}}>
						{data.name}
					</Box>
				</Tooltip>
			</Box>
		</>
	);
}

export const SchemaGroupNode = memo(SchemaGroupNodeComponent);
