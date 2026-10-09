import type { DiagramInitialState } from '../../src/webview-messages/diagram-messages.js';

export function getInitialState(): DiagramInitialState {
	let initialState = (window as unknown as { __INITIAL_STATE__?: DiagramInitialState }).__INITIAL_STATE__;

	if (!initialState) {
		throw new Error('Initial state was not provided by the extension host.');
	}

	return initialState;
}
