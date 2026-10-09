import './common-setup';

// Runs before every spec file of the real browser suite (vitest.browser.config.ts), ahead of that
// file's own imports. None of setup.ts's jsdom shims belong here: Chromium has real layout, real
// ResizeObserver, matchMedia, scrollIntoView and canvas, and stubbing any of them would throw away
// exactly what this suite exists to exercise.

// The same body style WebviewHtmlUtils.getReactWebviewHtml() gives every webview, so a bundle that
// sizes itself to 100vw/100vh (the diagram does) fills the viewport here the way it fills a webview
// panel, rather than being pushed down and right by the browser's default 8px margin.
document.body.style.margin = '0';
document.body.style.padding = '0';
