// No vscode/React dependency - safe to import from both extension-host code (src/) and webview code
// (webviews/), same reasoning as DbErrorUtils.
export class SchemaImportErrorUtils {
	// @dbml/core throws a plain object shaped like {diags: Array<{message, location?: {start, end}}>} for
	// a malformed .dbml file (confirmed empirically, not from any published type - @dbml/core doesn't
	// export one for this). Duck-typed rather than imported, since this needs to stay resilient to a
	// caught `unknown` the same defensive way DbErrorUtils.serialize does, and to keep working even if
	// a future @dbml/core version renames/restructures its own internal error class.
	private static extractDiags(error: unknown): SchemaImportErrorUtils.ImportErrorDiag[] {
		if(!error || typeof error !== 'object' || !Array.isArray((<{diags?: unknown}>error).diags)) {
			return [];
		}

		return (<{diags: unknown[]}>error).diags.map(diag => {
			let record = <Record<string, unknown>>(diag ?? {});
			let location = <Record<string, unknown>>(record.location ?? {});
			let start = <Record<string, unknown>>(location.start ?? {});

			return {
				message: typeof record.message === 'string' ? record.message : String(diag),
				startOffset: typeof start.offset === 'number' ? start.offset : undefined,
				startLine: typeof start.line === 'number' ? start.line : undefined,
				startColumn: typeof start.column === 'number' ? start.column : undefined
			};
		});
	}

	// The one place a caught schema-import error (DBML parse failure, malformed Frictionless JSON, or
	// anything else converter.import() might throw) is turned into the postMessage-safe shape
	// ImportErrorDialog renders - see SchemasProvider's handleImportSchema/handleImportSchemaFromText.
	// Mirrors DbErrorUtils.serialize's convention (send the whole normalized error, let the webview
	// decide how to present it) rather than pre-formatting a display string host-side.
	static serialize(error: unknown): SchemaImportErrorUtils.SerializedImportError {
		let diags = SchemaImportErrorUtils.extractDiags(error);

		if(diags.length > 0) {
			return {
				message: diags.length === 1 ? diags[0].message : `${diags.length} errors were found while parsing.`,
				diags: diags
			};
		}

		return {message: error instanceof Error ? error.message : String(error), diags: []};
	}
}

export namespace SchemaImportErrorUtils {
	export interface ImportErrorDiag {
		message: string;
		/** Present only when the source format's parser reports a location (DBML does; a Frictionless
		 * JSON.parse failure does not) - 1-based, matching how editors number lines/columns. */
		startOffset?: number;
		startLine?: number;
		startColumn?: number;
	}

	// A caught error, normalized to a plain, postMessage-safe shape - see serialize(). `diags` is empty
	// for an error with no per-location detail to show (e.g. a Frictionless JSON syntax error) - the
	// dialog falls back to showing just `message` as a single row in that case.
	export interface SerializedImportError {
		message: string;
		diags: ImportErrorDiag[];
	}
}
