import { act } from '@testing-library/react';

/**
 * Delivers a message to the webview the way the host's `panel.webview.postMessage()` does: as a
 * `message` event on `window`, which each bundle's app.tsx listens for. Wrapped in `act()` so the
 * resulting state update has rendered by the time this returns.
 */
export function postFromHost<TInbound>(message: TInbound): void {
	act(() => {
		window.dispatchEvent(new MessageEvent('message', { data: structuredClone(message) }));
	});
}
