export interface VsCodeApi<TOutbound = unknown> {
	postMessage(message: TOutbound): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi<TOutbound = unknown>(): VsCodeApi<TOutbound>;

let vscodeApi: VsCodeApi<unknown> | undefined;

/**
 * Each webview may only call acquireVsCodeApi() once, so the underlying instance is a singleton;
 * the type parameter only narrows postMessage's payload type for the caller, it doesn't affect that instance.
 */
export function getVsCodeApi<TOutbound = unknown>(): VsCodeApi<TOutbound> {
	if (!vscodeApi) {
		vscodeApi = acquireVsCodeApi();
	}
	return vscodeApi as VsCodeApi<TOutbound>;
}
