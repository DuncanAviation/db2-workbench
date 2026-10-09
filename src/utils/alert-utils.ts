import * as vscode from 'vscode';
import { Extension } from '../extension.js';

export class AlertUtils {
	static onError(error: string | unknown) {
		let message = typeof error === 'string' ? error : `An error occured with the ${Extension.NAME} extension. Please see the output console for details.`;
		vscode.window.showErrorMessage(message);
		console.log(error);
	}

	static onWarning(message: string) {
		vscode.window.showWarningMessage(message);
	}

	static onInfo(message: string) {
		vscode.window.showInformationMessage(message);
	}
}