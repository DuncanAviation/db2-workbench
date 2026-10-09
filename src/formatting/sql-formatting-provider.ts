import * as vscode from 'vscode';
import { Extension } from '../extension.js';
import { SqlDocumentFormatter } from './sql-document-formatter.js';
import { SqlStatementSplitter } from './sql-statement-splitter.js';
import { SqlTokenizer } from './sql-tokenizer.js';

// The only file in src/formatting/ that imports vscode -- everything it delegates to
// (SqlDocumentFormatter and below) takes/returns plain strings, so the rest of the pipeline stays
// unit-testable without the Extension Host.
export class SqlFormattingProvider implements vscode.DocumentFormattingEditProvider, vscode.DocumentRangeFormattingEditProvider {
	constructor(private extension: Extension) {}

	provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
		let text = document.getText();
		let fullRange = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
		let formatted = SqlDocumentFormatter.formatDocumentText(text, this.extension.configurations.formattingOptions);
		return [vscode.TextEdit.replace(fullRange, formatted)];
	}

	provideDocumentRangeFormattingEdits(document: vscode.TextDocument, range: vscode.Range): vscode.TextEdit[] {
		let statementRange = this.expandToEnclosingStatements(document, range);
		let formatted = SqlDocumentFormatter.formatSelectionText(document.getText(statementRange), this.extension.configurations.formattingOptions);
		return [vscode.TextEdit.replace(statementRange, formatted)];
	}

	// A selection can land anywhere inside a statement, or straddle several -- widen it to cover
	// every statement it touches so formatting a partial selection reformats each whole statement
	// rather than reindenting/rewrapping only the selected fragment in isolation. Boundaries come
	// from the same token-based splitter SqlDocumentFormatter uses internally, so a ";" inside a
	// string/comment/quoted identifier is never mistaken for one here either. Falls back to the
	// original range if the selection doesn't land inside any real statement (e.g. only whitespace
	// between two statements), leaving today's behavior unchanged for that corner case.
	private expandToEnclosingStatements(document: vscode.TextDocument, range: vscode.Range): vscode.Range {
		let tokens = SqlTokenizer.tokenize(document.getText());
		let spans = SqlStatementSplitter.split(tokens);
		let selectionStart = document.offsetAt(range.start);
		let selectionEnd = document.offsetAt(range.end);
		let overlapping = spans.filter(span => span[0].start < selectionEnd && span[span.length - 1].stop + 1 > selectionStart);

		if(overlapping.length === 0) {
			return range;
		}

		let firstSpan = overlapping[0];
		let lastSpan = overlapping[overlapping.length - 1];
		let start = document.positionAt(SqlFormattingProvider.skipLeadingBlankLines(firstSpan));
		let end = document.positionAt(lastSpan[lastSpan.length - 1].stop + 1);
		return new vscode.Range(start, end);
	}

	// A span's own leading tokens include the whitespace gap left over from the *previous*
	// statement's ";" (that's how SqlStatementSplitter attaches it) -- starting the range at
	// firstSpan[0] would pull that gap into the edit and lose it to formatTokens's leading-
	// whitespace strip, while the trailing gap after lastSpan's own ";" is never included in the
	// first place (the span ends at the ";" token itself). Only the blank-line part of that gap
	// (everything up to and including its last "\n") is worth shielding from the edit the same way
	// -- indentation on the statement's own first line (e.g. a paste sitting under some tabs) is
	// ordinary leading whitespace the formatter has always been expected to normalize away, so it
	// stays inside the range.
	private static skipLeadingBlankLines(span: SqlTokenizer.SqlToken[]): number {
		let gapStart = span[0].start;
		let gapText = '';

		for(let token of span) {
			if(token.type !== SqlTokenizer.TokenType.WHITESPACE) {
				break;
			}

			gapText += token.text;
		}

		let lastNewline = gapText.lastIndexOf('\n');
		return lastNewline === -1 ? gapStart : gapStart + lastNewline + 1;
	}
}
