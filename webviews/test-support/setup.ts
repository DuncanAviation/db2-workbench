import './common-setup';

// Runs before every spec file of the jsdom suite, ahead of that file's own imports (vitest's
// setupFiles). The acquireVsCodeApi() stub and the per-test reset live in common-setup.ts, shared
// with the real browser suite (browser-setup.ts); what is left here only exists because of jsdom.

// jsdom has no layout engine and leaves out a few browser APIs the webviews rely on. These make the
// components mount; they do not make layout real - every element still measures 0x0, so anything
// that depends on measured size (virtualized rows, React Flow node bounds) needs its own handling in
// the test that cares about it.
if (!('ResizeObserver' in globalThis)) {
	class NoopResizeObserver {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	}

	(globalThis as unknown as { ResizeObserver: typeof NoopResizeObserver }).ResizeObserver = NoopResizeObserver;
}

if (!window.matchMedia) {
	window.matchMedia = (query: string): MediaQueryList => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false
	});
}

// jsdom has no scrolling, so it leaves scrollIntoView out entirely. A no-op keeps callers such as the
// Run SQL panel's follow-the-running-statement effect from throwing; whether it scrolls is not tested.
if (!Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => {};
}

// jsdom's canvas already returns null from getContext() - it only adds a "Not implemented" console
// error on every call. Returning null quietly keeps the behaviour and drops the noise. Callers such as
// measureColumnWidths() in shared/utils/row-columns.tsx already treat a null context as "can't
// measure", so column widths are simply not exercised by this suite.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
