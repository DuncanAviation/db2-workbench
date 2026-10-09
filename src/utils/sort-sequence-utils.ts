// No vscode/React dependency - safe to import from both extension-host code (src/) and webview
// code (webviews/), same reasoning as FieldUtils (see field-utils.ts).
//
// Sort sequence is a DB2 for i concept (SRTSEQ), not a driver one, so identifying and comparing one
// lives here. Turning a sort sequence into connection settings is driver-specific and belongs to
// the driver instead - see DbDriver.withSortSequence() and its ODBC implementation.
export class SortSequenceUtils {
	// Sort sequence isn't fully identified by name alone - a custom table's library matters too (two
	// libraries could each have a table of the same name), so every comparison/build here takes both.
	static matches(a: SortSequenceUtils.Identity, b: SortSequenceUtils.Identity): boolean {
		return a.sortSequence === b.sortSequence && a.sortSequenceLibrary === b.sortSequenceLibrary;
	}
}

export namespace SortSequenceUtils {
	export interface Identity {
		sortSequence: string;
		sortSequenceLibrary: string;
	}
}
