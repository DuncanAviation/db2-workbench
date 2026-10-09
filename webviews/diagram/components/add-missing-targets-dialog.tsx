import { useEffect, useState } from 'react';
import { Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, List, ListItem, Typography } from '@mui/material';
import type { MissingRelationshipTarget, MissingTargetTable } from '../../../src/webview-messages/diagram-messages';

// The choice behind a column's "add the other end" marker when that column's foreign keys point at more
// than one table that isn't on the diagram (see findMissingTargets). A single target never opens this at
// all - app.tsx adds it straight away, since a dialog with one checkbox only asks the user to confirm
// what they already clicked.
//
// Everything listed is by definition absent from the diagram: the host recomputes and re-pushes the
// missing targets on every model change, so a table added since this dialog opened drops out of the list
// the marker was built from.

interface Props {
	// The clicked column's marker, or null when nothing is being chosen - doubles as the dialog's own
	// open state so the list and its selection can never be out of step with each other.
	target: MissingRelationshipTarget | null;
	onCancel: () => void;
	onAdd: (tables: MissingTargetTable[]) => void;
}

function targetKey(target: MissingTargetTable): string {
	return `${target.targetSchema}.${target.targetTable}`;
}

export function AddMissingTargetsDialog({ target, onCancel, onAdd }: Props) {
	let [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

	// Cleared per marker rather than per close so reopening the SAME marker after a cancel doesn't come
	// back pre-ticked with a selection the user just abandoned.
	useEffect(() => {
		setSelected(new Set());
	}, [target]);

	function toggle(key: string) {
		setSelected(current => {
			let next = new Set(current);

			if(!next.delete(key)) {
				next.add(key);
			}

			return next;
		});
	}

	function handleAdd() {
		onAdd((target?.targets ?? []).filter(row => selected.has(targetKey(row))));
	}

	return (
		<Dialog open={target !== null} onClose={onCancel} maxWidth="xs" fullWidth>
			<DialogTitle>Add Referenced Tables</DialogTitle>

			{/* dividers for the same reason SyncSummaryDialog uses it - the list is what scrolls when a
			column points at more tables than fit, not the dialog growing past the viewport. */}
			<DialogContent dividers sx={{ p: 0 }}>
				<List dense disablePadding sx={{ pt: 0.5 }}>
					{(target?.targets ?? []).map((row, index) => (
						<ListItem key={targetKey(row)} sx={{ px: 2, py: 0, bgcolor: index % 2 === 1 ? 'action.hover' : 'transparent' }}>
							<FormControlLabel
								control={<Checkbox size="small" checked={selected.has(targetKey(row))} onChange={() => toggle(targetKey(row))} />}
								label={<Typography sx={{ fontSize: '0.875rem' }}>{row.targetSchema}.{row.targetTable}</Typography>}
							/>
						</ListItem>
					))}
				</List>
			</DialogContent>

			<DialogActions>
				<Button onClick={onCancel}>Cancel</Button>
				<Button variant="contained" onClick={handleAdd} disabled={selected.size === 0}>Add</Button>
			</DialogActions>
		</Dialog>
	);
}
