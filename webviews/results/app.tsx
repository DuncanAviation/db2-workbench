import { useEffect, useReducer } from 'react';
import { Stack, Typography } from '@mui/material';
import type { ResultsInboundMessage, ResultsInitialState } from '../../src/webview-messages/results-messages';
import { getInitialState } from './initial-state';
import { NoConnectionsView } from './components/no-connections-view';
import { SessionSidebar } from './components/session-sidebar';
import { SessionDetail } from './components/session-detail';

type State = ResultsInitialState;

type Action =
	| { type: 'sessionsState'; message: Extract<ResultsInboundMessage, { command: 'sessionsState' }> }
	| { type: 'addRows'; message: Extract<ResultsInboundMessage, { command: 'addRows' }> };

function reducer(state: State, action: Action): State {
	switch (action.type) {
		case 'sessionsState':
			return {
				...state,
				appState: action.message.appState,
				sessions: action.message.sessions,
				activeUri: action.message.activeUri,
				activeSession: action.message.activeSession,
				autoFocusResults: action.message.autoFocusResults
			};

		case 'addRows':
			if (!state.activeSession) {
				return state;
			}

			return {
				...state,
				activeSession: {
					...state.activeSession,
					rows: [...state.activeSession.rows, ...action.message.rows],
					isCursorOpen: action.message.isCursorOpen
				}
			};
	}
}

export function App() {
	const [state, dispatch] = useReducer(reducer, undefined, () => getInitialState() as State);

	useEffect(() => {
		function onMessage(event: MessageEvent<ResultsInboundMessage>) {
			if (event.data.command === 'sessionsState') {
				dispatch({ type: 'sessionsState', message: event.data });
			} else if (event.data.command === 'addRows') {
				dispatch({ type: 'addRows', message: event.data });
			}
		}

		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, []);

	if (state.appState === 'noConnections') {
		return <NoConnectionsView extensionName={state.extensionName} />;
	}

	return (
		<Stack direction="row" sx={{ height: '100vh', minHeight: 0, overflow: 'hidden' }}>
			<Stack sx={{ flexGrow: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
				{state.activeSession
					? <SessionDetail key={state.activeSession.uri} session={state.activeSession} autoFocusResults={state.autoFocusResults} />
					: (
						<Stack sx={{ p: 2 }}>
							<Typography>Run a query to see results</Typography>
						</Stack>
					)}
			</Stack>

			{state.sessions.length > 0 && <SessionSidebar sessions={state.sessions} activeUri={state.activeUri} />}
		</Stack>
	);
}
