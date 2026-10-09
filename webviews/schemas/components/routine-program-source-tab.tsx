import { Stack, Typography } from '@mui/material';
import type { SchemasSystemRoutine } from '../../../src/webview-messages/schemas-messages';
import { ButtonGroup } from '../../shared/components/button-group';
import { Loading } from '../../shared/components/loading';
import { SqlErrorDisplay } from '../../shared/components/sql-error-display';
import { ProgramSourceView } from './program-source-view';
import { routineNoun, useRoutineSource } from './routine-data';

interface Props {
	routine: SchemasSystemRoutine;
}

// An external routine's program source - the program, or the service program the routine's entry point is
// exported from, and the member or IFS file it was compiled from (see SchemasProvider.postRoutineSource).
// For a service program, only the module that defines the entry is shown - the others bound in alongside
// it say nothing about this routine - unless that module can't be told apart, when every module gets a
// tab. Read from the system each time, so Refresh shows whatever the members hold now.
export function RoutineProgramSourceTab({ routine }: Props) {
	const loaded = useRoutineSource({ schema: routine.schema, specificName: routine.specificName });
	const refresh = <ButtonGroup actions={[{ label: 'Refresh', onClick: loaded.refresh }]} />;

	if (loaded.error) {
		return (
			<Stack sx={{ p: 2 }}>
				<SqlErrorDisplay error={loaded.error} label={`Failed to find the ${routineNoun(routine)}'s program source`} />
			</Stack>
		);
	}

	if (!loaded.value) {
		return <Loading message="Loading source..." />;
	}

	let { program, entry, sources, entryModuleFound, resolvedFromLibraryList, unavailable } = loaded.value;
	let heading = entry ? `${program}, entry ${entry}` : program;

	// With source to show, the program isn't repeated - it is the Info tab's External Name. The one thing
	// that name doesn't say is which library a *LIBL (or unqualified) name found, so only that is shown,
	// sharing the source location's line.
	if (!unavailable && sources.length > 0) {
		return (
			<Stack spacing={1} sx={{ p: 2, height: '100%', minHeight: 0, boxSizing: 'border-box' }}>
				{entry && !entryModuleFound && sources.length > 1 && (
					<Typography variant="body2" color="text.secondary">
						Could not tell which module defines {entry}.
					</Typography>
				)}
				<ProgramSourceView
					sources={sources}
					editorLabel="Program source"
					locationPrefix={resolvedFromLibraryList && (
						<>
							<Typography noWrap sx={{ flexShrink: 0 }}>Found on the library list: {program}</Typography>
							<Typography color="text.secondary" aria-hidden>·</Typography>
						</>
					)}
					locationActions={refresh}
				/>
			</Stack>
		);
	}

	return (
		<Stack spacing={1} sx={{ p: 2 }}>
			<Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
				<Typography>{heading}</Typography>
				{refresh}
			</Stack>
			<Typography>{unavailable ?? `No source location is recorded for ${program}.`}</Typography>
		</Stack>
	);
}
