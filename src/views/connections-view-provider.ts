import * as vscode from 'vscode';
import { Extension } from '../extension.js';
import { ConnectionConfig } from '../models/connection-config.js';

export class ConnectionsViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | null | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
	readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | null | void> = this._onDidChangeTreeData.event; // Corrected type

	constructor(private extension: Extension) {
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(`${Extension.ID}.connections`)) {
				this.refresh();
			}
		});
	}

	private createConnectionTreeItem(config: ConnectionConfig): vscode.TreeItem {
		const item = new vscode.TreeItem(config.name || 'Unnamed', vscode.TreeItemCollapsibleState.None);
		item.description = `${config.userName}@${config.host}`;
		item.iconPath = new vscode.ThemeIcon('database');
		item.contextValue = 'connectionItem'; // Set contextValue for menu contributions
		item.id = config.id;
		
		return item;
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
		if (!element) {
			const root = new vscode.TreeItem('Connections', vscode.TreeItemCollapsibleState.Expanded);
			root.contextValue = 'root';

			const formatting = new vscode.TreeItem('Formatting', vscode.TreeItemCollapsibleState.None);
			formatting.contextValue = 'formattingItem';
			formatting.iconPath = new vscode.ThemeIcon('gear');

			return [root, formatting];
		}

		if (element.contextValue === 'root') {
			let connections = this.extension.configurations.connections;

			if(connections.length === 0) {
				let addButton = new vscode.TreeItem('Add a connection', vscode.TreeItemCollapsibleState.None);
				addButton.iconPath = new vscode.ThemeIcon('add');

				addButton.command = {
					command: 'db2-workbench.addConnection',
					title: 'Add a connection'
				};

				return [addButton];
			}

			return connections.map(connection => this.createConnectionTreeItem(connection));
		}

		return [];
	}
}