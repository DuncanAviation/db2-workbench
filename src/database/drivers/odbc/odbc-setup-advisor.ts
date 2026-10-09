import * as vscode from 'vscode';
import { StringUtils } from '../../../utils/string-utils.js';
import { TryUtils } from '../../../utils/try-utils.js';
import { OdbcDriverUtils } from './odbc-driver-utils.js';

// Shared between the reactive path (WorkbenchViewProvider.onError(), when a query fails with the
// known "driver not found" ODBC error) and the proactive path (ConnectionEditorProvider's Test
// Connection action) - both need the same check-then-guide behavior, just triggered differently.
export class OdbcSetupAdvisor {
	static readonly DOWNLOAD_URL = 'https://www.ibm.com/support/pages/ibm-i-access-client-solutions';

	private static readonly OPEN_DOWNLOAD_PAGE_ACTION = 'Open Download Page';
	private static readonly LAUNCH_INSTALLER_ACTION = 'Launch ODBC Driver Setup';

	// Checks whether the connection string's driver is registered and, only when it's confirmed
	// missing, shows a warning notification with setup action(s) - "Open Download Page" always,
	// plus "Launch ODBC Driver Setup" when an existing IBM i Access Client Solutions install with a
	// locatable ODBC setup was found (Windows only). Always returns the check result so the caller
	// can decide whether it's still worth attempting a real connection.
	//
	// Presenting guidance is fired-and-forgotten rather than awaited: showWarningMessage() only
	// resolves once the user dismisses/acts on the notification, and callers (e.g. the Test
	// Connection button) need the check result right away instead of hanging until then.
	static async checkAndAdvise(connectionString: string): Promise<OdbcDriverUtils.DriverCheckResult> {
		let checkResult = await OdbcDriverUtils.checkDriverAvailability(connectionString);

		if(checkResult.detectionSupported && !checkResult.installed) {
			TryUtils.forgetPromise({
				context: `OdbcSetupAdvisor presentGuidance(${connectionString})`,
				promise: () => OdbcSetupAdvisor.presentGuidance(checkResult)
			});
		}

		return checkResult;
	}

	private static async presentGuidance(checkResult: OdbcDriverUtils.DriverCheckResult): Promise<void> {
		let setupOption = await OdbcDriverUtils.findAcsSetupOption();

		let message = StringUtils.isNotBlank(checkResult.driverName)
			? `The "${checkResult.driverName}" ODBC driver isn't installed on this machine.`
			: `The ODBC driver required for this connection isn't installed on this machine.`;

		if(setupOption && !setupOption.installerPath) {
			message += ' Found IBM i Access Client Solutions already installed, but couldn\'t locate its ODBC setup automatically.';
		}

		let actions = [OdbcSetupAdvisor.OPEN_DOWNLOAD_PAGE_ACTION];

		if(setupOption?.installerPath) {
			actions.unshift(OdbcSetupAdvisor.LAUNCH_INSTALLER_ACTION);
		}

		// The user must explicitly click "Launch ODBC Driver Setup" below - nothing here ever spawns
		// the installer on its own just because the check ran.
		let selection = await vscode.window.showWarningMessage(message, ...actions);

		if(selection === OdbcSetupAdvisor.OPEN_DOWNLOAD_PAGE_ACTION) {
			await vscode.env.openExternal(vscode.Uri.parse(OdbcSetupAdvisor.DOWNLOAD_URL));
		} else if(selection === OdbcSetupAdvisor.LAUNCH_INSTALLER_ACTION && setupOption?.installerPath) {
			OdbcDriverUtils.launchInstaller(setupOption.installerPath);
			vscode.window.showInformationMessage('Installer launched - finish the wizard, then click Test Connection again.');
		}
	}
}
