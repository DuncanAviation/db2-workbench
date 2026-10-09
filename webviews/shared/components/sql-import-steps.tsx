import { Alert, Box, Checkbox, Chip, Divider, FormControlLabel, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { SQL_IMPORT_IGNORE_TARGET, SQL_IMPORT_SECTIONS } from '../../../src/models/sql-import-config';
import type { SqlImportSectionId, SqlImportTarget } from '../../../src/models/sql-import-config';
import type { SqlImportConnectionTarget, SqlImportMappings, SqlImportRunSection } from '../../../src/webview-messages/schemas-messages';
import type { DbErrorUtils } from '../../../src/utils/db-error-utils';
import { SourceEditor } from './source-editor';
import { SqlErrorDisplay } from './sql-error-display';

// The two steps of a SQL schema import - write the statements, then map each statement's result columns
// onto internal fields. Kept out of ImportSchemaDialog itself because the same two steps are the whole
// body of the (later) edit-a-saved-import dialog, which has a different title, different buttons and no
// format radio, but must not drift from what the import dialog shows.
//
// Both steps show the same three sections one after another, and each one carries a lot of small parts
// (a statement or a dozen dropdowns, a row count, warnings, sample data). Stacked flat they read as one
// undifferentiated wall, so every section is its own outlined card with a shaded header - see
// SectionCard. Colors are theme tokens only (action.hover, divider, ...): a VS Code webview inherits
// whatever theme the user is running, so hand-picked values would only look right in some of them.

export type SqlImportStatements = Partial<Record<SqlImportSectionId, string>>;

interface SectionCardProps {
	title: string;
	/** Right-aligned in the header bar - the row count on the mapping step, required/optional on step 1. */
	badge?: ReactNode;
	children: ReactNode;
}

function SectionCard({ title, badge, children }: SectionCardProps) {
	return (
		<Paper variant="outlined">
			<Stack
				direction="row"
				spacing={1}
				sx={{ alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 1, bgcolor: 'action.hover' }}
			>
				<Typography variant="subtitle2">{title}</Typography>
				{badge}
			</Stack>

			<Divider />

			<Stack spacing={1.5} sx={{ p: 1.5 }}>{children}</Stack>
		</Paper>
	);
}

interface StatementsStepProps {
	statements: SqlImportStatements;
	onChange: (statements: SqlImportStatements) => void;
	/** Set when a run failed - rendered under the statement that caused it, not as a dialog-level error. */
	errorSection?: SqlImportSectionId;
	error?: DbErrorUtils.SerializedError;
	disabled: boolean;
}

export function SqlImportStatementsStep({ statements, onChange, errorSection, error, disabled }: StatementsStepProps) {
	return (
		<Stack spacing={2}>
			{SQL_IMPORT_SECTIONS.map(section => (
				<SectionCard
					key={section.id}
					title={section.label}
					badge={<Chip size="small" variant="outlined" label={section.required ? 'Required' : 'Optional'} />}
				>
					<SourceEditor
						aria-label={`${section.label} SQL`}
						minRows={4}
						maxRows={12}
						disabled={disabled}
						placeholder={SECTION_PLACEHOLDERS[section.id]}
						value={statements[section.id] ?? ''}
						onChange={sql => onChange({ ...statements, [section.id]: sql })}
						sx={{ '& .MuiInputBase-input': { fontSize: '0.85em' } }}
					/>

					{error && errorSection === section.id && <SqlErrorDisplay error={error} />}
				</SectionCard>
			))}
		</Stack>
	);
}

const SECTION_PLACEHOLDERS: Record<SqlImportSectionId, string> = {
	tables: 'select schema, name from my_table_catalog',
	columns: 'select schema, name, column_name from my_column_catalog',
	relationships: 'select schema1, name1, colname1, schema2, name2, colname2 from my_relationship_catalog'
};

interface SaveOptionsProps {
	save: boolean;
	onChangeSave: (save: boolean) => void;
	/** Set by the edit dialog: a saved import is already saved, so only its links are up for discussion. */
	linksOnly?: boolean;
	/** Null while the host's reply is still in flight - the list is fetched when the dialog opens. */
	connections: SqlImportConnectionTarget[] | null;
	connectionIds: string[];
	onChangeConnectionIds: (connectionIds: string[]) => void;
	disabled: boolean;
}

// Saving is what turns a one-off import into one that re-runs by itself, so it is checked by default and
// the connection list only appears when it is on - an unsaved import has nothing to link. A saved import
// linked to nothing is allowed (it simply never runs), which is why an empty selection doesn't block
// anything here.
export function SqlImportSaveOptions({ save, onChangeSave, linksOnly, connections, connectionIds, onChangeConnectionIds, disabled }: SaveOptionsProps) {
	function toggleConnection(connectionId: string, checked: boolean) {
		onChangeConnectionIds(checked ? [...connectionIds, connectionId] : connectionIds.filter(id => id !== connectionId));
	}

	return (
		<SectionCard
			title={linksOnly ? 'Connections' : 'Save'}
			badge={<Chip size="small" variant="outlined" label={save ? 'Runs on connect' : 'This session only'} />}
		>
			{!linksOnly && (
				<FormControlLabel
					control={<Checkbox size="small" checked={save} disabled={disabled} onChange={event => onChangeSave(event.target.checked)} />}
					label="Save this import and re-run it whenever a linked connection opens"
				/>
			)}

			{save && (
				<Stack spacing={0.5}>
					<Typography variant="caption" sx={{ color: 'text.secondary' }}>Run against these connections</Typography>

					{connections === null && <Typography variant="body2">Loading connections...</Typography>}

					{connections?.map(connection => (
						<FormControlLabel
							key={connection.id}
							control={(
								<Checkbox
									size="small"
									disabled={disabled}
									checked={connectionIds.includes(connection.id)}
									onChange={event => toggleConnection(connection.id, event.target.checked)}
								/>
							)}
							label={connection.name}
						/>
					))}
				</Stack>
			)}
		</SectionCard>
	);
}

interface MappingStepProps {
	sections: SqlImportRunSection[];
	mappings: SqlImportMappings;
	onChange: (mappings: SqlImportMappings) => void;
	disabled: boolean;
}

export function SqlImportMappingStep({ sections, mappings, onChange, disabled }: MappingStepProps) {
	function setTarget(section: SqlImportSectionId, resultColumn: string, value: string) {
		let sectionMapping = { ...(mappings[section] ?? {}) };

		if (value === SQL_IMPORT_IGNORE_TARGET) {
			delete sectionMapping[resultColumn];
		} else {
			sectionMapping[resultColumn] = value as SqlImportTarget;
		}

		onChange({ ...mappings, [section]: sectionMapping });
	}

	return (
		<Stack spacing={2}>
			{sections.map(section => {
				let definition = SQL_IMPORT_SECTIONS.find(candidate => candidate.id === section.section);

				if (!definition) {
					return null;
				}

				let sectionMapping = mappings[section.section] ?? {};
				// Every target stays selectable even when another column already has it. Hiding a taken target
				// makes swapping two columns a three-step dance (clear one, set the other, come back) - the
				// duplicate is caught on Import instead, which costs nothing until it actually happens.
				let duplicateTargets = findDuplicateTargets(sectionMapping);

				return (
					<SectionCard
						key={section.section}
						title={definition.label}
						badge={<Chip size="small" variant="outlined" label={`${section.rowCount.toLocaleString()} row${section.rowCount === 1 ? '' : 's'}`} />}
					>
						{section.truncated && (
							<Alert severity="warning">
								This statement returned more rows than the limit allows, so only the first {section.rowCount.toLocaleString()} were
								kept. Narrow the statement, or raise db2-workbench.sqlImportRowLimit.
							</Alert>
						)}

						{/* A two-column grid rather than a stack of rows: the dropdowns line up regardless of how
						long a result column's name is, which is what makes a dozen of them scannable. */}
						<Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(8em, max-content) minmax(16em, 1fr)', columnGap: 2, rowGap: 1, alignItems: 'center' }}>
							{section.resultColumns.map(resultColumn => (
								<Box key={resultColumn} sx={{ display: 'contents' }}>
									<Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{resultColumn}</Typography>

									<TextField
										select
										size="small"
										fullWidth
										disabled={disabled}
										error={!!sectionMapping[resultColumn] && duplicateTargets.has(sectionMapping[resultColumn])}
										value={sectionMapping[resultColumn] ?? SQL_IMPORT_IGNORE_TARGET}
										onChange={event => setTarget(section.section, resultColumn, event.target.value)}
									>
										<MenuItem value={SQL_IMPORT_IGNORE_TARGET}>{SQL_IMPORT_IGNORE_TARGET}</MenuItem>
										{definition.targets.map(target => (
											<MenuItem key={target.id} value={target.id}>
												{target.label}{target.required ? ' *' : ''}
											</MenuItem>
										))}
									</TextField>
								</Box>
							))}
						</Box>

						<SampleRows section={section} />
					</SectionCard>
				);
			})}
		</Stack>
	);
}

// A handful of real rows, so a reversed child/parent mapping (the easiest mistake to make here, and the
// one nothing else would catch) is visible before the import runs rather than after. Labelled "Sample
// Data" rather than left bare: these are the first few rows, never the whole result, and a table sitting
// under a row count would otherwise read as if it were showing all of them.
function SampleRows({ section }: { section: SqlImportRunSection }) {
	if (section.sampleRows.length === 0) {
		return null;
	}

	return (
		<Stack spacing={0.5}>
			<Divider textAlign="left">
				<Typography variant="caption" sx={{ color: 'text.secondary' }}>
					Sample Data — first {section.sampleRows.length} of {section.rowCount.toLocaleString()} rows
				</Typography>
			</Divider>

			<Box sx={{ overflowX: 'auto' }}>
				<Table size="small">
					<TableHead>
						<TableRow>
							{section.resultColumns.map(column => (
								<TableCell key={column} sx={{ whiteSpace: 'nowrap', fontFamily: 'monospace' }}>{column}</TableCell>
							))}
						</TableRow>
					</TableHead>
					<TableBody>
						{section.sampleRows.map((row, index) => (
							// Zebra striping, matching every other data table in the extension - see the data-table
							// conventions in CLAUDE.md.
							<TableRow key={index} sx={{ '&:nth-of-type(odd)': { bgcolor: 'action.hover' } }}>
								{section.resultColumns.map(column => (
									<TableCell key={column} sx={{ whiteSpace: 'nowrap' }}>{row[column]}</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</Box>
		</Stack>
	);
}

/** The targets this section's mapping uses more than once - each one's dropdowns are flagged in red. */
function findDuplicateTargets(sectionMapping: Record<string, SqlImportTarget>): Set<SqlImportTarget> {
	let seen = new Set<SqlImportTarget>();
	let duplicates = new Set<SqlImportTarget>();

	for (let target of Object.values(sectionMapping)) {
		if (seen.has(target)) {
			duplicates.add(target);
		}

		seen.add(target);
	}

	return duplicates;
}

// A target may only be used once per section, and the dropdowns deliberately don't enforce that (see
// the mapping step) - so it's checked here, on the way to Import, and named the same user-facing way as
// a missing required field.
export function findDuplicateMappedTargets(sections: SqlImportRunSection[], mappings: SqlImportMappings): string[] {
	let duplicates: string[] = [];

	for (let section of sections) {
		let definition = SQL_IMPORT_SECTIONS.find(candidate => candidate.id === section.section);

		for (let target of findDuplicateTargets(mappings[section.section] ?? {})) {
			let label = definition?.targets.find(candidate => candidate.id === target)?.label ?? target;
			duplicates.push(`${definition?.label}: ${label}`);
		}
	}

	return duplicates;
}

// Named for the user rather than by target id ("Tables: Schema"), since that's how the mapping step
// labels them - the Import button stays enabled and says what's missing instead of going quietly dead.
export function findUnmappedRequiredTargets(sections: SqlImportRunSection[], mappings: SqlImportMappings): string[] {
	let missing: string[] = [];

	for (let section of sections) {
		let definition = SQL_IMPORT_SECTIONS.find(candidate => candidate.id === section.section);
		let mapped = new Set(Object.values(mappings[section.section] ?? {}));

		for (let target of definition?.targets ?? []) {
			if (target.required && !mapped.has(target.id)) {
				missing.push(`${definition?.label}: ${target.label}`);
			}
		}
	}

	return missing;
}
