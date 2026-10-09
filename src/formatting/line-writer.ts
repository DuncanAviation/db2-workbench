// The pretty-printer's output model. Every rendering step returns lines of text, each tagged with
// its indent level, rather than finished strings -- so gluing a clause keyword to its content,
// telling a multi-line item from a one-line one, or measuring a line's width works on the lines
// themselves instead of splitting, prefix-stripping and re-joining strings. Indentation is turned
// into characters exactly once, by render.
export class LineWriter {
	static indentUnit(options: {useTabs: boolean; tabWidth: number}): string {
		return options.useTabs ? '\t' : ' '.repeat(Math.max(1, options.tabWidth));
	}

	// How many columns one indentUnit occupies on screen -- what width budgets must count, since a
	// tab is one character but tabWidth columns wide.
	static indentColumns(options: {tabWidth: number}): number {
		return Math.max(1, options.tabWidth);
	}

	static render(lines: LineWriter.Line[], indentUnit: string): string {
		return lines.map(line => `${indentUnit.repeat(Math.max(0, line.level))}${line.text}`).join('\n');
	}

	// Continues the last of "first"'s lines with the first of "second"'s, "separator" between them;
	// the joined line keeps the level of the line it started on. Either side may be empty.
	static join(first: LineWriter.Line[], second: LineWriter.Line[], separator: string): LineWriter.Line[] {
		if(first.length === 0) {
			return second;
		}

		if(second.length === 0) {
			return first;
		}

		let last = first[first.length - 1];
		let joined = second[0].text.length === 0 || last.text.length === 0 ? `${last.text}${second[0].text}` : `${last.text}${separator}${second[0].text}`;
		return [...first.slice(0, -1), {level: last.level, text: joined}, ...second.slice(1)];
	}

	// Whether "lines" take more than one line of output -- a block comment can hold line breaks of
	// its own within one line's text.
	static isMultiLine(lines: LineWriter.Line[]): boolean {
		return lines.length > 1 || lines.some(line => line.text.includes('\n'));
	}
}

export namespace LineWriter {
	export interface Line {
		readonly level: number;
		readonly text: string;
	}
}
