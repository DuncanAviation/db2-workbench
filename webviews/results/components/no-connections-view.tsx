import { Button, Stack, Typography } from '@mui/material';
import { resultsVsCodeApi } from '../vscode-api';

interface Props {
	extensionName: string;
}

export function NoConnectionsView({ extensionName }: Props) {
	function handleAddConnection() {
		resultsVsCodeApi.postMessage({ command: 'addConnection' });
	}

	return (
		<Stack spacing={2} sx={{ p: 2 }}>
			<Typography>Welcome to {extensionName}. To begin, add a connection.</Typography>
			<Button variant="contained" onClick={handleAddConnection} sx={{ alignSelf: 'flex-start' }}>Add a Connection</Button>
		</Stack>
	);
}
