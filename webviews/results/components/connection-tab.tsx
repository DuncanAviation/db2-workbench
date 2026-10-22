import { useEffect, useRef, useState } from 'react';
import { IconButton, Stack, Tooltip, Typography } from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import type { DbErrorUtils } from '../../../src/utils/db-error-utils';
import type { ResultsInboundMessage, ResultsSessionDetail } from '../../../src/webview-messages/results-messages';
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

	return (
		<Stack spacing={2} sx={{ p: 2 }}>
			<Typography>Connected to <b>{session.connectionName}</b> on <b>{info.jobDetails.createdDate}</b> as <b>{session.userName}</b></Typography>

			<Stack spacing={1}>
				<Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
					<Typography variant="subtitle1" sx={{ mr: 0.5 }}>Schema List</Typography>
					<CopyIconButton text={info.schemas.map(schema => schema.name).join(', ')} label="Copy schema list" />
					{editable && (
						// The span keeps the tooltip working while the button is disabled, which MUI needs.
						<Tooltip title={busy ? 'The schema list can\'t be edited while a statement is running' : 'Edit schema list'}>
							<span>
								<IconButton size="small" aria-label="Edit schema list" onClick={openDialog} disabled={busy}>
									<EditIcon fontSize="small" />
								</IconButton>
							</span>
						</Tooltip>
					)}
				</Stack>

				<Stack component="ol" aria-label="Schema list" sx={{ m: 0, pl: 0, listStyle: 'none' }}>
					{info.schemas.map(schema => (
						<Stack component="li" key={schema.name} direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
							<Typography>{schema.name}</Typography>
							<Typography variant="caption" sx={{ color: 'text.secondary' }}>{libraryListTypeLabel(schema.type)}</Typography>
						</Stack>
					))}
				</Stack>
			</Stack>

			<Stack spacing={1}>
				<Typography variant="subtitle1">Primary Connection</Typography>

				<Stack>
					<Typography variant="subtitle2">Job Name</Typography>
					<Typography>{info.jobDetails.jobName}</Typography>
				</Stack>

				<Stack>
					<Typography variant="subtitle2">IP</Typography>
					<Typography>{info.jobDetails.ip}</Typography>
				</Stack>

				<Stack>
					<Typography variant="subtitle2">Sort Sequence</Typography>
					<Typography>{info.jobDetails.sortSequence}</Typography>
				</Stack>
			</Stack>

			<Stack spacing={1}>
				<Typography variant="subtitle1">Worker Connection</Typography>

				<Stack>
					<Typography variant="subtitle2">Job Name</Typography>
					<Typography>{info.workerJobDetails.jobName}</Typography>
				</Stack>

				<Stack>
					<Typography variant="subtitle2">IP</Typography>
					<Typography>{info.workerJobDetails.ip}</Typography>
				</Stack>

				<Stack>
					<Typography variant="subtitle2">Sort Sequence</Typography>
					<Typography>{info.workerJobDetails.sortSequence}</Typography>
				</Stack>
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
