import { Alert } from '@mui/material';
import type { SxProps, Theme } from '@mui/material';
import type { ReactNode } from 'react';

interface Props {
	sx?: SxProps<Theme>;
	children: ReactNode;
}

// The one warning treatment (MUI Alert, severity="warning") all webviews should use for an
// inline caution/limitation message, so tabs/panels don't drift into their own Alert styling.
export function WarningAlert({ sx, children }: Props) {
	return (
		<Alert severity="warning" sx={sx}>
			{children}
		</Alert>
	);
}
