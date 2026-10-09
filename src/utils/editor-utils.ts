import * as vscode from 'vscode';
import { Extension } from '../extension.js';
import { Nullable } from './nullable.js';
import { SqlParser } from './sql-parser.js';
import { SqlStatementText } from './sql-statement-text.js';
import { StatementParser } from './statement-parser.js';

import { StringUtils } from './string-utils.js';

export class EditorUtils {
	static getOpenEditorTabs(fileExtension: string): EditorUtils.EditorTab[] {
		let tabs: EditorUtils.EditorTab[] = [];

		for (let group of vscode.window.tabGroups.all) {
			for (let tab of group.tabs) {
				if (tab.input instanceof vscode.TabInputText && tab.input.uri.path.toLowerCase().endsWith(fileExtension)) {
					tabs.push(<EditorUtils.EditorTab>tab);
				}
			}
		}

		return tabs;
	}

	// Thin vscode-dependent wrapper -- the actual text/offset logic lives in SqlStatementText
	// (which has no `vscode` import) so it can be unit tested directly. An empty selection (a plain
	// cursor, e.g. `new vscode.Selection(position, position)`) returns a single-element array with
	// the statement containing that position; a non-empty (highlighted) selection returns every
	// statement it touches at all, in document order -- callers that only want the one statement at
	// the cursor, or only the first of several highlighted statements, index into the result.
	static getSelectedSql(document: vscode.TextDocument, selection: vscode.Selection): string[] {
		return SqlStatementText.extractSelectedStatements(document.getText(), document.offsetAt(selection.start), document.offsetAt(selection.end));
	}

	// Bounded by the cursor (not the statement's trailing ";") so callers can look backward for
	// context, e.g. the nearest keyword, without picking up text the user hasn't typed yet.
	// Spans lines, since the keyword and the value being completed may not share a line.
	static getSqlUpToCursor(document: vscode.TextDocument, position: vscode.Position): string {
		return SqlStatementText.extractStatementUpToCursor(document.getText(), document.offsetAt(position));
	}

	// The cursor's 1-based line/column *within the current SQL statement* (as returned by
	// getSelectedSql for a plain cursor position), not the document -- this is the coordinate space
	// AST-based tools like dt-sql-parser expect, since they're fed the statement text in isolation,
	// not the whole document. Anchored to the same statement-start offset as getSelectedSql/
	// getSqlUpToCursor, so it always lines up with whichever of those a caller also used to get the
	// statement text.
	static getCaretPosition(document: vscode.TextDocument, position: vscode.Position): EditorUtils.CaretPosition {
		return SqlStatementText.getCaretPosition(document.getText(), document.offsetAt(position));
	}

	static getAllSql(document: vscode.TextDocument): string[] {
		return SqlStatementText.extractAllStatements(document.getText());
	}

	// Gathers everything Commands.onViewTableDetails' Go to Definition dispatch needs about the word
	// under "position": the word itself, the statement it sits in, and (if that word matches a
	// FROM/JOIN/etc. table reference) which occurrence of it. Returns undefined only when there's no
	// word at all under the cursor or it isn't inside a SQL statement - a word that's simply not a
	// table reference (e.g. a column or keyword) still comes back with occurrence left empty, since
	// callers (e.g. a CTE name check) may still care about word/sql alone.
	//
	// Resolution is position-first: if "position" sits directly on a table-name/alias token in an
	// actual FROM/JOIN declaration, that occurrence wins outright (SqlParser.findTableReferenceOccurrenceAt) -
	// this matters because the exact same table+alias pair can legitimately appear more than once in
	// one statement (e.g. a table aliased to its own name, once inside a CTE body and again in the
	// outer query), and only the click position can tell those apart. Only when the cursor isn't on
	// any declaration at all (e.g. a column qualifier like "e.name" elsewhere in the statement) does
	// this fall back to a plain name/alias search (SqlParser.findTable) - the same, position-blind
	// resolution this used exclusively before the collision above was found.
	static getWordContextAtPosition(document: vscode.TextDocument, position: vscode.Position): Nullable<EditorUtils.WordContext> {
		let wordRange = document.getWordRangeAtPosition(position);

		if(wordRange == null) {
			return undefined;
		}

		let word = document.getText(wordRange);
		let sql = EditorUtils.getSelectedSql(document, new vscode.Selection(position, position))[0];

		if(StringUtils.isBlank(sql)) {
			return undefined;
		}

		let parseResults = StatementParser.parse(sql);
		let localOffset = document.offsetAt(position) - EditorUtils.getStatementStartOffset(document, position);
		let routineCall = SqlParser.findRoutineCallAt(sql, localOffset);

		// A CALL statement names a procedure and no tables, so only the routine call means anything there.
		if(parseResults?.statementType !== StatementParser.StatementType.SQL) {
			return {word: word, sql: sql, occurrence: undefined, routineCall: routineCall};
		}

		let occurrence = SqlParser.findTableReferenceOccurrenceAt(sql, localOffset)
			?? EditorUtils.resolveTableReferenceByName(parseResults.tables, word);

		return {word: word, sql: sql, occurrence: occurrence, routineCall: routineCall};
	}

