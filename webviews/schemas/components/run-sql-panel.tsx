import { useEffect, useRef, useState } from 'react';
import CancelIcon from '@mui/icons-material/Cancel';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, IconButton, Stack, Typography } from '@mui/material';
import type { DbErrorUtils } from '../../../src/utils/db-error-utils';
import { StatementParser } from '../../../src/utils/statement-parser';
import { StringUtils } from '../../../src/utils/string-utils.js';
import { SqlErrorDisplay } from '../../shared/components/sql-error-display';
import { ResizablePanel } from '../../shared/components/resizable-panel';
import type { PanelResize } from '../../shared/components/resizable-panel';
import { SqlStatementBlock } from '../../shared/components/sql-statement-block';
import type { PendingDataStatement } from '../pending-statement';

export type StatementStatus = 'running' | 'success' | 'error';

interface Props {
	statements: PendingDataStatement[];
	/** Per-statement id - a 'success' entry is permanent (this statement is done: already ran, can't be
	 * re-run or deleted); 'running'/'error' only ever reflect the current/most recent run. See app.tsx. */
	statementStatuses: Record<string, StatementStatus>;
	/** Per-statement id - only set for a statement whose most recent attempt failed. */
	statementErrors: Record<string, DbErrorUtils.SerializedError>;
	/** True for the entire span of a run - disables Cancel, Clear, and every per-statement discard
	 * button so none of the statements the host is currently executing can be removed out from under it. */
	isRunning: boolean;
	collapsed: boolean;
	onToggleCollapsed: () => void;
	/** No confirmation of its own left - App owns the discard-confirmation dialog (requestExitEditMode)
	 * so tab-close actions can trigger the exact same confirmation/outcome as this button. */
	onCancelClick: () => void;
	onDeleteStatement: (id: string) => void;
	/** Called once the Run confirmation dialog is accepted - App posts runDataEditStatements and
	 * snapshots the sent statement ids itself, rather than this panel posting the message directly. */
	onRun: () => void;
	/** The Clear dialog's "Clear Done"/"Clear All" options - see handleClearClick below. */
	onClearDone: () => void;
	onClearAll: () => void;
	/** Makes the divider on the panel's left edge draggable - see ResizablePanel. Without it the panel is
	 * DEFAULT_RUN_SQL_PANEL_WIDTH wide. */
	resizable?: PanelResize;
}

/** The panel's width until it is dragged, and what a double-click on its divider puts it back to. */
export const DEFAULT_RUN_SQL_PANEL_WIDTH = 360;
const MIN_RUN_SQL_PANEL_WIDTH = 240;

// How narrow a drag may leave the tabs beside the panel.
const MIN_BESIDE_RUN_SQL_PANEL_WIDTH = 320;

// A small icon standing in for each statement's current run status, shown next to its Chip - nothing
// once a statement hasn't started (or finished) as part of the current/most recent run.
function StatusIcon({ status }: { status: StatementStatus | undefined }) {
	if (status === 'running') {
		return <CircularProgress size={16} />;
	}

	if (status === 'success') {
		return <CheckCircleIcon fontSize="small" color="success" />;
	}

	if (status === 'error') {
		return <CancelIcon fontSize="small" color="error" />;
	}

	return null;
}

type ChipColor = 'default' | 'info' | 'success' | 'warning' | 'error';

// A lowercase noun and a Chip color per StatementKind - covers today's INSERT/UPDATE/DELETE and the
// CREATE/ALTER/DROP kinds this panel is meant to grow into once the DDL feature reuses it.
const KIND_LABELS: Record<StatementParser.StatementKind, string> = {
	[StatementParser.StatementKind.SELECT]: 'Select',
	[StatementParser.StatementKind.INSERT]: 'Insert',
	[StatementParser.StatementKind.UPDATE]: 'Update',
	[StatementParser.StatementKind.DELETE]: 'Delete',
	[StatementParser.StatementKind.MERGE]: 'Merge',
	[StatementParser.StatementKind.CREATE]: 'Create',
	[StatementParser.StatementKind.ALTER]: 'Alter',
	[StatementParser.StatementKind.DROP]: 'Drop',
	[StatementParser.StatementKind.TRUNCATE]: 'Truncate',
	[StatementParser.StatementKind.CALL]: 'Call',
	[StatementParser.StatementKind.OTHER]: 'Statement'
};

