import type { VsCodeApi } from '../shared/vscode-api';

// Stands in for the `acquireVsCodeApi()` global that VS Code injects into a real webview. Each
// bundle's vscode-api.ts calls it once, at import time, and caches the result as a module-level
// singleton (see webviews/shared/vscode-api.ts) - so this has to be installed before any bundle
// module is imported (setup.ts does that), and it must be reset in place between tests rather than
// replaced, since the bundle is still holding the first object it was given.

let posted: unknown[] = [];
let state: unknown;
let acquireCount = 0;

const api: VsCodeApi<unknown> = {
	postMessage(message: unknown) {
		// Structured clone, the same as a real postMessage - a test then sees exactly what the host
		// would receive, and can't be fooled by the webview mutating the object after posting it.
		posted.push(structuredClone(message));
	},
	getState() {
		return state;
	},
	setState(newState: unknown) {
		state = newState;
	}
};

export function installVsCodeApiStub(): void {
	(globalThis as unknown as { acquireVsCodeApi: () => VsCodeApi<unknown> }).acquireVsCodeApi = () => {
		acquireCount++;

		// VS Code refuses a second acquire in the same webview, so a bundle that calls it twice is
		// broken in the real host - fail here too instead of quietly handing back the same object.
		if (acquireCount > 1) {
			throw new Error('An instance of the VS Code API has already been acquired');
		}

		return api;
	};
}

export function resetVsCodeApiStub(): void {
	posted = [];
	state = undefined;
}

/** Every message the webview has posted to the host since the current test started, oldest first. */
export function postedMessages<TOutbound>(): TOutbound[] {
	return [...posted] as TOutbound[];
}

/** The persisted webview state last set through `setState()`, as VS Code would restore it. */
export function webviewState(): unknown {
	return state;
}
