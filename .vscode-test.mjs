import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const testRoot = path.join(projectRoot, '.vscode-test');

// How @vscode/test-electron names each VS Code build it downloads into .vscode-test/ (its own
// downloadDirNameFormat), e.g. vscode-win32-x64-archive-1.139.0.
const BUILD_DIRECTORY_NAME = /^vscode-(?<platform>[a-z0-9-]+)-(?<version>\d+(?:\.\d+)*)$/;

function compareVersions(a, b) {
	let aParts = a.split('.').map(Number);
	let bParts = b.split('.').map(Number);
	for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
		let difference = (aParts[i] ?? 0) - (bParts[i] ?? 0);
		if (difference !== 0) {
			return difference;
		}
	}
	return 0;
}

/**
 * Deletes every downloaded VS Code build in `cachePath` except the newest one per platform, and returns
 * the names of the ones it deleted. @vscode/test-electron downloads each new stable release (about 1 GB
 * unpacked) and never removes the old ones, so without this they pile up with every VS Code update.
 *
 * It runs before the download, so right after a VS Code release the previous build is kept for one more
 * run. Keeping the newest is also what test-electron falls back to when it can't reach the update
 * service, so a run on a machine that is offline still has a build to use. Anything that isn't a
 * versioned build (the test profile directories, an insiders build) is left alone. A build that can't be
 * deleted, for example because an instance of it is still running, is skipped with a warning: cleanup
 * never fails the test run.
 */
export function pruneOldVsCodeBuilds(cachePath) {
	let entries;
	try {
		entries = fs.readdirSync(cachePath, { withFileTypes: true });
	} catch {
		return [];
	}

	let newestByPlatform = new Map();
	let builds = [];
	for (let entry of entries) {
		let match = entry.isDirectory() ? BUILD_DIRECTORY_NAME.exec(entry.name) : null;
		if (!match) {
			continue;
		}
		let { platform, version } = match.groups;
		builds.push({ name: entry.name, platform, version });
		let newest = newestByPlatform.get(platform);
		if (!newest || compareVersions(version, newest) > 0) {
			newestByPlatform.set(platform, version);
		}
	}

	let deleted = [];
	for (let build of builds) {
		if (build.version === newestByPlatform.get(build.platform)) {
			continue;
		}
		try {
			fs.rmSync(path.join(cachePath, build.name), { recursive: true, force: true });
			deleted.push(build.name);
		} catch (error) {
			console.warn(`Could not delete the old VS Code build ${build.name}: ${error.message}`);
		}
	}
	return deleted;
}

/**
 * Deletes the test instance's profile directory, so every run starts from an empty one, and returns
 * whether there was one to delete. VS Code adds to the profile with every run and never trims it - each
 * webview a test opens leaves its own service-worker cache (about 3 MB) under WebStorage/, which reached
 * 415 MB over 140 runs. Nothing in it is meant to survive a run: the tests write every setting they
 * depend on themselves, and CI keeps the logs as an artifact from the end of the failed run, not the next
 * one. A profile that can't be fully deleted, for example because another test run is still using it,
 * is left with a warning: cleanup never fails the test run.
 */
export function clearTestProfile(profilePath) {
	if (!fs.existsSync(profilePath)) {
		return false;
	}
	try {
		fs.rmSync(profilePath, { recursive: true, force: true });
		return true;
	} catch (error) {
		console.warn(`Could not clear the test profile ${profilePath}: ${error.message}`);
		return false;
	}
}

// The test runner loads this config before it resolves or downloads a build, on every run.
let testProfile = path.join(testRoot, 'test-user-data');
clearTestProfile(testProfile);

let deletedBuilds = pruneOldVsCodeBuilds(testRoot);
if (deletedBuilds.length > 0) {
	console.log(`Deleted ${deletedBuilds.length} old VS Code build(s) from .vscode-test: ${deletedBuilds.join(', ')}`);
}

export default defineConfig({
	files: 'out/test/**/*.test.js',
	// Every integration test runs against the fake driver (see src/database/drivers/fake/), so the
	// suite needs no database, no ODBC driver manager and no credentials - on a developer machine, in
	// a container, or in CI. DbDrivers throws if the named driver isn't registered, so a run that
	// somehow lost this setting fails loudly instead of quietly dialling a real system.
	//
	// Test mode only relaxes what a headless run can't answer - the password prompt. See
	// Extension.TEST_MODE_ENVIRONMENT_VARIABLE.
	env: {
		DB2_WORKBENCH_DRIVER: 'fake',
		DB2_WORKBENCH_TEST_MODE: '1'
	},
	// Without its own profile directories the test instance uses the developer's real VS Code profile,
	// which breaks two ways: VS Code refuses to run extension tests while another instance holds that
	// profile ("currently only supported if no other instance of Code is running"), and the tests'
	// own settings writes (db2-workbench.connections) land in the developer's settings.json. Both
	// directories live under .vscode-test/, which is already gitignored alongside the downloaded build.
	// The profile is emptied at the start of every run (clearTestProfile, above).
	launchArgs: [
		'--user-data-dir', testProfile,
		'--extensions-dir', path.join(testRoot, 'test-extensions'),
		// Only third-party extensions - the one under test is loaded through extensionDevelopmentPath.
		'--disable-extensions'
	],
	mocha: {
		// The first test in a fresh run pays for the extension host activating and the connection
		// opening; the default 2s timeout is tight for that on a cold CI machine.
		timeout: 20000
	}
});
