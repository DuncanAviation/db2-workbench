// Picks which side (left/right) of each column a relationship's edge should anchor to, based on where
// the two tables currently sit - not a fixed "always exits right, always enters left" convention, which
// loops a line all the way around a table once it ends up positioned on the "wrong" side of the one it's
// connected to. Every column declares all four possible anchors (see tableNodeHandles in table-node.tsx);
// this just chooses which pair to actually use for one specific edge, recomputed on every render so a
// live drag immediately flips the line to the short path as soon as it crosses the other table.

export interface EdgeHandles {
	sourceHandle: string;
	targetHandle: string;
}

// Handle id fragment used in place of a column name when tables are collapsed (see tableMiddleHandles in
// table-node.tsx) - a real column row isn't rendered at that zoom tier, so there's nothing meaningful to
// point at, and every relationship line instead anchors to the vertical middle of the table box itself.
// Not a valid column name (DB2 for i identifiers can't contain this character), so it can never collide
// with a real one.
export const TABLE_MIDDLE_HANDLE_ID = '$middle';

export function chooseEdgeHandles(fromColumn: string, toColumn: string, fromTableX: number, toTableX: number, expanded: boolean): EdgeHandles {
	// Ties (same x) default to the traditional "source exits right, target enters left" convention -
	// an arbitrary but stable choice, rather than one that could flicker between renders.
	let fromIsLeftOfTo = fromTableX <= toTableX;
	// Only meaningful once columns are actually rendered (the 'expanded' zoom tier) - at every other
	// tier, per-column handle positions would still be declared as if the table were fully expanded
	// (see tableNodeHandles), landing well outside the collapsed table's actual visible bounds.
	let fromId = expanded ? fromColumn : TABLE_MIDDLE_HANDLE_ID;
	let toId = expanded ? toColumn : TABLE_MIDDLE_HANDLE_ID;

	return {
		sourceHandle: `${fromId}-source-${fromIsLeftOfTo ? 'right' : 'left'}`,
		targetHandle: `${toId}-target-${fromIsLeftOfTo ? 'left' : 'right'}`
	};
}
