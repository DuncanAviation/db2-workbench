import { Alert, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, List, ListItem, ListItemText, Paper, Stack, Typography } from '@mui/material';
import { SQL_IMPORT_SECTIONS } from '../../../src/models/sql-import-config';
import type { SqlImportSectionSummary } from '../../../src/schema-conversion/sql-import-converter';
import type { SchemaImportReport } from '../../../src/webview-messages/schemas-messages';
import { getFormatLabel } from '../utils/import-labels';

// What an import actually did, shown after every import rather than just the ones with something to
// complain about. A SQL import's rows come from tables this extension doesn't control, so skipped and
// deduped rows are expected and have to be visible - and a DBML or Frictionless import, which used to
// land as a toast, says the same things in the same place now.
//
// Laid out the same way as the import dialog's mapping step: a headline for the import as a whole, then
// one outlined card per section, so three sections' counts and warnings don't run together. Theme tokens
// only for color - see the note in sql-import-steps.tsx.

interface Props {
	report?: SchemaImportReport;
	onClose: () => void;
}

export function ImportSummaryDialog({ report, onClose }: Props) {
	if (!report) {
		return null;
	}

	return (
		<Dialog open onClose={onClose} maxWidth="sm" fullWidth>
			<DialogTitle>Import Complete</DialogTitle>

			<DialogContent>
				<Stack spacing={2} sx={{ pt: 1 }}>
					<Paper variant="outlined">
						<Stack
							direction="row"
							spacing={1}
							sx={{ alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 1, bgcolor: 'action.hover' }}
						>
							<Typography variant="subtitle2">{report.sourceLabel}</Typography>
							<Chip size="small" variant="outlined" label={getFormatLabel(report.sourceFormat)} />
						</Stack>

						<Divider />

						<Stack spacing={1} sx={{ p: 1.5 }}>
							<Typography variant="body2">
								{count(report.tableCount, 'table')} imported
								{report.columnCount > 0 ? `, ${count(report.columnCount, 'column')}` : ''}
								{report.foreignKeyCount > 0 ? `, ${count(report.foreignKeyCount, 'relationship')}` : ''}.
							</Typography>

							{report.noSchemaCount > 0 && (
								<Alert severity="info">
									{count(report.noSchemaCount, 'table')} specified no schema and {report.noSchemaCount === 1 ? 'was' : 'were'} grouped
									under "{report.noSchemaBucket}".
								</Alert>
							)}
						</Stack>
					</Paper>

					{report.sections?.map(section => <SectionSummary key={section.section} section={section} />)}
				</Stack>
			</DialogContent>

			<DialogActions>
				<Button variant="contained" onClick={onClose}>OK</Button>
			</DialogActions>
		</Dialog>
	);
}

function SectionSummary({ section }: { section: SqlImportSectionSummary }) {
	let label = SQL_IMPORT_SECTIONS.find(candidate => candidate.id === section.section)?.label ?? section.section;

	return (
		<Paper variant="outlined">
			<Stack
				direction="row"
				spacing={1}
				sx={{ alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 1, bgcolor: 'action.hover' }}
			>
				<Typography variant="subtitle2">{label}</Typography>
				<Chip size="small" variant="outlined" label={`${count(section.rowCount, 'row')} read`} />
			</Stack>

			<Divider />

			<Stack spacing={0.5} sx={{ p: 1.5 }}>
				<Typography variant="body2">
					{section.applied
						? `${section.importedCount.toLocaleString()} used.`
						: 'Loaded per table as you open one.'}
				</Typography>

				{section.issues.length > 0 && (
					<List dense disablePadding>
						{section.issues.map(issue => (
							<ListItem key={`${issue.kind}|${issue.detail}`} disablePadding>
								<ListItemText primary={
									<Typography variant="body2" sx={{ color: 'warning.main' }}>
										{issue.count.toLocaleString()} × {issue.detail}
									</Typography>
								} />
							</ListItem>
						))}
					</List>
				)}
			</Stack>
		</Paper>
	);
}

function count(value: number, noun: string): string {
	return `${value.toLocaleString()} ${noun}${value === 1 ? '' : 's'}`;
}
