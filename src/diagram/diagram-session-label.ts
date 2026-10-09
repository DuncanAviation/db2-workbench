// How a diagram identifies itself outside its own editor: the file name its top-right info panel
// displays, and (via DiagramEditorProvider) the name shown for it in its shared "Diagrams: {connection}"
// session's attached-files list. Pure (no vscode import) so it's unit-testable through the existing
// .spec.ts/mocha convention, which is also why this takes a plain uri string rather than a vscode.Uri.

// Percent-decoded, since a document uri encodes characters a file name is allowed to contain (a space
// becomes %20). A stray '%' that isn't a valid escape makes decodeURIComponent throw, so a segment that
// can't be decoded is returned exactly as it arrived rather than losing the name entirely.
export function diagramFileName(documentUri: string): string {
	let segments = documentUri.split('/');
	let lastSegment = segments[segments.length - 1];

	if(!lastSegment) {
		return documentUri;
	}

	try {
		return decodeURIComponent(lastSegment);
	} catch {
		return lastSegment;
	}
}