	// The name-based fallback getWordContextAtPosition uses once the cursor isn't sitting directly on
	// a FROM/JOIN declaration - e.g. an "e.name" qualifier used later in the statement. Doesn't
	// attempt real CTE-body-vs-outer-query scoping (a "known, accepted gap" other regex-based parts
	// of this codebase already tolerate, see CteAssist) - just takes SqlParser.findTable's first
	// match, same as this whole feature's original, pre-position-aware behavior.
	private static resolveTableReferenceByName(tables: SqlParser.TableReference[] | undefined, word: string): Nullable<SqlParser.TableReferenceOccurrence> {
		let tableReference = SqlParser.findTable(tables, word);

		if(tableReference == null) {
			return undefined;
		}

		let matchedAs: 'table' | 'alias' = StringUtils.isNotBlank(tableReference.alias) && StringUtils.equalsIgnoreCase(tableReference.alias, word) ? 'alias' : 'table';
		return {reference: tableReference, matchedAs: matchedAs};
	}

	// The document offset "position"'s containing SQL statement starts at, once leading whitespace
	// is trimmed - the same anchor getSelectedSql/getCaretPosition use, so a local offset returned by
	// CteAssist.findCteDeclarationOffset/SqlParser.findAliasDeclarationOffset (computed against that
	// trimmed statement text) can be added to this to get a real document offset.
	static getStatementStartOffset(document: vscode.TextDocument, position: vscode.Position): number {
		return SqlStatementText.getTrimmedStatementStart(document.getText(), document.offsetAt(position));
	}

	static async updateCacheForStatement(extension: Extension, document: vscode.TextDocument, position: vscode.Position): Promise<void> {
		let currentSql = EditorUtils.getSelectedSql(document, new vscode.Selection(position, position))[0];

		if(StringUtils.isBlank(currentSql)) {
			return;
		}

		let parseResults = StatementParser.parse(currentSql);

		if(parseResults == null) {
			return;
		}

		let needsConnection = (parseResults.statementType === StatementParser.StatementType.SQL && !!parseResults.tables?.length)
			|| (parseResults.statementType === StatementParser.StatementType.SP && !!parseResults.name);

		if(!needsConnection) {
			return;
		}

		let key = document.uri.toString();

		// This cache warm-up has nothing to do without a connection, and (like content assist)
		// shouldn't establish one as a side effect of typing -- see
		// DbConnections.promptToConnect/hasActiveConnection.
		if(!extension.connections.hasActiveConnection(key)) {
			extension.connections.promptToConnect(key);
			return;
		}

		if(parseResults.statementType === StatementParser.StatementType.SQL
		&& parseResults.tables?.length) {
			let defaultSchema = (await extension.connections.getConnectionConfig({key: key}))?.defaultTableSchema;

			let targets: Array<{schema?: string; table: string}> = [];

			for(let table of parseResults.tables) {
				// Prefer the schema the table was actually declared with (e.g. "FROM myschema.mytable")
				// over the connection's default, since a schema-qualified table may not live there.
				let schema = table.schema ?? defaultSchema;
				let tables = await extension.memoryCache.getRelations({key: key, schema: schema});

				if(tables.some(existingTable => StringUtils.equalsIgnoreCase(existingTable.name, table.table))) {
					targets.push({schema: schema, table: table.table});
				}
			}

			// One warm-up request for every table in the statement rather than one per table - the whole
			// point here is to have the columns cached before autocomplete asks for them, and a statement
			// joining six tables shouldn't cost six round trips to do it.
			if(targets.length > 0) {
				await extension.memoryCache.getColumns({key: key, tables: targets});
			}
		}

		// The routine list is one query per connection, shared by function completion, Go to Definition on
		// a call and CALL's procedure resolution - loading it here means none of those waits on it first.
		if(parseResults.statementType === StatementParser.StatementType.SQL) {
			await extension.memoryCache.getRoutines({key: key});
		}

		if(parseResults.statementType === StatementParser.StatementType.SP
		&& parseResults.name) {
			await extension.memoryCache.getProcedureParams({key: key, schema: parseResults.schema, procedure: parseResults.name});
		}
	}
}

export namespace EditorUtils {
	export interface EditorTab extends vscode.Tab {
		readonly input: vscode.TabInputText;
	}

	export type CaretPosition = SqlStatementText.CaretPosition;

	export interface WordContext {
		word: string;
		sql: string;
		occurrence: Nullable<SqlParser.TableReferenceOccurrence>;
		/** Set when the cursor is on a routine call's name (or its schema) - see SqlParser.findRoutineCallAt. */
		routineCall?: Nullable<SqlParser.RoutineCall>;
	}
}