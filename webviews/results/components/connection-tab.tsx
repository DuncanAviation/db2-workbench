import { useEffect, useRef, useState } from 'react';
import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import type { DbErrorUtils } from '../../../src/utils/db-error-utils';
import { LibraryListUtils } from '../../../src/utils/library-list-utils';
import type { ResultsInboundMessage, ResultsJobDetails, ResultsSessionDetail } from '../../../src/webview-messages/results-messages';
import { CopyIconButton } from '../../shared/components/copy-icon-button';
import { EditSchemaListDialog, libraryListTypeLabel } from '../../shared/components/edit-schema-list-dialog';
import { resultsVsCodeApi } from '../vscode-api';

interface Props {
	session: ResultsSessionDetail;
}

export function ConnectionTab({ session }: Props) {
	const info = session.connectionInfo;
	const [dialogOpen, setDialogOpen] = useState(false);
	const [applying, setApplying] = useState(false);
	const [error, setError] = useState<DbErrorUtils.SerializedError | undefined>(undefined);
	// Library checks waiting on the host's answer, by request id.
	const pendingChecks = useRef(new Map<number, (exists: boolean) => void>());
	const nextCheckId = useRef(0);

	// Only the answers to this session's own requests. The new list itself arrives with the next sessionsState.
	useEffect(() => {
		function onMessage(event: MessageEvent<ResultsInboundMessage>) {
			if (event.data.command === 'libraryCheckResult' && event.data.uri === session.uri) {
				let resolve = pendingChecks.current.get(event.data.requestId);
				pendingChecks.current.delete(event.data.requestId);
				// The id comes from the message, so only an answer to a check still waiting resolves anything.
				if (typeof resolve === 'function') {
					// A lookup that failed lets the name through: OK then reports whatever is really wrong with it.
					resolve(event.data.exists || event.data.error != null);
				}
				return;
			}

			if (event.data.command !== 'libraryListResult' || event.data.uri !== session.uri) {
				return;
			}

			setApplying(false);
			setError(event.data.error);

			if (!event.data.error) {
				setDialogOpen(false);
			}
		}

		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, [session.uri]);

	if (!info) {
		return <Typography sx={{ p: 2 }}>No connection yet</Typography>;
	}

	// A SQL tab's own list only - a schema browser or diagram session builds its tree from its list, and
	// isn't meant to follow a change made for running statements. The main job can't take the command
	// while it runs a statement or fetches (the host refuses then too).
	const editable = session.sessionKind === 'editor';
	const busy = session.state !== 'ready' || session.isFetchingAll;

	function openDialog() {
		setError(undefined);
		setDialogOpen(true);
	}

	function checkLibrary(library: string): Promise<boolean> {
		let requestId = nextCheckId.current++;

		return new Promise(resolve => {
			pendingChecks.current.set(requestId, resolve);
			resultsVsCodeApi.postMessage({ command: 'checkLibrary', uri: session.uri, requestId, library });
		});
	}

	function handleSave(userLibraries: string[]) {
		setApplying(true);
		setError(undefined);
		resultsVsCodeApi.postMessage({ command: 'setLibraryList', uri: session.uri, userLibraries });
	}

	// The legend names only the types this list actually has, in the order they first appear.
	let legendTypes = [...new Set(info.schemas.map(schema => schema.type?.toUpperCase()))];

	return (
		<Stack spacing={2} sx={{ p: 2 }}>
			<Typography>Connected to <b>{session.connectionName}</b> as <b>{session.userName}</b> on <b>{info.jobDetails.createdDate}</b></Typography>

			<Stack spacing={1}>
				<Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
					<Typography variant="subtitle1" sx={{ fontWeight: 600, mr: 0.5 }}>Schema List</Typography>
					<CopyIconButton text={info.schemas.map(schema => schema.name).join(', ')} label="Copy schema list" />
					{editable && (
						// The span keeps the tooltip working while the button is disabled, which MUI needs.
						<Tooltip title={busy ? 'The schema list can\'t be edited while a statement is running' : 'Edit schema list'}>
							<span>
								<IconButton aria-label="Edit schema list" onClick={openDialog} disabled={busy}>
									<EditIcon fontSize="small" />
								</IconButton>
							</span>
						</Tooltip>
					)}
				</Stack>

				<Stack component="ol" aria-label="Schema list" direction="row" useFlexGap sx={{ m: 0, pl: 0, listStyle: 'none', flexWrap: 'wrap', gap: 0.75 }}>
					{info.schemas.map((schema, index) => (
						// describeChild, or the tooltip's text would replace the entry's own name as its label.
						<Tooltip key={schema.name} title={libraryListTypeLabel(schema.type)} describeChild>
							<Stack
								component="li"
								direction="row"
								spacing={0.75}
								sx={{
									alignItems: 'center',
									py: 0.375,
									pl: 0.5,
									pr: 1.25,
									borderRadius: 1,
									bgcolor: 'action.hover',
									borderLeft: 3,
									borderLeftColor: typeColor(schema.type)
								}}
							>
								<Typography variant="caption" sx={{ color: 'text.secondary', minWidth: 14, textAlign: 'right' }}>{index + 1}</Typography>
								<Typography>{schema.name}</Typography>
								<Box component="span" sx={VISUALLY_HIDDEN}>{libraryListTypeLabel(schema.type)}</Box>
							</Stack>
						</Tooltip>
					))}
				</Stack>

				<Stack direction="row" spacing={1.75} aria-hidden="true">
					{legendTypes.map(type => (
						<Stack key={type} direction="row" spacing={0.625} sx={{ alignItems: 'center' }}>
							<Box sx={{ width: 8, height: 8, borderRadius: 0.5, bgcolor: typeColor(type) }} />
							<Typography variant="caption" sx={{ color: 'text.secondary' }}>{libraryListTypeLabel(type)}</Typography>
						</Stack>
					))}
				</Stack>
			</Stack>

			<Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'flex-start', gap: 1.5 }}>
				<JobCard title="Primary Connection" job={info.jobDetails} />
				<JobCard title="Worker Connection" job={info.workerJobDetails} />
			</Stack>

			{editable && (
				<EditSchemaListDialog
					mode="live"
					open={dialogOpen}
					libraryList={info.schemas}
					applying={applying}
					error={error}
					checkLibrary={checkLibrary}
					onCancel={() => setDialogOpen(false)}
					onSave={handleSave}
				/>
			)}
		</Stack>
	);
}

