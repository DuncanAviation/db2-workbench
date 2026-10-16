import { memo } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { Box, Tooltip } from '@mui/material';
import { keyframes } from '@emotion/react';
import AddLinkIcon from '@mui/icons-material/AddLink';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import LinkIcon from '@mui/icons-material/Link';
import BoltIcon from '@mui/icons-material/Bolt';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import type { DiagramColumn, DiagramTable, MissingRelationshipTarget } from '../../../src/webview-messages/diagram-messages';
import { TABLE_MIDDLE_HANDLE_ID } from '../../../src/diagram/diagram-edge-routing';
import { columnDisplayName, columnTooltipLines } from '../../../src/diagram/diagram-column-labels';
import type { ColumnIndexMembership, ForeignKeyTarget } from '../../../src/diagram/diagram-column-labels';
import { ImportBadge } from '../../shared/components/import-badge';
import { TooltipLines } from '../../shared/components/tooltip-lines';
import type { ImportBadgeKind } from '../../shared/components/import-badge';
import { COLUMN_ICON_COLOR, HIGHLIGHT_COLOR, IMPORT_COLOR } from '../diagram-colors';
import { DESCRIPTION_HEIGHT, headerHeight, HEADER_PADDING_Y, ROW_HEIGHT, tableHeight, TABLE_WIDTH, TITLE_LINE_HEIGHT } from '../layout-constants';

export interface TableNodeData {
	table: DiagramTable;
	color: string;
	// Which of DB2's name forms each column row is labelled with - the user's
	// db2-workbench.resultHeadingLabels setting, straight through from the host. Only the label moves
	// with it: a column's identity (what edges anchor to, what handle ids are built from) never does.
	// See src/diagram/diagram-column-labels.ts.
	columnLabels: readonly string[];
	// False at the collapsed zoom tier - column rows (and their <Handle> elements) simply aren't
	// rendered then. Relationships still route correctly regardless, since edges connect via the
	// declarative handles from tableNodeHandles() below, not DOM measurement of these elements - the
	// same fix validated during this feature's prototype research for exactly this collapsed-state case.
	expanded: boolean;
	// True while a column is selected elsewhere in the diagram and this table has no relationship to
	// it - dims the whole table rather than picking out individual unrelated columns within it.
	dimmed: boolean;
	// Names of this table's own columns that are the current selection or directly related to it via a
	// relationship - drawn with a highlight; every other column renders normally regardless of `dimmed`.
	highlightedColumns: ReadonlySet<string>;
	// Set only when the filter field matched this table through one or more of its columns but not the
	// table itself (name/schema/description) - see app.tsx's dimmedColumnNamesByTableId. Names the columns
	// that should dim individually while the table as a whole (including the header) stays at full weight,
	// the mirror image of the whole-table `dimmed` case above. Empty whenever that split doesn't apply.
	dimmedColumnNames: ReadonlySet<string>;
	onColumnClick: (tableId: string, columnName: string) => void;
	// This table's foreign keys whose referenced table isn't on the diagram, keyed by column name -
	// each draws an "add the other end" button on its row. Pre-narrowed to this table by app.tsx so a
	// node doesn't have to filter the whole diagram's list on every render. Empty while disconnected.
	missingTargetsByColumn: ReadonlyMap<string, MissingRelationshipTarget>;
	onAddMissingTarget: (target: MissingRelationshipTarget) => void;
	// This table's own outgoing relationships (it's the foreign-key/fromTable end), keyed by fromColumn -
	// what a column's tooltip needs to say which table/column it's a foreign key to. A column can be the
	// source of more than one (a composite key shared across relationships), hence an array per column
	// rather than one target.
	foreignKeyTargetsByColumn: ReadonlyMap<string, ForeignKeyTarget[]>;
	// Count of relationships this table is the fromTable end of - shown in the table's own tooltip
	// alongside its column count. Deliberately outgoing only, matching what `foreignKey` on a column
	// already means (see DiagramColumn) - an incoming relationship is that OTHER table's outgoing one.
	outgoingRelationshipCount: number;
	[key: string]: unknown;
}

