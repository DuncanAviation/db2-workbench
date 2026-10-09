import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { createVsCodeTheme } from './create-vscode-theme';
import { useVsCodeThemeKind } from './use-vscode-theme-kind';

export interface VsCodeThemeProviderProps {
	children: ReactNode;
}

export function VsCodeThemeProvider({ children }: VsCodeThemeProviderProps) {
	const themeKind = useVsCodeThemeKind();
	const theme = useMemo(() => createVsCodeTheme(themeKind), [themeKind]);

	return (
		<ThemeProvider theme={theme}>
			<CssBaseline />
			{children}
		</ThemeProvider>
	);
}
