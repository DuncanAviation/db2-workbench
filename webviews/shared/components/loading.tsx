import { CircularProgress, Stack, Typography } from '@mui/material';

interface Props {
	message: string;
}

// The one loading treatment (spinner + message) all webviews should use for an in-progress
// async fetch, so tabs/panels don't drift into their own plain-text "Loading..." variants.
export function Loading({ message }: Props) {
	return (
		<Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', p: 2 }}>
			<CircularProgress size={16} thickness={5} />
			<Typography>{message}</Typography>
		</Stack>
	);
}
