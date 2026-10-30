import { useEffect, useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, List, ListItem, Stack, Typography } from '@mui/material';

// A generic "these no longer resolve against their source - keep or remove each one?" confirmation,
// shared rather than diagram-local (see the diagram's "Sync with Database" action, its first caller) so
// an analogous case elsewhere (the schema browser, say) has something real to reuse instead of a second
// implementation. Modeled on EditSchemaListDialog's per-row toggle-button shape rather than checkboxes,
// for the same reason that dialog uses buttons: a row's current choice needs to read as plainly as its
// label, not as a checkbox state the user has to interpret.

export interface KeepRemoveRow {
	key: string;
	label: string;
}

interface Props {
	open: boolean;
	title: string;
	description: string;
	rows: KeepRemoveRow[];
	onCancel: () => void;
	// Only the keys switched to Remove - everything else defaulted to Keep. Cancelling backs out of
	// whatever larger action this confirmation is blocking, not just the dialog itself; the caller is
	// expected to apply nothing at all when onCancel fires.
	onConfirm: (removeKeys: string[]) => void;
}

export function KeepRemoveDialog({ open, title, description, rows, onCancel, onConfirm }: Props) {
	let [removedKeys, setRemovedKeys] = useState<Set<string>>(new Set());

	// Re-seeds every row back to Keep each time the dialog opens, rather than tracking rows' identity -
	// a fresh open is always a fresh decision, and the row set itself can differ from the last time this
	// was shown.
	useEffect(() => {
		if(open) {
			setRemovedKeys(new Set());
		}
	}, [open]);

	function toggle(key: string) {
		setRemovedKeys(current => {
			let next = new Set(current);
			next.has(key) ? next.delete(key) : next.add(key);
			return next;
		});
	}

	return (
		<Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth>
			<DialogTitle>{title}</DialogTitle>
			<DialogContent>
				<DialogContentText sx={{ mb: 1 }}>{description}</DialogContentText>

				<List dense disablePadding>
					{rows.map((row, index) => {
						let removed = removedKeys.has(row.key);

						return (
							<ListItem
								key={row.key}
								disablePadding
								sx={{ px: 1, py: 0.5, bgcolor: index % 2 === 1 ? 'action.hover' : 'transparent' }}
								secondaryAction={
									<Stack direction="row" spacing={0.5}>
										<Button variant={removed ? 'text' : 'outlined'} onClick={() => toggle(row.key)}>
											Keep
										</Button>
										<Button color="error" variant={removed ? 'outlined' : 'text'} onClick={() => toggle(row.key)}>
											Remove
										</Button>
									</Stack>
								}
							>
								<Typography sx={{ pr: 18, color: removed ? 'text.disabled' : 'text.primary', textDecoration: removed ? 'line-through' : 'none' }}>
									{row.label}
								</Typography>
							</ListItem>
						);
					})}
				</List>
			</DialogContent>
			<DialogActions>
				<Button onClick={onCancel}>Cancel</Button>
				<Button variant="contained" onClick={() => onConfirm([...removedKeys])}>OK</Button>
			</DialogActions>
		</Dialog>
	);
}
