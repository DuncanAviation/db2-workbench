import type { DiagramCardinality } from '../../../src/diagram/diagram-cardinality';

// Crow's-foot cardinality notation for relationship lines, as SVG <marker> defs referenced by id from
// each edge's markerStart/markerEnd (see app.tsx's displayEdges). React Flow only builds markers itself
// for its own two built-in MarkerType values (arrow/arrowclosed); a plain string marker is passed
// straight through as `url('#<that string>')`, which is exactly the hook needed to supply real ER
// notation without also having to hand-write a custom edge component just to get at the <path> element.
//
// The same ERone/ERmany language the .drawio file format already uses (see RELATIONSHIP_STYLE in
// diagram-xml.ts), so the on-screen rendering and an exported diagram read identically.

// One marker per (cardinality, which end of the line) pair - the two ends can't share a marker even
// though the symbols are the same shape. orient="auto" points a marker's local +x axis along the line's
// direction of travel, which at the source end points AWAY from the table and at the target end points
// INTO it, so each symbol has to be drawn mirrored for the end it's used at to keep the crow's foot
// opening toward its own table (and the "one" bar standing off the table rather than buried in its border).
export function cardinalityMarkerId(cardinality: DiagramCardinality, end: 'start' | 'end'): string {
	return `db2-er-${cardinality}-${end}`;
}

// How far back along the line each symbol reaches. The crow's foot's tines land exactly on the line's
// endpoint (i.e. the table's own edge) with its apex FOOT_LENGTH back up the line; the "one" bar instead
// stands BAR_OFFSET off the table, since a bar drawn right at the endpoint sits on top of the table's
// border and reads as part of it.
const FOOT_LENGTH = 11;
const BAR_OFFSET = 8;
const HALF_HEIGHT = 5;
const STROKE_WIDTH = 1.5;

// markerUnits="userSpaceOnUse" keeps the symbol a fixed size in flow units instead of scaling with the
// line's own strokeWidth - a highlighted relationship thickens to 2px (see displayEdges) and shouldn't
// also grow a 2x crow's foot. overflow="visible" since every path below is drawn in negative coordinates
// relative to refX/refY rather than inside a markerWidth x markerHeight viewport.
const MARKER_PROPS = {
	markerUnits: 'userSpaceOnUse' as const,
	markerWidth: FOOT_LENGTH,
	markerHeight: HALF_HEIGHT * 2,
	refX: 0,
	refY: 0,
	orient: 'auto' as const,
	overflow: 'visible' as const
};

// context-stroke resolves to the referencing line's own computed stroke, so a marker follows its edge's
// color for free - including the highlight color a selected relationship switches to, and including the
// stroke React Flow's own stylesheet supplies when the edge sets none itself.
const PATH_PROPS = {
	fill: 'none',
	stroke: 'context-stroke',
	strokeWidth: STROKE_WIDTH,
	strokeLinecap: 'round' as const
};

// Rendered once inside the flow (not per edge) - marker ids resolve document-wide, so a single hidden
// <defs> serves every relationship line on the canvas.
export function RelationshipMarkers() {
	return (
		<svg style={{position: 'absolute', width: 0, height: 0, overflow: 'hidden'}} aria-hidden="true">
			<defs>
				{/* Source end: the table is behind the marker (-x), so the tines sit at x=0 and the apex
				runs forward to +FOOT_LENGTH. */}
				<marker id={cardinalityMarkerId('many', 'start')} {...MARKER_PROPS}>
					<path {...PATH_PROPS} d={`M ${FOOT_LENGTH},0 L 0,${-HALF_HEIGHT} M ${FOOT_LENGTH},0 L 0,0 M ${FOOT_LENGTH},0 L 0,${HALF_HEIGHT}`} />
				</marker>

				{/* Target end: mirrored - the table is ahead of the marker (+x), so the apex is back at
				-FOOT_LENGTH and the tines still land on the endpoint. */}
				<marker id={cardinalityMarkerId('many', 'end')} {...MARKER_PROPS}>
					<path {...PATH_PROPS} d={`M ${-FOOT_LENGTH},0 L 0,${-HALF_HEIGHT} M ${-FOOT_LENGTH},0 L 0,0 M ${-FOOT_LENGTH},0 L 0,${HALF_HEIGHT}`} />
				</marker>

				<marker id={cardinalityMarkerId('one', 'start')} {...MARKER_PROPS}>
					<path {...PATH_PROPS} d={`M ${BAR_OFFSET},${-HALF_HEIGHT} L ${BAR_OFFSET},${HALF_HEIGHT}`} />
				</marker>

				<marker id={cardinalityMarkerId('one', 'end')} {...MARKER_PROPS}>
					<path {...PATH_PROPS} d={`M ${-BAR_OFFSET},${-HALF_HEIGHT} L ${-BAR_OFFSET},${HALF_HEIGHT}`} />
				</marker>
			</defs>
		</svg>
	);
}
