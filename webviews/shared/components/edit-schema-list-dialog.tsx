import { useEffect, useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, List, ListItem, Stack, TextField, Typography } from '@mui/material';
import type { SchemasSchemaListEntry } from '../../../src/webview-messages/schemas-messages';

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

interface Props {
	open: boolean;
	schemaList: SchemasSchemaListEntry[];
	onCancel: () => void;
	onSave: (result: { hiddenSchemas: string[]; newSchemas: string[]; deletedSchemas: string[] }) => void;
}

export function EditSchemaListDialog({ open, schemaList, onCancel, onSave }: Props) {
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