// React Flow's per-node `dragHandle` prop (set on the node object in app.tsx's buildNodes) takes a CSS
// selector, not an element reference - this class is the contract between the two files, same as
// SCHEMA_DRAG_HANDLE_CLASS in schema-group-node.tsx. Only the header can start a table drag: a column row
// is a click target (select the column, highlight its relationships), and without this a drag that
// wandered a few pixels while clicking a row moved the table AND swallowed the click, so the click read
// as simply not working. The header is also the only part of the table that shows a grab cursor - that
// comes from React Flow's own `.react-flow__node.draggable` rule on the wrapper (deliberately not
// re-declared here, so the wrapper's `.dragging` rule can still switch it to `grabbing` mid-drag), left
// visible only on the header because every column row overrides it with `cursor: pointer`. This just makes
// the drag behavior match the affordance the cursor was already advertising.
export const TABLE_DRAG_HANDLE_CLASS = 'db2-table-drag-handle';

// Handles are invisible (edges connect to them, but a user never drags from one directly - editing
// connections isn't a goal yet). Every column gets all four possible anchors (source/target x left/
// right), not just one fixed pair - which side an edge actually uses is chosen dynamically per render in
// app.tsx based on where the other table currently sits, so a relationship always takes the short path
// instead of a fixed "always exits right" convention that loops around once tables get rearranged.
//
// Where a line meets its table normally comes from the declared geometry in tableNodeHandles, not from
// these elements. But React Flow's ResizeObserver re-measures every handle from the DOM whenever it
// fires for a node (it always passes force: true), and that DOM geometry stands until the next render
// re-parses node.handles - after a zoom that doesn't change tier, it just stays. So these elements are
// placed exactly where the declared ones are: 1x1 with no border (React Flow's own stylesheet gives a
// handle a 1px border, which made it 2x2), and flush with the table's edge rather than centred on it
// (React Flow's translate(-50%, -50%)), so a re-measure changes nothing. A 2x2 handle straddling the edge
// put the line a unit outside the table, and half a unit low.
const HANDLE_STYLE = {opacity: 0, width: 1, height: 1, minWidth: 1, minHeight: 1, border: 0, transform: 'translate(0, -50%)', pointerEvents: 'none' as const};

// "Marching ants" for a highlighted column row - an SVG overlay rather than a CSS `outline`, since
// animating a moving dash pattern isn't something a plain CSS outline/border can do on its own.
const marchingAnts = keyframes`
	to {
		stroke-dashoffset: -16;
	}
`;

