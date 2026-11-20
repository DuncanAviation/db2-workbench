import { useEffect, useRef, useState } from 'react';
import { Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, InputAdornment, List, ListItem, ListSubheader, TextField, Typography } from '@mui/material';
import ClearIcon from '@mui/icons-material/Clear';
import type { DiagramTableKey } from '../../../src/webview-messages/diagram-messages';
import { ImportBadge } from '../../shared/components/import-badge';

// What an "add related tables" button opens: every foreign key through one column (a column row's
// button) or through the whole table (the header's), in both directions, one row per key. A key whose
// other table is already on the diagram is listed too, ticked and disabled, so the dialog is the whole
// picture of how the table connects rather than only what's left to add. Nothing starts ticked.
//
// One row per table within a section: a table with two keys (BILL_TO and SHIP_TO both into CUSTOMER)
// is one row whose Joins On and Key cells list each key on its own line. Ticking is per table, so a
// table that both references and is referenced by this one ticks in both sections at once, since adding
// it once is all either row can do.
//
// The filter only hides rows: a table ticked and then filtered out stays ticked and is still added, the
// same as the data tables' Filter field leaves a hidden row's state alone.

/** One key as the dialog shows it - DiagramTableKey with its columns already labelled by app.tsx. */
export interface RelatedKeyRow {
	direction: DiagramTableKey['direction'];
	/** Blank for an imported key that came with no name. */
	constraintName: string;
	/** The key came only from an import - shown with the New badge. */
	isNew: boolean;
	otherSchema: string;
	otherTable: string;
	otherTableId: string;
	/** Column labels, in key order: the referencing (child) side and the referenced (parent) side. */
	childColumns: string[];
	parentColumns: string[];
}

// A new object per click, so the selection below resets per button.
export interface RelatedTablesChoice {
	/** What the keys go through, for the title - "SALES.ORDERS", or "SALES.ORDERS CUSNO" for one of its columns. */
	subject: string;
	keys: RelatedKeyRow[];
}

interface Props {
	// The clicked button's choice, or null when nothing is being chosen - doubles as the dialog's own
	// open state so the list and its selection can never be out of step with each other.
	choice: RelatedTablesChoice | null;
	/** The tables on the diagram now, by id. */
	presentTableIds: ReadonlySet<string>;
	onCancel: () => void;
	onAdd: (tables: { schema: string; table: string }[]) => void;
}

/** Everything a row shows, for the filter to match against: the other table, its columns, the key's name and its New badge. */
function rowText(row: RelatedKeyRow): string {
	return [`${row.otherSchema}.${row.otherTable}`, row.constraintName, row.isNew ? 'New' : '', ...row.childColumns, ...row.parentColumns].join(' ').toUpperCase();
}

/** Case-insensitive, and every space-separated word must appear somewhere in the row. */
export function matchesRelatedKeyFilter(row: RelatedKeyRow, filterText: string): boolean {
	let text = rowText(row);
	return filterText.toUpperCase().split(/\s+/).filter(word => word.length > 0).every(word => text.includes(word));
}

// By the other table's schema, then its name, then the key's name - so a table's keys sit together.
function compareRelatedKeys(a: RelatedKeyRow, b: RelatedKeyRow): number {
	return a.otherSchema.localeCompare(b.otherSchema) || a.otherTable.localeCompare(b.otherTable) || a.constraintName.localeCompare(b.constraintName);
}

