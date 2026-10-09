import { useState } from 'react';
import { Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import type { SchemasSystemRoutine } from '../../../src/webview-messages/schemas-messages';
import type { DbErrorUtils } from '../../../src/utils/db-error-utils';
import { ButtonGroup } from '../../shared/components/button-group';
import { Loading } from '../../shared/components/loading';
import { SourceEditor } from '../../shared/components/source-editor';
import { SqlErrorDisplay } from '../../shared/components/sql-error-display';
import { routineNoun, useRoutineDdl, useRoutineDetail } from './routine-data';

interface Props {
	routine: SchemasSystemRoutine;
}

type DefinitionMode = 'formatted' | 'raw';

function editorLabel(routine: SchemasSystemRoutine): string {
	return routine.routineType === 'PROCEDURE' ? 'Procedure definition' : 'Function definition';
}

// The statement that recreates the routine - CREATE OR REPLACE with its parameters, options and body - as
// IBM i's QSYS2.GENERATE_SQL writes it, already laid out by the system, so it is shown as is. Where
// GENERATE_SQL can't produce it (an older release, no authority to the object), the tab says so and falls
// back to the body SYSROUTINES stores.
export function RoutineDefinitionTab({ routine }: Props) {
	const ddl = useRoutineDdl(routine);

	if (ddl.value == null && ddl.error == null) {
		return <Loading message="Generating SQL..." />;
	}

	if (ddl.value) {
		return (
			<Stack spacing={1} sx={{ p: 2, height: '100%', minHeight: 0, boxSizing: 'border-box' }}>
				<Stack direction="row" sx={{ justifyContent: 'flex-end', flexShrink: 0 }}>
					<ButtonGroup actions={[{ label: 'Refresh', onClick: ddl.refresh }]} />
				</Stack>

				<SourceEditor aria-label={editorLabel(routine)} value={ddl.value} readOnly copyable />
			</Stack>
		);
	}

	return <StoredBody routine={routine} ddlError={ddl.error} onRefreshDdl={ddl.refresh} />;
}

interface StoredBodyProps extends Props {
	/** Why the full DDL isn't shown - absent when GENERATE_SQL ran but returned nothing. */
	ddlError: DbErrorUtils.SerializedError | null;
	onRefreshDdl: () => void;
}

// The fallback: SYSROUTINES.ROUTINE_DEFINITION, the body alone, formatted by default with the raw text a
// click away - the same as a view's Definition tab. An external routine has no body, only the program it
// runs, so that's what it names instead. Refresh retries the full DDL too.
function StoredBody({ routine, ddlError, onRefreshDdl }: StoredBodyProps) {
	const loaded = useRoutineDetail({ schema: routine.schema, specificName: routine.specificName });
	const [mode, setMode] = useState<DefinitionMode>('formatted');

	if (loaded.error) {
		return (
			<Stack sx={{ p: 2 }}>
				<SqlErrorDisplay error={loaded.error} label={`Failed to load the ${routineNoun(routine)} definition`} />
			</Stack>
		);
	}

	if (!loaded.value) {
		return <Loading message="Loading definition..." />;
	}

	let raw = loaded.value.detail?.definition ?? '';
	let refresh = (
		<ButtonGroup actions={[{
			label: 'Refresh',
			onClick: () => {
				onRefreshDdl();
				loaded.refresh();
			}
		}]} />
	);
	let notice = (
		<Typography variant="body2" color="text.secondary">
			The full SQL could not be generated{ddlError ? ` (${ddlError.message})` : ''}, so only the stored body is shown.
		</Typography>
	);

	if (!raw) {
		let externalName = loaded.value.detail?.externalName;

		return (
			<Stack spacing={1} sx={{ p: 2 }}>
				<Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
					<Typography>
						{externalName
							? `External ${routineNoun(routine)} - runs ${externalName}${routine.language ? ` (${routine.language})` : ''}.`
							: `No definition is stored for this ${routineNoun(routine)}.`}
					</Typography>
					{refresh}
				</Stack>
				{notice}
			</Stack>
		);
	}

	let text = mode === 'formatted' ? loaded.value.formattedDefinition || raw : raw;

	return (
		<Stack spacing={1} sx={{ p: 2, height: '100%', minHeight: 0, boxSizing: 'border-box' }}>
			<Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
				<ToggleButtonGroup
					size="small"
					exclusive
					value={mode}
					onChange={(_, value: DefinitionMode | null) => value && setMode(value)}
					aria-label="Definition format"
				>
					<ToggleButton value="formatted">Formatted</ToggleButton>
					<ToggleButton value="raw">Raw</ToggleButton>
				</ToggleButtonGroup>

				{refresh}
			</Stack>

			{notice}

			<SourceEditor aria-label={editorLabel(routine)} value={text} readOnly copyable />
		</Stack>
	);
}
