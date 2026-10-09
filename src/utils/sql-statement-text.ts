import { StringUtils } from './string-utils.js';

// Pure text/offset logic backing EditorUtils' statement-extraction methods, deliberately kept
// free of any `vscode` import -- EditorUtils imports `vscode`, which isn't a real resolvable
// module outside a running Extension Host, so anything in that file (even an otherwise-pure
// method) can't be loaded by a plain Node test runner. This class takes the document's raw text
// and character offsets instead of a vscode.TextDocument/Position/Selection, so it can be unit
// tested directly; EditorUtils.getSelectedSql/getSqlUpToCursor/getCaretPosition are thin wrappers over it.
export class SqlStatementText {
	// Bounded by the cursor (not the statement's trailing ";") so callers can look backward for
	// context, e.g. the nearest keyword, without picking up text the user hasn't typed yet.
	// Spans lines, since the keyword and the value being completed may not share a line.
	static extractStatementUpToCursor(text: string, offset: number): string {
		let start = SqlStatementText.getStatementStart(text, offset);
		return text.substring(start, offset);
	}

	// The cursor's 1-based line/column *within the current SQL statement* (as returned by
	// extractSelectedStatements for a plain cursor position), not the document -- this is the
	// coordinate space AST-based tools like dt-sql-parser expect, since they're fed the statement
	// text in isolation, not the whole document. Anchored to the *trimmed* statement start, not the
	// raw ";"-bounded one, because that trims leading whitespace (e.g. the newline right after the
	// previous statement's ";") before handing the text to an AST parser -- if this counted from the
	// untrimmed start instead, the coordinates would be off by however many leading blank
	// lines/columns got trimmed away for every statement that isn't the very first in the document.
	static getCaretPosition(text: string, offset: number): SqlStatementText.CaretPosition {
		let start = SqlStatementText.getTrimmedStatementStart(text, offset);
		let upToCursor = offset > start ? text.substring(start, offset) : '';
		let lines = upToCursor.split('\n');
		return {lineNumber: lines.length, column: lines[lines.length - 1].length + 1};
	}

	static getStatementStart(text: string, offset: number): number {
		let start = 0;

		for(let separator of SqlStatementText.findSeparators(text)) {
			if(separator >= offset) {
				break;
			}

			start = separator + 1;
		}

		return start;
	}

	// Every statement in the text, trimmed, blank ones dropped - what Execute All runs.
	static extractAllStatements(text: string): string[] {
		return SqlStatementText.splitStatements(text).map(statement => statement.sql);
	}

	// Offsets of each ";" that ends a statement: one outside a string ('...'), a delimited identifier
	// ("..."), a -- line comment and a /* */ block comment. A doubled quote inside a string or identifier
	// needs no special case - it closes and reopens. Comments matter as much as strings here: an
	// apostrophe in "-- the body's length" would otherwise open a string that swallows every ";" after it.
	static findSeparators(text: string): number[] {
		let separators: number[] = [];
		let i = 0;

		while(i < text.length) {
			let char = text[i];

			if(char === `'` || char === '"') {
				let close = text.indexOf(char, i + 1);
				i = close < 0 ? text.length : close + 1;
			} else if(char === '-' && text[i + 1] === '-') {
				let close = text.indexOf('\n', i + 2);
				i = close < 0 ? text.length : close + 1;
			} else if(char === '/' && text[i + 1] === '*') {
				let close = text.indexOf('*/', i + 2);
				i = close < 0 ? text.length : close + 2;
			} else {
				if(char === ';') {
					separators.push(i);
				}

				i++;
			}
		}

		return separators;
	}

	// A non-empty [selectionStart, selectionEnd) range returns every statement it touches at all
	// (in document order) - the caller decides what to do with more than one, e.g. running only the
	// first. An empty selection (selectionStart === selectionEnd, a plain cursor) instead returns the
	// single statement containing that position, matched against each statement's untrimmed ";"-
	// bounded span (rawStart/rawEnd) rather than its trimmed one, so a cursor sitting in the
	// whitespace between two statements still resolves to the adjacent statement rather than
	// matching nothing - the same rule the old cursor-only lookup used.
	static extractSelectedStatements(text: string, selectionStart: number, selectionEnd: number): string[] {
		let statements = SqlStatementText.splitStatements(text);

		if(selectionStart === selectionEnd) {
			let containing = statements.find(statement => selectionStart >= statement.rawStart && selectionStart <= statement.rawEnd);
			return containing ? [containing.sql] : [];
		}

		return statements
			.filter(statement => selectionEnd > statement.start && selectionStart < statement.end)
			.map(statement => statement.sql);
	}

	// Splits on findSeparators' ";", keeping both each statement's trimmed offsets
	// (start/end, used for the highlighted-selection overlap check) and its untrimmed ";"-bounded
	// ones (rawStart/rawEnd, used for the plain-cursor containment check) - unlike EditorUtils.getAllSql
	// (which only needs the trimmed text), extractSelectedStatements needs both to line up with the
	// untrimmed document.
	private static splitStatements(text: string): Array<{sql: string; start: number; end: number; rawStart: number; rawEnd: number}> {
		let rawSegments: Array<{start: number; end: number}> = [];
		let segmentStart = 0;

		for(let separator of SqlStatementText.findSeparators(text)) {
			rawSegments.push({start: segmentStart, end: separator});
			segmentStart = separator + 1;
		}

		rawSegments.push({start: segmentStart, end: text.length});

		return rawSegments
			.map(segment => ({...SqlStatementText.trimSegment(text, segment.start, segment.end), rawStart: segment.start, rawEnd: segment.end}))
			.filter(segment => StringUtils.isNotBlank(segment.sql));
	}

	private static trimSegment(text: string, start: number, end: number): {sql: string; start: number; end: number} {
		while(start < end && /\s/.test(text[start])) {
			start++;
		}

		while(end > start && /\s/.test(text[end - 1])) {
			end--;
		}

		return {sql: text.substring(start, end), start, end};
	}

	// Same as getStatementStart, but skipping past any leading whitespace -- the point at which the
	// containing statement's trimmed text actually begins. If the cursor itself sits within that
	// leading whitespace (nothing typed yet), this can exceed offset; callers must check for that
	// rather than assume it's always <= offset.
	// Also used by EditorUtils.getStatementStartOffset to translate a document-relative cursor
	// position into the trimmed-statement-relative offset a local Go to Definition target (CteAssist/
	// SqlParser's alias offset) was computed in, so the two can be added together.
	static getTrimmedStatementStart(text: string, offset: number): number {
		let start = SqlStatementText.getStatementStart(text, offset);
		let index = start;

		while(index < text.length && /\s/.test(text[index])) {
			index++;
		}

		return index;
	}
}

export namespace SqlStatementText {
	export interface CaretPosition {
		readonly lineNumber: number;
		readonly column: number;
	}
}
