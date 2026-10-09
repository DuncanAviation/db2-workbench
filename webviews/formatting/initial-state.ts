import type { FormattingEditorInitialState } from '../../src/webview-messages/formatting-editor-messages.js';

export function getInitialState(): FormattingEditorInitialState {
	let initialState = (window as unknown as { __INITIAL_STATE__?: FormattingEditorInitialState }).__INITIAL_STATE__;

	if (!initialState) {
		throw new Error('Initial state was not provided by the extension host.');
	}

	return initialState;
}
