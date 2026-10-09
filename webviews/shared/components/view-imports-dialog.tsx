import { useEffect, useMemo, useState } from 'react';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Box, Button, Checkbox, Collapse, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, FormControlLabel, IconButton, InputAdornment, Radio, RadioGroup, Stack, TextField, Typography } from '@mui/material';
import { StringUtils } from '../../../src/utils/string-utils.js';
import type { SchemaImportEntry, SchemaImportSummary } from '../../../src/webview-messages/schemas-messages';
import { buildImportLabel, formatImportTimestamp, getFormatLabel } from '../utils/import-labels';
import { Loading } from './loading';

// "View Imports" on the schema tree's own menu, in both hosts (schema browser and diagram picker) - the
// imports themselves are one shared per-connection store (see SchemaTrees), so the same dialog listing the
// same batches belongs in both rather than a diagram-flavored copy.
//
// Lists every import made this session for this connection, expandable to the tables each one contributed.
// The checkboxes show what is currently APPLIED rather than a selection: a table switched off shows
// unchecked, and a fully switched-off import shows every box unchecked but stays in the list. "Apply"
// commits the difference in both directions, so the same control that disables an import is the one that
// brings it back.
//
// Apply only ever enables and disables - it never takes an import off this list, not even when every box
// of one is unticked, so it is always reversible from here and needs no confirmation. Removal is the
// delete button's job instead, and that is what raises the confirmation below: unlink from this connection
// (saved imports only, since nothing else has a settings entry to stay behind for) or delete outright.

interface Props {
	open: boolean;
	/** Null until the host's reply arrives - distinct from an empty array, which means "no imports". */
	imports: SchemaImportSummary[] | null;
	onCancel: () => void;
	/** Either the difference between what the checkboxes now show and what is currently applied (Apply), or
	 * one import's removal with every table of it disabled alongside (the delete button's confirmation) -
	 * never both at once. The dialog stays open; the host answers with a refreshed list rather than the
	 * dialog editing what it is showing. */
	onApply: (change: ViewImportsDialog.Change) => void;
	/** Only ever called for a SAVED import (summary.saved) - nothing else has statements to edit or to
	 * run again. Editing closes this dialog in favour of the edit one; refreshing leaves it open. */
	onEdit: (importId: string) => void;
	onRefresh: (importId: string) => void;
}

// What the delete button does with the import it was pressed on - the two ways of taking one off this
// list. 'unlink' is offered for a saved import only, and is its default, since it is the one that leaves
// the import itself intact for the other connections using it.
type RemovalChoice = 'unlink' | 'delete';

// A table row's key - schema+table alone would collide across two imports of the same table.
function entryKey(importId: string, schema: string, table: string): string {
	return `${importId} ${schema} ${table}`;
}

function toEntry(summary: SchemaImportSummary, table: {schema: string; table: string}): SchemaImportEntry {
	return {importId: summary.importId, schema: table.schema, table: table.table};
}

