import { execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Nullable } from '../../../utils/nullable.js';
import { StringUtils } from '../../../utils/string-utils.js';
import { ConnectionStringUtils } from './connection-string-utils.js';

const execFileAsync = promisify(execFile);

// Node-only (child_process/fs) - extension-host code only, not safe to bundle into a webview.
// Detects whether the ODBC driver a connection string names is actually registered on this
// machine, and (Windows only) whether IBM i Access Client Solutions is already installed so we
// can offer to launch its ODBC setup instead of just pointing at a download page.
export class OdbcDriverUtils {
	private static readonly WINDOWS_DRIVER_KEYS = [
		'HKLM\\SOFTWARE\\ODBC\\ODBCINST.INI\\ODBC Drivers',
		'HKLM\\SOFTWARE\\WOW6432Node\\ODBC\\ODBCINST.INI\\ODBC Drivers',
		'HKCU\\SOFTWARE\\ODBC\\ODBCINST.INI\\ODBC Drivers',
		'HKCU\\SOFTWARE\\WOW6432Node\\ODBC\\ODBCINST.INI\\ODBC Drivers'
	];

	private static readonly ACS_UNINSTALL_KEYS = [
		'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
		'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
	];

	// Relative to an install's InstallLocation/base folder. `cwbodbcreg.exe` is confirmed real -
	// it's IBM's own ODBC-driver-registration utility, shipped directly in the product root of the
	// legacy "Client Access"/iSeries Access line, and re-registers the driver without a full
	// reinstall. The rest are an unverified best-effort guess at modern ACS's layout - if none of
	// these exist we fall back to "found an IBM install, but couldn't locate its ODBC setup
	// automatically" rather than guessing wrong and launching nothing (or the wrong thing).
	private static readonly ACS_ODBC_INSTALLER_CANDIDATES = [
		'cwbodbcreg.exe',
		'Windows_Application\\Install\\ODBC\\Windows32\\setup.exe',
		'Windows_Application\\Install\\ODBC\\Windows64\\setup.exe',
		'Start_Programs\\Windows_i386\\ODBCSetup.exe',
		'Start_Programs\\Windows_x86-64\\ODBCSetup.exe'
	];

	// IBM has shipped this under several product names over the years ("Client Access", "iSeries
	// Access for Windows", the modern "IBM i Access Client Solutions") - matched loosely since we
	// don't know which generation a given machine has.
	private static readonly ACS_DISPLAY_NAME_PATTERN = /ibm i access|client access|iseries access/i;

	// Confirmed against a real machine: a working "Client Access" install can have no matching entry
	// in either Uninstall registry hive at all (likely a silent/corporate deployment that skips it),
	// so the registry scan alone under-detects real installs. These are the well-known folders IBM's
	// Windows installers use, checked directly as a fallback when the registry search finds nothing.
	private static getKnownInstallBasePaths(): string[] {
		let programFilesRoots = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]
			.filter((value): value is string => StringUtils.isNotBlank(value));
		let productFolders = ['IBM\\Client Access', 'IBM\\ClientSolutions'];
		let paths = programFilesRoots.flatMap(root => productFolders.map(folder => path.join(root, folder)));

		if(StringUtils.isNotBlank(process.env.USERPROFILE)) {
			paths.push(path.join(<string>process.env.USERPROFILE, 'IBM', 'ClientSolutions'));
		}

