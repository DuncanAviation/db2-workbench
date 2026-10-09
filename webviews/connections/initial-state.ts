import type { ConnectionEditorInitialState } from '../../src/webview-messages/connection-editor-messages.js';

export function getInitialState(): ConnectionEditorInitialState {
	let initialState = (window as unknown as { __INITIAL_STATE__?: ConnectionEditorInitialState }).__INITIAL_STATE__;

	if (!initialState) {
		throw new Error('Initial state was not provided by the extension host.');
	}

	return initialState;
}
