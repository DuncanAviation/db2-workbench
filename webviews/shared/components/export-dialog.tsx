import { useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Radio, RadioGroup, Stack, Typography } from '@mui/material';
import type { ExportDestination, ExportFormat, ExportWhat } from '../../../src/utils/export-utils';

interface Props {
	open: boolean;
	onClose: () => void;
	loadedRowCount: number;
	filteredRowCount: number;
	selectedRowCount: number;
	canExportFiltered: boolean;
	// Selected rows is only offered while 1+ rows are actually selected.
	canExportSelected: boolean;
	canExportAll: boolean;
	onExport: (what: ExportWhat, format: ExportFormat, destination: ExportDestination) => void;
}

export function ExportDialog({ open, onClose, loadedRowCount, filteredRowCount, selectedRowCount, canExportFiltered, canExportSelected, canExportAll, onExport }: Props) {
	const [what, setWhat] = useState<ExportWhat>('loaded');
	const [format, setFormat] = useState<ExportFormat>('csv');

	// Guards against a stale selection if the filter was cleared, the row selection was cleared, or
	// fetching finished, while the dialog was open with 'filtered'/'selected'/'all' already selected.
	const effectiveWhat: ExportWhat = (what === 'filtered' && !canExportFiltered) || (what === 'selected' && !canExportSelected) || (what === 'all' && !canExportAll) ? 'loaded' : what;

	function handleExport(destination: ExportDestination) {
		onExport(effectiveWhat, format, destination);
		onClose();
	}

	return (
		<Dialog open={open} onClose={onClose}>
			<DialogTitle>Export Data</DialogTitle>

			<DialogContent>
				<Stack spacing={2} sx={{ pt: 1 }}>
					<Stack>
						<Typography variant="subtitle2">What to export</Typography>
						<RadioGroup value={effectiveWhat} onChange={event => setWhat(event.target.value as ExportWhat)}>
							<FormControlLabel value="loaded" control={<Radio />} label={`Loaded results (${loadedRowCount} rows)`} />
							{canExportFiltered && <FormControlLabel value="filtered" control={<Radio />} label={`Filtered results (${filteredRowCount} rows)`} />}
							{canExportSelected && <FormControlLabel value="selected" control={<Radio />} label={`Selected rows (${selectedRowCount} rows)`} />}
							{canExportAll && <FormControlLabel value="all" control={<Radio />} label="All results (fetches remaining rows first)" />}
						</RadioGroup>
					</Stack>

					<Stack>
						<Typography variant="subtitle2">Format</Typography>
						<RadioGroup row value={format} onChange={event => setFormat(event.target.value as ExportFormat)}>
							<FormControlLabel value="csv" control={<Radio />} label="CSV" />
							<FormControlLabel value="json" control={<Radio />} label="JSON" />
						</RadioGroup>
					</Stack>
				</Stack>
			</DialogContent>

			<DialogActions>
				<Button onClick={onClose}>Cancel</Button>
				<Button onClick={() => handleExport('clipboard')}>Clipboard</Button>
				<Button variant="contained" onClick={() => handleExport('file')}>Save</Button>
			</DialogActions>
		</Dialog>
	);
}
