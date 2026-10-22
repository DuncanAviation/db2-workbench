import { useEffect, useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Radio, RadioGroup, Stack, TextField, Typography } from '@mui/material';
import type { SchemaFormatId } from '../../../src/schema-conversion/schema-format-converter';
import { autoMapSqlImportColumns } from '../../../src/schema-conversion/sql-import-mapping';
import { SQL_IMPORT_SECTIONS } from '../../../src/models/sql-import-config';
import type { SqlImportSectionId } from '../../../src/models/sql-import-config';
import type { SqlImportConnectionTarget, SqlImportMappings, SqlImportRunResult, SqlImportStatementInput } from '../../../src/webview-messages/schemas-messages';
import type { DbErrorUtils } from '../../../src/utils/db-error-utils';
import { SourceEditor } from './source-editor';
import { SqlErrorDisplay } from './sql-error-display';
import { findDuplicateMappedTargets, findUnmappedRequiredTargets, SqlImportMappingStep, SqlImportSaveOptions, SqlImportStatementsStep, SqlImportStatements } from './sql-import-steps';

// 'sql' is not a SchemaFormatId - there's no text to parse and it can never be an export target (see
// ImportSourceFormat) - so the radio's own value type is wider than the format passed to a text import.
type ImportSource = SchemaFormatId | 'sql';

const FORMAT_OPTIONS: Array<{ id: ImportSource; label: string }> = [
	{ id: 'dbml', label: 'DBML' },
	{ id: 'frictionless', label: 'Frictionless Table Schema' },
	{ id: 'sql', label: 'SQL' }
];

interface Props {
	open: boolean;
	onCancel: () => void;
	/** "Import File..." - the host owns the native file picker, so this just tells it to open one;
	 * the dialog closes optimistically the same way other outbound-message-triggered actions in this
	 * webview do (see app.tsx). Independent of whatever's in the text area. */
	onImportFile: () => void;
	/** "Import" - uses whatever's pasted into the text area. Format is explicit since there's no
	 * filename to sniff it from. */
	onImportText: (format: SchemaFormatId, content: string) => void;
	/** "Next" in SQL mode - runs every filled statement on the connection this panel is pointed at. */
	onRunSqlImport: (statements: SqlImportStatementInput[]) => void;
	/** "Import" in SQL mode - applies the run's rows through the mapping built in step 2. */
	onImportSql: (request: {runId: string; name: string; mappings: SqlImportMappings; save: boolean; connectionIds: string[]}) => void;
	/** Asks the host for the connection checkbox list - sent when the dialog opens in SQL mode rather than
	 * carried in initial state, so a connection added since the panel opened is still offered. */
	onLoadConnections: () => void;
	/** Null until the host answers onLoadConnections. */
	connections: SqlImportConnectionTarget[] | null;
	/** Closing or stepping back makes the host's held rows garbage - let it drop them. */
	onDiscardSqlRun: (runId: string) => void;
	/** "Back" - clears the run result this dialog is driven by, returning it to the statements step. The
	 * result is the parent's state (it arrives as a message), so only the parent can drop it. */
	onResetSqlRun: () => void;
	/** Pushed back by the host in reply to onRunSqlImport. */
	sqlRunResult?: SqlImportRunResult;
	/** A failed import (as opposed to a failed run) - shown on the mapping step, which stays open. */
	sqlImportError?: DbErrorUtils.SerializedError;
	/** True while a run or an import is in flight, so the dialog can't be double-submitted. */
	busy: boolean;
}

