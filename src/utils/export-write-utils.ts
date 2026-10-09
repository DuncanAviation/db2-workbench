import * as vscode from 'vscode';
import { AlertUtils } from './alert-utils.js';
import { ExportDestination } from './export-utils.js';

// The mechanical tail shared by every "Export..." feature that writes to the workspace rather than a
// live editor (diagram export, schema export, results-grid export) - clipboard short-circuits before the
// save dialog, default filename/directory, cancel returns silently, write via vscode.workspace.fs, then
// an info toast. Deliberately NOT export-utils.ts: that module ships inside the webview bundles too (see
// e.g. webviews/shared/components/data-table.tsx's own ExportUtils.toCsv/toJson use), and vscode.window/
// vscode.workspace.fs are extension-host-only - this file must never be imported from anything under
// webviews/ or webview-messages/.
//
// Does NOT own try/catch around the whole operation - callers differ on that today (diagram/schema
// export wrap in AlertUtils.onError, results export doesn't), so that stays each caller's own choice
// rather than being forced here.
export class ExportWriteUtils {
	static async write(options: ExportWriteUtils.Options): Promise<void> {
		if(options.destination === 'clipboard') {
			await vscode.env.clipboard.writeText(options.content);
			AlertUtils.onInfo(options.clipboardMessage);
			return;
		}

		let workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
		let defaultUri = workspaceFolder ? vscode.Uri.joinPath(workspaceFolder, options.defaultFileName) : vscode.Uri.file(options.defaultFileName);

		let targetUri = await vscode.window.showSaveDialog({
			defaultUri: defaultUri,
			filters: {[options.filterLabel]: [options.fileExtension]}
		});

		if(!targetUri) {
			return;
		}

		await vscode.workspace.fs.writeFile(targetUri, Buffer.from(options.content, 'utf8'));
		AlertUtils.onInfo(options.fileMessage(targetUri.fsPath));
	}
}

export namespace ExportWriteUtils {
	export interface Options {
		content: string;
		fileExtension: string;
		filterLabel: string;
		defaultFileName: string;
		destination: ExportDestination;
		clipboardMessage: string;
		fileMessage: (path: string) => string;
	}
}
