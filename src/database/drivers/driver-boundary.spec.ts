import { expect } from 'chai';
import { readdirSync, readFileSync, statSync } from 'fs';
import * as path from 'path';

// The whole point of DbDriver is that one folder knows about ODBC and nothing else does - a stray
// `import ... from 'odbc'` somewhere else compiles fine and breaks nothing today, but quietly takes
// the abstraction back apart (and forces the native module to load in a fake-driver test run). This
// guards the boundary the same way the code review would, on every test run instead of by memory.
//
// Runs against the TypeScript sources rather than the compiled output, since out/ also carries
// source maps and older builds.
const SOURCE_ROOTS = ['src', 'webviews'];
const ODBC_IMPORT_PATTERN = /(?:from\s+['"]odbc['"]|require\(\s*['"]odbc['"]\s*\)|import\(\s*['"]odbc['"]\s*\))/;
const ALLOWED_FILE = path.join('src', 'database', 'drivers', 'odbc', 'odbc-driver.ts');
// This guard quotes the very import it forbids, so it has to exempt itself.
const GUARD_FILE = path.join('src', 'database', 'drivers', 'driver-boundary.spec.ts');

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

describe('driver boundary', () => {
	// Mocha runs from the project root (see the test:unit script), so relative roots resolve there.
	let files = SOURCE_ROOTS.flatMap(root => listSourceFiles(root));

	it('finds the sources it is supposed to be checking', () => {
		expect(files.length).to.be.greaterThan(50);
		expect(files).to.include(ALLOWED_FILE);
	});

	it('imports odbc only from the ODBC driver', () => {
		let offenders = files.filter(file => file !== ALLOWED_FILE && file !== GUARD_FILE && ODBC_IMPORT_PATTERN.test(readFileSync(file, 'utf8')));
		expect(offenders, `only ${ALLOWED_FILE} may import the odbc package`).to.deep.equal([]);
	});
});
