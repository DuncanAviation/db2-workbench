import * as vscode from 'vscode';
import { DbConnection } from '../database/db-connection.js';
import { Extension } from '../extension.js';
import { ConnectionConfig } from '../models/connection-config.js';
import { Secrets } from '../secrets.js';
import { AlertUtils } from '../utils/alert-utils.js';
import { DbErrorUtils } from '../utils/db-error-utils.js';
import { Nullable } from '../utils/nullable.js';
import { StringUtils } from '../utils/string-utils.js';
import { WebviewHtmlUtils } from '../utils/webview-html-utils.js';
import { ConnectionEditorInitialState, ConnectionEditorOutboundMessage } from '../webview-messages/connection-editor-messages.js';

export class ConnectionEditorProvider {
	private currentPanel: Nullable<vscode.WebviewPanel>;

	constructor(private extension: Extension) {}

	async show(config?: Nullable<ConnectionConfig>): Promise<void> {
		config ??= { id: '', name: '', host: '', userName: '', defaultTableSchema: '' };

		if (this.currentPanel) {
			this.currentPanel.reveal(vscode.ViewColumn.One);
			this.currentPanel.title = StringUtils.default(config.name, () => 'New Connection');
		} else {
			this.currentPanel = vscode.window.createWebviewPanel(
				`${Extension.ID}.connectionEditor`,
				StringUtils.default(config.name, () => 'New Connection'),
				vscode.ViewColumn.One,
				{
					enableScripts: true,
					localResourceRoots: [vscode.Uri.joinPath(this.extension.context.extensionUri, 'dist')],
					retainContextWhenHidden: true // Keep state when hidden
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

		this.currentPanel.webview.html = this.getPanelHtml(config);
	}

	private getPanelHtml(config: ConnectionConfig): string {
		if(this.currentPanel == null) {
			throw new Error(`The editor panel has not been initialized`);
		}

		let initialState: ConnectionEditorInitialState = {
			config,
			defaultConnectionString: this.extension.drivers.get(config).defaultConnectionString,
			sqlImports: this.extension.sqlSchemaImports.getSavedImports().map(entry => ({id: entry.id, name: entry.name}))
		};

		return WebviewHtmlUtils.getReactWebviewHtml({
			webview: this.currentPanel.webview,
			extensionUri: this.extension.context.extensionUri,
			bundleName: 'connections',
			initialState
		});
	}

	private async handleWebviewMessage(message: ConnectionEditorOutboundMessage): Promise<void> {
		switch (message.command) {
			case 'saveConnection':
				let config: ConnectionConfig = message.connection;
				
				if(StringUtils.isBlank(config.name)) {
					AlertUtils.onError('Connection name is required.');
					return;
				}

				if(StringUtils.isBlank(config.host)) {
					AlertUtils.onError('Host is required.');
					return;
				}

				if(StringUtils.isBlank(config.userName)) {
					AlertUtils.onError('User name is required.');
					return;
				}

				if(StringUtils.isBlank(config.defaultTableSchema)) {
					AlertUtils.onError('Default table schema is required.');
					return;
				}

				let connections = this.extension.configurations.connections;
				const index = connections.findIndex(conn => conn.id === config.id);

				if (index === -1) {
					config.id = Date.now().toString();
					connections.push(config);
					this.extension.configurations.connections = connections;
					AlertUtils.onInfo(`Connection '${config.name}' added.`);
				} else {
					connections[index] = config;
					this.extension.configurations.connections = connections;
					AlertUtils.onInfo(`Connection '${config.name}' saved.`);
				}

				this.currentPanel?.dispose();
				return;
				
			case 'cancelEdit':
				this.currentPanel?.dispose();
				return;

			case 'testConnection':
				await this.testConnection(message.connection);
				return;

			case 'setPassword':
				await this.setPassword(message);
				return;
		}
	}

	/**
	 * Replaces the stored password for a host and user name, for a password that changed on the host.
	 * The stored one is only overwritten once a new one is entered, so cancelling changes nothing. It
	 * doesn't connect - Test Connection is there for that.
	 */
	private async setPassword(target: Secrets.StoreKey): Promise<void> {
		if(StringUtils.isBlank(target.host) || StringUtils.isBlank(target.userName)) {
			return;
		}

		let password = await this.promptForPassword(target);

		if(password == null) {
			return;
		}

		await this.extension.secrets.store({ host: target.host, userName: target.userName, password });
		this.currentPanel?.webview.postMessage({command: 'passwordSet', message: `Password set for ${target.userName}@${target.host}.`});
	}

	// Its own method so the integration tests can answer it - a headless run has nobody to type into an
	// input box.
	private async promptForPassword(target: Secrets.StoreKey): Promise<Nullable<string>> {
		return vscode.window.showInputBox({
			prompt: `Enter the new password for ${target.userName}@${target.host}`,
			password: true,
			ignoreFocusOut: true,
			validateInput: value => StringUtils.isBlank(value) ? 'A password is required.' : undefined
		});
	}

	private async testConnection(config: ConnectionConfig): Promise<void> {
		let driver = this.extension.drivers.get(config);
		let connectionString = StringUtils.default(config.connectionString, () => driver.defaultConnectionString);
		let checkResult = await driver.checkSetup?.(connectionString);

		if(checkResult?.detectionSupported && !checkResult.installed) {
			this.postTestConnectionResult(false, `${driver.displayName} driver not found - see the notification for setup options.`);
			return;
		}

		let password = await this.extension.connections.getPassword(config);

		if(StringUtils.isBlank(password)) {
			this.postTestConnectionResult(false, 'A password is required to test the connection.');
			return;
		}

		let connection = new DbConnection({key: `test-connection-${config.host}-${config.userName}`, configuration: {...config, connectionString}, password: <string>password, driver: driver});

		try {
			await connection.connect();
			this.postTestConnectionResult(true, `Successfully connected to ${config.host}.`);
		} catch(error: any) {
			if(driver.isSetupError?.(error)) {
				// The proactive check above didn't catch this (e.g. detection is unsupported on this
				// platform) but the real connect just confirmed it - show the same guidance anyway.
				await driver.checkSetup?.(connectionString);
				this.postTestConnectionResult(false, `${driver.displayName} driver not found - see the notification for setup options.`);
			} else {
				this.postTestConnectionResult(false, StringUtils.default(error?.message, () => 'Unable to connect.'), DbErrorUtils.extractDriverErrors(error));
			}
		} finally {
			await connection.close();
		}
	}

	private postTestConnectionResult(success: boolean, message: string, driverErrors?: DbErrorUtils.DbErrorDetail[]): void {
		this.currentPanel?.webview.postMessage({command: 'testConnectionResult', success, message, driverErrors});
	}
}