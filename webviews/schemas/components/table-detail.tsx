import { MouseEvent, useState } from 'react';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { Box, IconButton, Menu, MenuItem, Stack, Tab, Tabs, Typography } from '@mui/material';
import { SystemTable } from '../../../src/models/system-table.js';
import type { TreeTableEntry } from '../../../src/webview-messages/schemas-messages';
import type { PendingDataStatement } from '../pending-statement';
import { ImportBadge } from '../../shared/components/import-badge';
import { getEntryKey } from '../table-key';
import { AdvisedIndexesTab } from './advised-indexes-tab';
import { ColumnsTab } from './columns-tab';
import { ForeignKeysTab } from './foreign-keys-tab';
import { ImportedInfoTab } from './imported-info-tab';
import { IndexesTab } from './indexes-tab';
import { InfoTab } from './info-tab';
import { TableDataTab } from './table-data-tab';
import { TableKeysTab } from './table-keys-tab';
import { TriggersTab } from './triggers-tab';
import { ViewDefinitionTab } from './view-definition-tab';

// Which badge the header shows - the two cases need different explanations even though the badge
// label itself doesn't, shown as a hover tooltip on the badge rather than a click-to-open dialog.
const BADGE_HELP_TEXT: Record<'imported' | 'enhanced', string> = {
	imported: 'This table was brought in from an imported file (DBML or Frictionless Table Schema) and does not exist in the connected database yet. Everything shown for it comes from that import, not from a live query.',
	enhanced: 'This is a real table in the connected database - everything shown for it reflects the actual database - but it has also been enhanced with additional information from an imported file, such as relationships DB2 itself does not enforce as real foreign keys. Anything sourced from an import is flagged so it\'s never mistaken for something the database itself reported.'
};

interface Props {
	entry: TreeTableEntry;
	currentSortSequence: string;
	currentSortSequenceLibrary: string;
	/** Whether the Run SQL panel is currently open - hides the Data tab's "Edit Data" action while true. */
	editMode: boolean;
	onEnterEditMode: () => void;
	/** The Data tab's "Cancel Edit" action, shown in editMode in place of "Edit Data" - same confirmation
	 * flow as the Run SQL panel's own Cancel button. See app.tsx's requestExitEditMode. */
	onCancelEditClick: () => void;
	/** True for the entire span of a run - disables every row/table action that would add or remove a
	 * pending statement, since the host is currently executing the exact list that was sent. See
	 * app.tsx. */
	isRunning: boolean;
	/** Can span multiple open tables' tabs at once - see app.tsx. */
	pendingStatements: PendingDataStatement[];
	onUpsertStatement: (statement: PendingDataStatement) => void;
	onDeleteStatement: (id: string) => void;
	/** The {schema, table} pairs whose pending statements just ran successfully - see app.tsx's
	 * handleRunResult. */
	runCompletionNotice: Array<{schema: string; table: string}> | null;
	/** Opens the Export Schema dialog - see app.tsx's exportSchemaDialogOpen. */
	onOpenExport: () => void;
	/** Table tab header's "Disable Imported Changes" menu item - app.tsx sends the disableImportedTableData
	 * message and, for a wholly-imported table (nothing left at all once its only import is switched off),
	 * closes this table's tab too. No confirmation behind it: disabling only switches imported data off for
	 * this connection, and it can be switched back on from the menu item below or from View Imports. See
	 * app.tsx's handleDisableImportedChange. */
	onDisableImportedChange: () => void;
	/** Table tab header's "Enable Imported Changes" menu item - shown only while
	 * TreeTableEntry.hasDisabledImports is set. See app.tsx's handleEnableImportedChange. */
	onEnableImportedChange: () => void;
	/** Which sub-tab is selected - lifted to app.tsx (rather than local state) so it survives switching
	 * between open tables instead of resetting every time this component remounts for a new table (see
	 * the key={tableKeyToString(...)} on TableDetail in app.tsx). app.tsx resets it back to 'info' once
	 * every table tab is closed. */
	subTab: SubTabKey;
	onSubTabChange: (value: SubTabKey) => void;
}

