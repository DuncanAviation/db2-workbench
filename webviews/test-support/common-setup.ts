import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { installVsCodeApiStub, resetVsCodeApiStub } from './vscode-api-stub';
import { setInitialState } from './render-webview';

// The part of the per-file setup both webview suites share - the jsdom suite (setup.ts) and the real
// browser suite (browser-setup.ts). Imported first by each, so that it still runs ahead of the spec
// file's own imports, which is what lets the acquireVsCodeApi() stub exist by the time a bundle's
// vscode-api.ts calls it at import time.

installVsCodeApiStub();

afterEach(() => {
	// globals: false means Testing Library can't register its own automatic cleanup.
	cleanup();
	resetVsCodeApiStub();
	setInitialState(undefined);
	document.body.className = '';
});
