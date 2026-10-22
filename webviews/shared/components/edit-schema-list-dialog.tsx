import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, List, ListItem, Stack, TextField, Tooltip, Typography } from '@mui/material';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import { DbErrorUtils } from '../../../src/utils/db-error-utils';
import { LibraryListUtils } from '../../../src/utils/library-list-utils';
import type { SchemasSchemaListEntry } from '../../../src/webview-messages/schemas-messages';
import { SqlErrorDisplay } from './sql-error-display';

interface ExistingRow {
	name: string;
	hidden: boolean;
	added: boolean;
	/** Marked for deletion on OK - reversible in-dialog (via Undo) the same way hidden is, unlike the
	 * actual deletion it results in once committed. Only offered for a schema the user added by name
	 * (`added`), which is the one case where deleting does something hiding can't: take the name back out
	 * of the overrides so it stops appearing here at all. A library-list schema can only ever be hidden,
	 * and an import-only one disappears on its own once its import is disabled from View Imports. */
	deleted: boolean;
}

interface NewRow {
	id: number;
	value: string;
}

let nextNewRowId = 0;

function newRow(): NewRow {
	return { id: nextNewRowId++, value: '' };
}

// Two modes over one dialog. 'overrides' is the schema browser's and the diagram picker's persistent,
// per-config list: hide a schema, add one by name, delete one that was added. 'live' is a session's actual
// library list (the results panel's connection tab): reorder, add and remove the user portion, which the
// host applies to the session's jobs with CHGLIBL. The two share the dialog, not state.
type Props = OverridesProps | LiveProps;

interface OverridesProps {
	mode: 'overrides';
	open: boolean;
	schemaList: SchemasSchemaListEntry[];
	onCancel: () => void;
	onSave: (result: { hiddenSchemas: string[]; newSchemas: string[]; deletedSchemas: string[] }) => void;
}

interface LiveProps {
	mode: 'live';
	open: boolean;
	/** The session's library list in order, each entry typed as QSYS2.LIBRARY_LIST_INFO.TYPE reports it. */
	libraryList: LibraryListUtils.Entry[];
	/** While the host is applying a save - OK is disabled and the edits stay as they are. */
	applying: boolean;
	/** The host's answer to the last save, when it failed. The dialog stays open with the user's edits. */
	error?: DbErrorUtils.SerializedError;
	/** Whether a library exists on the system, asked before Add puts it in the list - so a name that isn't
	 * there is refused at Add, beside the field, rather than failing the whole change at OK. */
	checkLibrary: (library: string) => Promise<boolean>;
	onCancel: () => void;
	/** The user portion, in order - QTEMP included where it sits, since it can't be moved or removed. */
	onSave: (userLibraries: string[]) => void;
}

export function EditSchemaListDialog(props: Props) {
	return props.mode === 'live' ? <LiveLibraryListDialog {...props} /> : <OverridesSchemaListDialog {...props} />;
}

