import { useEffect, useRef, useState } from 'react';
import { Box, Stack, Tab, Tabs } from '@mui/material';
import type { ResultsSessionDetail } from '../../../src/webview-messages/results-messages';
import { ConnectionTab } from './connection-tab';
import { HistoryTab, getDefaultHistoryCategories } from './history-tab';
import type { HistoryCategory } from './history-tab';
import { DataTab } from './data-tab';
import { ParametersTab } from './parameters-tab';

interface Props {
	session: ResultsSessionDetail;
	/** db2-workbench.autoFocusResults - whether a new query result should switch the selected tab
	 * to Data on its own, mirroring the host's decision to reveal the panel on execute. */
	autoFocusResults: boolean;
}

type TabKey = 'connection' | 'history' | 'data' | 'parameters';

export function SessionDetail({ session, autoFocusResults }: Props) {
	// True for the schema browser AND the diagram editor - neither has result rows or bind parameters
	const isMetadataOnly = session.sessionKind !== 'editor';
	const [selectedTab, setSelectedTab] = useState<TabKey>(autoFocusResults && session.rows.length > 0 ? 'data' : 'history');
	// Owned here (rather than inside HistoryTab) because SessionDetail only conditionally renders
	// HistoryTab - it unmounts every time a new query result switches selectedTab to 'data' (see
	// the effect below), which would otherwise reset the filters on every query execution.
	const [historySearchText, setHistorySearchText] = useState('');
	const [historyCategories, setHistoryCategories] = useState<HistoryCategory[]>(() => getDefaultHistoryCategories(session.sessionKind));
	// Tracks the last parameterFocusRequest.nonce this component has already switched tabs for -
	// session.parameterFocusRequest is a new object reference on every session update (it travels
	// through postMessage), so without this guard the tab would jump back to Parameters on every
	// unrelated later update instead of only on a genuinely new request.
	const appliedFocusNonceRef = useRef<number | undefined>(undefined);

	// Re-derive the default whenever a new query result changes the row count for this session
	// (rather than only on first mount) - otherwise a session that started at 0 rows stays on
	// History forever, even after a query returns data. Skipped when autoFocusResults is off, so
	// a query run without stealing focus also doesn't yank the user to a different tab than the
	// one they're currently looking at.
	useEffect(() => {
		if (autoFocusResults) {
			setSelectedTab(session.rows.length > 0 ? 'data' : 'history');
		}
	}, [session.rows.length, autoFocusResults]);

	useEffect(() => {
		let request = session.parameterFocusRequest;

		if (request && appliedFocusNonceRef.current !== request.nonce) {
			appliedFocusNonceRef.current = request.nonce;
			setSelectedTab('parameters');
		}
	}, [session.parameterFocusRequest]);

	return (
		<Stack sx={{
			flexGrow: 1,
			minWidth: 0,
			minHeight: 0,
			overflow: 'hidden',
			borderStyle: 'solid',
			borderWidth: session.resultBorderColor ? 2 : 0,
			borderColor: session.resultBorderColor ?? 'transparent'
		}}>
			<Tabs value={selectedTab} onChange={(_, value: TabKey) => setSelectedTab(value)}>
				<Tab label="Connection" value="connection" />
				<Tab label={`History (${session.histories.length})`} value="history" />
				{!isMetadataOnly && <Tab label={`Data (${session.rows.length})`} value="data" />}
				{!isMetadataOnly && <Tab label={`Parameters${session.parameters.length > 0 ? ` (${session.parameters.length})` : ''}`} value="parameters" />}
			</Tabs>

			<Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto' }}>
				{selectedTab === 'connection' && <ConnectionTab session={session} />}
				{selectedTab === 'history' && (
					<HistoryTab
						session={session}
						searchText={historySearchText}
						onSearchTextChange={setHistorySearchText}
						selectedCategories={historyCategories}
						onSelectedCategoriesChange={setHistoryCategories}
					/>
				)}
				{!isMetadataOnly && selectedTab === 'data' && <DataTab session={session} />}
				{!isMetadataOnly && selectedTab === 'parameters' && <ParametersTab session={session} />}
			</Box>
		</Stack>
	);
}
