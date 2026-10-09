import { LineWriter } from './line-writer.js';
import { SqlTokenizer } from './sql-tokenizer.js';

// Greedy delimited-list layout, shared by the SELECT list (the "wrapToWidth" differentiator),
// GROUP BY/ORDER BY (always wrapped, not user-configurable -- see sql-pretty-printer.ts), and
// FROM (always one per line). Rendering itself (turning a token span into lines) is left to
// caller-supplied callbacks so this stays independent of keywordCase/denseOperators/subquery
// recursion/comments -- whatever the pretty-printer's own expression renderer does.
export class SelectListWrapper {
	// Splits "tokens" into top-level comma-delimited items, each keeping the comma that ends it. A
	// comma nested inside a deeper paren group (a function call's own argument list, e.g.
	// "COALESCE(a, b)") is never a delimiter, so that call is one item; a "CASE...END" expression
	// has no comma delimiter of its own at all (its WHEN/THEN branches aren't comma-separated), so
	// it's always one item regardless of how many branches it has -- items are never split
	// mid-expression as a structural consequence of this, not a special case. An empty item is
	// kept when a comma ends it (",," in malformed SQL), so no comma is ever dropped.
	static splitTopLevelItems<T extends SqlTokenizer.SqlToken>(tokens: T[]): SelectListWrapper.Item<T>[] {
		let items: SelectListWrapper.Item<T>[] = [];
		let current: T[] = [];
		let depth = 0;

		for(let token of tokens) {
			if(token.type === SqlTokenizer.TokenType.PUNCTUATION) {
				if(token.text === '(') {
					depth++;
				} else if(token.text === ')') {
					depth = Math.max(0, depth - 1);
				} else if(token.text === ',' && depth === 0) {
					items.push({tokens: current, delimiter: token});
					current = [];
					continue;
				}
			}

			current.push(token);
		}

		if(current.length > 0) {
			items.push({tokens: current});
		}

		return items;
	}

	// Lays "items" (already split by splitTopLevelItems) out as either one-per-line or a greedy
	// width-wrap, never splitting a single item across lines even if it alone exceeds maxWidth. An
	// item whose own rendering already spans multiple lines (a derived-table/scalar subquery,
	// recursively formatted by the pretty-printer) is always placed on its own line group rather
	// than packed alongside others.
	static emitDelimitedList<T extends SqlTokenizer.SqlToken>(items: SelectListWrapper.Item<T>[], options: SelectListWrapper.Options<T>): LineWriter.Line[] {
		let pieces = SelectListWrapper.placeCommas(items, options);

		if(options.mode === 'oneColumnPerLine') {
			return pieces.flatMap(piece => piece.lines);
		}

		let level = options.baseIndentLevel;
		// Measured in screen columns -- a tab is one character but indentColumns wide.
		let indentWidth = Math.max(0, level) * options.indentColumns;
		let outputLines: LineWriter.Line[] = [];
		let currentLine = '';

		let flush = () => {
			if(currentLine.length > 0) {
				outputLines.push({level, text: currentLine});
				currentLine = '';
			}
		};

		for(let piece of pieces) {
			if(LineWriter.isMultiLine(piece.lines)) {
				flush();
				outputLines.push(...piece.lines);
				continue;
			}

			let text = piece.lines[0]?.text ?? '';

			if(currentLine.length === 0) {
				currentLine = text;
			} else {
				// Only the line still being assembled in "outputLines" position 0 can end up glued to a
				// clause keyword afterward (renderClauseSegment, for clauseLayout: "compact") -- once a
				// line has been flushed, every later line starts fresh at "level" with nothing prepended.
				let extraWidth = outputLines.length === 0 ? (options.firstLineExtraWidth ?? 0) : 0;
				let candidateWidth = indentWidth + extraWidth + currentLine.length + 1 + text.length;

				if(candidateWidth > options.maxWidth) {
					flush();
					currentLine = text;
				} else {
					currentLine = `${currentLine} ${text}`;
				}
			}

			if(piece.endsLine) {
				flush();
			}
		}

		flush();
		return outputLines;
	}

	// Decides where each item's delimiting comma goes. Normally it trails the item ("a,", or
	// "a, -- note" when a comment followed the comma), but an item ending in a line comment can't
	// take one -- the comma would be swallowed into the comment. Instead that comma leads the next
	// item (", b"), the leading-comma style people use precisely so each column can carry its own
	// trailing comment, and the commented item ends its output line.
	private static placeCommas<T extends SqlTokenizer.SqlToken>(items: SelectListWrapper.Item<T>[], options: SelectListWrapper.Options<T>): SelectListWrapper.Piece[] {
		let pieces: SelectListWrapper.Piece[] = [];
		let carried: SelectListWrapper.Piece | undefined;

		for(let item of items) {
			let rendered = options.renderItem(item.tokens);
			let lines = rendered.lines;

			if(carried) {
				lines = carried.endsLine ? [...carried.lines, ...lines] : LineWriter.join(carried.lines, lines, ' ');
				carried = undefined;
			}

			let delimiter = item.delimiter ? options.renderDelimiter(item.delimiter) : undefined;

			if(delimiter && rendered.endsLine) {
				carried = delimiter;
				pieces.push({lines, endsLine: true});
			} else if(delimiter) {
				pieces.push({lines: LineWriter.join(lines, delimiter.lines, ''), endsLine: delimiter.endsLine});
			} else {
				pieces.push({lines, endsLine: rendered.endsLine});
			}
		}

		// A comma after the last item (malformed, e.g. "a, b, FROM") still has to be printed somewhere.
		if(carried) {
			pieces.push(carried);
		}

		return pieces;
	}
}

export namespace SelectListWrapper {
	export interface Item<T extends SqlTokenizer.SqlToken> {
		tokens: T[];
		// The comma that ends this item, if any.
		delimiter?: T;
	}

	export interface Options<T extends SqlTokenizer.SqlToken> {
		mode: 'oneColumnPerLine' | 'wrapToWidth';
		maxWidth: number;
		// The level every item's first line is rendered at, and packed lines are placed at.
		baseIndentLevel: number;
		// Screen columns one indent level occupies (tabWidth for a tab).
		indentColumns: number;
		renderItem: (tokens: T[]) => Piece;
		// Renders an item's comma, with any comments that belong to it.
		renderDelimiter: (delimiter: T) => Piece;
		// Extra columns the very first assembled line will consume beyond its indent once it's glued
		// to a clause keyword under clauseLayout: "compact" (e.g. "SELECT ".length) -- omitted/0 when
		// the caller doesn't (yet) know whether this block will be glued to a header.
		firstLineExtraWidth?: number;
	}

	export interface Piece {
		lines: LineWriter.Line[];
		// The last line ends in a line comment, so nothing may follow it on that line.
		endsLine: boolean;
	}
}
