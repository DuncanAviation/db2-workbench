/**
 * The vscode api does not define an object for reporting the progress when using vscode.window.withProgress. We'll define one here.
 * @see vscode.window.withProgress
 */
export interface ProgressReport {
	message?: string;
	increment?: number;
}