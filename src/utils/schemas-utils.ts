import { Extension } from '../extension.js';

// Kept out of both SchemasProvider and WorkbenchViewProvider directly (rather than a static on
// either class) so neither provider needs to import the other's file just to build/recognize this
// key format or agree on the schema browser's display label.
export class SchemasUtils {
	// Computed on demand rather than cached in a static field initializer - this file sits in an
	// import cycle (extension.ts -> workbench-view-provider.ts -> schemas-utils.ts ->
	// extension.ts), and a field initializer runs at module-load time, before extension.ts's own
	// `Extension` class declaration has executed - which throws (TDZ) and crashes the whole
	// extension's activation. Reading Extension.ID inside a method body instead defers the access
	// until this is actually called, well after the module graph has finished loading.
	private static prefix(): string {
		return `${Extension.ID}.schemas.`;
	}

	static buildKey(configId: string): string {
		return `${SchemasUtils.prefix()}${configId}`;
	}

	static isSchemasKey(key: string): boolean {
		return key.startsWith(SchemasUtils.prefix());
	}

	static label(configName: string): string {
		return `Schemas: ${configName}`;
	}
}