export function ViewImportsDialog({ open, imports, onCancel, onApply, onEdit, onRefresh }: Props) {
	const [filterText, setFilterText] = useState('');
	// What the checkboxes currently show. Seeded from the host's `enabled` flags and re-seeded on every
	// refreshed list, so an apply's outcome - not the dialog's own guess at it - is what ends up on screen.
	const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set());
	const [collapsedImportIds, setCollapsedImportIds] = useState<Set<string>>(new Set());
	// The import the delete button was pressed on, non-null while its confirmation is up. Carries the
	// summary itself rather than an id, so confirming acts on exactly what was asked about even if a
	// refreshed list has arrived in between.
	const [pendingRemoval, setPendingRemoval] = useState<SchemaImportSummary | null>(null);
	const [removalChoice, setRemovalChoice] = useState<RemovalChoice>('unlink');
	// Whether this open has actually taken an import off the list - what separates "the list emptied out
	// because of what you just did" (close, below) from "there was nothing here when you opened it" (empty
	// state). Disabling never empties the list, so it never sets this.
	const [removedAnything, setRemovedAnything] = useState(false);

	// A fresh open is a fresh decision - same convention as KeepRemoveDialog/EditSchemaListDialog. The
	// filter is reset too, since the list it was narrowing may be entirely different by now.
	useEffect(() => {
		if(open) {
			setFilterText('');
			setCollapsedImportIds(new Set());
			setPendingRemoval(null);
			setRemovedAnything(false);
		}
	}, [open]);

	// The checkboxes follow the host's state, not the other way round: every list that arrives (the first
	// one, and the refreshed one after each apply) re-seeds them, so a half-applied change can never be left
	// on screen looking applied.
	useEffect(() => {
		if(imports) {
			setCheckedKeys(new Set(imports.flatMap(summary => summary.tables
				.filter(table => table.enabled)
				.map(table => entryKey(summary.importId, table.schema, table.table)))));
		}
	}, [imports]);

	// Nothing left to show once the last import is gone, so the dialog closes itself rather than sitting
	// there on its own empty state. Driven by the host's refreshed list (not by what was requested), so an
	// apply that the host ends up not applying - the diagram's Keep/Remove prompt cancelled, say - leaves
	// the dialog open. Opening it with no imports at all still shows the empty state.
	useEffect(() => {
		if(open && removedAnything && imports !== null && imports.length === 0) {
			onCancel();
		}
	}, [open, removedAnything, imports, onCancel]);

	// Imports with their tables narrowed by the filter. A batch whose own label matches keeps all of its
	// tables (the user is filtering FOR that import); otherwise only its matching tables show, and a batch
	// with no match at all drops out. Same "match the parent or match a child" rule the schema tree's
	// filter uses.
	const filteredImports = useMemo(() => {
		if(!imports) {
			return [];
		}

		let filter = filterText.trim().toLowerCase();

		if(StringUtils.isBlank(filter)) {
			return imports;
		}

		return imports.flatMap(summary => {
			let labelMatches = buildImportLabel(summary).toLowerCase().includes(filter)
				|| summary.sourceLabel.toLowerCase().includes(filter)
				|| getFormatLabel(summary.sourceFormat).toLowerCase().includes(filter);

			if(labelMatches) {
				return [summary];
			}

			let tables = summary.tables.filter(table => `${table.schema}.${table.table}`.toLowerCase().includes(filter));
			return tables.length > 0 ? [{...summary, tables: tables}] : [];
		});
	}, [imports, filterText]);

	// Filtering auto-expands, the same way the tree's filter does - a collapsed batch would otherwise hide
	// the very rows the filter just found.
	let filtering = StringUtils.isNotBlank(filterText.trim());

	// The two-way difference between the checkboxes and what the host says is applied. Computed over the
	// WHOLE list rather than the filtered one: the filter narrows what is on screen, never what a change
	// already made to a hidden row means.
	const change = useMemo(() => {
		let disable: SchemaImportEntry[] = [];
		let enable: SchemaImportEntry[] = [];

		for(let summary of imports ?? []) {
			for(let table of summary.tables) {
				let checked = checkedKeys.has(entryKey(summary.importId, table.schema, table.table));

				if(table.enabled && !checked) {
					disable.push(toEntry(summary, table));
				} else if(!table.enabled && checked) {
					enable.push(toEntry(summary, table));
				}
			}
		}

		return {disable: disable, enable: enable};
	}, [imports, checkedKeys]);

	let changeCount = change.disable.length + change.enable.length;

	function toggleCollapsed(importId: string) {
		setCollapsedImportIds(current => {
			let next = new Set(current);
			next.has(importId) ? next.delete(importId) : next.add(importId);
			return next;
		});
	}

	function toggleTable(key: string) {
		setCheckedKeys(current => {
			let next = new Set(current);
			next.has(key) ? next.delete(key) : next.add(key);
			return next;
		});
	}

	// The header checkbox acts on what's currently VISIBLE in that batch, not on tables the filter is
	// hiding - changing rows you can't see is exactly the surprise that makes a bulk action unsafe.
	function toggleImport(summary: SchemaImportSummary, checkAll: boolean) {
		setCheckedKeys(current => {
			let next = new Set(current);

			for(let table of summary.tables) {
				let key = entryKey(summary.importId, table.schema, table.table);
				checkAll ? next.add(key) : next.delete(key);
			}

			return next;
		});
	}

	// Everything Apply commits is reversible from this same dialog - an import with every box unticked is
	// disabled, not removed - so it goes straight through with no confirmation of its own.
	function requestApply() {
		applyChange(change.disable, change.enable, [], []);
	}

	// Removal is the delete button's, and the only thing that asks first. The choice between unlinking and
	// deleting is what the confirmation below is for; an unsaved import has no settings entry, so deleting
	// is all it can offer and that is what it opens on.
	function requestRemoval(summary: SchemaImportSummary) {
		setRemovalChoice(summary.saved ? 'unlink' : 'delete');
		setPendingRemoval(summary);
	}

	// The removal carries the import's tables as a `disable` list: the host only unlinks or deletes an
	// import its apply leaves fully disabled, and re-derives that from the summaries it holds rather than
	// taking the id list on trust.
	function confirmRemoval() {
		if(!pendingRemoval) {
			return;
		}

		let disable = pendingRemoval.tables.filter(table => table.enabled).map(table => toEntry(pendingRemoval, table));
		let importIds = [pendingRemoval.importId];

		applyChange(disable, [], removalChoice === 'unlink' ? importIds : [], removalChoice === 'delete' ? importIds : []);
	}

	function applyChange(disable: SchemaImportEntry[], enable: SchemaImportEntry[], unlinkImportIds: string[], deleteImportIds: string[]) {
		onApply({disable: disable, enable: enable, unlinkImportIds: unlinkImportIds, deleteImportIds: deleteImportIds});

		if(unlinkImportIds.length > 0 || deleteImportIds.length > 0) {
			setRemovedAnything(true);
		}

		setPendingRemoval(null);
	}

	return (
		<>
			<Dialog open={open} onClose={onCancel} maxWidth="md" fullWidth>
				<DialogTitle>Imported Schemas</DialogTitle>
				<DialogContent>
					{imports === null ? (
						<Loading message="Loading imports..." />
					) : imports.length === 0 ? (
						<DialogContentText>There are no imports to view.</DialogContentText>
					) : (
						<Stack spacing={1}>
							<TextField
								size="small"
								fullWidth
								placeholder="Filter..."
								value={filterText}
								onChange={event => setFilterText(event.target.value)}
								slotProps={{
									input: {
										endAdornment: filterText && (
											<InputAdornment position="end">
												<IconButton size="small" aria-label="Clear filter" onClick={() => setFilterText('')}>
													✕
												</IconButton>
											</InputAdornment>
										)
									}
								}}
							/>

							{filteredImports.length === 0 && (
								<DialogContentText>No imports match this filter.</DialogContentText>
							)}

							{filteredImports.map(summary => {
								let expanded = filtering || !collapsedImportIds.has(summary.importId);
								let keys = summary.tables.map(table => entryKey(summary.importId, table.schema, table.table));
								let checkedCount = keys.filter(key => checkedKeys.has(key)).length;
								// Reads off the HOST's state, not the checkboxes: this is "nothing of this import is
								// applied right now", which is what the dimmed styling below is saying, rather than
								// "you have just unticked all of it".
								let allDisabled = summary.tables.every(table => !table.enabled);

								return (
									<Box key={summary.importId} sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
										<Stack direction="row" sx={{ alignItems: 'center', gap: 0.5, px: 0.5, py: 0.5 }}>
											<IconButton size="small" aria-label={expanded ? 'Collapse import' : 'Expand import'} onClick={() => toggleCollapsed(summary.importId)}>
												{expanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
											</IconButton>

											<Checkbox
												size="small"
												checked={checkedCount > 0 && checkedCount === keys.length}
												indeterminate={checkedCount > 0 && checkedCount < keys.length}
												onChange={event => toggleImport(summary, event.target.checked)}
												slotProps={{ input: { 'aria-label': `Apply all tables from ${summary.sourceLabel}` } }}
											/>

											<Stack sx={{ flexGrow: 1, minWidth: 0 }}>
												<Typography noWrap sx={{ fontWeight: 600, color: allDisabled ? 'text.disabled' : 'text.primary' }} title={buildImportLabel(summary)}>
													{buildImportLabel(summary)}
												</Typography>
												{/* "Last run" rather than "Imported" for a saved import: its timestamp moves every time it
												re-runs, which for a saved one is every connection. */}
												<Typography variant="caption" noWrap color="text.secondary">
													{getFormatLabel(summary.sourceFormat)} · {summary.saved ? 'Last run' : 'Imported'} {formatImportTimestamp(summary.importedAt)} · {summary.tables.length} table{summary.tables.length === 1 ? '' : 's'}{allDisabled ? ' · disabled' : ''}
												</Typography>
											</Stack>

											{/* Only a saved import can be edited or re-run - everything else has no statements behind
											it, just the rows a file or a paste produced once. */}
											{summary.saved && (
												<>
													<IconButton size="small" title="Run this import again" aria-label={`Refresh ${summary.sourceLabel}`} onClick={() => onRefresh(summary.importId)}>
														<RefreshIcon fontSize="small" />
													</IconButton>
													<IconButton size="small" title="Edit this import" aria-label={`Edit ${summary.sourceLabel}`} onClick={() => onEdit(summary.importId)}>
														<EditIcon fontSize="small" />
													</IconButton>
												</>
											)}

											{/* Removal is offered for every import, saved or not - Apply no longer takes anything off
											this list, so this button is the only way off it. */}
											<IconButton size="small" color="error" title="Remove this import" aria-label={`Remove ${summary.sourceLabel}`} onClick={() => requestRemoval(summary)}>
												<DeleteIcon fontSize="small" />
											</IconButton>
										</Stack>

										<Collapse in={expanded} unmountOnExit>
											<Box sx={{ borderTop: 1, borderColor: 'divider' }}>
												{summary.tables.map((table, index) => {
													let key = entryKey(summary.importId, table.schema, table.table);

													return (
														<Stack
															key={key}
															direction="row"
															sx={{ alignItems: 'center', gap: 0.5, pl: 4, pr: 1, bgcolor: index % 2 === 1 ? 'action.hover' : 'transparent' }}
														>
															<Checkbox
																size="small"
																checked={checkedKeys.has(key)}
																onChange={() => toggleTable(key)}
																slotProps={{ input: { 'aria-label': `Apply ${table.schema}.${table.table}` } }}
															/>
															{/* No "disabled" caption per row - the unticked box and the dimmed name already say it.
															The import header carries one, since a collapsed batch shows nothing else. */}
															<Typography noWrap title={`${table.schema}.${table.table}`} sx={{ color: table.enabled ? 'text.primary' : 'text.disabled' }}>
																{table.schema}.{table.table}
															</Typography>
														</Stack>
													);
												})}
											</Box>
										</Collapse>
									</Box>
								);
							})}
						</Stack>
					)}
				</DialogContent>
				<DialogActions>
					<Button onClick={onCancel}>Close</Button>
					<Button variant="contained" disabled={changeCount === 0} onClick={requestApply}>
						Apply{changeCount > 0 ? ` (${changeCount} change${changeCount === 1 ? '' : 's'})` : ''}
					</Button>
				</DialogActions>
			</Dialog>

			<Dialog open={pendingRemoval !== null} onClose={() => setPendingRemoval(null)} maxWidth="sm" fullWidth>
				<DialogTitle>Remove Import</DialogTitle>
				<DialogContent>
					{pendingRemoval && (
						<Box sx={{ mt: 2 }}>
							<Typography noWrap sx={{ fontWeight: 600 }} title={buildImportLabel(pendingRemoval)}>
								{buildImportLabel(pendingRemoval)}
							</Typography>

							<RadioGroup value={removalChoice} onChange={event => setRemovalChoice(event.target.value as RemovalChoice)}>
								{/* Only a saved import has a settings entry that can outlive this connection, so it is
								the only kind with anything to stay behind for. */}
								{pendingRemoval.saved && (
									<RemovalOption
										value="unlink"
										label="Unlink from this connection"
										caption={`Keeps its saved statements, so it can be imported here again. ${buildOtherConnectionsCaption(pendingRemoval, 'Stays linked to')}`.trim()}
									/>
								)}

								<RemovalOption
									value="delete"
									label={pendingRemoval.saved ? 'Delete permanently' : 'Delete'}
									caption={pendingRemoval.saved
										? `Deletes its saved statements from settings. ${buildOtherConnectionsCaption(pendingRemoval, 'Also unlinks from')} This cannot be undone.`.trim()
										: 'This import only exists in memory, so it cannot be restored.'}
								/>
							</RadioGroup>
						</Box>
					)}
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setPendingRemoval(null)}>Cancel</Button>
					<Button variant="contained" color="error" onClick={confirmRemoval}>Remove</Button>
				</DialogActions>
			</Dialog>
		</>
	);
}

