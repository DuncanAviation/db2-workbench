import type { ReactElement, ReactNode } from 'react';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { VsCodeThemeProvider } from '../shared/theme/vscode-theme-provider';
import type { VsCodeThemeKind } from '../shared/theme/use-vscode-theme-kind';

export interface RenderWebviewOptions<TInitialState> {
	/** Embedded as `window.__INITIAL_STATE__`, the way WebviewHtmlUtils.getReactWebviewHtml() does,
	 * for the bundle's own initial-state.ts to read. Omit it to test a bundle that was given none. */
	initialState?: TInitialState;
	/** The body class VS Code sets for its color theme, which useVsCodeThemeKind() reads. */
	themeKind?: VsCodeThemeKind;
	/** Wrap in the date-picker LocalizationProvider, as the results and schemas bundles' index.tsx do.
	 * Off by default so a bundle that doesn't mount one in production doesn't get one here either. */
	withDatePickers?: boolean;
}

const THEME_BODY_CLASSES: Record<VsCodeThemeKind, string> = {
	'light': 'vscode-light',
	'dark': 'vscode-dark',
	'high-contrast': 'vscode-high-contrast',
	'high-contrast-light': 'vscode-high-contrast-light'
};

export function setInitialState<TInitialState>(initialState: TInitialState | undefined): void {
	let target = window as unknown as { __INITIAL_STATE__?: TInitialState };

	if (initialState === undefined) {
		delete target.__INITIAL_STATE__;
	} else {
		// Round-tripped through JSON because that is how the host embeds it - a Date or undefined
		// field in a fixture then arrives the way it would in production, not as the original object.
		target.__INITIAL_STATE__ = JSON.parse(JSON.stringify(initialState)) as TInitialState;
	}
}

/**
 * Renders a webview component inside the same providers its bundle's index.tsx mounts it in, with
 * the given initial state embedded first.
 */
export function renderWebview<TInitialState>(ui: ReactElement, options: RenderWebviewOptions<TInitialState> = {}): RenderResult {
	setInitialState(options.initialState);
	document.body.className = THEME_BODY_CLASSES[options.themeKind ?? 'dark'];

	// Passed as Testing Library's `wrapper` rather than wrapped around `ui` here, so the returned
	// rerender() keeps the providers - a test can then hand the component new props the way its parent would.
	function Providers({ children }: { children: ReactNode }) {
		let content = options.withDatePickers
			? <LocalizationProvider dateAdapter={AdapterDayjs}>{children}</LocalizationProvider>
			: children;

		return <VsCodeThemeProvider>{content}</VsCodeThemeProvider>;
	}

	return render(ui, { wrapper: Providers });
}
