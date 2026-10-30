import { useEffect, useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField } from '@mui/material';
import { SQL_IMPORT_SECTIONS } from '../../../src/models/sql-import-config';
import type { SqlImportConfig, SqlImportSectionId } from '../../../src/models/sql-import-config';
import { autoMapSqlImportColumns } from '../../../src/schema-conversion/sql-import-mapping';
import type {
	SqlImportConnectionTarget,
	SqlImportMappings,
	SqlImportRunResult,
	SqlImportRunSection,
	SqlImportStatementInput
} from '../../../src/webview-messages/schemas-messages';
import type { DbErrorUtils } from '../../../src/utils/db-error-utils';
import { Loading } from './loading';
import {
	findDuplicateMappedTargets,
	findUnmappedRequiredTargets,
	SqlImportMappingStep,
	SqlImportSaveOptions,
	SqlImportStatementsStep,
	SqlImportStatements
} from './sql-import-steps';

// Editing a saved SQL import (db2-workbench.sqlImports), over the same two-step body the import dialog
// uses - statements first, mapping second - so the two can't drift into showing the same thing two ways.
// What differs is what the buttons mean:
//
//   Save            - writes the statements, mapping and links. The Tables statement runs on the next
//                     connection, not now.
//   Next            - re-runs the statements so the mapping can be rebuilt against what they return today.
//   Save & Re-run   - only on the mapping step, since it is the step that has fresh columns behind it.
//
// Deleting lives on the View Imports list instead, next to that import's Edit button - it is a per-import
// action on a list of imports, not something this editor's half-typed state should be mixed up with.
//
// Saving replaces the data already loaded for this import: its per-table caches are dropped, so every
// table re-reads what the (possibly new) statements say. Said out loud in the dialog rather than left to
// be discovered.

interface Props {
	open: boolean;
	/** Null while the host's reply to onLoad is in flight; undefined config means the entry is gone. */
	config: SqlImportConfig | null | undefined;
	connections: SqlImportConnectionTarget[] | null;
	/** Which connections currently link this import - the checkbox list's starting state. */
	linkedConnectionIds: string[];
	onCancel: () => void;
	onSave: (request: {
		importId: string;
		name: string;
		statements: SqlImportStatementInput[];
		mappings: SqlImportMappings;
		resultColumns: Partial<Record<SqlImportSectionId, string[]>>;
		connectionIds: string[];
		rerun: boolean;
	}) => void;
	/** "Next" - runs the (possibly edited) statements, exactly as the import dialog's does. */
	onRunSqlImport: (statements: SqlImportStatementInput[]) => void;
	onDiscardSqlRun: (runId: string) => void;
	onResetSqlRun: () => void;
	sqlRunResult?: SqlImportRunResult;
	/** A rejected save - shown inline; the dialog stays open. */
	saveError?: string;
	busy: boolean;
}

// Which connections a saved import is currently linked to - the checkbox list's starting state. Derived
// from the connection list rather than passed separately so it can't disagree with the boxes it drives.
export function linkedConnectionIdsFor(connections: SqlImportConnectionTarget[] | null, config: SqlImportConfig | null | undefined): string[] {
	if (!connections || !config) {
		return [];
	}

	return connections.filter(connection => connection.sqlImportIds.includes(config.id)).map(connection => connection.id);
}