// One level deeper than strictly needed for v1's sub-tabs, so future categories can be added as
// sibling tabs without restructuring this component.
// 'definition' is a view's, a routine's and a materialized query table's tab (see ViewDetail, RoutineDetail), 'parameters'/'resultColumns'/
// 'programSource' a routine's - one shared key type, since app.tsx remembers a single selected sub-tab across every open
// tab, whatever its kind.
export type SubTabKey = 'info' | 'definition' | 'parameters' | 'resultColumns' | 'programSource' | 'columns' | 'tableKeys' | 'foreignKeys' | 'indexes' | 'advisedIndexes' | 'triggers' | 'data';

const NOT_TABLE_SUB_TABS: readonly SubTabKey[] = ['definition', 'parameters', 'resultColumns', 'programSource'];

const NOT_MQT_SUB_TABS: readonly SubTabKey[] = ['tableKeys', 'foreignKeys', 'triggers'];

export function TableDetail({ entry, currentSortSequence, currentSortSequenceLibrary, editMode, onEnterEditMode, onCancelEditClick, isRunning, pendingStatements, onUpsertStatement, onDeleteStatement, runCompletionNotice, onOpenExport, onDisableImportedChange, onEnableImportedChange, subTab, onSubTabChange }: Props) {
	const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLElement | null>(null);

	const { connected } = entry;
	const imported = entry.imported ?? [];
	// Presence/absence is the whole signal - no connected data at all means this table doesn't exist in
	// the database yet; both means a real table enhanced with imported data. See TreeTableEntry.
	const badge: 'imported' | 'enhanced' | null = !connected && imported.length > 0 ? 'imported' : connected && imported.length > 0 ? 'enhanced' : null;
	// Columns/Table Keys/Foreign Keys/Indexes each show a leading flags column (New/Imported chip) only
	// when there's something for it to ever flag - a plain connected-only table's rows are never isNew.
	const hasImportedData = badge !== null;

	let key = getEntryKey(entry);
	// Columns/Table Keys/Foreign Keys/Indexes only ever need schema/name (never the rest of
	// SchemasSystemTable's DB2 catalog fields), so this works whether or not a live table backs this
	// entry - the host resolves either way. See table-resolver.ts.
	let minimalTable = { schema: key.schema, name: key.table };

	// Columns/Table Keys/Foreign Keys/Indexes each fetch once on mount and hold the result in their own
	// state - they never re-fetch just because hasImportedData (a display-only prop, driving the "New"
	// flags column) changes. Without forcing a remount here, adding or removing an import while one of
	// these tabs is already open would leave it showing stale rows - e.g. "Remove Imported Change"
	// hiding the flags column but leaving a since-removed imported-only row still sitting there. Keying
	// on a fingerprint of the imported set (not just its length, in case a same-count swap ever happens)
	// forces exactly these tabs to remount and refetch whenever this table's imports actually change.
	let importedFingerprint = imported.map(table => table.provenance.importedAt).sort().join('|');

	function handleMenuOpen(event: MouseEvent<HTMLElement>) {
		setMenuAnchorEl(event.currentTarget);
	}

	function handleMenuClose() {
		setMenuAnchorEl(null);
	}

	function handleExportClick() {
		handleMenuClose();
		onOpenExport();
	}

	// Neither direction confirms: both only switch imported data on or off for this connection, and the
	// other menu item switches it straight back.
	function handleDisableImportedChangeClick() {
		handleMenuClose();
		onDisableImportedChange();
	}

	function handleEnableImportedChangeClick() {
		handleMenuClose();
		onEnableImportedChange();
	}
	// Every other sub-tab below unmounts on switch (cheap - the host caches their queries). The Data
	// tab is different: it accumulates paged rows and scroll position that shouldn't be thrown away
	// every time the user glances at another tab, so once opened it stays mounted (hidden via
	// display: none rather than unmounted) for as long as this table's detail view is. Switching to
	// a different table remounts TableDetail entirely (see app.tsx's key={tableKeyToString(...)}),
	// which naturally resets this too.
	const [dataTabOpened, setDataTabOpened] = useState(Boolean(connected) && subTab === 'data');

	// Advised Indexes/Triggers/Data only exist for a connected table. The remembered subTab can point at one of
	// those while the current entry is imported-only (e.g. it was last set on a different, connected,
	// table) - fall back to Info for display only, without touching the remembered value itself, so
	// switching to another connected table still lands back on Advised Indexes/Triggers/Data as expected.
	const requiresConnected = subTab === 'advisedIndexes' || subTab === 'triggers' || subTab === 'data';
	// A materialized query table gets one more tab - the select statement it was created from - and loses the
	// three that never have anything to show for one: its rows come from its select, so it has no constraints
	// or triggers of its own.
	const isMqt = connected != null && SystemTable.isMqt(connected);
	// Same fallback for a view or function tab remembered from one that was open before this table - except
	// Definition, which an MQT has too - and for a table-only tab remembered when an MQT opens.
	const notThisTable = (NOT_TABLE_SUB_TABS.includes(subTab) && !(isMqt && subTab === 'definition'))
		|| (isMqt && NOT_MQT_SUB_TABS.includes(subTab));
	const displaySubTab: SubTabKey = (requiresConnected && !connected) || notThisTable ? 'info' : subTab;

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
					<Box component="span">{key.schema}/{key.table} {connected?.description}</Box>
				</Typography>

				{badge && <ImportBadge kind={badge} tooltip={BADGE_HELP_TEXT[badge]} />}

				<IconButton size="small" aria-label="Table options" onClick={handleMenuOpen}>
					<MoreVertIcon fontSize="small" />
				</IconButton>

				<Menu anchorEl={menuAnchorEl} open={menuAnchorEl !== null} onClose={handleMenuClose}>
					<MenuItem onClick={handleExportClick}>Export</MenuItem>
					{hasImportedData && <MenuItem onClick={handleDisableImportedChangeClick}>Disable Imported Changes</MenuItem>}
					{/* Both can show at once on a partly-disabled table: some of its imports are on, some off. */}
					{entry.hasDisabledImports && <MenuItem onClick={handleEnableImportedChangeClick}>Enable Imported Changes</MenuItem>}
				</Menu>
			</Stack>

			<Tabs value={displaySubTab} onChange={(_, value: SubTabKey) => handleSubTabChange(value)}>
				<Tab label="Info" value="info" />
				<Tab label="Columns" value="columns" />
				{isMqt && <Tab label="Definition" value="definition" />}
				{!isMqt && <Tab label="Table Keys" value="tableKeys" />}
				{!isMqt && <Tab label="Foreign Keys" value="foreignKeys" />}
				<Tab label="Indexes" value="indexes" />
				{connected && <Tab label="Advised Indexes" value="advisedIndexes" />}
				{connected && !isMqt && <Tab label="Triggers" value="triggers" />}
				{connected && <Tab label="Data" value="data" />}
			</Tabs>

			<Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto' }}>
				{displaySubTab === 'info' && (connected ? <InfoTab table={connected} /> : <ImportedInfoTab imported={imported} />)}
				{displaySubTab === 'columns' && <ColumnsTab key={importedFingerprint} table={minimalTable} hasImportedData={hasImportedData} />}
				{isMqt && displaySubTab === 'definition' && <ViewDefinitionTab view={minimalTable} source="mqt" />}
				{displaySubTab === 'tableKeys' && <TableKeysTab key={importedFingerprint} table={minimalTable} hasImportedData={hasImportedData} />}
				{displaySubTab === 'foreignKeys' && <ForeignKeysTab key={importedFingerprint} table={minimalTable} hasImportedData={hasImportedData} />}
				{displaySubTab === 'indexes' && <IndexesTab key={importedFingerprint} table={minimalTable} hasImportedData={hasImportedData} />}
				{connected && displaySubTab === 'advisedIndexes' && (
					<AdvisedIndexesTab
						table={connected}
						currentSortSequence={currentSortSequence}
						currentSortSequenceLibrary={currentSortSequenceLibrary}
					/>
				)}
				{connected && displaySubTab === 'triggers' && <TriggersTab table={minimalTable} />}
				{connected && dataTabOpened && (
					<Box sx={{ display: displaySubTab === 'data' ? 'contents' : 'none', height: '100%', minHeight: 0 }}>
						<TableDataTab
							table={connected}
							editMode={editMode}
							onEnterEditMode={onEnterEditMode}
							onCancelEditClick={onCancelEditClick}
							isRunning={isRunning}
							pendingStatements={pendingStatements}
							onUpsertStatement={onUpsertStatement}
							onDeleteStatement={onDeleteStatement}
							runCompletionNotice={runCompletionNotice}
						/>
					</Box>
				)}
			</Box>
		</Stack>
	);
}
