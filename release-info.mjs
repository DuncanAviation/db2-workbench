import * as fs from 'node:fs';

// Checks that a release tag is ready to publish and works out what the release workflow needs from
// it. Run it before pushing a tag to see what the release would do:
//
//   node release-info.mjs v0.1.0
//
// The tag must be "v" plus package.json's version, and CHANGELOG.md must have a non-empty section for
// that version (a "## [0.1.0]" heading); that section becomes the GitHub Release notes. The channel
// follows the minor version: odd minors (0.1.x, 0.3.x) publish as pre-releases, even minors as stable.
// VS Code offers pre-release users the highest version on either channel, so a pre-release line must
// stay numerically ahead of the stable one to reach anyone.
//
// In GitHub Actions the tag defaults to GITHUB_REF_NAME and the results are written to GITHUB_OUTPUT.

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const notesPath = process.argv[3] ?? 'release-notes.md';

function fail(message) {
	console.error(`release-info: ${message}`);
	process.exit(1);
}

if (!tag) {
	fail('no tag given. Usage: node release-info.mjs v<version> [notes-file]');
}

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));

// The Marketplace accepts only major.minor.patch: a "-beta" style suffix is rejected at publish.
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
if (!match) {
	fail(`package.json version "${version}" must be major.minor.patch with no suffix.`);
}
if (tag !== `v${version}`) {
	fail(`tag "${tag}" does not match package.json version "${version}" (expected "v${version}").`);
}

const preRelease = Number(match[2]) % 2 === 1;
const notes = changelogSection(fs.readFileSync('CHANGELOG.md', 'utf8'), version);
if (notes == null) {
	fail(`CHANGELOG.md has no "## [${version}]" section.`);
}
if (!notes) {
	fail(`CHANGELOG.md's "## [${version}]" section is empty.`);
}

fs.writeFileSync(notesPath, notes + '\n');

console.log(`Version:  ${version}`);
console.log(`Channel:  ${preRelease ? 'pre-release' : 'stable'}`);
console.log(`Notes:    ${notesPath}`);
console.log();
console.log(notes);

if (process.env.GITHUB_OUTPUT) {
	fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\npre-release=${preRelease}\nnotes-file=${notesPath}\n`);
}

// The body under "## [version]" (with or without a date after it), up to the next "## " heading.
// Undefined when there is no such heading.
function changelogSection(changelog, version) {
	const lines = changelog.split(/\r?\n/);
	const heading = `## [${version}]`;
	const start = lines.findIndex(line => line === heading || line.startsWith(`${heading} `));
	if (start < 0) {
		return undefined;
	}
	const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
	return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}