export function EditSqlImportDialog({
	open,
	config,
	connections,
	linkedConnectionIds,
	onCancel,
	onSave,
	onRunSqlImport,
	onDiscardSqlRun,
	onResetSqlRun,
	sqlRunResult,
	saveError,
	busy
}: Props) {
	const [name, setName] = useState('');
	const [statements, setStatements] = useState<SqlImportStatements>({});
	const [mappings, setMappings] = useState<SqlImportMappings>({});
	const [connectionIds, setConnectionIds] = useState<string[]>([]);

	// Seeded from the saved entry the moment it arrives, and only then - every edit after that is the
	// user's, and a re-render must not overwrite it.
	useEffect(() => {
		if (config) {
			setName(config.name);
			setStatements({
				tables: config.tables.sql,
				columns: config.columns?.sql ?? '',
				relationships: config.relationships?.sql ?? ''
			});
			setMappings({
				tables: config.tables.mapping,
				columns: config.columns?.mapping,
				relationships: config.relationships?.mapping
			});
		}
	}, [config]);

	useEffect(() => {
		setConnectionIds(linkedConnectionIds);
	}, [linkedConnectionIds]);

	// A re-run's result columns replace the recorded ones, so the mapping step maps what the statements
	// return TODAY. A column that still exists keeps its saved target; anything new is guessed at, the same
	// way a first import is.
	useEffect(() => {
		if (sqlRunResult?.kind === 'ran') {
			setMappings(current => {
				let remapped: SqlImportMappings = {};

				for (let section of sqlRunResult.sections) {
					let saved = current[section.section] ?? {};
					let guessed = autoMapSqlImportColumns(section.section, section.resultColumns.filter(column => !saved[column]));
					let kept = Object.fromEntries(Object.entries(saved).filter(([column]) => section.resultColumns.includes(column)));

					remapped[section.section] = { ...guessed, ...kept };
				}

				return remapped;
			});
		}
	}, [sqlRunResult]);

	let ranSections = sqlRunResult?.kind === 'ran' ? sqlRunResult.sections : undefined;
	let runError = sqlRunResult?.kind === 'error' ? sqlRunResult : undefined;
	let missingTargets = ranSections ? findUnmappedRequiredTargets(ranSections, mappings) : [];
	let duplicateTargets = ranSections ? findDuplicateMappedTargets(ranSections, mappings) : [];
	let hasTablesStatement = (statements.tables ?? '').trim().length > 0;

	function filledStatements(): SqlImportStatementInput[] {
		return SQL_IMPORT_SECTIONS
			.map(section => ({ section: section.id as SqlImportSectionId, sql: statements[section.id]?.trim() ?? '' }))
			.filter(statement => statement.sql.length > 0);
	}

	// The columns the mapping was built against: the fresh ones when the statements have just been
	// re-run, the recorded ones otherwise. Saving without re-running must not throw away what the entry
	// already knew, or the next run would have nothing to report drift against.
	function currentResultColumns(): Partial<Record<SqlImportSectionId, string[]>> {
		if (ranSections) {
			return Object.fromEntries(ranSections.map(section => [section.section, section.resultColumns]));
		}

		return {
			tables: config?.tables.resultColumns ?? [],
			columns: config?.columns?.resultColumns ?? [],
			relationships: config?.relationships?.resultColumns ?? []
		};
	}

	function handleSave(rerun: boolean) {
		if (!config || !hasTablesStatement) {
			return;
		}

		onSave({
			importId: config.id,
			name: name.trim() || config.name,
			statements: filledStatements(),
			mappings: mappings,
			resultColumns: currentResultColumns(),
			connectionIds: connectionIds,
			rerun: rerun
		});
	}

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

	return (
		<Dialog open={open} onClose={handleCancel} maxWidth="md" fullWidth>
			<DialogTitle>{config ? `Edit Import - ${config.name}` : 'Edit Import'}</DialogTitle>

			<DialogContent>
				{config === null && <Loading message="Loading import..." />}

				{config === undefined && open && (
					<Alert severity="warning">This import no longer exists - it may have been deleted from your settings.</Alert>
				)}

				{config && (
					<Stack spacing={2} sx={{ pt: 1 }}>
						<Alert severity="info">
							Saving replaces the data this import has already loaded. Its tables reload now or on the next
							connection; columns and relationships reload as each table is opened.
						</Alert>

						{!ranSections && (
							<>
								<TextField
									label="Name"
									fullWidth
									value={name}
									onChange={event => setName(event.target.value)}
									helperText="How this import is named in the View Imports list."
								/>

								<SqlImportStatementsStep
									statements={statements}
									onChange={setStatements}
									errorSection={runError?.section}
									error={runError?.error as DbErrorUtils.SerializedError | undefined}
									disabled={busy}
								/>

								<SqlImportSaveOptions
									save
									linksOnly
									onChangeSave={() => undefined}
									connections={connections}
									connectionIds={connectionIds}
									onChangeConnectionIds={setConnectionIds}
									disabled={busy}
								/>
							</>
						)}

						{ranSections && (
							<>
								<SqlImportMappingStep sections={ranSections as SqlImportRunSection[]} mappings={mappings} onChange={setMappings} disabled={busy} />

								{missingTargets.length > 0 && (
									<Alert severity="info">Map every required field before saving: {missingTargets.join(', ')}.</Alert>
								)}

								{duplicateTargets.length > 0 && (
									<Alert severity="warning">Each field can only be mapped once: {duplicateTargets.join(', ')}.</Alert>
								)}
							</>
						)}

						{saveError && <Alert severity="error">{saveError}</Alert>}
					</Stack>
				)}
			</DialogContent>

			<DialogActions>
				<Button onClick={handleCancel}>Cancel</Button>

				{ranSections && <Button disabled={busy} onClick={handleBack}>Back</Button>}

				{!ranSections && config && (
					<>
						<Button disabled={busy || !hasTablesStatement} onClick={() => handleSave(false)}>Save</Button>
						<Button variant="contained" disabled={busy || !hasTablesStatement} onClick={() => onRunSqlImport(filledStatements())}>Next</Button>
					</>
				)}

				{ranSections && (
					<Button
						variant="contained"
						disabled={busy || missingTargets.length > 0 || duplicateTargets.length > 0}
						onClick={() => handleSave(true)}
					>
						Save &amp; Re-run
					</Button>
				)}
			</DialogActions>
		</Dialog>
	);
}
