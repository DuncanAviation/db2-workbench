import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { installVsCodeApiStub, resetVsCodeApiStub } from './vscode-api-stub';
import { setInitialState } from './render-webview';

// The part of the per-file setup both webview suites share - the jsdom suite (setup.ts) and the real
// browser suite (browser-setup.ts). Imported first by each, so that it still runs ahead of the spec
// file's own imports, which is what lets the acquireVsCodeApi() stub exist by the time a bundle's
// vscode-api.ts calls it at import time.

installVsCodeApiStub();

// waitFor/findBy give up after 1s by default, which a busy CI runner can miss while it is still
// working through something as ordinary as a MUI dialog's exit transition. A real failure still
// fails, just later, and well inside the 20s test timeout.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
	// globals: false means Testing Library can't register its own automatic cleanup.
	cleanup();
	resetVsCodeApiStub();
	setInitialState(undefined);
	document.body.className = '';
});
