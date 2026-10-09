import { Stack, Typography } from '@mui/material';
import type { ResultsSessionDetail } from '../../../src/webview-messages/results-messages';

interface Props {
	session: ResultsSessionDetail;
}

export function ConnectionTab({ session }: Props) {
	const info = session.connectionInfo;

	if (!info) {
		return <Typography sx={{ p: 2 }}>No connection yet</Typography>;
	}

	const schemaList = info.schemas.map(schema => schema.name).join(', ');

	return (
		<Stack spacing={2} sx={{ p: 2 }}>
			<Typography>Connected to <b>{session.connectionName}</b> on <b>{info.jobDetails.createdDate}</b> as <b>{session.userName}</b></Typography>

			<Stack spacing={1}>
				<Typography variant="subtitle1">Schema List</Typography>
				<Typography>{schemaList}</Typography>
			</Stack>

			<Stack spacing={1}>
				<Typography variant="subtitle1">Primary Connection</Typography>

				<Stack>
					<Typography variant="subtitle2">Job Name</Typography>
					<Typography>{info.jobDetails.jobName}</Typography>
				</Stack>

				<Stack>
					<Typography variant="subtitle2">IP</Typography>
					<Typography>{info.jobDetails.ip}</Typography>
				</Stack>

				<Stack>
					<Typography variant="subtitle2">Sort Sequence</Typography>
					<Typography>{info.jobDetails.sortSequence}</Typography>
				</Stack>
			</Stack>

			<Stack spacing={1}>
				<Typography variant="subtitle1">Worker Connection</Typography>

				<Stack>
					<Typography variant="subtitle2">Job Name</Typography>
					<Typography>{info.workerJobDetails.jobName}</Typography>
				</Stack>

				<Stack>
					<Typography variant="subtitle2">IP</Typography>
					<Typography>{info.workerJobDetails.ip}</Typography>
				</Stack>

				<Stack>
					<Typography variant="subtitle2">Sort Sequence</Typography>
					<Typography>{info.workerJobDetails.sortSequence}</Typography>
				</Stack>
			</Stack>
		</Stack>
	);
}
