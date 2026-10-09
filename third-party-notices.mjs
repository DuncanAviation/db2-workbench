import * as fs from 'node:fs';
import * as path from 'node:path';

// Writes THIRD_PARTY_NOTICES.txt for the packaged extension. Bundling copies third-party code into our
// own output files (out/extension.js and its chunks, out/vendor/, dist/webviews/), and minifying drops
// the license headers that came with it, so this file is what carries their license and copyright
// text. odbc and its dependencies are not listed: they ship unbundled in node_modules, each with its
// own license file.
//
// The list comes from the metafiles the real builds write to out/metafiles/ (esbuild-extension.mjs,
// esbuild.mjs, esbuild-dt-sql-parser.mjs), so it names exactly what was bundled - never a guess from
// package.json. Runs in vscode:prepublish, after every build.
//
// The build fails on a license outside ALLOWED_LICENSES, so a new dependency under a license nobody
// has looked at stops the package instead of shipping quietly. A dual license ("A OR B") must have
// its choice recorded in LICENSE_ELECTIONS.

const METAFILE_DIR = 'out/metafiles';
const METAFILES = ['extension.json', 'webviews.json', 'dt-sql-parser.json'];
const OUTPUT = 'THIRD_PARTY_NOTICES.txt';

const ALLOWED_LICENSES = new Set([
	'MIT',
	'ISC',
	'Apache-2.0',
	'BSD-2-Clause',
	'BSD-3-Clause',
	'0BSD',
	'BlueOak-1.0.0',
	'CC0-1.0',
	'Unlicense',
	'EPL-2.0'
]);

// Which license we use a dual-licensed package under.
const LICENSE_ELECTIONS = {
	// EPL-2.0's copyleft only covers elkjs's own files, which we ship unmodified. Never GPL.
	elkjs: 'EPL-2.0'
};

const LICENSE_FILE = /^(licen[sc]e|copying)([.-].*)?$/i;
const NOTICE_FILE = /^notice([.-].*)?$/i;

function packageDirs() {
	let dirs = new Set();

	for(let name of METAFILES) {
		let file = path.join(METAFILE_DIR, name);

		if(!fs.existsSync(file)) {
			throw new Error(`${file} is missing - run the builds before generating notices.`);
		}

		let metafile = JSON.parse(fs.readFileSync(file, 'utf8'));

		for(let input of Object.keys(metafile.inputs)) {
			// The last node_modules segment owns the file, so a nested copy of a package (a different
			// version under another package's node_modules) is listed separately.
			let match = /^(.*node_modules\/(@[^/]+\/)?[^/]+)\//.exec(input.replace(/\\/g, '/'));

			if(match) {
				dirs.add(match[1].replace(/^.*?(node_modules\/)/, '$1'));
			}
		}
	}

	return [...dirs];
}

function licenseOf(manifest) {
	let license = manifest.license ?? manifest.licenses;

	if(Array.isArray(license)) {
		license = license.map(entry => entry.type ?? entry).join(' OR ');
	} else if(typeof license === 'object' && license != null) {
		license = license.type;
	}

	return typeof license === 'string' ? license.replace(/^\((.*)\)$/, '$1') : undefined;
}

function repositoryOf(manifest) {
	let url = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
	// Normalized to a browsable https link: package.json spells these as git+https, ssh, git@host:,
	// github: or bare owner/repo shorthand (which npm reads as GitHub).
	return url
		?.replace(/^git\+/, '')
		.replace(/^(ssh:\/\/git@|git:\/\/)/, 'https://')
		.replace(/^git@([^:]+):/, 'https://$1/')
		.replace(/^github:/, 'https://github.com/')
		.replace(/^([\w.-]+\/[\w.-]+)$/, 'https://github.com/$1')
		.replace(/\.git$/, '') ?? manifest.homepage;
}

function readMatching(dir, pattern) {
	return fs.readdirSync(dir)
		.filter(file => pattern.test(file) && fs.statSync(path.join(dir, file)).isFile())
		.sort()
		.map(file => fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n').trim());
}

function main() {
	let problems = [];
	let entries = new Map();

	for(let dir of packageDirs()) {
		let manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
		let id = `${manifest.name}@${manifest.version}`;
		let declared = licenseOf(manifest);
		let used = LICENSE_ELECTIONS[manifest.name] ?? declared;

		if(used == null) {
			problems.push(`${id} declares no license.`);
			continue;
		}

		if(/\s(OR|AND)\s/.test(used)) {
			problems.push(`${id} is "${used}" - record which license we use in LICENSE_ELECTIONS.`);
			continue;
		}

		if(!ALLOWED_LICENSES.has(used)) {
			problems.push(`${id} is ${used}, which isn't in ALLOWED_LICENSES - check it before adding it there.`);
			continue;
		}

		let licenseTexts = readMatching(dir, LICENSE_FILE);

		if(!licenseTexts.length) {
			problems.push(`${id} has no license file to copy.`);
			continue;
		}

		entries.set(id, {
			id: id,
			license: used === declared ? used : `${used} (elected from "${declared}")`,
			repository: repositoryOf(manifest),
			texts: [...licenseTexts, ...readMatching(dir, NOTICE_FILE)]
		});
	}

	if(problems.length) {
		throw new Error(`Third-party notices can't be generated:\n  ${problems.join('\n  ')}`);
	}

	let sorted = [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
	let rule = '-'.repeat(80);
	let sections = sorted.map(entry => [
		rule,
		entry.id,
		`License: ${entry.license}`,
		...(entry.repository ? [`Source: ${entry.repository}`] : []),
		rule,
		'',
		entry.texts.join('\n\n')
	].join('\n'));

	let header = [
		'DB2 Workbench includes the following third-party software, bundled into its own files.',
		'Each is listed with its license, the source it can be obtained from, and its license and notice text.',
		''
	].join('\n');

	fs.writeFileSync(OUTPUT, `${header}\n${sections.join('\n\n\n')}\n`);
	console.log(`${OUTPUT}: ${sorted.length} packages`);
}

try {
	main();
} catch(error) {
	console.error(error.message ?? error);
	process.exit(1);
}
