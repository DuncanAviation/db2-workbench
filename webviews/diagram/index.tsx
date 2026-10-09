import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import { App } from './app';
import { VsCodeThemeProvider } from '../shared/theme/vscode-theme-provider';

const container = document.getElementById('root');

if (container) {
	createRoot(container).render(
		<VsCodeThemeProvider>
			{/* App itself (not just the <ReactFlow> element it renders) needs to call
			useUpdateNodeInternals - see the comment above that call in app.tsx - which only works in a
			component that sits inside a ReactFlowProvider (or under <ReactFlow> itself, which is too
			late here since App is <ReactFlow>'s own parent). */}
			<ReactFlowProvider>
				<App />
			</ReactFlowProvider>
		</VsCodeThemeProvider>
	);
}