function OverridesSchemaListDialog({ open, schemaList, onCancel, onSave }: OverridesProps) {
	const [existingRows, setExistingRows] = useState<ExistingRow[]>([]);
	const [newRows, setNewRows] = useState<NewRow[]>([]);

	// Re-seeds the dialog's own draft from the current schema list every time it's opened - not tied
	// to schemaList's identity, only to the open transition, so a state push that arrives while the
	// dialog happens to be open (unlikely, but see SchemaListUpdatedMessage) can't clobber in-progress edits.
	useEffect(() => {
		if (open) {
			setExistingRows(schemaList.map(entry => ({ ...entry, deleted: false })));
			setNewRows([]);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	function toggleHidden(name: string) {
		setExistingRows(current => current.map(row => row.name === name ? { ...row, hidden: !row.hidden } : row));
	}

	// Deleted supersedes hidden (a deleted schema's hidden flag is meaningless), so clear it when
	// marking for deletion - doesn't affect handleSave's payload either way, just keeps the draft state
	// consistent while Undo can still bring the row back.
	function toggleDeleted(name: string) {
		setExistingRows(current => current.map(row => row.name === name ? { ...row, deleted: !row.deleted, hidden: false } : row));
	}

	function handleAddRow() {
		setNewRows(current => [...current, newRow()]);
	}

	function updateNewRow(id: number, value: string) {
		setNewRows(current => current.map(row => row.id === id ? { ...row, value } : row));
	}

	function handleDeleteNewRow(id: number) {
		setNewRows(current => current.filter(row => row.id !== id));
	}

	function handleSave() {
		onSave({
			hiddenSchemas: existingRows.filter(row => row.hidden && !row.deleted).map(row => row.name),
			newSchemas: newRows.map(row => row.value.trim()).filter(value => value.length > 0),
			deletedSchemas: existingRows.filter(row => row.deleted).map(row => row.name)
		});
	}

	return (
		<Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
			<DialogTitle>Edit Schema List</DialogTitle>
			<DialogContent>
				<List dense disablePadding>
					{existingRows.map((row, index) => (
						<ListItem
							key={row.name}
							disablePadding
							sx={{ px: 1, py: 0.5, bgcolor: index % 2 === 1 ? 'action.hover' : 'transparent' }}
							secondaryAction={
								row.deleted ? (
									<Button size="small" onClick={() => toggleDeleted(row.name)}>Undo</Button>
								) : (
									<Stack direction="row" spacing={0.5}>
										<Button size="small" onClick={() => toggleHidden(row.name)}>
											{row.hidden ? 'Show' : 'Hide'}
										</Button>
										{row.added && (
											<Button size="small" color="error" onClick={() => toggleDeleted(row.name)}>Delete</Button>
										)}
									</Stack>
								)
							}
						>
							<Typography
								sx={{
									pr: 14,
									color: row.deleted || row.hidden ? 'text.disabled' : 'text.primary',
									textDecoration: row.deleted ? 'line-through' : 'none'
								}}
							>
								{row.name}
							</Typography>
						</ListItem>
					))}
				</List>

				<Stack spacing={1} sx={{ mt: 2 }}>
					{newRows.map(row => (
						<Stack key={row.id} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
							<TextField
								size="small"
								autoFocus
								fullWidth
								placeholder="Schema name"
								value={row.value}
								onChange={event => updateNewRow(row.id, event.target.value)}
							/>
							<IconButton size="small" aria-label="Remove schema" onClick={() => handleDeleteNewRow(row.id)}>
								✕
							</IconButton>
						</Stack>
					))}

					<Button onClick={handleAddRow} sx={{ alignSelf: 'flex-start' }}>Add Schema</Button>
				</Stack>
			</DialogContent>
			<DialogActions>
				<Button onClick={onCancel}>Cancel</Button>
				<Button variant="contained" onClick={handleSave}>OK</Button>
			</DialogActions>
		</Dialog>
	);
}

interface LiveRow {
	name: string;
	type: string;
	/** System, product and current entries, and QTEMP, can't be moved or removed - CHGLIBL only sets the
	 * user portion, and the host keeps QTEMP whatever it is sent. */
	fixed: boolean;
}

const TYPE_LABELS: Record<string, string> = {
	[LibraryListUtils.EntryType.SYSTEM]: 'System',
	[LibraryListUtils.EntryType.PRODUCT]: 'Product',
	[LibraryListUtils.EntryType.CURRENT]: 'Current',
	[LibraryListUtils.EntryType.USER]: 'User'
};

export function libraryListTypeLabel(type: string): string {
	return TYPE_LABELS[type?.toUpperCase()] ?? type;
}

function isUserEntry(entry: LibraryListUtils.Entry): boolean {
	return entry.type?.toUpperCase() === LibraryListUtils.EntryType.USER;
}

function toLiveRow(entry: LibraryListUtils.Entry): LiveRow {
	let name = entry.name.trim().toUpperCase();
	return { name: name, type: entry.type, fixed: !isUserEntry(entry) || name === LibraryListUtils.QTEMP };
}

function LiveLibraryListDialog({ open, libraryList, applying, error, checkLibrary, onCancel, onSave }: LiveProps) {
	const [rows, setRows] = useState<LiveRow[]>([]);
	const [newName, setNewName] = useState('');
	const [checking, setChecking] = useState(false);
	const [notFound, setNotFound] = useState<string | undefined>(undefined);
	const errorRef = useRef<HTMLDivElement>(null);

	// Re-seeded on open only, like the overrides mode: a list pushed while the dialog is open (a library
	// command run from a SQL tab) doesn't overwrite edits in progress.
	useEffect(() => {
		if (open) {
			setRows(libraryList.map(toLiveRow));
			setNewName('');
			setNotFound(undefined);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// The error sits below the list, out of sight once the list is long enough to scroll - bring it into
	// view when it arrives. scrollIntoView is optional-called: jsdom doesn't implement it.
	useEffect(() => {
		if (error) {
			errorRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
		}
	}, [error]);

	// A move swaps with the nearest movable row in that direction, so fixed rows keep their places.
	function move(index: number, direction: -1 | 1) {
		setRows(current => {
			let target = index + direction;

			while (target >= 0 && target < current.length && current[target].fixed) {
				target += direction;
			}

			if (target < 0 || target >= current.length) {
				return current;
			}

			let next = [...current];
			[next[index], next[target]] = [next[target], next[index]];
			return next;
		});
	}

	function canMove(index: number, direction: -1 | 1): boolean {
		for (let target = index + direction; target >= 0 && target < rows.length; target += direction) {
			if (!rows[target].fixed) {
				return true;
			}
		}

		return false;
	}

	function remove(index: number) {
		setRows(current => current.filter((_, rowIndex) => rowIndex !== index));
	}

	let trimmedName = newName.trim().toUpperCase();
	let duplicate = trimmedName.length > 0 && rows.some(row => row.name === trimmedName);
	let invalid = trimmedName.length > 0 && !LibraryListUtils.isValidSystemName(trimmedName);
	let nameError = invalid
		? 'Up to 10 characters: letters, digits, $, # or @ and _, starting with a letter, $, # or @'
		: duplicate ? `${trimmedName} is already on the library list`
			: notFound === trimmedName ? `Library ${trimmedName} was not found` : undefined;

	// The name is captured before the check, so typing on while it runs can't change what gets added.
	async function handleAdd() {
		if (trimmedName.length === 0 || nameError || checking) {
			return;
		}

		let library = trimmedName;
		let exists: boolean;
		setChecking(true);

		try {
			exists = await checkLibrary(library);
		} finally {
			setChecking(false);
		}

		if (!exists) {
			setNotFound(library);
			return;
		}

		setRows(current => current.some(row => row.name === library) ? current : [...current, { name: library, type: LibraryListUtils.EntryType.USER, fixed: false }]);
		setNewName(current => current.trim().toUpperCase() === library ? '' : current);
	}

	function handleSave() {
		onSave(rows.filter(row => isUserEntry(row)).map(row => row.name));
	}

	return (
		<Dialog open={open} onClose={applying ? undefined : onCancel} maxWidth="sm" fullWidth>
			<DialogTitle>Edit Library List</DialogTitle>
			<DialogContent>
				<Typography variant="body2" sx={{ color: 'text.secondary', mb: 1 }}>
					Changes this connection's library list until it disconnects.
				</Typography>

				<List dense disablePadding aria-label="Library list">
					{rows.map((row, index) => (
						<ListItem
							key={row.name}
							disablePadding
							aria-label={row.name}
							sx={{ px: 1, py: 0.5, bgcolor: index % 2 === 1 ? 'action.hover' : 'transparent' }}
							secondaryAction={!row.fixed && (
								<Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
									{/* Each span keeps its tooltip working while the button is disabled, which MUI needs. */}
									<Tooltip title="Move up">
										<span>
											<IconButton size="small" aria-label={`Move ${row.name} up`} disabled={applying || !canMove(index, -1)} onClick={() => move(index, -1)}>
												<ArrowUpwardIcon fontSize="small" />
											</IconButton>
										</span>
									</Tooltip>
									<Tooltip title="Move down">
										<span>
											<IconButton size="small" aria-label={`Move ${row.name} down`} disabled={applying || !canMove(index, 1)} onClick={() => move(index, 1)}>
												<ArrowDownwardIcon fontSize="small" />
											</IconButton>
										</span>
									</Tooltip>
									<Button size="small" color="error" aria-label={`Remove ${row.name}`} disabled={applying} onClick={() => remove(index)}>Remove</Button>
								</Stack>
							)}
						>
							<Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', pr: row.fixed ? 0 : 22 }}>
								<Typography sx={{ color: row.fixed ? 'text.secondary' : 'text.primary' }}>{row.name}</Typography>
								<Typography variant="caption" sx={{ color: 'text.secondary' }}>{libraryListTypeLabel(row.type)}</Typography>
							</Stack>
						</ListItem>
					))}
				</List>

				<Stack direction="row" spacing={1} sx={{ mt: 2, alignItems: 'flex-start' }}>
					<TextField
						size="small"
						fullWidth
						placeholder="Library name"
						slotProps={{ htmlInput: { 'aria-label': 'Library name' } }}
						value={newName}
						disabled={applying}
						error={nameError != null}
						helperText={checking ? `Checking ${trimmedName}...` : nameError}
						onChange={event => setNewName(event.target.value)}
						onKeyDown={event => {
							if (event.key === 'Enter') {
								event.preventDefault();
								void handleAdd();
							}
						}}
					/>
					<Button onClick={() => void handleAdd()} disabled={applying || checking || trimmedName.length === 0 || nameError != null}>Add</Button>
				</Stack>

				{error && (
					<Stack ref={errorRef} sx={{ mt: 2 }}>
						<SqlErrorDisplay error={error} label="The library list was not changed" />
					</Stack>
				)}
			</DialogContent>
			<DialogActions>
				<Button onClick={onCancel} disabled={applying}>Cancel</Button>
				<Button variant="contained" onClick={handleSave} disabled={applying}>{applying ? 'Applying...' : 'OK'}</Button>
			</DialogActions>
		</Dialog>
	);
}
