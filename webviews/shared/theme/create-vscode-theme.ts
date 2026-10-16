import type { Theme } from '@mui/material/styles';
import { createTheme } from '@mui/material/styles';
import type { VsCodeThemeKind } from './use-vscode-theme-kind';

/** The colors VS Code's own tables use (the Keyboard Shortcuts editor), for DataTable to match them. */
export interface DataTablePalette {
	/** Every other row's background - translucent, laid over the row's own background. */
	stripe: string;
	/** The header row's background - translucent, like stripe. */
	header: string;
	/** The line between columns. */
	columnBorder: string;
}

declare module '@mui/material/styles' {
	interface Palette {
		/** Optional so a plain createTheme() (a test's, say) still type-checks; DataTable falls back without it. */
		dataTable?: DataTablePalette;
	}

	interface PaletteOptions {
		dataTable?: DataTablePalette;
	}
}

/** How long the pointer must rest on something before its tooltip shows - see MuiTooltip below. */
export const TOOLTIP_ENTER_DELAY_MS = 500;

export function createVsCodeTheme(themeKind: VsCodeThemeKind): Theme {
	const mode = themeKind === 'light' || themeKind === 'high-contrast-light' ? 'light' : 'dark';
	const isLight = mode === 'light';
	const isHighContrast = themeKind === 'high-contrast' || themeKind === 'high-contrast-light';

	// Resolves a --vscode-* custom property to its current computed color value (e.g. "#0e639c").
	// MUI palette colors get passed through alpha()/decomposeColor() at render time (Button hover/focus
	// overlays, etc), which only understand literal color formats - a raw `var(--vscode-x)` string
	// crashes the first time anything tries to manipulate it, so resolve to the actual color up front.
	function read(name: string, darkFallback: string, lightFallback: string): string {
		const fallback = isLight ? lightFallback : darkFallback;
		const value = getComputedStyle(document.body).getPropertyValue(name).trim();
		return value || fallback;
	}

	// The first of several --vscode-* properties that's set - for a token VS Code itself defaults to another.
	function readFirst(names: string[], fallback: string): string {
		const style = getComputedStyle(document.body);

		for (const name of names) {
			const value = style.getPropertyValue(name).trim();

			if (value) {
				return value;
			}
		}

		return fallback;
	}

	// VS Code's own defaults, used only when a theme leaves the token unset: its foreground at 4% for the
	// stripes and header, at 12.5% for column lines. High contrast themes stripe nothing, so neither does
	// this - a fully transparent color rather than 'transparent', which MUI's color helpers can't parse.
	const tableTint = isHighContrast ? 'rgba(0, 0, 0, 0)' : isLight ? '#6161610a' : '#cccccc0a';
	const tableStripe = readFirst(['--vscode-keybindingTable-rowsBackground', '--vscode-tree-tableOddRowsBackground'], tableTint);

	return createTheme({
		palette: {
			mode,
			dataTable: {
				stripe: tableStripe,
				header: readFirst(['--vscode-keybindingTable-headerBackground', '--vscode-tree-tableOddRowsBackground'], tableTint),
				columnBorder: readFirst(['--vscode-tree-tableColumnsBorder', '--vscode-contrastBorder'], isLight ? '#61616120' : '#cccccc20'),
			},
			background: {
				default: read('--vscode-editor-background', '#1e1e1e', '#ffffff'),
				paper: read('--vscode-editor-background', '#1e1e1e', '#ffffff'),
			},
			text: {
				primary: read('--vscode-foreground', '#cccccc', '#3b3b3b'),
				secondary: read('--vscode-descriptionForeground', '#9d9d9d', '#717171'),
				disabled: read('--vscode-disabledForeground', '#6b6b6b', '#a1a1a1'),
			},
			// light/dark/contrastText are set explicitly for primary/secondary/error rather than left
			// for MUI to derive, since augmentColor() also runs decomposeColor() on `main`.
			primary: {
				main: read('--vscode-button-background', '#0e639c', '#007acc'),
				light: read('--vscode-button-background', '#0e639c', '#007acc'),
				dark: read('--vscode-button-hoverBackground', '#1177bb', '#0062a3'),
				contrastText: read('--vscode-button-foreground', '#ffffff', '#ffffff'),
			},
			secondary: {
				main: read('--vscode-button-secondaryBackground', '#3a3d41', '#5f6a79'),
				light: read('--vscode-button-secondaryBackground', '#3a3d41', '#5f6a79'),
				dark: read('--vscode-button-secondaryHoverBackground', '#45494e', '#4c5561'),
				contrastText: read('--vscode-button-secondaryForeground', '#ffffff', '#ffffff'),
			},
			error: {
				main: read('--vscode-errorForeground', '#f48771', '#a1260d'),
				light: read('--vscode-errorForeground', '#f48771', '#a1260d'),
				dark: read('--vscode-errorForeground', '#f48771', '#a1260d'),
				contrastText: '#ffffff',
			},
			divider: read('--vscode-widget-border', '#80808040', '#80808040'),
		},
		shape: {
			borderRadius: 3,
		},
		typography: {
			fontFamily: read('--vscode-font-family', '"Segoe UI", sans-serif', '"Segoe UI", sans-serif'),
			fontSize: parseFloat(read('--vscode-font-size', '13px', '13px')) || 13,
		},
		components: {
			MuiTooltip: {
				defaultProps: {
					// Every tooltip in every webview waits this long before showing, like VS Code's own
					// hovers, rather than MUI's 100ms - quick enough to find, slow enough not to pop up over
					// a grid or diagram the pointer is just passing across. MUI's hysteresis still opens the
					// next tooltip at once while moving between neighbouring ones.
					enterDelay: TOOLTIP_ENTER_DELAY_MS,
				},
			},
			MuiButtonBase: {
				defaultProps: {
					disableRipple: true,
				},
				styleOverrides: {
					// MUI's default focus-visible indicator is a faint overlay tint - easy to miss
					// against a solid button background. Use VS Code's own focus-ring color/convention
					// instead, matching what tabbing through the rest of the editor looks like.
					root: {
						'&.Mui-focusVisible': {
							outline: `2px solid ${read('--vscode-focusBorder', '#007fd4', '#0090f1')}`,
							outlineOffset: 2,
						},
					},
				},
			},
			MuiButton: {
				styleOverrides: {
					// `secondary.main` maps to --vscode-button-secondaryBackground, which is meant
					// for contained button backgrounds, not text. Outlined buttons need a color
					// that's actually legible against the page background.
					outlined: {
						color: read('--vscode-foreground', '#cccccc', '#3b3b3b'),
						borderColor: read('--vscode-contrastBorder', '#6b6b6b', '#a1a1a1'),
					},
				},
			},
			MuiToggleButton: {
				styleOverrides: {
					// ToggleButton's default border/selected-state colors come from palette.divider
					// (mapped above to --vscode-widget-border, a faint token meant for subtle
					// separators - not a visible control outline) and MUI's generic action/text-primary
					// overlay palette (flat gray, no accent color). Swap in the same
					// --vscode-inputOption-* tokens VS Code's own toggle controls use (e.g. the search
					// widget's Match Case/Whole Word/Regex buttons) so this reads as a native toggle.
					root: {
						color: read('--vscode-foreground', '#cccccc', '#3b3b3b'),
						borderColor: read('--vscode-contrastBorder', '#6b6b6b', '#a1a1a1'),
						'&:hover': {
							backgroundColor: read('--vscode-inputOption-hoverBackground', '#5a5d5e80', '#b8b8b850'),
						},
						'&.Mui-selected': {
							color: read('--vscode-inputOption-activeForeground', '#ffffff', '#000000'),
							backgroundColor: read('--vscode-inputOption-activeBackground', '#0e639c66', '#007acc33'),
							borderColor: read('--vscode-inputOption-activeBorder', '#007acc', '#007acc'),
							'&:hover': {
								backgroundColor: read('--vscode-inputOption-activeBackground', '#0e639c66', '#007acc33'),
							},
						},
					},
				},
			},
		},
	});
}
