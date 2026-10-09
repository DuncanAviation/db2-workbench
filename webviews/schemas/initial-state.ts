import type { SchemasInitialState } from '../../src/webview-messages/schemas-messages.js';

export function getInitialState(): SchemasInitialState {
	let initialState = (window as unknown as { __INITIAL_STATE__?: SchemasInitialState }).__INITIAL_STATE__;

	if (!initialState) {
		throw new Error('Initial state was not provided by the extension host.');
	}

	return initialState;
}
