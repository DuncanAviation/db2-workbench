import { useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Radio, RadioGroup, Stack, Typography } from '@mui/material';
import type { DiagramExportFormat } from '../../../src/webview-messages/diagram-messages';
import type { ExportDestination } from '../../../src/utils/export-utils';

// drawio first: it's the lossless, purpose-built option (see DiagramExportFormat's own comment) -
// dbml/frictionless are both best-effort. Both callers (the diagram's own Export and the schema
// browser's) offer this exact same set, so it lives here instead of being duplicated in each app.tsx.
const FORMAT_OPTIONS: Array<{ id: DiagramExportFormat; label: string }> = [
	{ id: 'drawio', label: 'draw.io (.drawio)' },
	{ id: 'dbml', label: 'DBML' },
	{ id: 'frictionless', label: 'Frictionless Table Schema' }
];

interface Props {
	open: boolean;
	title: string;
	initialFormat: DiagramExportFormat;
	// Presence of this prop is what turns the Scope section on - pass it to offer "All Tables" / "Filtered
	// Tables Only", or omit it to hide Scope entirely (e.g. exporting a fixed table selection, or a caller
	// with no notion of a canvas filter). Scope always reports back to onExport as 'all' when omitted.
	hasFilter?: boolean;
	onCancel: () => void;
	onExport: (format: DiagramExportFormat, scope: 'all' | 'filtered', destination: ExportDestination) => void;
}

// Shared by the diagram's own "Export..." and the schema browser's - both were the same Format radio
// group plus Clipboard/Save actions (no reply message; the host resolves entirely via a native Save
// dialog and an info/error toast), differing only in the default format and whether a Scope choice
// applies.
export function ExportTablesDialog({ open, title, initialFormat, hasFilter, onCancel, onExport }: Props) {
	const [format, setFormat] = useState<DiagramExportFormat>(initialFormat);
	const [scope, setScope] = useState<'all' | 'filtered'>('all');

	const showScope = hasFilter !== undefined;
	const effectiveScope = showScope && hasFilter ? scope : 'all';

	function handleExport(destination: ExportDestination) {
		onExport(format, effectiveScope, destination);
	}

	return (
		<Dialog open={open} onClose={onCancel}>
			<DialogTitle>{title}</DialogTitle>

			<DialogContent>
				<Stack spacing={1} sx={{ pt: 1 }}>
					<Typography variant="subtitle2">Format</Typography>
					<RadioGroup value={format} onChange={event => setFormat(event.target.value as DiagramExportFormat)}>
						{FORMAT_OPTIONS.map(option => (
							<FormControlLabel key={option.id} value={option.id} control={<Radio size="small" />} label={option.label} />
						))}
					</RadioGroup>

					{showScope && (
						<>
							<Typography variant="subtitle2" sx={{ pt: 1 }}>Scope</Typography>
							<RadioGroup value={effectiveScope} onChange={event => setScope(event.target.value as 'all' | 'filtered')}>
								<FormControlLabel value="all" control={<Radio size="small" />} label="All Tables" />
								<FormControlLabel value="filtered" control={<Radio size="small" disabled={!hasFilter} />} label="Filtered Tables Only" disabled={!hasFilter} />
							</RadioGroup>
						</>
					)}
				</Stack>
			</DialogContent>

			<DialogActions>
				<Button onClick={onCancel}>Cancel</Button>
				<Button onClick={() => handleExport('clipboard')}>Clipboard</Button>
				<Button variant="contained" onClick={() => handleExport('file')}>Save</Button>
			</DialogActions>
		</Dialog>
	);
}
