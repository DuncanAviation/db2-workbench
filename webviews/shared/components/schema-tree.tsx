import { DragEvent, MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { Box, IconButton, InputAdornment, ListItemButton, ListItemIcon, ListItemText, Menu, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useVirtualizer } from '@tanstack/react-virtual';
import { StringUtils } from '../../../src/utils/string-utils.js';
import { buildTableKey, tableKeysEqual, tableKeyToString, TableKey, TableKeyKind } from '../table-key';
import { ContextMenu } from './context-menu';
import { ResizablePanel } from './resizable-panel';
import type { PanelResize } from './resizable-panel';

// The custom MIME type a multi-select row's HTML5 drag advertises (see handleTableDragStart below) - a
// drop target checks for this specifically (event.dataTransfer.types.includes(...)) rather than accepting
// any drag, so it doesn't react to something dragged in from outside this tree (a file from the OS, text
// from elsewhere in the editor, etc). Only meaningful in 'multi' mode; single-select rows aren't draggable.
export const TABLE_ROW_DRAG_MIME_TYPE = 'application/x-db2-workbench-table-keys';

// A schema/Tables/table (and optionally Views/view and Functions/function) tree with a filter box, shared by the schema browser (single-select, to open a
// table's detail tabs) and the diagram editor's table picker (multi-select, to add a batch of tables to a
// diagram). The diagram needed the same tree view with the same filtering, and the parts
// genuinely worth sharing are the filter-derived auto-expand behavior and the react-virtual windowing -
// reimplementing either in the diagram bundle would have been the actual mistake.

// Flat by design: whatever a bundle's own table entries look like, it maps them into this before handing
// them over. That keeps connected-vs-imported (a schema-browser concept, see getEntryKey in
// webviews/schemas/table-key.ts) and SchemasSystemTable's dozen DB2 columns out of here entirely, so the
// diagram never has to fabricate fields it has no value for just to render a row.
export interface SchemaTreeEntry {
	schema: string;
	/** The row's identity within its schema - for a function, its specific name. */
	table: string;
	/** Shown (and filtered on) instead of `table` when set - a function's name, or an overload's signature. */
	label?: string;
	description?: string;
}

// Used for both the vertical-dots menu ("Edit Schema List"/"Import" in the schema browser, nothing in
// the diagram, which hides the button entirely) and the multi-select right-click menu. Supplied rather
// than hardcoded, which is what let this component move out of the schemas bundle at all.
export interface SchemaTreeMenuItem {
	label: string;
	onClick: () => void;
}

// A discriminated union rather than a pile of optional props, so a host can't half-configure a mode:
// picking 'single' makes selectedKey/onSelectTable required and the multi-select callbacks unavailable,
// and vice versa.
export type SchemaTreeSelection =
	| {
		mode: 'single';
		/** A view's key carries kind: 'view' - see TableKey.kind. */
		selectedKey: TableKey | null;
		onSelectTable: (schema: string, table: string) => void;
		/** Clicking a row under a schema's Views node. Only reachable when viewsBySchema is passed. */
		onSelectView?: (schema: string, view: string) => void;
		/** Clicking a row under a schema's Functions node, with the function's specific name. Only reachable
		 * when functionsBySchema is passed. */
		onSelectFunction?: (schema: string, specificName: string) => void;
		/** Clicking a row under a schema's Procedures node, with the procedure's specific name. Only
		 * reachable when proceduresBySchema is passed. */
		onSelectProcedure?: (schema: string, specificName: string) => void;
	}
	| {
		mode: 'multi';
		/** tableKeyToString() values - a primitive set, since freshly built TableKeys are never reference-equal. */
		selectedKeys: ReadonlySet<string>;
		/**
		 * The tree hands back the whole resulting set rather than a per-row toggle, because it is the only
		 * side that knows the visible row ORDER a shift-click range has to be resolved against - the host
		 * just stores what it is given.
		 */
		onSelectionChange: (selectedKeys: ReadonlySet<string>) => void;
		/**
		 * Right-click menu entries, rebuilt each time the menu opens so a label can reflect how many rows
		 * are selected ("Add 3 tables to Diagram"). Omit it and right-click falls through to the default.
		 */
		contextMenuItems?: (selectedKeys: ReadonlySet<string>) => SchemaTreeMenuItem[];
	};

interface Props {
	tablesBySchema: Record<string, SchemaTreeEntry[]>;
	/**
	 * Adds a "Materialized Query Tables (n)" node under each schema, after its Tables node. An MQT is a
	 * table in every other respect, so its rows behave exactly like table rows - same key (no kind), same
	 * selection callbacks, in either mode. Only the node they're listed under differs.
	 */
	mqtsBySchema?: Record<string, SchemaTreeEntry[]>;
	/**
	 * Adds a "Views (n)" node under each schema, after its Tables node - `table` holds the view's name.
	 * Single-select only: views can't be added to a diagram, so the diagram picker simply doesn't pass
	 * this, and a multi-select tree ignores it. The filter matches views the same way it matches tables.
	 */
	viewsBySchema?: Record<string, SchemaTreeEntry[]>;
	/**
	 * Adds a "Functions (n)" node after Views, one row per function (an overload is its own row) - `table`
	 * holds the specific name and `label` what to show. Single-select only, for the same reason as views.
	 */
	functionsBySchema?: Record<string, SchemaTreeEntry[]>;
	/** Adds a "Procedures (n)" node after Functions, shaped the same way as functionsBySchema. */
	proceduresBySchema?: Record<string, SchemaTreeEntry[]>;
	filterText: string;
	onFilterTextChange: (filterText: string) => void;
	selection: SchemaTreeSelection;
	menuItems?: SchemaTreeMenuItem[];
	/**
	 * True while the host is still fetching what this tree should show (the diagram picker, between
	 * connecting and its first schemaTablesLoaded push - see emptyMessage's own "Loading tables..." case).
	 * Hides the vertical-dots menu (Edit Schema List/Import) for the duration, so nothing can act on a
	 * schema list that hasn't actually arrived yet. Collapsing and filtering stay available - neither
	 * touches anything the load could race with. Defaults to false, since most hosts never have a gap
	 * between having a tree at all and having its data (the schema browser seeds tablesBySchema from its
	 * own initial state).
	 */
	loading?: boolean;
	/**
	 * Header above the filter field, naming what the tree is showing - both hosts pass the connection
	 * name. Deliberately a generic `title` rather than a `connectionName`: the tree itself has no notion
	 * of a connection, and a host with something else worth naming there shouldn't have to misuse the
	 * prop. Omit it and the header row still renders, since the tree's own buttons live in it.
	 */
	title?: string;
	/** Shown in place of the tree when nothing matches the filter, or when there is nothing to show yet. */
	emptyMessage?: string;
	/**
	 * Makes the divider on the tree's right edge draggable - see ResizablePanel. Without it the tree is
	 * DEFAULT_TREE_WIDTH wide, as in the diagram picker.
	 */
	resizable?: PanelResize;
}

type FlatRow =
	| { type: 'schema'; schema: string; tableCount: number; expanded: boolean }
	| { type: 'tables-node'; group: TableGroup; schema: string; tableCount: number; expanded: boolean }
	| { type: 'table'; schema: string; entry: SchemaTreeEntry }
	| { type: 'object-node'; kind: TableKeyKind; schema: string; count: number; expanded: boolean }
	| { type: 'object'; kind: TableKeyKind; schema: string; entry: SchemaTreeEntry };

// The nodes whose rows are tables - plain tables, and materialized query tables listed apart from them.
type TableGroup = 'tables' | 'mqts';

const TABLE_GROUP_LABELS: Record<TableGroup, string> = {
	tables: 'Tables',
	mqts: 'Materialized Query Tables'
};

// The non-table kinds, each with its own node under a schema, in display order after the table groups.
const OBJECT_GROUPS: { kind: TableKeyKind; label: string }[] = [
	{ kind: 'view', label: 'Views' },
	{ kind: 'function', label: 'Functions' },
	{ kind: 'procedure', label: 'Procedures' }
];

const DEFAULT_EMPTY_MESSAGE = 'No schemas match the current filter';

/** The tree's width until it is dragged, and what a double-click on the divider puts it back to. */
export const DEFAULT_TREE_WIDTH = 260;
const MIN_TREE_WIDTH = 180;

// How narrow a drag may leave the panel beside the tree.
const MIN_BESIDE_TREE_WIDTH = 320;

function toggleInSet<T>(set: Set<T>, value: T): Set<T> {
	let next = new Set(set);
	next.has(value) ? next.delete(value) : next.add(value);
	return next;
}

function entryKey(entry: SchemaTreeEntry): TableKey {
	return { schema: entry.schema, table: entry.table };
}

function objectKey(kind: TableKeyKind, entry: SchemaTreeEntry): TableKey {
	return buildTableKey(entry.schema, entry.table, kind);
}

function displayName(entry: SchemaTreeEntry): string {
	return entry.label ?? entry.table;
}

function flatRowKey(row: FlatRow): string {
	if(row.type === 'table') {
		return `table:${tableKeyToString(entryKey(row.entry))}`;
	}

	if(row.type === 'object') {
		// A view's or function's string key is already kind-prefixed, so it can't collide with any other row's.
		return tableKeyToString(objectKey(row.kind, row.entry));
	}

	if(row.type === 'tables-node') {
		return `${row.group}-node:${row.schema}`;
	}

	return row.type === 'object-node' ? `${row.kind}-node:${row.schema}` : `${row.type}:${row.schema}`;
}

const NO_OBJECTS: Record<string, SchemaTreeEntry[]> = {};

// The filter's per-entry test, shared by every kind.
function matchesFilter(entry: SchemaTreeEntry, filter: string): boolean {
	return displayName(entry).toLowerCase().includes(filter) || (entry.description ?? '').toLowerCase().includes(filter);
}

// By name, then - for overloads, whose labels only differ in their signatures - shortest signature first.
// The name is compared without its "(...)": localeCompare all but ignores punctuation, which would
// otherwise interleave the overloads by their parameter types' letters.
function sortEntries(entries: SchemaTreeEntry[]): SchemaTreeEntry[] {
	let baseName = (entry: SchemaTreeEntry) => displayName(entry).split('(')[0];
	return [...entries].sort((a, b) => baseName(a).localeCompare(baseName(b)) || displayName(a).length - displayName(b).length);
}

// A schema present in tablesBySchema doesn't necessarily have any tables - a manually added schema
// (see the "Edit Schema List" menu) can be empty - so a schema row can expand to nothing at all, since
// empty folders are left out.
export function SchemaTree({ tablesBySchema, mqtsBySchema = NO_OBJECTS, viewsBySchema, functionsBySchema, proceduresBySchema, filterText, onFilterTextChange, selection, menuItems, loading, title, emptyMessage, resizable }: Props) {
	const theme = useTheme();
	const containerRef = useRef<HTMLDivElement>(null);
	const [collapsed, setCollapsed] = useState(false);
	const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLElement | null>(null);
	// Anchored to the mouse position rather than to the row element, so the menu opens exactly where
	// the click landed the way a right-click menu is expected to - a row-element anchor would also go
	// stale the moment the virtualizer recycled that row out from under it.
	const [contextMenu, setContextMenu] = useState<{ mouseX: number; mouseY: number; items: SchemaTreeMenuItem[] } | null>(null);
	// Multi-select only: the last row picked WITHOUT shift, which is the fixed end of a shift-click
	// range. Keeping it fixed (rather than moving it to whatever was last clicked) is what lets
	// repeated shift-clicks re-stretch one range instead of walking it forward a row at a time.
	const [selectionAnchorKey, setSelectionAnchorKey] = useState<string | null>(null);
	const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
	const [expandedTablesNodes, setExpandedTablesNodes] = useState<Set<string>>(new Set());
	// Views/Functions nodes, keyed '<kind>:<schema>'.
	const [expandedObjectNodes, setExpandedObjectNodes] = useState<Set<string>>(new Set());
	// While filtering, every visible schema/tables-node auto-expands (see flatRows below) so matches
	// are visible without manual clicks - this set holds only the ones the user explicitly collapsed
	// back during that filter, keyed 'schema:x'/'tables:x'/'view:x'/'function:x'/'procedure:x' since a schema and its nodes share a
	// name. It's kept entirely separate from expandedSchemas/expandedTablesNodes (the permanent
	// manual state) and reset whenever the filter is cleared, so clearing the filter reverts to
	// exactly the pre-filter layout with no snapshot/restore step needed.
	const [filterCollapsedOverrides, setFilterCollapsedOverrides] = useState<Set<string>>(new Set());

	// Views and routines only ever show in single-select mode - see the viewsBySchema prop. A kind whose
	// map wasn't passed gets no node at all, rather than an empty one.
	const objectGroups = useMemo(() => {
		let byKind: Record<TableKeyKind, Record<string, SchemaTreeEntry[]> | undefined> = { view: viewsBySchema, function: functionsBySchema, procedure: proceduresBySchema };
		return selection.mode === 'single'
			? OBJECT_GROUPS.filter(group => byKind[group.kind] != null).map(group => ({ ...group, bySchema: byKind[group.kind] ?? NO_OBJECTS }))
			: [];
	}, [viewsBySchema, functionsBySchema, proceduresBySchema, selection.mode]);

	const schemaNames = useMemo(() => Array.from(new Set([
		...Object.keys(tablesBySchema),
		...Object.keys(mqtsBySchema),
		...objectGroups.flatMap(group => Object.keys(group.bySchema))
	])).sort(), [tablesBySchema, mqtsBySchema, objectGroups]);

	const filter = filterText.trim().toLowerCase();

	useEffect(() => {
		if(!filter) {
			setFilterCollapsedOverrides(new Set());
		}
	}, [filter]);

	// Every schema's tables are already loaded, so the filter matches against the complete set
	// immediately - there's no partial-coverage gap where an unexpanded schema hasn't been searched yet.
	const visible = useMemo(() => {
		let tables: Record<string, SchemaTreeEntry[]> = {};
		let mqts: Record<string, SchemaTreeEntry[]> = {};
		let objects: Partial<Record<TableKeyKind, Record<string, SchemaTreeEntry[]>>> = {};
		let match = (entries: SchemaTreeEntry[], matchesSchema: boolean) => matchesSchema ? entries : entries.filter(entry => matchesFilter(entry, filter));

		for(let schema of schemaNames) {
			let matchesSchema = !filter || schema.toLowerCase().includes(filter);
			let matchedTables = match(tablesBySchema[schema] ?? [], matchesSchema);
			let matchedMqts = match(mqtsBySchema[schema] ?? [], matchesSchema);
			let matchedObjects = objectGroups.map(group => ({ kind: group.kind, entries: match(group.bySchema[schema] ?? [], matchesSchema) }));

			// A schema whose own name matches stays visible even with no (or no matching) tables -
			// otherwise an empty added schema would vanish the instant its name is searched for.
			if(matchesSchema || matchedTables.length > 0 || matchedMqts.length > 0 || matchedObjects.some(matched => matched.entries.length > 0)) {
				tables[schema] = matchedTables;
				mqts[schema] = matchedMqts;

				for(let matched of matchedObjects) {
					(objects[matched.kind] ??= {})[schema] = matched.entries;
				}
			}
		}

		return { tables, mqts, objects };
	}, [tablesBySchema, mqtsBySchema, objectGroups, schemaNames, filter]);

	const visibleSchemaNames = useMemo(() => Object.keys(visible.tables).sort(), [visible]);

	// Flattened once per render into a single list (schema / tables-node / table rows) rather than a
	// nested tree, so the virtualizer below only ever has to deal with one flat, indexable sequence.
	const flatRows = useMemo(() => {
		let rows: FlatRow[] = [];

		for(let schema of visibleSchemaNames) {
			let entries = sortEntries(visible.tables[schema]);
			let schemaExpanded = filter ? !filterCollapsedOverrides.has(`schema:${schema}`) : expandedSchemas.has(schema);
			rows.push({ type: 'schema', schema, tableCount: entries.length, expanded: schemaExpanded });

			// A folder with nothing to show - none of that kind in the schema, or none matching the filter -
			// is left out rather than shown as "(0)".
			if(schemaExpanded) {
				let tablesExpanded = filter ? !filterCollapsedOverrides.has(`tables:${schema}`) : expandedTablesNodes.has(schema);

				if(entries.length > 0) {
					rows.push({ type: 'tables-node', group: 'tables', schema, tableCount: entries.length, expanded: tablesExpanded });
				}

				if(tablesExpanded) {
					for(let entry of entries) {
						rows.push({ type: 'table', schema, entry });
					}
				}

				let mqts = sortEntries(visible.mqts[schema] ?? []);
				let mqtsNodeKey = `mqts:${schema}`;
				let mqtsExpanded = filter ? !filterCollapsedOverrides.has(mqtsNodeKey) : expandedObjectNodes.has(mqtsNodeKey);

				if(mqts.length > 0) {
					rows.push({ type: 'tables-node', group: 'mqts', schema, tableCount: mqts.length, expanded: mqtsExpanded });

					if(mqtsExpanded) {
						for(let entry of mqts) {
							rows.push({ type: 'table', schema, entry });
						}
					}
				}

				for(let group of objectGroups) {
					let objects = sortEntries(visible.objects[group.kind]?.[schema] ?? []);
					let nodeKey = `${group.kind}:${schema}`;
					let objectsExpanded = filter ? !filterCollapsedOverrides.has(nodeKey) : expandedObjectNodes.has(nodeKey);

					if(objects.length === 0) {
						continue;
					}

					rows.push({ type: 'object-node', kind: group.kind, schema, count: objects.length, expanded: objectsExpanded });

					if(objectsExpanded) {
						for(let entry of objects) {
							rows.push({ type: 'object', kind: group.kind, schema, entry });
						}
					}
				}
			}
		}

		return rows;
	}, [visibleSchemaNames, visible, objectGroups, filter, expandedSchemas, expandedTablesNodes, expandedObjectNodes, filterCollapsedOverrides]);

	// Just the table rows of flatRows, in display order. A shift-click range has to follow what is
	// actually on screen - the current filter and expansion state - not the unfiltered data, so it's
	// derived from the same flattened list the virtualizer renders rather than from tablesBySchema.
	const visibleTableKeys = useMemo(() => {
		let keys: string[] = [];

		for(let row of flatRows) {
			if(row.type === 'table') {
				keys.push(tableKeyToString(entryKey(row.entry)));
			}
		}

		return keys;
	}, [flatRows]);

	const virtualizer = useVirtualizer({
		count: flatRows.length,
		getScrollElement: () => containerRef.current,
		estimateSize: () => 34,
		overscan: 10
	});

	function toggleSchema(schema: string) {
		if(filter) {
			setFilterCollapsedOverrides(prev => toggleInSet(prev, `schema:${schema}`));
		} else {
			setExpandedSchemas(prev => toggleInSet(prev, schema));
		}
	}

	function toggleTablesNode(group: TableGroup, schema: string) {
		if(group === 'mqts') {
			// Kept with the Views/Functions nodes' state - 'mqts' is no object kind, so the key can't collide.
			toggleNodeKey(`mqts:${schema}`);
			return;
		}

		if(filter) {
			setFilterCollapsedOverrides(prev => toggleInSet(prev, `tables:${schema}`));
		} else {
			setExpandedTablesNodes(prev => toggleInSet(prev, schema));
		}
	}

	function toggleObjectNode(kind: TableKeyKind, schema: string) {
		toggleNodeKey(`${kind}:${schema}`);
	}

	function toggleNodeKey(nodeKey: string) {
		if(filter) {
			setFilterCollapsedOverrides(prev => toggleInSet(prev, nodeKey));
		} else {
			setExpandedObjectNodes(prev => toggleInSet(prev, nodeKey));
		}
	}

	function handleMenuOpen(event: MouseEvent<HTMLElement>) {
		setMenuAnchorEl(event.currentTarget);
	}

	function handleMenuClose() {
		setMenuAnchorEl(null);
	}

	function handleMenuItemClick(item: SchemaTreeMenuItem) {
		handleMenuClose();
		item.onClick();
	}

	// Explorer-style modifier selection: ctrl/cmd toggles a single row, shift takes the whole range
	// between the anchor and the clicked row, ctrl+shift adds that range to what is already selected,
	// and a plain click collapses the selection down to the one row.
	function selectTableRow(key: string, event: MouseEvent<HTMLElement>) {
		if(selection.mode !== 'multi') {
			return;
		}

		let additive = event.ctrlKey || event.metaKey;

		if(event.shiftKey && selectionAnchorKey) {
			let anchorIndex = visibleTableKeys.indexOf(selectionAnchorKey);
			let clickedIndex = visibleTableKeys.indexOf(key);

			// An anchor that has since been filtered out or collapsed away has no place in the visible
			// order, so there is no range to draw from it - fall through and treat this as a plain click
			// rather than selecting rows the user cannot see.
			if(anchorIndex >= 0 && clickedIndex >= 0) {
				let range = visibleTableKeys.slice(Math.min(anchorIndex, clickedIndex), Math.max(anchorIndex, clickedIndex) + 1);
				selection.onSelectionChange(new Set(additive ? [...selection.selectedKeys, ...range] : range));
				return;
			}
		}

		setSelectionAnchorKey(key);
		selection.onSelectionChange(additive ? toggleInSet(new Set(selection.selectedKeys), key) : new Set([key]));
	}

	function handleTableContextMenu(key: string, event: MouseEvent<HTMLElement>) {
		// No preventDefault in single-select mode (or with no items supplied), so those hosts keep
		// whatever the platform's own right-click behavior is instead of getting an empty menu.
		if(selection.mode !== 'multi' || !selection.contextMenuItems) {
			return;
		}

		event.preventDefault();

		// Right-clicking inside the selection acts on the whole selection; right-clicking outside it
		// replaces the selection with that one row first. That is what every file explorer does, and it
		// avoids the menu silently acting on rows scrolled out of sight.
		let isInSelection = selection.selectedKeys.has(key);
		let keys: ReadonlySet<string> = isInSelection ? selection.selectedKeys : new Set([key]);

		if(!isInSelection) {
			setSelectionAnchorKey(key);
			selection.onSelectionChange(keys);
		}

		// Items are snapshotted at open time (rather than recomputed while the menu is up) so a label
		// like "Add 3 tables" matches the selection the click actually applied to.
		setContextMenu({ mouseX: event.clientX, mouseY: event.clientY, items: selection.contextMenuItems(keys) });
	}

	// Double-click runs the first right-click menu entry directly, skipping the menu - in the diagram
	// picker that's "Add N Tables to Diagram", so double-clicking a table adds it without a right-click
	// detour. Same in-selection-vs-not rule as handleTableContextMenu: double-clicking a row already part
	// of the selection acts on the whole selection, otherwise it acts on just that row.
	function handleTableDoubleClick(key: string) {
		if(selection.mode !== 'multi' || !selection.contextMenuItems) {
			return;
		}

		let isInSelection = selection.selectedKeys.has(key);
		let keys: ReadonlySet<string> = isInSelection ? selection.selectedKeys : new Set([key]);

		if(!isInSelection) {
			setSelectionAnchorKey(key);
			selection.onSelectionChange(keys);
		}

		selection.contextMenuItems(keys)[0]?.onClick();
	}

	function handleContextMenuItemClick(item: SchemaTreeMenuItem) {
		setContextMenu(null);
		item.onClick();
	}

	// Dragging a row outside the current selection acts on just that row, exactly like right-clicking one
	// does (see handleTableContextMenu above) - so what ends up dragged always matches what the tree shows
	// as selected, rather than silently dragging a stale selection the row itself isn't part of.
	function handleTableDragStart(key: string, event: DragEvent<HTMLElement>) {
		if(selection.mode !== 'multi') {
			return;
		}

		let isInSelection = selection.selectedKeys.has(key);
		let keys: ReadonlySet<string> = isInSelection ? selection.selectedKeys : new Set([key]);

		if(!isInSelection) {
			setSelectionAnchorKey(key);
			selection.onSelectionChange(keys);
		}

		event.dataTransfer.effectAllowed = 'copy';
		event.dataTransfer.setData(TABLE_ROW_DRAG_MIME_TYPE, JSON.stringify([...keys]));

		// A custom drag image rather than the row's own (clipped, oddly-sized) DOM node - a small pill
		// naming what the drop will do, the same idea as the OS's own "N items" drag badge. Built and
		// measured off-screen because setDragImage() snapshots it synchronously at this point; the element
		// only needs to exist for this call; the timeout removes it right after that snapshot is taken.
		let dragImage = document.createElement('div');
		dragImage.textContent = `Add ${keys.size} table${StringUtils.getPlural(keys.size)}`;
		dragImage.style.position = 'absolute';
		dragImage.style.top = '-1000px';
		dragImage.style.left = '-1000px';
		dragImage.style.padding = '4px 10px';
		dragImage.style.borderRadius = `${theme.shape.borderRadius}px`;
		dragImage.style.backgroundColor = theme.palette.primary.main;
		dragImage.style.color = theme.palette.primary.contrastText;
		dragImage.style.fontFamily = theme.typography.fontFamily ?? 'inherit';
		dragImage.style.fontSize = '12px';
		dragImage.style.whiteSpace = 'nowrap';
		document.body.appendChild(dragImage);
		event.dataTransfer.setDragImage(dragImage, 0, 0);
		setTimeout(() => document.body.removeChild(dragImage), 0);
	}

	function renderTableRow(entry: SchemaTreeEntry) {
		let key = entryKey(entry);
		let primary = entry.description ? `${entry.table} (${entry.description})` : entry.table;

		if(selection.mode === 'multi') {
			let keyString = tableKeyToString(key);

			return (
				<ListItemButton
					selected={selection.selectedKeys.has(keyString)}
					onClick={event => selectTableRow(keyString, event)}
					onDoubleClick={() => handleTableDoubleClick(keyString)}
					onContextMenu={event => handleTableContextMenu(keyString, event)}
					draggable
					onDragStart={event => handleTableDragStart(keyString, event)}
					// userSelect: without it, shift-clicking a range also leaves the browser's own text
					// selection smeared across every row the shift-click spanned.
					sx={{ py: 0.25, pl: 6, userSelect: 'none' }}
				>
					<ListItemText primary={primary} slotProps={{ primary: { sx: { whiteSpace: 'nowrap' } } }} />
				</ListItemButton>
			);
		}

		return (
			<ListItemButton
				selected={!!selection.selectedKey && tableKeysEqual(selection.selectedKey, key)}
				onClick={() => selection.onSelectTable(key.schema, key.table)}
				sx={{ py: 0.25, pl: 6 }}
			>
				<ListItemText primary={primary} slotProps={{ primary: { sx: { whiteSpace: 'nowrap' } } }} />
			</ListItemButton>
		);
	}

	function selectObject(kind: TableKeyKind, key: TableKey) {
		if(selection.mode !== 'single') {
			return;
		}

		if(kind === 'view') {
			selection.onSelectView?.(key.schema, key.table);
		} else if(kind === 'function') {
			selection.onSelectFunction?.(key.schema, key.table);
		} else {
			selection.onSelectProcedure?.(key.schema, key.table);
		}
	}

	function renderObjectRow(kind: TableKeyKind, entry: SchemaTreeEntry) {
		let key = objectKey(kind, entry);
		let primary = entry.description ? `${displayName(entry)} (${entry.description})` : displayName(entry);

		return (
			<ListItemButton
				selected={selection.mode === 'single' && !!selection.selectedKey && tableKeysEqual(selection.selectedKey, key)}
				onClick={() => selectObject(kind, key)}
				sx={{ py: 0.25, pl: 6 }}
			>
				<ListItemText primary={primary} slotProps={{ primary: { sx: { whiteSpace: 'nowrap' } } }} />
			</ListItemButton>
		);
	}

	function renderFlatRow(row: FlatRow) {
		if(row.type === 'schema') {
			return (
				<ListItemButton onClick={() => toggleSchema(row.schema)} sx={{ py: 0.5 }}>
					<ListItemIcon sx={{ minWidth: 24 }}>
						{row.expanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
					</ListItemIcon>
					<ListItemText primary={row.schema} />
				</ListItemButton>
			);
		}

		if(row.type === 'tables-node') {
			return (
				<ListItemButton onClick={() => toggleTablesNode(row.group, row.schema)} sx={{ py: 0.5, pl: 3 }}>
					<ListItemIcon sx={{ minWidth: 24 }}>
						{row.expanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
					</ListItemIcon>
					<ListItemText primary={`${TABLE_GROUP_LABELS[row.group]} (${row.tableCount})`} />
				</ListItemButton>
			);
		}

		if(row.type === 'object-node') {
			let label = OBJECT_GROUPS.find(group => group.kind === row.kind)?.label;

			return (
				<ListItemButton onClick={() => toggleObjectNode(row.kind, row.schema)} sx={{ py: 0.5, pl: 3 }}>
					<ListItemIcon sx={{ minWidth: 24 }}>
						{row.expanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
					</ListItemIcon>
					<ListItemText primary={`${label} (${row.count})`} />
				</ListItemButton>
			);
		}

		return row.type === 'object' ? renderObjectRow(row.kind, row.entry) : renderTableRow(row.entry);
	}

	if(collapsed) {
		return (
			<Stack sx={{ height: '100%', flexShrink: 0, borderRight: 1, borderColor: 'divider', alignItems: 'center', pt: 1 }}>
				<IconButton aria-label="Expand schema tree" onClick={() => setCollapsed(false)}>
					<ChevronRightIcon fontSize="small" />
				</IconButton>
			</Stack>
		);
	}

	let tree = (
		// height: 100% (not flexGrow) deliberately - flexGrow resolves against whichever axis is the HOST's
		// main axis, which differs between this tree's two hosts. The schema browser drops it straight into
		// a row (main axis = width), so flexGrow: 1 there would fight the sibling detail panel over width
		// and blow past the tree's own width; the diagram nests it inside its own column-direction wrapper
		// Box (main axis = height), where flexGrow would do the right thing but only by accident of that
		// host's layout. A height, in contrast, only ever affects the vertical axis - it fills whatever
		// height a stretched (or explicitly sized) parent hands it in either host, leaving width alone.
		<Stack sx={{ width: resizable?.width ?? DEFAULT_TREE_WIDTH, height: '100%', flexShrink: 0, minHeight: 0, borderRight: 1, borderColor: 'divider', overflow: 'hidden' }}>
			{/* Header row: what this tree is showing, with the tree's own two buttons right-aligned beside it
			rather than crowding the filter field below. The title takes up the slack (flexGrow) so the buttons
			stay pinned right whether or not a title was supplied, and it truncates rather than wrapping - a long
			connection name must not push those buttons out of a fixed-width rail. */}
			<Stack direction="row" sx={{ pl: 1, pr: 0.5, pt: 0.5, flexShrink: 0, alignItems: 'center', gap: 0.5 }}>
				<Typography variant="body2" noWrap title={title} sx={{ flexGrow: 1, minWidth: 0, fontWeight: 600 }}>
					{title}
				</Typography>

				{!loading && menuItems && menuItems.length > 0 && (
					<>
						<IconButton aria-label="Schema tree options" onClick={handleMenuOpen}>
							<MoreVertIcon fontSize="small" />
						</IconButton>

						<Menu anchorEl={menuAnchorEl} open={menuAnchorEl !== null} onClose={handleMenuClose}>
							{menuItems.map(item => (
								<MenuItem key={item.label} onClick={() => handleMenuItemClick(item)}>{item.label}</MenuItem>
							))}
						</Menu>
					</>
				)}

				<IconButton aria-label="Collapse schema tree" onClick={() => setCollapsed(true)}>
					<ChevronLeftIcon fontSize="small" />
				</IconButton>
			</Stack>

			<Box sx={{ px: 1, pb: 1, pt: 0.5, flexShrink: 0 }}>
				<TextField
					fullWidth
					placeholder="Filter..."
					value={filterText}
					onChange={event => onFilterTextChange(event.target.value)}
					slotProps={{
						input: {
							endAdornment: filterText && (
								<InputAdornment position="end">
									<IconButton aria-label="Clear filter" onClick={() => onFilterTextChange('')}>
										✕
									</IconButton>
								</InputAdornment>
							)
						}
					}}
				/>
			</Box>

			<ContextMenu position={contextMenu} onClose={() => setContextMenu(null)}>
				{contextMenu?.items.map(item => (
					<MenuItem key={item.label} onClick={() => handleContextMenuItemClick(item)}>{item.label}</MenuItem>
				))}
			</ContextMenu>

			{visibleSchemaNames.length === 0 ? (
				<Typography variant="body2" sx={{ p: 2, color: 'text.secondary' }}>{emptyMessage ?? DEFAULT_EMPTY_MESSAGE}</Typography>
			) : (
				<Box ref={containerRef} sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto' }}>
					<Box sx={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
						{virtualizer.getVirtualItems().map(virtualRow => {
							let row = flatRows[virtualRow.index];

							return (
								<Box
									key={flatRowKey(row)}
									data-index={virtualRow.index}
									ref={virtualizer.measureElement}
									sx={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
								>
									{renderFlatRow(row)}
								</Box>
							);
						})}
					</Box>
				</Box>
			)}
		</Stack>
	);

	if(!resizable) {
		return tree;
	}

	return (
		<ResizablePanel {...resizable} edge="right" minWidth={MIN_TREE_WIDTH} defaultWidth={DEFAULT_TREE_WIDTH} reserveWidth={MIN_BESIDE_TREE_WIDTH} label="Resize schema tree">
			{tree}
		</ResizablePanel>
	);
}
