import { expect } from 'chai';
import { readdirSync, readFileSync, statSync } from 'fs';
import * as path from 'path';

// Two suites, two globs: the unit suite runs `out/**/*.spec.js` and the integration suite runs
// `out/test/**/*.test.js`. A `*.test.ts` written anywhere but src/test/ therefore compiles happily
// and is then picked up by neither - it is not a failure, it is an absence, which is worse. That is
// exactly what happened to src/utils/parameter-parser.test.ts: 18 tests that had never run once.
//
// Same failure class as a stray `odbc` import (see src/database/drivers/driver-boundary.spec.ts),
// and guarded the same way - on every test run instead of by memory.
//
// A third suite runs vitest over `webviews/**/*.spec.ts(x)` in jsdom (see webviews/vitest.config.ts).
// Those specs share the *.spec suffix with the mocha ones, so the suffix alone can't say which runner
// a spec belongs to - its `vitest` import does. A mocha/chai spec under webviews/ is never compiled
// into out/ (webviews build with noEmit), so like a misfiled *.test.ts it simply never runs; a vitest
// spec under src/ is loaded by mocha and fails on import. The real browser suite's *.browser.spec.tsx
// (webviews/vitest.browser.config.ts) import vitest too, so the same rule covers them.
//
// Runs against the TypeScript sources rather than the compiled output, since out/ also carries
// source maps and older builds.
const SOURCE_ROOTS = ['src', 'webviews'];
const INTEGRATION_ROOT = path.join('src', 'test');
const WEBVIEW_ROOT = 'webviews';
const TEST_FILE_PATTERN = /\.test\.tsx?$/;
const SPEC_FILE_PATTERN = /\.spec\.tsx?$/;
const VITEST_IMPORT_PATTERN = /from\s+['"]vitest['"]/;

function listSourceFiles(directory: string): string[] {
	let entries: string[] = [];

	for(let name of readdirSync(directory)) {
		let fullPath = path.join(directory, name);

		if(statSync(fullPath).isDirectory()) {
			if(name === 'node_modules') {
				continue;
			}

			entries.push(...listSourceFiles(fullPath));
		} else if(/\.tsx?$/.test(name)) {
			entries.push(fullPath);
		}
	}

	return entries;
}

function isWebviewFile(file: string): boolean {
	return file.startsWith(WEBVIEW_ROOT + path.sep);
}

describe('test layout', () => {
	// Mocha runs from the project root (see the test:unit script), so relative roots resolve there.
	let files = SOURCE_ROOTS.flatMap(root => listSourceFiles(root));

	it('finds the sources it is supposed to be checking', () => {
		expect(files.length).to.be.greaterThan(50);
		expect(files.filter(file => TEST_FILE_PATTERN.test(file)).length).to.be.greaterThan(0);
		expect(files.filter(file => SPEC_FILE_PATTERN.test(file)).length).to.be.greaterThan(0);
		expect(files.filter(file => SPEC_FILE_PATTERN.test(file) && isWebviewFile(file)).length).to.be.greaterThan(0);
	});

	it('keeps every *.test.ts under src/test, where the integration suite looks', () => {
		let offenders = files.filter(file => TEST_FILE_PATTERN.test(file) && !file.startsWith(INTEGRATION_ROOT + path.sep));
		expect(offenders, `a *.test.ts outside ${INTEGRATION_ROOT} is run by neither suite - move it there, or rename it *.spec.ts if it doesn't need the VS Code host`).to.deep.equal([]);
	});

	it('keeps every *.spec.ts out of src/test, where the unit suite would load it without a host', () => {
		// out/**/*.spec.js also matches out/test/, so a spec filed here is run by mocha with no
		// extension host - it fails on the first `import * as vscode`, loudly, but for the wrong reason.
		let offenders = files.filter(file => SPEC_FILE_PATTERN.test(file) && file.startsWith(INTEGRATION_ROOT + path.sep));
		expect(offenders, `a *.spec.ts under ${INTEGRATION_ROOT} is loaded by the unit suite outside the VS Code host`).to.deep.equal([]);
	});

	it('keeps every webviews/ spec on vitest, where the webview suite runs it', () => {
		let offenders = files.filter(file => SPEC_FILE_PATTERN.test(file) && isWebviewFile(file) && !VITEST_IMPORT_PATTERN.test(readFileSync(file, 'utf8')));
		expect(offenders, 'a spec under webviews/ must import from vitest - mocha never sees webviews/, so a mocha/chai spec there never runs').to.deep.equal([]);
	});

	it('keeps vitest out of src/ specs, which the unit suite runs under mocha', () => {
		let offenders = files.filter(file => SPEC_FILE_PATTERN.test(file) && !isWebviewFile(file) && VITEST_IMPORT_PATTERN.test(readFileSync(file, 'utf8')));
		expect(offenders, 'a spec under src/ runs under mocha - write it with mocha + chai, or move it under webviews/ if it tests a webview').to.deep.equal([]);
	});
});
