import { defineConfig } from 'vitest/config';

// The webview suite: React components under webviews/**, rendered into jsdom. Kept apart from the two
// mocha suites (out/**/*.spec.js and the VS Code host's out/test/**/*.test.js) because webview code is
// never compiled into out/ - esbuild bundles it straight to dist/webviews/ - so neither of their globs
// can reach it. vitest compiles the TS/TSX itself, so this suite needs no build step first.
//
// Lives under webviews/ rather than at the project root so that `tsc -p webviews` typechecks it, the
// webviews block of eslint.config.mjs lints it, and .vscodeignore's webviews/** keeps it out of the
// .vsix. At the root, the extension's own tsconfig.json would pick it up and fail its rootDir.
export default defineConfig({
	root: import.meta.dirname,
	test: {
		environment: 'jsdom',
		// Explicit `import { describe, it, expect } from 'vitest'` in every spec, rather than globals:
		// src/test-layout.spec.ts relies on that import to tell a vitest spec from a mocha one.
		globals: false,
		include: ['**/*.spec.{ts,tsx}'],
		// The real browser suite's specs (vitest.browser.config.ts). They import vitest/browser, which
		// only works inside a browser, and they depend on the real layout this suite doesn't have.
		exclude: ['**/node_modules/**', '**/*.browser.spec.{ts,tsx}'],
		setupFiles: ['./test-support/setup.ts'],
		// The slowest specs drive MUI fields keystroke by keystroke through userEvent, and every keystroke
		// re-renders the form. They take up to about 2s on a developer machine but went past vitest's
		// default 5s on CI's medium Windows runner. 20s matches the mocha timeout in .vscode-test.mjs.
		// A test that times out doesn't stop its pending keystrokes, which then land in the next test's
		// render - so one timeout here can show up as an unrelated-looking failure in the test after it.
		testTimeout: 20000
	}
});
