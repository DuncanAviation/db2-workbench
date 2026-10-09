import * as vscode from 'vscode';
import { Extension } from '../extension.js';
import { EditorUtils } from '../utils/editor-utils.js';
import { Nullable } from '../utils/nullable.js';
import { StatementParser } from '../utils/statement-parser.js';
import { StringUtils } from '../utils/string-utils.js';
import { DbAssist } from './db-assist.js';
import { SpAssist } from './sp-assist.js';
import { SqlAssist } from './sql-assist.js';

export class StatementCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private extension: Extension) { }

	async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, _token: vscode.CancellationToken, _context: vscode.CompletionContext): Promise<vscode.CompletionItem[] | vscode.CompletionList> {
		let key = document.uri.toString();
		let sql = StatementParser.stripComments(EditorUtils.getSelectedSql(document, new vscode.Selection(position, position))[0]);
		let descriptors: DbAssist.CompletionItemDescriptor[];

		if(this.extension.connections.hasActiveConnection(key)) {
			descriptors = await this.getItems(document, position, sql);
		} else {
			// Resolving table/column/etc. completions for a not-yet-connected session would
			// establish its connection as a side effect of typing, interrupting it with a
			// connection/password prompt. Only keyword completions (which need no connection) are
			// offered until the user deliberately connects via this one-time notice.
			this.extension.connections.promptToConnect(key);
			descriptors = new DbAssist(this.extension).getKeyWordItems();
		}

		let casing = DbAssist.getDominantCasing(sql);
		let replacementRange = this.getReplacementRange(document, position);
		let items = descriptors.map(descriptor => this.buildCompletionItem(descriptor));

		items.forEach(item => {
			let text = item.insertText ?? (typeof item.label === 'string' ? item.label : item.label.label);

			item.insertText = casing === 'lower'
				? text.toString().toLowerCase()
				: text.toString().toUpperCase();

			// Set the range for replacement
			if(replacementRange) {
				item.range = replacementRange;
			}
		});

		return items;
	}

	private getReplacementRange(document: vscode.TextDocument, position: vscode.Position): Nullable<vscode.Range> {
		let linePrefix = document.lineAt(position).text.substring(0, position.character);
		let replacementRange: vscode.Range | undefined;

		// Determine the word being typed at the current position
		let wordRange = document.getWordRangeAtPosition(position);

		if(wordRange) {
			replacementRange = wordRange;
		} else {
			// If no word range, check for partial words that might not be considered a full "word" by getWordRangeAtPosition
			// For example, if the user types "MYTABLE." and then "C", getWordRangeAtPosition might only return "C"
			// We need to handle cases like "MYTABLE.COL" where "COL" is the prefix.
			let lastDotIndex = linePrefix.lastIndexOf('.');

			if(lastDotIndex !== -1) {
				let afterDot = linePrefix.substring(lastDotIndex + 1);

				if(afterDot.match(/^\w*$/)) { // Check if it's a valid partial word after a dot
					replacementRange = new vscode.Range(position.line, lastDotIndex + 1, position.line, position.character);
				}
			}
		}

		return replacementRange;
	}

	private async getItems(document: vscode.TextDocument, position: vscode.Position, currentSql?: string): Promise<DbAssist.CompletionItemDescriptor[]> {
		if(StringUtils.isBlank(currentSql)) {
			return new DbAssist(this.extension).getKeyWordItems();
		}

		let parseResults = StatementParser.parse(currentSql);

		if(parseResults == null) {
			return new DbAssist(this.extension).getKeyWordItems();
		}

		let key = document.uri.toString();
		let sql = EditorUtils.getSqlUpToCursor(document, position);
		let caretPosition = EditorUtils.getCaretPosition(document, position);

		return parseResults.statementType === StatementParser.StatementType.SQL
			? await new SqlAssist(this.extension).getItems(key, sql, caretPosition, parseResults)
			: await new SpAssist(this.extension).getItems(key, sql, caretPosition, parseResults);
	}

	private buildCompletionItem(descriptor: DbAssist.CompletionItemDescriptor): vscode.CompletionItem {
		let item = new vscode.CompletionItem(descriptor.label, vscode.CompletionItemKind[descriptor.kind]);
		item.insertText = descriptor.insertText;
		item.detail = descriptor.detail;
		item.sortText = descriptor.sortText;
		return item;
	}
}