import type { ResultsInitialState } from '../../src/webview-messages/results-messages.js';

export function getInitialState(): ResultsInitialState {
	let initialState = (window as unknown as { __INITIAL_STATE__?: ResultsInitialState }).__INITIAL_STATE__;

	if (!initialState) {
		throw new Error('Initial state was not provided by the extension host.');
	}

	return initialState;
}