// Theme palette colors rather than --vscode-* tokens, since MUI adapts these to the light or dark mode.
const TYPE_COLORS: Record<string, string> = {
	[LibraryListUtils.EntryType.SYSTEM]: 'text.disabled',
	[LibraryListUtils.EntryType.PRODUCT]: 'success.main',
	[LibraryListUtils.EntryType.CURRENT]: 'warning.main',
	[LibraryListUtils.EntryType.USER]: 'info.main'
};

function typeColor(type: string): string {
	return TYPE_COLORS[type?.toUpperCase()] ?? 'divider';
}

// The chip shows its type by color alone, so a screen reader gets it as text.
const VISUALLY_HIDDEN = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } as const;

function JobCard({ title, job }: { title: string; job: ResultsJobDetails }) {
	return (
		<Box component="section" aria-label={title} sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}>
			<Typography sx={{ fontWeight: 600, px: 1.25, py: 0.75, borderBottom: 1, borderColor: 'divider' }}>{title}</Typography>
			<Box component="dl" sx={{ m: 0, px: 1.25, py: 1, display: 'grid', gridTemplateColumns: '110px auto', rowGap: 1, columnGap: 1 }}>
				<Typography component="dt" sx={{ color: 'text.secondary' }}>Job Name</Typography>
				<Typography component="dd" sx={{ m: 0 }}>{job.jobName}</Typography>
				<Typography component="dt" sx={{ color: 'text.secondary' }}>IP</Typography>
				<Typography component="dd" sx={{ m: 0 }}>{job.ip}</Typography>
				<Typography component="dt" sx={{ color: 'text.secondary' }}>Sort Sequence</Typography>
				<Typography component="dd" sx={{ m: 0 }}>{job.sortSequence}</Typography>
			</Box>
		</Box>
	);
}
