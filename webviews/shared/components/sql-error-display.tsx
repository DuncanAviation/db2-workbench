import { Stack, Typography } from '@mui/material';
import type { DbErrorUtils } from '../../../src/utils/db-error-utils';
import { DbErrorTable } from './db-error-table';

interface Props {
	error: DbErrorUtils.SerializedError;
	/** Prefixed onto the message as "label: message" - e.g. "Failed to load data". Omit to show the
	 * message on its own, matching how a statement's own row already establishes context (Run SQL panel). */
	label?: string;
}

// The one message + optional full driver error chain (SQLSTATE/code/message) rendering, shared by every
// surface that gets a SerializedError (see DbErrorUtils.serialize) instead of a pre-formatted string -
// the Run SQL panel's per-statement error and the Data tab's load error today.
export function SqlErrorDisplay({ error, label }: Props) {
	return (
		// textAlign: 'left' is explicit, not the assumed default - a caller may render this inside a
		// centered container (e.g. DataTable's emptyMessage cell), and text-align inherits through
		// descendants regardless of the table/table-cell display types in between, so without this the
		// message and the DbErrorTable's own cell text would come out centered too.
		<Stack spacing={0.5} sx={{ color: 'error.main', textAlign: 'left' }}>
			<Typography variant="body2">{label ? `${label}: ${error.message}` : error.message}</Typography>
			{error.driverErrors && <DbErrorTable driverErrors={error.driverErrors} />}
		</Stack>
	);
}