const KIND_COLORS: Record<StatementParser.StatementKind, ChipColor> = {
	[StatementParser.StatementKind.SELECT]: 'success',
	[StatementParser.StatementKind.INSERT]: 'success',
	[StatementParser.StatementKind.UPDATE]: 'success',
	[StatementParser.StatementKind.DELETE]: 'success',
	[StatementParser.StatementKind.MERGE]: 'default',
	[StatementParser.StatementKind.CREATE]: 'default',
	[StatementParser.StatementKind.ALTER]: 'default',
	[StatementParser.StatementKind.DROP]: 'default',
	[StatementParser.StatementKind.TRUNCATE]: 'default',
	[StatementParser.StatementKind.CALL]: 'default',
	[StatementParser.StatementKind.OTHER]: 'default'
};

export function RunSqlPanel({ statements, statementStatuses, statementErrors, isRunning, collapsed, onToggleCollapsed, onCancelClick, onDeleteStatement, onRun, onClearDone, onClearAll, resizable }: Props) {
	const [confirmRunOpen, setConfirmRunOpen] = useState(false);
	const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
	// Ref per statement's own row element - see the auto-scroll effect below.
	const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});

	// Keeps whichever statement is currently executing in view - relevant for a batch too long to fit
	// in the panel at once. Only ever one 'running' entry at a time (executeStatements runs in order).
	useEffect(() => {
		let runningId = Object.keys(statementStatuses).find(id => statementStatuses[id] === 'running');
		itemRefs.current[runningId ?? '']?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	}, [statementStatuses]);

	function handleConfirmRun() {
		setConfirmRunOpen(false);
		onRun();
	}

	// A done statement (statementStatuses[id] === 'success', see app.tsx) can't be re-run - only
	// whatever's left actually gets sent, so the confirmation/Run button reflect that, not the full list.
	const runnableStatements = statements.filter(statement => statementStatuses[statement.id] !== 'success');
	const doneCount = statements.length - runnableStatements.length;
	// One statement DB2 would certainly reject holds the whole run - a run stops at its first failure
	// anyway, and the fix is a field edit away.
	const hasInvalidStatement = runnableStatements.some(statement => statement.validationErrors?.length);

	// Grouped by kind for the Run confirmation's "3 inserts, 10 updates, 2 deletes" breakdown - only
	// the per-kind totals are shown, not which statements they are.
	const countsByKind = new Map<StatementParser.StatementKind, number>();
	for(let statement of runnableStatements) {
		let kind = StatementParser.classifyKind(statement.sql);
		countsByKind.set(kind, (countsByKind.get(kind) ?? 0) + 1);
	}
	const runSummary = Array.from(countsByKind.entries())
		.map(([kind, count]) => `${count} ${KIND_LABELS[kind]}${StringUtils.getPlural(count)}`)
		.join(', ');

	function handleClearClick() {
		// Nothing not-yet-run to lose - clear directly rather than asking for confirmation of a no-op risk.
		if (runnableStatements.length === 0) {
			onClearAll();
			return;
		}

		setClearConfirmOpen(true);
	}

	function handleClearDoneClick() {
		setClearConfirmOpen(false);
		onClearDone();
	}

	function handleClearAllClick() {
		setClearConfirmOpen(false);
		onClearAll();
	}

	if(collapsed) {
		return (
			<Stack sx={{ flexShrink: 0, borderLeft: 1, borderColor: 'divider', alignItems: 'center', pt: 1 }}>
				<IconButton aria-label="Expand run SQL panel" onClick={onToggleCollapsed}>
					<ChevronLeftIcon fontSize="small" />
				</IconButton>
			</Stack>
		);
	}

	let panel = (
		<Stack sx={{ width: resizable?.width ?? DEFAULT_RUN_SQL_PANEL_WIDTH, flexShrink: 0, minHeight: 0, borderLeft: 1, borderColor: 'divider', overflow: 'hidden' }}>
			<Stack direction="row" sx={{ p: 1, flexShrink: 0, alignItems: 'center', justifyContent: 'space-between' }}>
				<Typography variant="subtitle1">Run SQL</Typography>
				<IconButton aria-label="Collapse run SQL panel" onClick={onToggleCollapsed}>
					<ChevronRightIcon fontSize="small" />
				</IconButton>
			</Stack>

			<Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto', px: 1 }}>
				{statements.length === 0 ? (
					<Typography variant="body2" sx={{ p: 1, color: 'text.secondary' }}>No pending changes</Typography>
				) : (
					<Stack spacing={2} sx={{ pb: 1 }}>
						{statements.map(statement => {
							let kind = StatementParser.classifyKind(statement.sql);
							let status = statementStatuses[statement.id];
							let done = status === 'success';
							let error = status === 'error' ? statementErrors[statement.id] : undefined;

							return (
								<Stack
									key={statement.id}
									spacing={0.5}
									ref={(element: HTMLDivElement | null) => {
										itemRefs.current[statement.id] = element;
									}}
									sx={done ? { opacity: 0.6 } : undefined}
								>
									<Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
										<Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
											<Chip size="small" label={KIND_LABELS[kind]} color={KIND_COLORS[kind]} />
											<StatusIcon status={status} />
										</Stack>
										<IconButton aria-label="Discard statement" disabled={isRunning || done} onClick={() => onDeleteStatement(statement.id)}>
											✕
										</IconButton>
									</Stack>
									<SqlStatementBlock sql={statement.sql} invalid={!done && Boolean(statement.validationErrors?.length)} />
									{!done && statement.validationErrors?.map(message => (
										<Typography key={message} variant="body2" color="error">{message}</Typography>
									))}
									{error && <SqlErrorDisplay error={error} />}
								</Stack>
							);
						})}
					</Stack>
				)}
			</Box>

			<Stack direction="row" spacing={1} sx={{ p: 1, flexShrink: 0, justifyContent: 'flex-end' }}>
				<Button disabled={isRunning} onClick={onCancelClick}>Cancel</Button>
				<Button disabled={isRunning || statements.length === 0} onClick={handleClearClick}>Clear</Button>
				<Button variant="contained" onClick={() => setConfirmRunOpen(true)} disabled={isRunning || runnableStatements.length === 0 || hasInvalidStatement}>Run</Button>
			</Stack>

			<Dialog open={confirmRunOpen} onClose={() => setConfirmRunOpen(false)} maxWidth="sm" fullWidth>
				<DialogTitle>Run Pending Changes</DialogTitle>
				<DialogContent>
					<DialogContentText>This will run {runSummary}.</DialogContentText>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setConfirmRunOpen(false)}>Cancel</Button>
					<Button variant="contained" onClick={handleConfirmRun}>Run</Button>
				</DialogActions>
			</Dialog>

			<Dialog open={clearConfirmOpen} onClose={() => setClearConfirmOpen(false)} maxWidth="sm" fullWidth>
				<DialogTitle>Clear Pending Changes</DialogTitle>
				<DialogContent>
					<DialogContentText>
						There {runnableStatements.length === 1 ? 'is' : 'are'} {runnableStatements.length} statement{StringUtils.getPlural(runnableStatements.length)} that {runnableStatements.length === 1 ? 'has' : 'have'} not run yet.
					</DialogContentText>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setClearConfirmOpen(false)}>Cancel</Button>
					{doneCount > 0 && <Button onClick={handleClearDoneClick}>Clear Done</Button>}
					<Button variant="contained" color="error" onClick={handleClearAllClick}>Clear All</Button>
				</DialogActions>
			</Dialog>
		</Stack>
	);

	if(!resizable) {
		return panel;
	}

	return (
		<ResizablePanel {...resizable} edge="left" minWidth={MIN_RUN_SQL_PANEL_WIDTH} defaultWidth={DEFAULT_RUN_SQL_PANEL_WIDTH} reserveWidth={MIN_BESIDE_RUN_SQL_PANEL_WIDTH} label="Resize run SQL panel">
			{panel}
		</ResizablePanel>
	);
}
