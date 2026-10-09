import { createRoot } from 'react-dom/client';
import { App } from './app';
import { VsCodeThemeProvider } from '../shared/theme/vscode-theme-provider';

const container = document.getElementById('root');

if (container) {
	createRoot(container).render(
		<VsCodeThemeProvider>
			<App />
		</VsCodeThemeProvider>
	);
}