// Box (not Stack/Typography) throughout - see the diagram feature's design notes on why MUI's
// Stack/Typography typings currently conflict with @xyflow/react's when both are imported into the same
// file (an MUI v9 / React 19 types issue, not anything specific to this feature).
function TableNodeComponent({data, selected}: NodeProps & {data: TableNodeData}) {
	let {
		table, color, expanded, dimmed, columnLabels, highlightedColumns, dimmedColumnNames, onColumnClick,
		missingTargetsByColumn, onAddMissingTarget, foreignKeyTargetsByColumn, outgoingRelationshipCount
	} = data;

	let tableTooltip = (
		<TableTooltipContent table={table} outgoingRelationshipCount={outgoingRelationshipCount} />
	);

	// Every other column sharing THIS column's unique constraint, already resolved to display form (see
	// columnTooltipLines' own comment on why that resolution belongs here rather than there) - built once
	// per render off table.uniqueKeys, which always holds identities, not whatever the user's
	// resultHeadingLabels setting currently shows. Cheap: a table's own keys/columns are always small.
	let columnByIdentity = new Map(table.columns.map(candidate => [candidate.name, candidate]));
	let displayNameForIdentity = (identity: string) => {
		let found = columnByIdentity.get(identity);
		return found ? columnDisplayName(found, columnLabels) : identity;
	};

	let uniquePartnersByColumn = new Map<string, string[]>();

	for(let group of table.uniqueKeys ?? []) {
		for(let identity of group.columns) {
			uniquePartnersByColumn.set(identity, group.columns.filter(other => other !== identity).map(displayNameForIdentity));
		}
	}

	let indexesByColumn = new Map<string, ColumnIndexMembership[]>();

	for(let index of table.indexes ?? []) {
		for(let identity of index.columns) {
			let existing = indexesByColumn.get(identity) ?? [];
			existing.push({name: index.name, unique: index.unique});
			indexesByColumn.set(identity, existing);
		}
	}

	return (
		<Box
			sx={{
				position: 'relative',
				width: TABLE_WIDTH,
				borderRadius: 1,
				// An inset outline rather than a border, because an outline takes no layout space. A 1px border
				// pushed the header, and so every column row, 1px further down than layout-constants.ts puts
				// them - which is where tableNodeHandles anchors each relationship line - and made the box 2px
				// taller than the node React Flow sizes it as. Drawn at the same place a border would be, just
				// over the header's and rows' outer pixel instead of outside them.
				outline: theme => `1px solid ${theme.palette.divider}`,
				outlineOffset: '-1px',
				boxShadow: 1,
				opacity: dimmed ? 0.35 : 1,
				backgroundColor: 'background.paper',
				overflow: 'hidden',
				transition: 'opacity 120ms ease'
			}}
		>
			{selected && (
				// Same marching-ants treatment as a selected column row (see ColumnRow below) - an SVG
				// overlay rather than a CSS outline, since a plain outline can't animate a moving dash
				// pattern. `selected` is React Flow's own multi-select state (ctrl+click, or a drag-box),
				// not this diagram's column-click selection - the two are independent and can be highlighted
				// at the same time. The parent's own overflow:hidden clips this rect's square corners to
				// match the table's rounded border, the same as it clips the stroke's outer half.
				<svg style={{position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1}} width="100%" height="100%">
					<rect
						x="0" y="0" width="100%" height="100%"
						fill="none" stroke={HIGHLIGHT_COLOR} strokeOpacity={1} strokeWidth={4} strokeDasharray="10 2" vectorEffect="non-scaling-stroke"
						style={{animation: `${marchingAnts} 0.5s linear infinite`}}
					/>
				</svg>
			)}

			{expanded ? (
				<>
					<Tooltip title={tableTooltip} placement="top">
						<Box className={TABLE_DRAG_HANDLE_CLASS} sx={{px: 1, py: `${HEADER_PADDING_Y}px`, backgroundColor: color, color: '#fff'}}>
							<Box sx={{display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 0.5}}>
								{/* lineHeight pinned to TITLE_LINE_HEIGHT for the same reason as the description Box below -
								left to the font's own metrics, this renders a couple pixels off from what HEADER_HEIGHT
								assumes, which the row-position math in tableNodeHandles/tableHeight can't see. minWidth: 0
								lets it keep truncating with ellipsis once the badge beside it claims some of the row. */}
								<Box sx={{flexGrow: 1, minWidth: 0, fontSize: '0.875rem', fontWeight: 600, lineHeight: `${TITLE_LINE_HEIGHT}px`, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{table.name}</Box>
								{/* Top-right corner of the header, per the design spec - a real/enhanced table's name is
								the more important thing to keep readable, so this is the one that gives up width first.
								The same ImportBadge the schema browser uses (dark background, golden border/text/icon) -
								its own hover tooltip is skipped here since the header's own Tooltip (tableTooltip, wrapping
								this whole box) already explains Imported/Enhanced via TableTooltipContent below. Wrapped in
								a shrink-to-fit Box so the Chip's own flex sizing doesn't fight flexGrow on the name above it. */}
								{table.importStatus && (
									<Box sx={{flexShrink: 0}}>
										<ImportBadge kind={importBadgeKind(table.importStatus)} />
									</Box>
								)}
							</Box>
							{table.description && (
								// lineHeight pinned to DESCRIPTION_HEIGHT (not left to the font's own metrics) so this
								// box's actual rendered height always matches what the row-position math in
								// tableNodeHandles/tableHeight assumes it added - see DESCRIPTION_HEIGHT's own comment.
								<Box sx={{fontSize: '0.7rem', lineHeight: `${DESCRIPTION_HEIGHT}px`, opacity: 0.85, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{table.description}</Box>
							)}
						</Box>
					</Tooltip>

					<Box>
						{table.columns.map(column => (
							<ColumnRow
								key={column.name}
								column={column}
								columnLabels={columnLabels}
								highlighted={highlightedColumns.has(column.name)}
								dimmed={dimmedColumnNames.has(column.name)}
								onClick={() => onColumnClick(table.id, column.name)}
								missingTarget={missingTargetsByColumn.get(column.name)}
								onAddMissingTarget={onAddMissingTarget}
								foreignKeyTargets={foreignKeyTargetsByColumn.get(column.name)}
								uniquePartners={uniquePartnersByColumn.get(column.name)}
								indexes={indexesByColumn.get(column.name)}
							/>
						))}
					</Box>
				</>
			) : (
				// Collapsed tier (zoomed out below the expanded threshold, but tables still shown - see
				// diagram-zoom-tiers.ts): rather than shrinking to a header-only sliver, the table keeps its
				// full expanded footprint (tableAbsoluteXById and every neighbor's spacing already assume
				// this size regardless of tier) and shows one solid name block instead - the same idea as a
				// schema's own zoomed-out summary box (schema-group-node.tsx), just filled with this table's
				// own header color instead of a translucent tint, so it still reads as "this table" rather
				// than "this schema".
				<Tooltip title={tableTooltip} placement="top">
					<Box
						className={TABLE_DRAG_HANDLE_CLASS}
						sx={{
							width: '100%', height: tableHeight(table.columns.length, !!table.description), boxSizing: 'border-box',
							display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', px: 1.5,
							backgroundColor: color, color: '#fff'
						}}
					>
						{/* width: '100%' (not just the flex default) so a name too long for the box actually has a
						width to be clipped against - a centered flex child sizes to its own content otherwise, and
						the ellipsis never appears no matter how long the text is. Same reason on the description. */}
						<Box sx={{width: '100%', fontSize: '2rem', fontWeight: 600, textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{table.name}</Box>
						{table.description && (
							// Smaller and unbold against the name above it, so the two read as a heading and its
							// subtitle at a zoom level where nothing else about the table is legible. Descriptions run
							// long and there's only ever one line here - the same single-line ellipsis the expanded
							// header's description uses, just scaled up to this tier.
							<Box sx={{width: '100%', fontSize: '1.15rem', fontWeight: 400, opacity: 0.85, textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{table.description}</Box>
						)}
					</Box>
				</Tooltip>
			)}

			{/* Always rendered, regardless of `expanded` - unlike the per-column handles above (which
			only exist in the DOM while their row is actually showing), edges need to fall back to these
			whenever a table is collapsed (see tableMiddleHandles/TABLE_MIDDLE_HANDLE_ID), and React Flow
			can only resolve an edge to a handle id if a real <Handle> element with that id exists
			somewhere in the node - a purely declarative node.handles entry with no matching DOM element
			gets silently rejected ("Couldn't create edge for source/target handle id"). Position doesn't
			matter here (invisible either way); only the declared x/y in tableMiddleHandles governs where
			the edge actually anchors. */}
			<Handle id={`${TABLE_MIDDLE_HANDLE_ID}-target-left`} type="target" position={Position.Left} style={HANDLE_STYLE} />
			<Handle id={`${TABLE_MIDDLE_HANDLE_ID}-source-left`} type="source" position={Position.Left} style={HANDLE_STYLE} />
			<Handle id={`${TABLE_MIDDLE_HANDLE_ID}-target-right`} type="target" position={Position.Right} style={HANDLE_STYLE} />
			<Handle id={`${TABLE_MIDDLE_HANDLE_ID}-source-right`} type="source" position={Position.Right} style={HANDLE_STYLE} />
		</Box>
	);
}

interface ColumnRowProps {
	column: DiagramColumn;
	columnLabels: readonly string[];
	highlighted: boolean;
	// See TableNodeData.dimmedColumnNames - true only for the "matched by column, not by table" case, where
	// this row is one of the non-matching columns being dimmed out while its table stays at full weight.
	dimmed: boolean;
	onClick: () => void;
	missingTarget?: MissingRelationshipTarget;
	onAddMissingTarget: (target: MissingRelationshipTarget) => void;
	foreignKeyTargets?: ForeignKeyTarget[];
	// Other columns sharing this column's unique constraint (see TableNodeComponent's own comment on why
	// this is resolved to display form up there, not here) and the indexes this column is a key column of -
	// both narrowed to just this column by the caller, same convention as foreignKeyTargets above.
	uniquePartners?: string[];
	indexes?: ColumnIndexMembership[];
}

function ColumnRow({
	column, columnLabels, highlighted, dimmed, onClick, missingTarget, onAddMissingTarget, foreignKeyTargets, uniquePartners, indexes
}: ColumnRowProps) {
	function handleClick(event: ReactMouseEvent) {
		// Stops this from also bubbling up to the node's own onNodeClick - clicking a column is a
		// distinct interaction (select/highlight its relationships) from clicking the table itself
		// (propagates the public table-selected event), not a more specific version of the same click.
		event.stopPropagation();
		onClick();
	}

	let indicatorText = columnIndicatorText(column);

	let row = (
		<Box
			onClick={handleClick}
			sx={{
				position: 'relative', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 0.5,
				height: ROW_HEIGHT, px: 1, cursor: 'pointer',
				// The divider above each row is an inset shadow, not a border-top, so the row's padding box -
				// which its handles' top: 50% is measured against - is the whole row. With a 1px border-top the
				// handles sat half a unit below the row's middle (see HANDLE_STYLE).
				boxShadow: theme => `inset 0 1px 0 ${theme.palette.divider}`,
				opacity: dimmed ? 0.35 : 1,
				transition: 'opacity 120ms ease',
				backgroundColor: highlighted ? 'action.selected' : undefined,
				'&:nth-of-type(odd)': {backgroundColor: highlighted ? 'action.selected' : 'action.hover'},
				'&:hover': {backgroundColor: 'action.selected'}
			}}
		>
			{highlighted && (
				// pointer-events: none so this purely decorative overlay never steals the row's own click
				// handling. Relies on the svg's own default overflow:hidden to clip the half of the stroke
				// that would otherwise spill past the row's edge, rather than needing an inset via calc() -
				// simpler, and avoids relying on calc() support inside an SVG geometry attribute.
				<svg style={{position: 'absolute', inset: 0, pointerEvents: 'none'}} width="100%" height="100%">
					<rect
						x="0" y="0" width="100%" height="100%"
						fill="none" stroke={HIGHLIGHT_COLOR} strokeOpacity={1} strokeWidth={4} strokeDasharray="10 2" vectorEffect="non-scaling-stroke"
						style={{animation: `${marchingAnts} 0.5s linear infinite`}}
					/>
				</svg>
			)}

			<Handle id={`${column.name}-target-left`} type="target" position={Position.Left} style={HANDLE_STYLE} />
			<Handle id={`${column.name}-source-left`} type="source" position={Position.Left} style={HANDLE_STYLE} />
			<Handle id={`${column.name}-target-right`} type="target" position={Position.Right} style={HANDLE_STYLE} />
			<Handle id={`${column.name}-source-right`} type="source" position={Position.Right} style={HANDLE_STYLE} />

			<Box sx={{width: 16, display: 'flex', justifyContent: 'center', flexShrink: 0}}>
				<ColumnIcon column={column} missingTarget={missingTarget} onAddMissingTarget={onAddMissingTarget} />
			</Box>
			{/* The label, not the identity - a row reads the way the results grid and schema browser read.
			Only the first configured option is shown: one narrow cell can't fit two or three names.
			flexGrow: 0 (not 1) so this box sizes to the text itself rather than claiming the row's whole
			remaining width - otherwise the AutoAwesome icon right after it would land next to the type
			column instead of hugging the name, with a stretch of empty space in between. minWidth: 0 keeps
			the ellipsis working once a long name is actually forced to shrink. */}
			<Box component="span" sx={{flexGrow: 0, flexShrink: 1, minWidth: 0, fontSize: '0.75rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>{columnDisplayName(column, columnLabels)}</Box>
			{/* NN/U/I - Not Null, Unique, Indexed, in that fixed order, only the ones that apply. Its own
			flexShrink: 0 span (not appended inside the name's own span above) so a long name's ellipsis
			truncates the NAME, never silently swallows the indicator along with it. */}
			{indicatorText && (
				<Box component="span" sx={{flexShrink: 0, fontSize: '0.75rem', color: 'text.secondary', whiteSpace: 'nowrap'}}>({indicatorText})</Box>
			)}
			{/* To the RIGHT of the name (never the left, where ColumnIcon's identity/key/FK markers live)
			so the two icon families never collide in the same 16px slot. */}
			{column.imported && <AutoAwesomeIcon sx={{fontSize: 12, color: IMPORT_COLOR, flexShrink: 0}} titleAccess="New or modified by an import" />}
			{/* marginLeft: auto claims whatever width the name gave up, pushing the type to the row's own
			right edge same as before (the row's own `gap` still covers the minimum spacing when there's
			nothing to push against, e.g. a name long enough to fill the row on its own) - the row's overall
			layout is unchanged, only where the icon sits is. */}
			<Box component="span" sx={{ml: 'auto', fontSize: '0.75rem', color: 'text.secondary', whiteSpace: 'nowrap'}}>{column.type}</Box>
		</Box>
	);

	let tooltipLines = columnTooltipLines(column, foreignKeyTargets, uniquePartners, indexes);

	// Skipped entirely for a column with none of the three name forms, no type, no flags, and no foreign
	// key - an empty tooltip box would just be a hover delay with nothing to show for it.
	if(tooltipLines.length === 0) {
		return row;
	}

	return (
		<Tooltip placement="right" title={<TooltipLines lines={tooltipLines} />}>
			{row}
		</Tooltip>
	);
}

// "(NN, U, I)" - Not Null, Unique, Indexed, in that fixed order, comma-separated, only the ones that
// apply - empty string (not shown at all) for a column with none. A fixed order reads
// consistently across every column rather than one that reorders itself per row.
function columnIndicatorText(column: DiagramColumn): string {
	return [column.notNull && 'NN', column.unique && 'U', column.indexed && 'I'].filter((flag): flag is string => !!flag).join(', ');
}

// Same two explanations the schema browser's own badge tooltip gives (table-detail.tsx's
// BADGE_HELP_TEXT), condensed to fit a single tooltip line here rather than a dedicated hover target of
// their own. 'orphaned' is diagram-only - the schema browser has no equivalent, since it always reflects
// a live resolve rather than a saved snapshot.
const IMPORT_STATUS_TOOLTIP_TEXT: Record<NonNullable<DiagramTable['importStatus']>, string> = {
	imported: 'Not in the connected database - everything shown for it comes from an imported file',
	enhanced: 'A real, connected table enhanced with additional data from an imported file',
	orphaned: 'No longer resolves against the database or an imported file, as of the last Sync - kept on the diagram, not confirmed current'
};

const IMPORT_STATUS_LABEL: Record<NonNullable<DiagramTable['importStatus']>, string> = {
	imported: 'Imported', enhanced: 'Enhanced', orphaned: 'New'
};

// 'orphaned' shares the "New" badge (ImportBadgeKind has no separate 'orphaned' look) - both say the same
// underlying thing (don't trust this as confirmed DB2 data), and a distinct alarming label isn't what an
// orphan needs after the user has already chosen, via the Sync confirmation, to keep it.
function importBadgeKind(status: NonNullable<DiagramTable['importStatus']>): ImportBadgeKind {
	return status === 'orphaned' ? 'new' : status;
}

// A table's own hover tooltip: its schema-qualified name and description (same text the header's own
// tooltip already showed), plus how many columns it has, how many indexes it has (same otherwise-invisible
// reasoning - a column's own "I" marker says it's indexed, not how many indexes or by whom), and how many
// foreign key relationships it's the source end of - all three otherwise invisible at the collapsed zoom
// tier's solid name block, and not something a user could count by eye even while expanded. An Imported/
// Enhanced table adds one more line explaining why - the header badge itself has no room to.
function TableTooltipContent({table, outgoingRelationshipCount}: {table: DiagramTable; outgoingRelationshipCount: number}) {
	return (
		<Box sx={{display: 'flex', flexDirection: 'column', gap: 0.25}}>
			<Box sx={{fontSize: '0.7rem'}}>{table.schemaId}.{table.name}{table.description ? ` - ${table.description}` : ''}</Box>
			<TooltipLines lines={[
				{label: 'Columns', value: String(table.columns.length)},
				{label: 'Indexes', value: String(table.indexes?.length ?? 0)},
				{label: 'Foreign Keys', value: String(outgoingRelationshipCount)},
				...(table.importStatus
					? [{label: IMPORT_STATUS_LABEL[table.importStatus], value: IMPORT_STATUS_TOOLTIP_TEXT[table.importStatus]}]
					: [])
			]} />
		</Box>
	);
}

// One icon slot per column, priority identity > PK > FK, rather than stacking multiple icons - keeps a
// wide, real-world table (10-15+ columns) readable instead of cluttered. An identity column that's also
// the PK shows the identity icon (identity is the more specific/informative fact about that
// column); PK-but-not-identity falls back to the key icon, and FK-but-neither still gets its own icon so
// that distinction isn't lost entirely. All three markers share COLUMN_ICON_COLOR - one visual family for
// "this column is special", not a ranking implied by different colors.
function ColumnIcon({column, missingTarget, onAddMissingTarget}: {
	column: DiagramColumn;
	missingTarget?: MissingRelationshipTarget;
	onAddMissingTarget: (target: MissingRelationshipTarget) => void;
}) {
	if (column.identity) {
		return <BoltIcon sx={{fontSize: 12, color: COLUMN_ICON_COLOR}} titleAccess="Identity column" />;
	}

	if (column.primaryKey) {
		return <VpnKeyIcon sx={{fontSize: 12, color: COLUMN_ICON_COLOR}} titleAccess="Primary key" />;
	}

	if (column.foreignKey) {
		// The referenced table isn't on the diagram yet - same slot the normal foreign-key icon would
		// otherwise occupy, swapped for a "+" version that both signals that and adds it on click, rather
		// than a separate icon elsewhere on the row (this used to sit at the row's right edge - moved here
		// so a column's relationship state is always read from one place).
		if (missingTarget) {
			return <MissingTargetIcon target={missingTarget} onClick={onAddMissingTarget} />;
		}

		return <LinkIcon sx={{fontSize: 12, color: COLUMN_ICON_COLOR}} titleAccess="Foreign key" />;
	}

	return null;
}

// The other end(s) of a foreign key that isn't on the diagram yet. Deliberately always visible rather
// than revealed on row hover: a relationship you can't see is exactly the thing you'd never think to go
// hunting for. The tooltip carries the target's name, since the icon itself has no room for it - and
// only names it when there's exactly one, since a column pointing at several opens a picker anyway
// (see app.tsx's handleAddMissingTarget).
function MissingTargetIcon({target, onClick}: {target: MissingRelationshipTarget; onClick: (target: MissingRelationshipTarget) => void}) {
	function handleClick(event: ReactMouseEvent) {
		// Stops the row's own click handler (select the column, highlight its relationships) from also
		// firing - and, through it, the node's. This is its own action, not a column selection.
		event.stopPropagation();
		onClick(target);
	}

	let title = target.targets.length === 1
		? `Add ${target.targets[0].targetSchema}.${target.targets[0].targetTable} to the diagram`
		: `Add ${target.targets.length} referenced tables to the diagram`;

	return (
		<Tooltip title={title} placement="right">
			<Box onClick={handleClick} sx={{display: 'flex', color: COLUMN_ICON_COLOR}}>
				<AddLinkIcon sx={{fontSize: 12}} />
			</Box>
		</Tooltip>
	);
}

// A declared handle's x/y is NOT the point an edge actually connects to - @xyflow/system's
// getHandlePosition() treats it as the top-left corner of a `width` x `height` box, then re-derives the
// real connection point from that: Position.Left -> {x, y: y + height/2}, Position.Right ->
// {x: x + width, y: y + height/2}. Declaring x/y as the row's own center therefore lands the actual
// connection half a unit (height/2) too low, and every right-side one a full unit (width) further right
// than the table's own edge - individually invisible at rest, but a small, constant misalignment that
// becomes obvious the moment you're watching the line track a table you're actively dragging. Since
// every declared handle here is a 1x1 box, this constant just subtracts that same half/full unit back
// out so the box's resulting center lands exactly on the row's true center.
const HANDLE_SIZE = 1;

export function tableNodeHandles(table: DiagramTable) {
	// A table with a description has a taller header (see the description Box's own comment above) -
	// every row sits that much further down than HEADER_HEIGHT alone would put it.
	let tableHeaderHeight = headerHeight(!!table.description);

	return table.columns.flatMap((column, index) => {
		let centerY = tableHeaderHeight + index * ROW_HEIGHT + ROW_HEIGHT / 2;
		let y = centerY - HANDLE_SIZE / 2;
		let rightX = TABLE_WIDTH - HANDLE_SIZE;

		return [
			{id: `${column.name}-target-left`, type: 'target' as const, position: Position.Left, x: 0, y: y, width: HANDLE_SIZE, height: HANDLE_SIZE},
			{id: `${column.name}-source-left`, type: 'source' as const, position: Position.Left, x: 0, y: y, width: HANDLE_SIZE, height: HANDLE_SIZE},
			{id: `${column.name}-target-right`, type: 'target' as const, position: Position.Right, x: rightX, y: y, width: HANDLE_SIZE, height: HANDLE_SIZE},
			{id: `${column.name}-source-right`, type: 'source' as const, position: Position.Right, x: rightX, y: y, width: HANDLE_SIZE, height: HANDLE_SIZE}
		];
	});
}

// Used instead of tableNodeHandles while a table is collapsed (header only, no column rows rendered) -
// per-column handles would still be positioned as if every row were showing, landing well below the
// collapsed box's actual (much shorter) height and making every relationship line appear to enter/exit
// at an arbitrary point along the side of the table. `height` is whatever this node is actually rendered
// at right now (headerHeight(hasDescription) today, since there's nothing else to show once collapsed -
// see its own comment for why a description changes it), not recomputed from the column count, so this
// stays correct even if a collapsed table ever grows a second summary row.
export function tableMiddleHandles(height: number) {
	// See tableNodeHandles' comment above for why HANDLE_SIZE/2 (and, on the right, HANDLE_SIZE) is
	// subtracted back out here.
	let y = height / 2 - HANDLE_SIZE / 2;
	let rightX = TABLE_WIDTH - HANDLE_SIZE;

	return [
		{id: `${TABLE_MIDDLE_HANDLE_ID}-target-left`, type: 'target' as const, position: Position.Left, x: 0, y: y, width: HANDLE_SIZE, height: HANDLE_SIZE},
		{id: `${TABLE_MIDDLE_HANDLE_ID}-source-left`, type: 'source' as const, position: Position.Left, x: 0, y: y, width: HANDLE_SIZE, height: HANDLE_SIZE},
		{id: `${TABLE_MIDDLE_HANDLE_ID}-target-right`, type: 'target' as const, position: Position.Right, x: rightX, y: y, width: HANDLE_SIZE, height: HANDLE_SIZE},
		{id: `${TABLE_MIDDLE_HANDLE_ID}-source-right`, type: 'source' as const, position: Position.Right, x: rightX, y: y, width: HANDLE_SIZE, height: HANDLE_SIZE}
	];
}

export const TableNode = memo(TableNodeComponent);