export function ImportSchemaDialog({ open, onCancel, onImportFile, onImportText, onRunSqlImport, onImportSql, onLoadConnections, connections, onDiscardSqlRun, onResetSqlRun, sqlRunResult, sqlImportError, busy }: Props) {
	const [format, setFormat] = useState<ImportSource>('dbml');
	const [pastedText, setPastedText] = useState('');
	const [name, setName] = useState('');
	const [statements, setStatements] = useState<SqlImportStatements>({});
	const [mappings, setMappings] = useState<SqlImportMappings>({});
	const [save, setSave] = useState(true);
	const [connectionIds, setConnectionIds] = useState<string[]>([]);

	// Re-seeds the dialog's own draft every time it's opened - same convention as
	// EditSchemaListDialog - so a previous session's pasted text isn't still sitting there next time.
	useEffect(() => {
		if (open) {
			setPastedText('');
			setStatements({});
			setMappings({});
			setName(buildDefaultImportName());
			setSave(true);
			setConnectionIds([]);
			onLoadConnections();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// The connection this panel is pointed at is checked the moment the list arrives, and only then - every
	// change after that is the user's. A diagram opened without a connection flags none, so nothing is
	// pre-checked and the user picks.
	useEffect(() => {
		if (connections) {
			setConnectionIds(connections.filter(connection => connection.current).map(connection => connection.id));
		}
	}, [connections]);

	// The mapping step's opening guess, re-made whenever a run comes back and never in between: every
	// edit after that is the user's, and a re-render must not overwrite it. sqlRunResult is a piece of
	// the parent's state, so it only changes identity when a new reply actually arrives.
	useEffect(() => {
		if (sqlRunResult?.kind === 'ran') {
			let guessed: SqlImportMappings = {};

			for (let section of sqlRunResult.sections) {
				guessed[section.section] = autoMapSqlImportColumns(section.section, section.resultColumns);
			}

			setMappings(guessed);
		}
	}, [sqlRunResult]);

	let ranSections = sqlRunResult?.kind === 'ran' ? sqlRunResult.sections : undefined;
	let runError = sqlRunResult?.kind === 'error' ? sqlRunResult : undefined;
	let missingTargets = ranSections ? findUnmappedRequiredTargets(ranSections, mappings) : [];
	let duplicateTargets = ranSections ? findDuplicateMappedTargets(ranSections, mappings) : [];

	function handleImportText() {
		if (!pastedText.trim() || format === 'sql') {
			return;
		}

		onImportText(format, pastedText);
	}

	function handleNext() {
		let filled: SqlImportStatementInput[] = SQL_IMPORT_SECTIONS
			.map(section => ({ section: section.id as SqlImportSectionId, sql: statements[section.id]?.trim() ?? '' }))
			.filter(statement => statement.sql.length > 0);

		onRunSqlImport(filled);
	}

	// Back returns to the (still-populated) statements and drops the rows the host is holding - they
	// belong to a statement the user is about to edit, and Next runs everything again anyway. The mapping
	// is re-guessed from the next run's result, so an edit made on the mapping step doesn't survive a
	// trip back.
	function handleBack() {
		if (sqlRunResult?.kind === 'ran') {
			onDiscardSqlRun(sqlRunResult.runId);
		}

		onResetSqlRun();
	}

	function handleCancel() {
		if (sqlRunResult?.kind === 'ran') {
			onDiscardSqlRun(sqlRunResult.runId);
		}

		onCancel();
	}

	function handleImportSql() {
		if (sqlRunResult?.kind !== 'ran' || missingTargets.length > 0 || duplicateTargets.length > 0) {
			return;
		}

		onImportSql({
			runId: sqlRunResult.runId,
			name: name.trim() || buildDefaultImportName(),
			mappings: mappings,
			save: save,
			connectionIds: save ? connectionIds : []
		});
	}

	let hasTablesStatement = (statements.tables ?? '').trim().length > 0;

	return (
		<Dialog open={open} onClose={handleCancel} maxWidth={format === 'sql' ? 'md' : 'sm'} fullWidth>
			<DialogTitle>Import Schema</DialogTitle>

			<DialogContent>
				<Stack spacing={2} sx={{ pt: 1 }}>
					{!ranSections && (
						<Stack spacing={1}>
							<Typography variant="subtitle2">Format</Typography>
							<RadioGroup row value={format} onChange={event => setFormat(event.target.value as ImportSource)}>
								{FORMAT_OPTIONS.map(option => (
									<FormControlLabel key={option.id} value={option.id} control={<Radio size="small" />} label={option.label} />
								))}
							</RadioGroup>
						</Stack>
					)}

					{format !== 'sql' && (
						<SourceEditor
							aria-label="Pasted schema"
							minRows={12}
							maxRows={20}
							placeholder="Paste DBML or Frictionless Table Schema content here..."
							value={pastedText}
							onChange={setPastedText}
							sx={{ '& .MuiInputBase-input': { fontSize: '0.85em' } }}
						/>
					)}

					{format === 'sql' && !ranSections && (
						<>
							<TextField
								label="Name"
								size="small"
								fullWidth
								value={name}
								onChange={event => setName(event.target.value)}
								helperText="How this import is named in the View Imports list."
							/>

							<SqlImportStatementsStep
								statements={statements}
								onChange={setStatements}
								errorSection={runError?.section}
								error={runError?.error}
								disabled={busy}
							/>

							<SqlImportSaveOptions
								save={save}
								onChangeSave={setSave}
								connections={connections}
								connectionIds={connectionIds}
								onChangeConnectionIds={setConnectionIds}
								disabled={busy}
							/>
						</>
					)}

					{format === 'sql' && ranSections && (
						<>
							<SqlImportMappingStep sections={ranSections} mappings={mappings} onChange={setMappings} disabled={busy} />

							{missingTargets.length > 0 && (
								<Alert severity="info">Map every required field before importing: {missingTargets.join(', ')}.</Alert>
							)}

							{duplicateTargets.length > 0 && (
								<Alert severity="warning">Each field can only be mapped once: {duplicateTargets.join(', ')}.</Alert>
							)}

							{sqlImportError && <SqlErrorDisplay error={sqlImportError} />}
						</>
					)}
				</Stack>
			</DialogContent>

			<DialogActions>
				<Button onClick={handleCancel}>Cancel</Button>

				{format !== 'sql' && <Button onClick={onImportFile}>Import File...</Button>}
				{format !== 'sql' && <Button variant="contained" disabled={!pastedText.trim()} onClick={handleImportText}>Import</Button>}

				{format === 'sql' && ranSections && <Button disabled={busy} onClick={handleBack}>Back</Button>}
				{format === 'sql' && !ranSections && (
					<Button variant="contained" disabled={busy || !hasTablesStatement} onClick={handleNext}>Next</Button>
				)}
				{format === 'sql' && ranSections && (
					<Button variant="contained" disabled={busy || missingTargets.length > 0 || duplicateTargets.length > 0} onClick={handleImportSql}>Import</Button>
				)}
			</DialogActions>
		</Dialog>
	);
}

// Matches the plan's default of "SQL import <date>" - a name the user can replace, not a generated id.
function buildDefaultImportName(): string {
	return `SQL import ${new Date().toLocaleDateString()}`;
}
