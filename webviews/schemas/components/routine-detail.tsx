import { Box, Stack, Tab, Tabs, Typography } from '@mui/material';
import type { SchemasSystemRoutine } from '../../../src/webview-messages/schemas-messages';
import { RoutineDefinitionTab } from './routine-definition-tab';
import { RoutineInfoTab } from './routine-info-tab';
import { RoutineParamsTab } from './routine-params-tab';
import { RoutineProgramSourceTab } from './routine-program-source-tab';
import type { SubTabKey } from './table-detail';

interface Props {
	routine: SchemasSystemRoutine;
	/** Shared with TableDetail - see app.tsx. A tab this routine doesn't have falls back to Info. */
	subTab: SubTabKey;
	onSubTabChange: (value: SubTabKey) => void;
}

// A function's or procedure's counterpart to TableDetail and ViewDetail. Both kinds share the tabs, since
// both are SYSROUTINES rows with SYSPARMS parameters. Result Columns only exists for a table function, and
// Program Source for an external routine - one that runs a program rather than an SQL body.
export function RoutineDetail({ routine, subTab, onSubTabChange }: Props) {
	const isTableFunction = routine.functionType === 'T';
	const isExternal = routine.body === 'EXTERNAL';
	const subTabs: readonly SubTabKey[] = [
		'info', 'parameters',
		...(isTableFunction ? ['resultColumns' as const] : []),
		'definition',
		...(isExternal ? ['programSource' as const] : [])
	];
	const displaySubTab: SubTabKey = subTabs.includes(subTab) ? subTab : 'info';

	return (
		<Stack sx={{ flexGrow: 1, minHeight: 0, overflow: 'hidden' }}>
			<Stack direction="row" sx={{ alignItems: 'center', gap: 1, px: 2, py: 1, flexShrink: 0 }}>
				<Typography noWrap sx={{ minWidth: 0 }}>
					<Box component="span">{routine.schema}/{routine.signature ?? routine.name} {routine.description}</Box>
				</Typography>
			</Stack>

			<Tabs value={displaySubTab} onChange={(_, value: SubTabKey) => onSubTabChange(value)}>
				<Tab label="Info" value="info" />
				<Tab label="Parameters" value="parameters" />
				{isTableFunction && <Tab label="Result Columns" value="resultColumns" />}
				<Tab label="Definition" value="definition" />
				{isExternal && <Tab label="Program Source" value="programSource" />}
			</Tabs>

			<Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto' }}>
				{displaySubTab === 'info' && <RoutineInfoTab routine={routine} />}
				{displaySubTab === 'parameters' && <RoutineParamsTab routine={routine} rowType="P" />}
				{displaySubTab === 'resultColumns' && <RoutineParamsTab routine={routine} rowType="R" />}
				{displaySubTab === 'definition' && <RoutineDefinitionTab routine={routine} />}
				{displaySubTab === 'programSource' && <RoutineProgramSourceTab routine={routine} />}
			</Box>
		</Stack>
	);
}
