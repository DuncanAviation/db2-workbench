import { Extension } from '../extension.js';

// Mirrors SchemasUtils, and for the same reason: kept out of both DiagramEditorProvider and
// WorkbenchViewProvider so neither has to import the other's file just to build or recognize this key
// format, or agree on the label a diagram's session shows in the results/History session list.
export class DiagramUtils {
	// Computed on demand rather than in a static field initializer - this file sits in an import cycle
	// (extension.ts -> workbench-view-provider.ts -> diagram-utils.ts -> extension.ts), and a field
	// initializer runs at module-load time, before extension.ts's own `Extension` class declaration has
	// executed, which throws (TDZ) and crashes activation. Exactly the gotcha SchemasUtils.prefix()
	// documents and DiagramEditorProvider.VIEW_TYPE hit a second time.
	private static prefix(): string {
		return `${Extension.ID}.diagram.`;
	}

	// Keyed per connection config, not per document - every diagram pointed at the same connection shares
	// one session/connection (see DiagramEditorProvider's documentUrisByConfigId), the same
	// one-session-per-connection model SchemasUtils.buildKey already uses for the schema browser.
	static buildKey(configId: string): string {
		return `${DiagramUtils.prefix()}${configId}`;
	}

	static isDiagramKey(key: string): boolean {
		return key.startsWith(DiagramUtils.prefix());
	}

	// The inverse of buildKey - lets a caller that only has the session key (e.g. the sidebar's generic
	// "Reconnect" action, which only knows the session's uri/key) recover which connection config a shared
	// diagram session actually belongs to.
	static configIdForKey(key: string): string {
		let prefix = DiagramUtils.prefix();
		return key.startsWith(prefix) ? key.substring(prefix.length) : key;
	}

	// Mirrors SchemasUtils.label's "Schemas: " convention, pluralized since one of these sessions can (and
	// is meant to) represent several open diagrams at once.
	static label(configName: string): string {
		return `Diagrams: ${configName}`;
	}
}
