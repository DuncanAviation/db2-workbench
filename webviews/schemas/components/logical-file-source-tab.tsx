import { Stack, Typography } from '@mui/material';
import type { SchemasSystemView } from '../../../src/webview-messages/schemas-messages';
import { ButtonGroup } from '../../shared/components/button-group';
import { Loading } from '../../shared/components/loading';
import { SqlErrorDisplay } from '../../shared/components/sql-error-display';
import { useLogicalFileSource } from './logical-file-data';
import { ProgramSourceView } from './program-source-view';

interface Props {
	file: SchemasSystemView;
}

// The DDS a logical file was created from - the source member SYSFILES records, read the way a program's
// source is (see SchemasProvider.postLogicalFileSource). Read from the system each time, so Refresh shows
// whatever the member holds now.
export function LogicalFileSourceTab({ file }: Props) {
	const loaded = useLogicalFileSource({ schema: file.schema, name: file.name });
	const refresh = <ButtonGroup actions={[{ label: 'Refresh', onClick: loaded.refresh }]} />;

	if (loaded.error) {
		return (
			<Stack sx={{ p: 2 }}>
				<SqlErrorDisplay error={loaded.error} label="Failed to find the logical file's source" />
			</Stack>
		);
	}

	if (!loaded.value) {
		return <Loading message="Loading source..." />;
	}

	let { sources, unavailable } = loaded.value;

	if (!unavailable && sources.length > 0) {
		return (
			<Stack spacing={1} sx={{ p: 2, height: '100%', minHeight: 0, boxSizing: 'border-box' }}>
				<ProgramSourceView sources={sources} editorLabel="Logical file source" locationActions={refresh} />
			</Stack>
		);
	}

	return (
		<Stack spacing={1} sx={{ p: 2 }}>
			<Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
				<Typography>{file.schema}/{file.name}</Typography>
				{refresh}
			</Stack>
			<Typography>{unavailable ?? `No source member is recorded for ${file.schema}/${file.name}.`}</Typography>
		</Stack>
	);
}