// One radio with its consequence spelled out underneath - the label alone can't carry "and what that means
// for the connections this import is linked to", which is the whole point of the choice.
function RemovalOption({ value, label, caption }: { value: RemovalChoice; label: string; caption: string }) {
	return (
		<Box>
			<FormControlLabel value={value} control={<Radio size="small" />} label={label} />
			<Typography variant="caption" color="text.secondary" sx={{ display: 'block', pl: 4 }}>
				{caption}
			</Typography>
		</Box>
	);
}

// Names the OTHER connections a saved import is linked to, for whichever half of the choice is asking about
// them. An import linked only to this one has no others to name, so the sentence is dropped rather than
// rendered empty.
function buildOtherConnectionsCaption(summary: SchemaImportSummary, lead: string): string {
	let others = (summary.linkedConnections ?? []).filter(connection => !connection.current);
	return others.length === 0 ? '' : `${lead}: ${others.map(connection => connection.name).join(', ')}.`;
}

export namespace ViewImportsDialog {
	/** What the dialog commits - the two-way table difference from Apply, or one import's removal from the
	 * delete button (its tables in `disable`, its id in one of the two lists). Both id lists are re-derived
	 * host-side before anything acts on them. */
	export interface Change {
		disable: SchemaImportEntry[];
		enable: SchemaImportEntry[];
		unlinkImportIds: string[];
		deleteImportIds: string[];
	}
}
