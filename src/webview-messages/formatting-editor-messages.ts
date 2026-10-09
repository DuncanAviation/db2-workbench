import type { SqlDocumentFormatter } from '../formatting/sql-document-formatter.js';

export interface FormattingEditorInitialState {
	options: SqlDocumentFormatter.Options;
	// initialSql formatted with options, which is what the SQL box shows first.
	initialSql: string;
	// The unformatted text initialSql was made from. Previews format this rather than the box, so a
	// lossy option (Remove Comments, Keyword Case) is undone again by unchecking it.
	sourceSql: string;
}

export interface PreviewFormatMessage {
	command: 'previewFormat';
	sql: string;
	options: SqlDocumentFormatter.Options;
}

export interface SaveFormattingMessage {
	command: 'saveFormatting';
	options: SqlDocumentFormatter.Options;
}

export interface CancelEditMessage {
	command: 'cancelEdit';
}

export type FormattingEditorMessage = PreviewFormatMessage | SaveFormattingMessage | CancelEditMessage;

export interface PreviewResultMessage {
	command: 'previewResult';
	text: string;
}
