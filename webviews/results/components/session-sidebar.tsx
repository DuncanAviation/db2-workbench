import { Box, IconButton, List, ListItem, ListItemButton, ListItemText, Menu, MenuItem, Stack, Typography } from '@mui/material';
import { MouseEvent, useState } from 'react';
import type { ResultsSessionSummary } from '../../../src/webview-messages/results-messages';
import { resultsVsCodeApi } from '../vscode-api';

interface Props {
	sessions: ResultsSessionSummary[];
	activeUri?: string;
}

interface SessionMenuState {
	anchorEl: HTMLElement;
	uri: string;
}

export function SessionSidebar({ sessions, activeUri }: Props) {
	const [sessionMenu, setSessionMenu] = useState<SessionMenuState | null>(null);

	function handleSelect(uri: string) {
		resultsVsCodeApi.postMessage({ command: 'selectSession', uri });
	}

	function handleMenuOpen(event: MouseEvent<HTMLElement>, uri: string) {
		setSessionMenu({ anchorEl: event.currentTarget, uri });
	}

	function handleMenuClose() {
		setSessionMenu(null);
	}

	function handleReconnect() {
		if (sessionMenu) {
			resultsVsCodeApi.postMessage({ command: 'reconnect', uri: sessionMenu.uri });
		}

		handleMenuClose();
	}

	return (
		<Stack sx={{ width: 250, flexShrink: 0, minHeight: 0, borderLeft: 1, borderColor: 'divider', overflow: 'hidden' }}>
			<Typography variant="subtitle2" sx={{ px: 2, py: 1, flexShrink: 0 }}>Sessions</Typography>
			<Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto' }}>
				<List dense disablePadding>
					{sessions.map(session => (
						<ListItem
							key={session.uri}
							disablePadding
							secondaryAction={
								<IconButton aria-label="Session options" onClick={event => handleMenuOpen(event, session.uri)}>
									⋮
								</IconButton>
							}
						>
							<ListItemButton selected={session.uri === activeUri} onClick={() => handleSelect(session.uri)} sx={{ pr: 5 }}>
								<ListItemText primary={session.name} />
							</ListItemButton>
						</ListItem>
					))}
				</List>
			</Box>

			<Menu anchorEl={sessionMenu?.anchorEl} open={sessionMenu !== null} onClose={handleMenuClose}>
				<MenuItem onClick={handleReconnect}>Reconnect</MenuItem>
			</Menu>
		</Stack>
	);
}
