import { Box, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import { CopyIconButton } from './copy-icon-button';

interface Props {
	sql: string;
	/** Tints the block red - a statement that can't run as it stands. */
	invalid?: boolean;
}

// Extracted from HistoryTab's history entry rendering - reused as-is by RunSqlPanel for pending
// statements.
export function SqlStatementBlock({ sql, invalid }: Props) {
	return (
		<Box sx={invalid ? theme => ({ position: 'relative', borderRadius: 1, backgroundColor: alpha(theme.palette.error.main, 0.15) }) : { position: 'relative' }}>
			<Typography component="code" sx={{ display: 'block', fontFamily: 'monospace', whiteSpace: 'pre-wrap', pt: 1, pr: 4, pb: 1, pl: 1 }}>{sql}</Typography>
			<CopyIconButton text={sql} label="Copy SQL" sx={{ position: 'absolute', top: 0, right: 0 }} />
		</Box>
	);
}
