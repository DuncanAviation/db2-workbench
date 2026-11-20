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
	// Format Document and Format Selection run the same pipeline: a scratch ".sql" file used only to
	// reformat SQL pasted from application code is a real workflow, and formatting all of it must give
	// what selecting all of it and formatting the selection gives.
	static formatDocumentText(text: string, options: SqlDocumentFormatter.Options): string {
		return SqlDocumentFormatter.formatText(text, options);
	}

	static formatSelectionText(text: string, options: SqlDocumentFormatter.Options): string {
		return SqlDocumentFormatter.formatText(text, options);
	}

	// The text is read as host code first (EmbeddedSqlExtractor). Text that isn't host code is SQL
	// and formats as it is. Host code formats as the queries it builds, with any plain DB2 statement
	// found among it, in source order; the host code itself is dropped. An extracted query has no ";"
	// of its own (the host statement's ";" isn't SQL), so one is added after each query that isn't
	// last, keeping it apart from the next statement when the result is formatted again.
	private static formatText(text: string, options: SqlDocumentFormatter.Options): string {
		try {
			let extraction = EmbeddedSqlExtractor.extract(text);

			if(!extraction.hostCode) {
				return SqlDocumentFormatter.formatSql(text, options) ?? text;
			}

			let separator = SqlDocumentFormatter.separator(options);
			let last = extraction.segments.length - 1;
			return extraction.segments
				.map((segment, index) => {
					let formatted = SqlDocumentFormatter.formatSql(segment.sql, options) ?? segment.sql;
					return segment.kind === 'extracted' && index < last && !formatted.trimEnd().endsWith(';') ? `${formatted};` : formatted;
				})
				.join(separator);
		} catch {
			return text;
		}
	}

	// Tokenizes once, splits into statements and formats each on its own, so a failure formatting one
	// statement leaves it as written without taking its neighbours with it. SqlPrettyPrinter.formatTokens
	// never throws itself; the try/catch here guards what runs above it. Undefined when the text holds
	// no statement at all.
	private static formatSql(text: string, options: SqlDocumentFormatter.Options): string | undefined {
		let spans = SqlStatementSplitter.split(SqlTokenizer.tokenize(text));

		if(spans.length === 0) {
			return undefined;
		}

		return spans
			.map(span => {
				try {
					return SqlPrettyPrinter.formatTokens(span, options);
				} catch {
					return span.map(token => token.text).join('');
				}
			})
			.join(SqlDocumentFormatter.separator(options));
	}

	private static separator(options: SqlDocumentFormatter.Options): string {
		return `\n${'\n'.repeat(Math.max(0, options.linesBetweenQueries))}`;
	}
}

export namespace SqlDocumentFormatter {
	export interface Options extends SqlPrettyPrinter.Options {
		linesBetweenQueries: number;
	}
}
