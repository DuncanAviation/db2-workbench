import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, List, ListItem, Typography } from '@mui/material';
import type { DiagramSyncResultTable } from '../../../src/webview-messages/diagram-messages';

// "Sync with Database" only ever shows this when its edit actually changed something (see
// DiagramEditorProvider.applySync) - a genuine no-op stays the plain toast it already was, since there's
// nothing to list. A batch can span every table on the diagram, so the row list is what scrolls (via
// DialogContent's own `dividers`, which caps it and scrolls internally) rather than the dialog itself
// growing to fit - the same reason the Keep/Remove confirmation (KeepRemoveDialog) doesn't just grow either.

const STATUS_LABEL: Record<DiagramSyncResultTable['status'], string> = {
	updated: 'Updated', removed: 'Removed', orphaned: 'Kept - Not Found'
};

interface Props {
	open: boolean;
	tables: DiagramSyncResultTable[];
	onClose: () => void;
}

export function SyncSummaryDialog({ open, tables, onClose }: Props) {
	return (
		<Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
			<DialogTitle>Sync with Database</DialogTitle>
			{/* dividers, not a manual maxHeight/overflow Box, is what gives the scrolling region a hard cap
			against the viewport - MUI's own convention for a DialogContent that can outgrow the dialog. */}
			<DialogContent dividers sx={{ p: 0 }}>
				<List dense disablePadding>
					{tables.map((row, index) => (
						<ListItem
							key={row.tableId}
							sx={{
								px: 2, py: 0.5, bgcolor: index % 2 === 1 ? 'action.hover' : 'transparent',
								display: 'flex', flexDirection: 'row', justifyContent: 'space-between', gap: 2
							}}
						>
							<Typography sx={{ fontSize: '0.875rem', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
								{row.schema}.{row.table}
							</Typography>
							<Box sx={{ fontSize: '0.75rem', color: 'text.secondary', flexShrink: 0 }}>{STATUS_LABEL[row.status]}</Box>
						</ListItem>
					))}
				</List>
			</DialogContent>
			<DialogActions>
				<Button variant="contained" onClick={onClose}>OK</Button>
			</DialogActions>
		</Dialog>
	);
}