		return paths;
	}

	static extractDriverName(connectionString: string): Nullable<string> {
		let properties = ConnectionStringUtils.parseProperties(connectionString);
		let driverProperty = properties.find(property => StringUtils.beginsWithIgnoreCase(property, 'driver='));

		if(!driverProperty) {
			return undefined;
		}

		let value = driverProperty.substring(driverProperty.indexOf('=') + 1).trim();
		return value.replace(/^\{/, '').replace(/\}$/, '').trim();
	}

	static async checkDriverAvailability(connectionString: string): Promise<OdbcDriverUtils.DriverCheckResult> {
		let driverName = OdbcDriverUtils.extractDriverName(connectionString);
		let {driverNames, detectionSupported} = await OdbcDriverUtils.listInstalledDriverNames();

		let normalizedDriverName = driverName?.trim().toLowerCase();
		let installed = detectionSupported && StringUtils.isNotBlank(normalizedDriverName) &&
			driverNames.some(name => name.trim().toLowerCase() === normalizedDriverName);

		return {driverName, installed, installedDrivers: driverNames, detectionSupported};
	}

	private static async listInstalledDriverNames(): Promise<OdbcDriverUtils.DriverListResult> {
		return process.platform === 'win32' ? OdbcDriverUtils.listWindowsDrivers() : OdbcDriverUtils.listUnixOdbcDrivers();
	}

	private static async listWindowsDrivers(): Promise<OdbcDriverUtils.DriverListResult> {
		let queries = await Promise.all(OdbcDriverUtils.WINDOWS_DRIVER_KEYS.map(key => OdbcDriverUtils.queryRegistryDriverNames(key)));
		let driverNames = [...new Set(queries.flatMap(query => query.driverNames))];
		let detectionSupported = queries.some(query => query.detectionSupported);
		return {driverNames, detectionSupported};
	}

	private static async queryRegistryDriverNames(key: string): Promise<OdbcDriverUtils.DriverListResult> {
		try {
			let {stdout} = await execFileAsync('reg', ['query', key]);
			let driverNames: string[] = [];
			let regex = /^\s{4}(.+?)\s{2,}REG_SZ\s{2,}/;

			for(let line of stdout.split(/\r?\n/)) {
				let match = regex.exec(line);

				if(match) {
					driverNames.push(match[1].trim());
				}
			}

			return {driverNames, detectionSupported: true};
		} catch(error: any) {
			// ENOENT means reg.exe itself couldn't be run - genuinely can't detect anything. Any other
			// failure (most commonly: the key doesn't exist, reg.exe exits 1) just means no drivers
			// registered under this particular key/view, not a detection failure.
			return {driverNames: [], detectionSupported: error?.code !== 'ENOENT'};
		}
	}

	private static async listUnixOdbcDrivers(): Promise<OdbcDriverUtils.DriverListResult> {
		try {
			let {stdout} = await execFileAsync('odbcinst', ['-q', '-d']);
			let driverNames: string[] = [];
			let regex = /^\[(.+)\]$/;

			for(let line of stdout.split(/\r?\n/)) {
				let match = regex.exec(line.trim());

				if(match) {
					driverNames.push(match[1].trim());
				}
			}

			return {driverNames, detectionSupported: true};
		} catch(error: any) {
			// ENOENT here means unixODBC (odbcinst) isn't installed at all - can't tell one way or the
			// other, so this must be reported as "detection unsupported", not "driver not installed".
			return {driverNames: [], detectionSupported: error?.code !== 'ENOENT'};
		}
	}

	// Windows-only: looks for an existing IBM i Access Client Solutions install (a common cause of
	// "driver missing" - ACS installed without its optional ODBC component) and, if found, tries to
	// locate its ODBC setup executable so the caller can offer to launch it directly.
	static async findAcsSetupOption(): Promise<Nullable<OdbcDriverUtils.AcsSetupOption>> {
		if(process.platform !== 'win32') {
			return undefined;
		}

		let installation = await OdbcDriverUtils.findAcsInstallation();

		if(!installation) {
			return undefined;
		}

		let installerPath = await OdbcDriverUtils.findAcsOdbcInstaller(installation.installLocation);
		return {displayName: installation.displayName, installerPath};
	}

	private static async findAcsInstallation(): Promise<Nullable<OdbcDriverUtils.AcsInstallation>> {
		let registryMatch = await OdbcDriverUtils.findAcsInstallationFromRegistry();
		return registryMatch ?? OdbcDriverUtils.findAcsInstallationFromFilesystem();
	}

	private static async findAcsInstallationFromRegistry(): Promise<Nullable<OdbcDriverUtils.AcsInstallation>> {
		for(let baseKey of OdbcDriverUtils.ACS_UNINSTALL_KEYS) {
			let subKeys = await OdbcDriverUtils.listRegistrySubKeys(baseKey);

			// Enumerating every installed program's uninstall entry and querying each individually is
			// the only reliable way to recover an ACS InstallLocation - on a machine with a lot of
			// installed software this can mean a couple hundred short-lived `reg query` calls. Run them
			// concurrently rather than one at a time; this path only runs once, after the driver check
			// has already failed, not as part of any routine/automatic check.
			let entries = await Promise.all(subKeys.map(subKey => OdbcDriverUtils.readUninstallEntry(subKey)));
			let match = entries.find(entry => entry && OdbcDriverUtils.ACS_DISPLAY_NAME_PATTERN.test(entry.displayName ?? ''));

			if(match) {
				return {displayName: <string>match.displayName, installLocation: match.installLocation};
			}
		}

		return undefined;
	}

	private static async findAcsInstallationFromFilesystem(): Promise<Nullable<OdbcDriverUtils.AcsInstallation>> {
		for(let candidatePath of OdbcDriverUtils.getKnownInstallBasePaths()) {
			if(await OdbcDriverUtils.pathExists(candidatePath)) {
				return {displayName: path.basename(candidatePath), installLocation: candidatePath};
			}
		}

		return undefined;
	}

	private static async listRegistrySubKeys(baseKey: string): Promise<string[]> {
		try {
			let {stdout} = await execFileAsync('reg', ['query', baseKey]);
			return stdout
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(line => line.toUpperCase().startsWith(baseKey.toUpperCase()));
		} catch {
			return [];
		}
	}

	private static async readUninstallEntry(subKey: string): Promise<Nullable<{displayName?: string; installLocation?: string}>> {
		try {
			let {stdout} = await execFileAsync('reg', ['query', subKey]);
			return {
				displayName: OdbcDriverUtils.extractRegValue(stdout, 'DisplayName'),
				installLocation: OdbcDriverUtils.extractRegValue(stdout, 'InstallLocation')
			};
		} catch {
			return undefined;
		}
	}

	private static extractRegValue(stdout: string, valueName: string): Nullable<string> {
		let regex = new RegExp(`^\\s{4}${valueName}\\s{2,}REG_\\w+\\s{2,}(.*)$`, 'm');
		let match = regex.exec(stdout);
		return match ? match[1].trim() : undefined;
	}

	private static async findAcsOdbcInstaller(installLocation: Nullable<string>): Promise<Nullable<string>> {
		if(StringUtils.isBlank(installLocation)) {
			return undefined;
		}

		for(let relativePath of OdbcDriverUtils.ACS_ODBC_INSTALLER_CANDIDATES) {
			let candidatePath = path.join(<string>installLocation, relativePath);

			if(await OdbcDriverUtils.pathExists(candidatePath)) {
				return candidatePath;
			}
		}

		return undefined;
	}

	private static async pathExists(candidatePath: string): Promise<boolean> {
		try {
			await fs.access(candidatePath);
			return true;
		} catch {
			return false;
		}
	}

	// Always launches the installer's own interactive wizard (never silent/unattended flags) and
	// detaches it from the extension host process - the caller only ever invokes this from an
	// explicit user action (a button click), never automatically.
	static launchInstaller(installerPath: string): void {
		spawn(installerPath, [], {detached: true, stdio: 'ignore'}).unref();
	}
}

export namespace OdbcDriverUtils {
	export interface DriverListResult {
		driverNames: string[];
		detectionSupported: boolean;
	}

	export interface DriverCheckResult {
		driverName: Nullable<string>;
		installed: boolean;
		installedDrivers: string[];
		detectionSupported: boolean;
	}

	export interface AcsInstallation {
		displayName: string;
		installLocation?: string;
	}

	export interface AcsSetupOption {
		displayName: string;
		installerPath?: string;
	}
}
