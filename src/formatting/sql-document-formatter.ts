import { EmbeddedSqlExtractor } from './embedded-sql-extractor.js';
import { SqlPrettyPrinter } from './sql-pretty-printer.js';
import { SqlStatementSplitter } from './sql-statement-splitter.js';
import { SqlTokenizer } from './sql-tokenizer.js';

// Orchestrates the formatting pipeline and owns fault isolation across statements: tokenize once,
// split into per-statement spans, format each independently so a bug/crash formatting one
// statement can never take down its siblings in the same document. Layered with
// SqlPrettyPrinter.formatTokens's own internal never-throw guarantee -- this class's per-span
// try/catch and the outer whole-document try/catch are defense-in-depth for something going wrong
// above the printer itself (e.g. in tokenizing or splitting), not the expected path for merely
// unusual SQL.
export class SqlDocumentFormatter {
	// Whole-document formatting runs the same embedded-host-code extraction Format Selection does --
	// a scratch ".sql" file used purely to reformat a pasted host-code snippet is a real workflow
	// (Format Document must not behave differently from selecting-all-and-Format-Selection on the
	// exact same text), and EmbeddedSqlExtractor.hasSqlKeyword/hasConcatenationGlue already no-op on
	// anything that doesn't look like host-language string concatenation, so ordinary multi-
	// statement DB2 SQL (including one that builds a dynamic statement with "||") passes through
	// untouched -- see hasConcatenationGlue's "+"-only glue requirement for why "||" specifically
	// doesn't trip this.
	static formatDocumentText(text: string, options: SqlDocumentFormatter.Options): string {
		return SqlDocumentFormatter.formatText(text, options);
	}

	static formatSelectionText(text: string, options: SqlDocumentFormatter.Options): string {
		return SqlDocumentFormatter.formatText(text, options);
	}

	private static formatText(text: string, options: SqlDocumentFormatter.Options): string {
		try {
			// Splits the *raw* text into statement spans before extraction runs, rather than running
			// EmbeddedSqlExtractor once over the whole input -- extraction deliberately drops
			// whatever sits outside the first/last string-or-template piece it finds (that's what
			// strips a host language's own "String sql = ...;" declaration), so running it over two
			// unrelated statements at once (one embedded-host-code block, one plain DB2 statement
			// with no quotes at all) would treat the second statement as more of that declaration
			// syntax and silently drop it. Extracting per span keeps each statement's fate
			// independent, same as formatting itself already is.
			let tokens = SqlTokenizer.tokenize(text);
			let spans = SqlStatementSplitter.split(tokens);

			if(spans.length === 0) {
				return text;
			}

			let separator = `\n${'\n'.repeat(Math.max(0, options.linesBetweenQueries))}`;
			return spans
				.map((span, index) => {
					let spanText = span.map(token => token.text).join('');

					try {
						let extraction = EmbeddedSqlExtractor.extract(spanText);
						let spanTokens = extraction.replaced ? SqlTokenizer.tokenize(extraction.sql) : span;
						let formatted = SqlPrettyPrinter.formatTokens(spanTokens, options);

						// EmbeddedSqlExtractor.extract never carries a ";" into its output -- it treats
						// the one at the end of a host-code span as that language's own statement
						// terminator, not part of the SQL, and drops it as declaration syntax. That's
						// right when this is the last statement in the document, but every non-last span
						// exists *because* SqlStatementSplitter found a top-level ";" ending it -- drop
						// that here too and the next statement's text runs straight into this one with
						// nothing to separate them, silently merging the two the next time this is parsed.
						let isLastStatement = index === spans.length - 1;
						return extraction.replaced && !isLastStatement ? `${formatted};` : formatted;
					} catch {
						return spanText;
					}
				})
				.join(separator);
		} catch {
			return text;
		}
	}
}

export namespace SqlDocumentFormatter {
	export interface Options extends SqlPrettyPrinter.Options {
		linesBetweenQueries: number;
	}
}
