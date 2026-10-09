import { Box, Stack, Typography } from '@mui/material';
import type { ImportedTableSchema } from '../../../src/schema-conversion/schema-format-converter';
import { formatImportTimestamp, getFormatLabel } from '../../shared/utils/import-labels';

interface Props {
	imported: ImportedTableSchema[];
}

// The imported-only counterpart to InfoTab - no live connection backs this table, so there's nothing to
// fetch and nothing beyond schema/name plus where each contribution came from to show.
export function ImportedInfoTab({ imported }: Props) {
	return (
		<Stack spacing={2} sx={{ p: 2 }}>
			<Typography>This table does not exist in the connected database yet.</Typography>

			<Stack spacing={1}>
				<Typography variant="subtitle1">Imported From</Typography>

				{imported.map((entry, index) => (
					<Box key={index} sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 2 }}>
						<Stack>
							<Typography variant="subtitle2">File</Typography>
							<Typography sx={{ wordBreak: 'break-word' }}>{entry.provenance.sourceLabel}</Typography>
						</Stack>
						<Stack>
							<Typography variant="subtitle2">Format</Typography>
							<Typography>{getFormatLabel(entry.provenance.sourceFormat)}</Typography>
						</Stack>
						<Stack>
							<Typography variant="subtitle2">Imported</Typography>
							<Typography>{formatImportTimestamp(entry.provenance.importedAt)}</Typography>
						</Stack>
					</Box>
				))}
			</Stack>
		</Stack>
	);
}
