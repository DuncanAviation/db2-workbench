import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

// The real browser suite: webviews/**/*.browser.spec.tsx, run in headless Chromium through Playwright.
// It exists for what jsdom can't do (see vitest.config.ts) - real layout, real element sizes and real
// pointer input - so the gestures that depend on them, such as dragging a diagram table, can be tested.
// Headless needs no display, so it runs the same on a developer machine and on a CI runner; the one
// prerequisite is the browser itself (`npx playwright install chromium`).
//
// Kept as its own config and npm script (test:webviews:browser) rather than a second project under
// test:webviews, so the jsdom suite still runs anywhere Node does without a browser download.
//
// Layout depends on the fonts installed, and those differ between a developer machine and a CI
// runner. Assert on relationships with a tolerance (a table moved by the dragged distance, within a
// pixel), never on absolute pixel positions or screenshots.
const BROWSER_VIEWPORT = { width: 1200, height: 800 };

export default defineConfig({
	root: import.meta.dirname,
	test: {
		globals: false,
		include: ['**/*.browser.spec.{ts,tsx}'],
		setupFiles: ['./test-support/browser-setup.ts'],
		// Empties the failure-screenshot directory before the run - see clear-attachments.ts.
		globalSetup: ['./test-support/clear-attachments.ts'],
		browser: {
			enabled: true,
			provider: playwright(),
			headless: true,
			instances: [{ browser: 'chromium' }],
			viewport: BROWSER_VIEWPORT
		}
	}
});
