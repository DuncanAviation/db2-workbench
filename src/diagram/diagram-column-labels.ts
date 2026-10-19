import { ColumnDetailsUtils } from '../utils/column-details.js';
import type { ColumnDetailLine } from '../utils/column-details.js';
import { ColumnNameUtils } from '../utils/column-name-utils.js';
import { DiagramColumn } from '../webview-messages/diagram-messages.js';

// The one place a diagram decides what to CALL a column, and the one place it decides whether a name it
// was handed refers to a given column. Pure - nothing in its dependency graph imports vscode, which is
// what keeps it unit-testable and is why the label values live in models/result-heading-label.ts rather
// than in Configurations - so the host (diagram-xml.ts, writing the draw.io-visible label) and the
// webview's table-node rows go through exactly the same rules.
//
// Two separate ideas, deliberately not conflated:
//
// IDENTITY (`column.name`) is internal and permanent: it ends the mxGraph cell id, every relationship
// anchors to it, and React Flow handle ids are built from it. It must never depend on a user setting -
// flipping resultHeadingLabels would otherwise silently re-point every edge in the file.
//
// DISPLAY is what the user reads, and follows the same `db2-workbench.resultHeadingLabels` setting the
// results grid and the schema browser use, so a column reads the same way in all three. Only the FIRST
// configured option is shown: a diagram row is one narrow cell (see ColumnDetailsUtils.formatType's comment on the
// same constraint), so joining two or three names the way the results grid's stacked header can would
// simply not fit.

// Both halves delegate to ColumnNameUtils (src/utils/column-name-utils.ts), which owns the display and
// matching rules for every surface, the diagram included - these are the DiagramColumn-shaped entry
// points into it.

/**
 * True when `name` refers to this column in any of its NAME forms (identity, short, long - never the
 * description; see ColumnNameUtils). Case-insensitive.
 */
export function matchesColumnName(column: DiagramColumn, name: string): boolean {
	return ColumnNameUtils.matches(ColumnNameUtils.fromDiagramColumn(column), name);
}

/**
 * The IDENTITY of the column `name` refers to, or undefined when no column does. This is what makes an
 * imported foreign key work: an import names its columns in DB2's short form (that's what
 * dbml-format.ts writes out), so the name it carries usually isn't the identity a connected table's
 * columns are keyed by - it's the short-name alias of one.
 */
export function findColumnIdentity(columns: readonly DiagramColumn[], name: string): string | undefined {
	return columns.find(column => matchesColumnName(column, name))?.name;
}

/**
 * What to render for this column: the first configured label option that the column actually has a
 * value for, falling back to its identity. The fallback matters for a column with no aliases at all -
 * every diagram saved before aliases were stored, and any import that supplied only one name form.
 */
export function columnDisplayName(column: DiagramColumn, resultHeadingLabels: readonly string[]): string {
	return ColumnNameUtils.displayName(ColumnNameUtils.fromDiagramColumn(column), resultHeadingLabels);
}

/** A tooltip line - the shared shape, so the diagram and the data grids render the same thing. */
export type ColumnTooltipLine = ColumnDetailLine;

/** One relationship this column is the foreign-key (fromColumn) end of - just enough for a tooltip to
 * name what it points at, not the full DiagramRelationship shape (which also carries an id and the
 * fromTable/fromColumn a tooltip already knows from context). */
export interface ForeignKeyTarget {
	toTable: string;
	toColumn: string;
}

/** One physical index this column is a key column of - see DiagramTable.indexes. */
export interface ColumnIndexMembership {
	name: string;
	unique: boolean;
}

/**
 * Every line of a column's hover tooltip: what ColumnDetailsUtils.lines() shows for a column anywhere -
 * short name, long name, and description (skipping whichever of the three this column doesn't have), its
 * type, then an Identity line, a Primary Key line and a Not Null line - followed by the diagram-only lines:
 * a Unique line, an Index line per index it belongs to, and a Foreign Key line per relationship it's the
 * source end of, each shown independently of the others (a column can be more than
 * one at once, e.g. a primary key that's also an identity column - the row's own icon only ever shows one,
 * identity taking priority (see table-node.tsx's ColumnIcon), but the tooltip has room to be complete, in
 * that same priority order). Unlike columnDisplayName this doesn't stop at the first match: a tooltip has
 * room to show all of them at once, so there's no "first configured option wins" tradeoff to make here.
 * The identity (column.name) itself is deliberately left out - it's an internal field a user has no reason
 * to care about (see this file's own IDENTITY/DISPLAY comment above); "Identity" here means the
 * identity-column property (auto-generated values), an unrelated DB2 concept that just happens to share
 * the word.
 */
export function columnTooltipLines(
	column: DiagramColumn,
	foreignKeyTargets: readonly ForeignKeyTarget[] = [],
	// Other columns sharing this column's UNIQUE constraint, already resolved to display form and already
	// excluding this column itself - the caller (table-node.tsx) builds this from DiagramTable.uniqueKeys,
	// since it already resolves every other column's display name for its own row and is the natural place
	// to do that lookup once per table rather than once per tooltip line here. Empty/undefined for a
	// single-column unique constraint.
	uniquePartners: readonly string[] = [],
	indexes: readonly ColumnIndexMembership[] = []
): ColumnTooltipLine[] {
	let lines = ColumnDetailsUtils.lines(column);

	if(column.unique) {
		lines.push({label: 'Unique', value: uniquePartners.length > 0 ? `With ${uniquePartners.join(', ')}` : 'Yes'});
	}

	for(let index of indexes) {
		lines.push({label: 'Index', value: index.unique ? `${index.name} (Unique)` : index.name});
	}

	for(let target of foreignKeyTargets) {
		lines.push({label: 'Foreign Key', value: `${target.toTable}.${target.toColumn}`});
	}

	return lines;
}
