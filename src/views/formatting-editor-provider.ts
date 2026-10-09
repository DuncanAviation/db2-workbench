import * as vscode from 'vscode';
import { Extension } from '../extension.js';
import { SqlDocumentFormatter } from '../formatting/sql-document-formatter.js';
import { AlertUtils } from '../utils/alert-utils.js';
import { Nullable } from '../utils/nullable.js';
import { TryUtils } from '../utils/try-utils.js';
import { WebviewHtmlUtils } from '../utils/webview-html-utils.js';
import { FormattingEditorInitialState, FormattingEditorMessage } from '../webview-messages/formatting-editor-messages.js';

export class FormattingEditorProvider {
	private static readonly DUMMY_SQL = `with data as ( -- CTE for billed hours
	select hours, empId
	from billed
)
select e.id, e.name, e.hireDate, d.deptName, e.status, case when e.status = 'A' then 'Active' else 'Inactive' end as statusDescription, count(*) as count
from employees e
join departments d on d.id = e.deptId
join billed b on b.empId = e.id
where e.status = 'ACTIVE'
	and e.hireDate > '2020-01-01'
group by e.id, e.name, e.hireDate, d.deptName, e.status
having count(*) > 0
and count(*) < 10
order by e.name;

Update employees
Set status = 'INACTIVE'
Where id = 42;`;

	private currentPanel: Nullable<vscode.WebviewPanel>;

	constructor(private extension: Extension) {}

	show(): void {
		if (this.currentPanel) {
			this.currentPanel.reveal(vscode.ViewColumn.One);
		} else {
			this.currentPanel = vscode.window.createWebviewPanel(
				`${Extension.ID}.formattingEditor`,
				'SQL Formatting',
				vscode.ViewColumn.One,
				{
					enableScripts: true,
					localResourceRoots: [vscode.Uri.joinPath(this.extension.context.extensionUri, 'dist')],
					retainContextWhenHidden: true
				}
			);

			this.currentPanel.onDidDispose(() => {
				this.currentPanel = undefined;
			}, null, this.extension.context.subscriptions);

			this.currentPanel.webview.onDidReceiveMessage(
				message => this.handleWebviewMessage(message),
				null,
				this.extension.context.subscriptions
			);
		}

		this.currentPanel.webview.html = this.getPanelHtml();
	}

	private getPanelHtml(): string {
		if(this.currentPanel == null) {
			throw new Error(`The editor panel has not been initialized`);
		}

		let options = this.extension.configurations.formattingOptions;

		let initialState: FormattingEditorInitialState = {
			options,
			initialSql: SqlDocumentFormatter.formatDocumentText(FormattingEditorProvider.DUMMY_SQL, options),
			sourceSql: FormattingEditorProvider.DUMMY_SQL
		};

		return WebviewHtmlUtils.getReactWebviewHtml({
			webview: this.currentPanel.webview,
			extensionUri: this.extension.context.extensionUri,
			bundleName: 'formatting',
			initialState
		});
	}

	private handleWebviewMessage(message: FormattingEditorMessage): void {
		switch (message.command) {
			case 'previewFormat':
				this.currentPanel?.webview.postMessage({
					command: 'previewResult',
					text: SqlDocumentFormatter.formatDocumentText(message.sql, message.options)
				});
				return;

			case 'saveFormatting':
				TryUtils.forgetPromise({
					context: 'formatting-editor-provider saveFormatting',
					promise: () => this.saveFormatting(message.options),
					onError: error => AlertUtils.onError(error)
				});
				return;

			case 'cancelEdit':
				this.currentPanel?.dispose();
				return;
		}
	}

	// Says "saved" and closes the editor only once every setting has actually been written. If a write
	// fails, it says so and leaves the panel open, so the edits aren't lost and Save can be tried again.
	private async saveFormatting(options: SqlDocumentFormatter.Options): Promise<void> {
		try {
			await this.extension.configurations.setFormattingOptions(options);
		} catch (error) {
			console.log(error);
			AlertUtils.onError(`Could not save the formatting options: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}

		AlertUtils.onInfo('Formatting options saved.');
		this.currentPanel?.dispose();
	}
}
