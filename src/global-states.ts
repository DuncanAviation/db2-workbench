import { Extension } from './extension.js';
import type { SchemaBrowserPanel } from './webview-messages/schemas-messages.js';

/**
 * Global states are data retained even when the extension or vscode is restarted
 */
export class GlobalStates {
	constructor(private extension: Extension) {}

	private getKey(key: string): string {
		return `${Extension.ID}.${key}`;
	}

	private get(key: string): unknown | undefined {
		return this.extension.context.globalState.get(this.getKey(key));
	}

	private set(key: string, value: unknown) {
		this.extension.context.globalState.update(this.getKey(key), value);
	}
	
	get lastActiveHost(): string | undefined {
		return <string>this.get(GlobalStates.Keys.LAST_ACTIVE_HOST);
	}

	set lastActiveHost(lastActiveHost: string | undefined) {
		this.set(GlobalStates.Keys.LAST_ACTIVE_HOST, lastActiveHost);
	}

	/** The schema browser's resizable panels' widths in pixels, as last dragged - one set for every
	 * connection's browser. A panel never dragged is absent. */
	get schemaBrowserPanelWidths(): Partial<Record<SchemaBrowserPanel, number>> {
		let stored = <Record<string, unknown>>this.get(GlobalStates.Keys.SCHEMA_BROWSER_PANEL_WIDTHS) ?? {};
		return Object.fromEntries(Object.entries(stored).filter(([, width]) => typeof width === 'number' && Number.isFinite(width)));
	}

	setSchemaBrowserPanelWidth(panel: SchemaBrowserPanel, width: number) {
		this.set(GlobalStates.Keys.SCHEMA_BROWSER_PANEL_WIDTHS, {...this.schemaBrowserPanelWidths, [panel]: width});
	}

	// Per-connection (keyed by ConnectionConfig.id) overrides on top of the schema tree's default
	// "everything on the connection's current library list" set - see SchemasProvider.buildSchemaTreeState.
	getSchemaListOverrides(configId: string): GlobalStates.SchemaListOverrides {
		let all = <Record<string, GlobalStates.SchemaListOverrides>>this.get(GlobalStates.Keys.SCHEMA_LIST_OVERRIDES) ?? {};
		return all[configId] ?? {added: [], hidden: []};
	}

	setSchemaListOverrides(configId: string, overrides: GlobalStates.SchemaListOverrides) {
		let all = <Record<string, GlobalStates.SchemaListOverrides>>this.get(GlobalStates.Keys.SCHEMA_LIST_OVERRIDES) ?? {};
		this.set(GlobalStates.Keys.SCHEMA_LIST_OVERRIDES, {...all, [configId]: overrides});
	}
}

export namespace GlobalStates {
	export enum Keys {
		LAST_ACTIVE_HOST = 'lastActiveHost',
		SCHEMA_LIST_OVERRIDES = 'schemaListOverrides',
		SCHEMA_BROWSER_PANEL_WIDTHS = 'schemaBrowserPanelWidths'
	}

	export interface SchemaListOverrides {
		/** Schema names manually added despite not being on the connection's current library list. */
		added: string[];
		/** Schema names (from either the library list or `added`) the user has hidden from the tree. */
		hidden: string[];
	}
}