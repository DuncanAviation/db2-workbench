// Mirrors the private geometry constants in src/diagram/diagram-xml.ts (TABLE_WIDTH/HEADER_HEIGHT/
// ROW_HEIGHT) - kept as a small duplicate here rather than a cross-bundle runtime import from src/, since
// webviews only ever import *types* from src/ (see any existing */vscode-api.ts), never runtime values.
// If either copy of these numbers changes, check the other - a mismatch wouldn't break correctness (both
// sides read column count off the model independently), just visual consistency between what's stored
// and what's rendered.
export const TABLE_WIDTH = 390;
export const HEADER_HEIGHT = 36;
export const ROW_HEIGHT = 24;
// Header padding (table-node.tsx's header Box: py: 0.75) is 0.75 * MUI's 8px spacing unit = 6px top + 6px
// bottom = 12px total. The title text's own line-height is pinned to fill exactly the rest of
// HEADER_HEIGHT, the same reasoning as DESCRIPTION_HEIGHT below - left to the font's own metrics instead,
// the title line renders a couple pixels shorter or taller than this, which is invisible at rest but
// exactly the kind of small, constant gap that becomes noticeable the moment a relationship line is
// tracking a table in motion (the same class of bug DESCRIPTION_HEIGHT itself fixed, just smaller).
export const HEADER_PADDING_Y = 6;
export const TITLE_LINE_HEIGHT = HEADER_HEIGHT - HEADER_PADDING_Y * 2;
// The extra line a table's header grows by when it has a description (see table-node.tsx's header
// Box) - HEADER_HEIGHT alone only accounts for the title line. The description Box's own sx pins its
// line-height to this exact value, so this constant and what actually renders can't drift apart; every
// row-position calculation below needs to add it in whenever a table has a description, or every row
// renders this many pixels lower on screen than the geometry here assumes (harmless at rest since
// nothing else depends on it, but exactly the gap a relationship line's declared anchor would fall
// short by).
export const DESCRIPTION_HEIGHT = 16;

export function headerHeight(hasDescription: boolean): number {
	return HEADER_HEIGHT + (hasDescription ? DESCRIPTION_HEIGHT : 0);
}

export function tableHeight(columnCount: number, hasDescription: boolean): number {
	return headerHeight(hasDescription) + columnCount * ROW_HEIGHT;
}
