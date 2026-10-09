import { useState } from 'react';
import { Box, Stack, Tab, Tabs, Typography } from '@mui/material';
import type { SchemasSystemView } from '../../../src/webview-messages/schemas-messages';
import { ColumnsTab } from './columns-tab';
import type { SubTabKey } from './table-detail';
import { TableDataTab } from './table-data-tab';
import { ViewDefinitionTab } from './view-definition-tab';
import { ViewInfoTab } from './view-info-tab';

interface Props {
	view: SchemasSystemView;
	/** Shared with TableDetail - see app.tsx. A table-only tab remembered from a table falls back to Info. */
	subTab: SubTabKey;
	onSubTabChange: (value: SubTabKey) => void;
}

const VIEW_SUB_TABS: readonly SubTabKey[] = ['info', 'columns', 'definition', 'data'];

// No-op edit-session callbacks for the Data tab, which never enters edit mode for a view (readOnly).
const NO_PENDING_STATEMENTS: never[] = [];
const noop = () => {};

// A view's counterpart to TableDetail. Columns and Data are the table tabs themselves, pointed at the
// view's name - SYSCOLUMNS2 lists a view's columns like a table's, and a view pages like a table does,
// just without an RRN key (see DataQueries.ListTableDataOptions.readOnly). No imports, badges or
// export menu: those are table features.
export function ViewDetail({ view, subTab, onSubTabChange }: Props) {
	const displaySubTab: SubTabKey = VIEW_SUB_TABS.includes(subTab) ? subTab : 'info';
	const minimalView = { schema: view.schema, name: view.name };

	// Same keep-mounted-once-opened rule as TableDetail's Data tab, for the same reason.
	const [dataTabOpened, setDataTabOpened] = useState(displaySubTab === 'data');

	function handleSubTabChange(value: SubTabKey) {
		onSubTabChange(value);

		if (value === 'data') {
			setDataTabOpened(true);
		}
	}

	return (
		<Stack sx={{ flexGrow: 1, minHeight: 0, overflow: 'hidden' }}>
			<Stack direction="row" sx={{ alignItems: 'center', gap: 1, px: 2, py: 1, flexShrink: 0 }}>
				<Typography noWrap sx={{ minWidth: 0 }}>
					<Box component="span">{view.schema}/{view.name} {view.description}</Box>
				</Typography>
			</Stack>

			<Tabs value={displaySubTab} onChange={(_, value: SubTabKey) => handleSubTabChange(value)}>
				<Tab label="Info" value="info" />
				<Tab label="Columns" value="columns" />
				<Tab label="Definition" value="definition" />
				<Tab label="Data" value="data" />
			</Tabs>

			<Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto' }}>
				{displaySubTab === 'info' && <ViewInfoTab view={view} />}
				{displaySubTab === 'definition' && <ViewDefinitionTab view={minimalView} />}
				{displaySubTab === 'columns' && <ColumnsTab table={minimalView} hasImportedData={false} />}
				{dataTabOpened && (
					<Box sx={{ display: displaySubTab === 'data' ? 'contents' : 'none', height: '100%', minHeight: 0 }}>
						<TableDataTab
							table={minimalView}
							readOnly
							editMode={false}
							onEnterEditMode={noop}
							onCancelEditClick={noop}
							isRunning={false}
							pendingStatements={NO_PENDING_STATEMENTS}
							onUpsertStatement={noop}
							onDeleteStatement={noop}
							runCompletionNotice={null}
						/>
					</Box>
				)}
			</Box>
		</Stack>
	);
}