// Every row and the header share one grid, so Table, Joins On and Key line up down the whole list: the
// checkbox, then the three columns. minmax(0, ...) lets a long name ellipsize instead of widening its
// column. Joins On gets the most room, since a composite key's column list is the longest thing here.
const ROW_GRID = { display: 'grid', gridTemplateColumns: '42px minmax(0, 3fr) minmax(0, 4fr) minmax(0, 3fr)', columnGap: 2, alignItems: 'center' };
const CELL = { minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

/** A section's keys, one entry per table, in the order the keys arrive (already sorted). */
function groupByTable(rows: RelatedKeyRow[]): RelatedKeyRow[][] {
	let byTable = new Map<string, RelatedKeyRow[]>();

	for(let row of rows) {
		let group = byTable.get(row.otherTableId) ?? [];
		group.push(row);
		byTable.set(row.otherTableId, group);
	}

	return [...byTable.values()];
}

// Each key's Joins On and Key lines share this height, so a key's columns and its name stay level.
const KEY_LINE = { height: 22, display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 };

const SECTIONS: { direction: DiagramTableKey['direction']; title: string }[] = [
	{ direction: 'references', title: 'References' },
	{ direction: 'referencedBy', title: 'Referenced By' }
];

export function AddRelatedTablesDialog({ choice, presentTableIds, onCancel, onAdd }: Props) {
	let [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	let [filterText, setFilterText] = useState('');
	// The last subject shown, so the title doesn't go blank while the dialog fades out after choice is cleared.
	let lastSubject = useRef('');
	lastSubject.current = choice?.subject ?? lastSubject.current;
	let subject = lastSubject.current;

	// Cleared per button rather than per close so reopening the SAME button after a cancel doesn't come
	// back pre-ticked with a selection the user just abandoned, or still filtered.
	useEffect(() => {
		setSelected(new Set());
		setFilterText('');
	}, [choice]);

	function toggle(tableId: string) {
		setSelected(current => {
			let next = new Set(current);

			if(!next.delete(tableId)) {
				next.add(tableId);
			}

			return next;
		});
	}

	function handleAdd() {
		let tables = new Map<string, { schema: string; table: string }>();

		for(let key of choice?.keys ?? []) {
			if(selected.has(key.otherTableId) && !presentTableIds.has(key.otherTableId)) {
				tables.set(key.otherTableId, { schema: key.otherSchema, table: key.otherTable });
			}
		}

		onAdd([...tables.values()]);
	}

	let keys = (choice?.keys ?? []).filter(row => matchesRelatedKeyFilter(row, filterText)).sort(compareRelatedKeys);

	return (
		<Dialog open={choice !== null} onClose={onCancel} maxWidth="md" fullWidth>
			<DialogTitle>Add Tables Related to {subject}</DialogTitle>

			{/* dividers for the same reason SyncSummaryDialog uses it - the list is what scrolls when a
			table has more keys than fit, not the dialog growing past the viewport. */}
			<DialogContent dividers sx={{ p: 0 }}>
				<Box sx={{ px: 2, py: 1 }}>
					<TextField
						autoFocus
						fullWidth
						placeholder="Filter..."
						value={filterText}
						onChange={event => setFilterText(event.target.value)}
						slotProps={{
							htmlInput: { 'aria-label': 'Filter keys' },
							input: {
								endAdornment: filterText && (
									<InputAdornment position="end">
										<IconButton aria-label="Clear filter" onClick={() => setFilterText('')}>
											<ClearIcon fontSize="small" />
										</IconButton>
									</InputAdornment>
								)
							}
						}}
					/>
				</Box>
				{keys.length === 0 && (choice?.keys.length ?? 0) > 0 && (
					<Typography sx={{ px: 2, pb: 1.5, fontSize: '0.8rem', color: 'text.secondary', fontStyle: 'italic' }}>No keys match the filter.</Typography>
				)}
				{keys.length > 0 && (
					<Box sx={{ ...ROW_GRID, px: 2, py: 0.5, fontSize: '0.75rem', color: 'text.secondary', borderBottom: 1, borderColor: 'divider' }}>
						<span />
						<span>Table</span>
						<span>Joins On</span>
						<span>Key</span>
					</Box>
				)}
				<List dense disablePadding>
					{SECTIONS.map(section => {
						let rows = keys.filter(key => key.direction === section.direction);

						if(rows.length === 0) {
							return null;
						}

						return (
							<li key={section.direction}>
								<ul style={{ padding: 0 }}>
									<ListSubheader sx={{ lineHeight: '28px', fontSize: '0.8rem' }}>{section.title}</ListSubheader>
									{groupByTable(rows).map((group, index) => (
										<TableRow
											key={group[0].otherTableId}
											keys={group}
											striped={index % 2 === 1}
											onDiagram={presentTableIds.has(group[0].otherTableId)}
											checked={selected.has(group[0].otherTableId)}
											onToggle={() => toggle(group[0].otherTableId)}
										/>
									))}
								</ul>
							</li>
						);
					})}
				</List>
			</DialogContent>

			<DialogActions>
				<Button onClick={onCancel}>Cancel</Button>
				<Button variant="contained" onClick={handleAdd} disabled={selected.size === 0}>Add</Button>
			</DialogActions>
		</Dialog>
	);
}

function TableRow({ keys, striped, onDiagram, checked, onToggle }: { keys: RelatedKeyRow[]; striped: boolean; onDiagram: boolean; checked: boolean; onToggle: () => void }) {
	let tableName = `${keys[0].otherSchema}.${keys[0].otherTable}`;
	let joinsFor = (key: RelatedKeyRow) => `${key.childColumns.join(', ')} → ${key.parentColumns.join(', ')}`;

	return (
		<ListItem disablePadding sx={{ ...ROW_GRID, px: 2, py: keys.length > 1 ? 0.5 : 0, bgcolor: striped ? 'action.hover' : 'transparent' }}>
			<Checkbox
				checked={onDiagram || checked}
				disabled={onDiagram}
				onChange={onToggle}
				slotProps={{ input: { 'aria-label': tableName } }}
			/>
			<Box sx={{ ...CELL, display: 'flex', alignItems: 'baseline', gap: 1, color: onDiagram ? 'text.secondary' : undefined }}>
				<Typography component="span" title={tableName} sx={{ ...CELL, fontSize: '0.875rem' }}>{tableName}</Typography>
				{onDiagram && <Typography component="span" sx={{ fontSize: '0.75rem', color: 'text.secondary', fontStyle: 'italic', flexShrink: 0 }}>(on diagram)</Typography>}
			</Box>
			<Box sx={{ minWidth: 0 }}>
				{keys.map((key, index) => (
					<Box key={index} sx={KEY_LINE}>
						<Typography component="span" title={joinsFor(key)} sx={{ ...CELL, fontSize: '0.75rem', fontFamily: 'var(--vscode-editor-font-family, monospace)', color: onDiagram ? 'text.secondary' : undefined }}>
							{joinsFor(key)}
						</Typography>
					</Box>
				))}
			</Box>
			{/* One New badge for the row, before the stacked names, when any of the table's keys came only
			from an import - one per key read as clutter once a table had several. */}
			<Box sx={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 1 }}>
				{keys.some(key => key.isNew) && <Box sx={{ flexShrink: 0 }}><ImportBadge kind="new" /></Box>}
				<Box sx={{ minWidth: 0 }}>
					{keys.map((key, index) => (
						<Box key={index} sx={KEY_LINE}>
							{key.constraintName && <Typography component="span" title={key.constraintName} sx={{ ...CELL, fontSize: '0.75rem', color: 'text.secondary' }}>{key.constraintName}</Typography>}
						</Box>
					))}
				</Box>
			</Box>
		</ListItem>
	);
}
