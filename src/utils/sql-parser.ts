import type { SystemRoutine } from '../models/system-routine.js';
import { KeywordTable } from './keyword-table.js';
import { Nullable } from './nullable.js';
import { StatementParser } from './statement-parser.js';

import { StringUtils } from './string-utils.js';

export class SqlParser {
	// Kept as aliases (rather than inlining KeywordTable's names everywhere below) so this file's
	// own regex-building reads the same as it always has -- the keyword data itself now lives in
	// KeywordTable, shared with Db2SyntaxShim and the SQL formatter, see keyword-table.ts.
	static readonly TABLE_KEY_WORDS = KeywordTable.TABLE_KEYWORDS;
	static readonly COLUMN_KEY_WORDS = KeywordTable.COLUMN_KEYWORDS;
	static readonly KEY_WORDS = KeywordTable.CLAUSE_KEYWORDS;
	static readonly RESERVED_WORDS = KeywordTable.RESERVED_WORDS;

	static parse(sql: string): SqlParser.SqlParseResults {
		return {
			statementType: StatementParser.StatementType.SQL,
			statementKind: StatementParser.classifyKind(sql),
			originalSql: sql,
			tables: SqlParser.parseTables(sql),
			insertColumns: SqlParser.parseInsertColumns(sql),
			isValid: true
		};
	}

	// Resolves a reference typed in the SQL (e.g. the "e" in "e.name") to its parsed table, matching
	// against either the table name or the alias it was given in the FROM/JOIN clause.
	static findTable(tables: Nullable<SqlParser.TableReference[]>, tableReference: string): Nullable<SqlParser.TableReference> {
		return tables?.find(table => StringUtils.equalsIgnoreCase(table.table, tableReference)
			|| (StringUtils.isNotBlank(table.alias) && StringUtils.equalsIgnoreCase(table.alias, tableReference)));
	}

	// Zero-based index of the comma-separated argument the cursor is currently in, within whatever
	// paren group is innermost/unclosed, e.g. "VALUES (1, 2, |" or "CALL proc(1, |" is index 1.
	// Useful anywhere a cursor position needs to be lined up with a positional argument/column —
	// VALUES lists, IN (...) lists, function-call arguments, etc.
	static getArgumentIndex(sql: string): number {
		let start = SqlParser.getCurrentParenStart(sql);
		return start === -1 ? 0 : SqlParser.countTopLevelCommas(sql.substring(start + 1));
	}

	// Returns the index just after the innermost "(" that has no matching ")" yet, or -1 if every
	// paren in the text is balanced.
	static getCurrentParenStart(sql: string): number {
		let stack: number[] = [];

		for(let i = 0; i < sql.length; i++) {
			if(sql[i] === '(') {
				stack.push(i);
			} else if(sql[i] === ')') {
				stack.pop();
			}
		}

		return stack.length > 0 ? <number>stack.pop() : -1;
	}

	// Counts commas that are neither nested inside a deeper paren group nor inside a quoted string
	// (e.g. a string literal like 'Smith, John' isn't mistaken for two arguments).
	static countTopLevelCommas(text: string): number {
		return SqlParser.splitTopLevelCommas(text).length - 1;
	}

	// Splits "text" on commas that are neither nested inside a deeper paren group nor inside a
	// quoted string literal -- the same top-level-comma rule countTopLevelCommas counts, but
	// returning the actual pieces (e.g. for pulling apart a SELECT list) rather than just a count.
	static splitTopLevelCommas(text: string): string[] {
		let items: string[] = [];
		let depth = 0;
		let quoteChar: string | undefined;
		let start = 0;

		for(let i = 0; i < text.length; i++) {
			let char = text[i];

			if(quoteChar) {
				if(char === quoteChar) {
					quoteChar = undefined;
				}

				continue;
			}

			if(char === `'` || char === `"`) {
				quoteChar = char;
			} else if(char === '(') {
				depth++;
			} else if(char === ')') {
				depth--;
			} else if(char === ',' && depth === 0) {
				items.push(text.substring(start, i));
				start = i + 1;
			}
		}

		items.push(text.substring(start));
		return items;
	}

	// Isolates the SELECT list belonging to the statement currently being typed -- the last
	// top-level SELECT in "sql" (callers pass the text truncated at the cursor) and the first
	// top-level FROM after it, both found outside of any parens/quotes so a CTE's own
	// "SELECT ... FROM ..." (nested inside the WITH clause's parens) or a scalar subquery inside
	// the select list itself is never mistaken for the boundary of the statement actually being
	// edited. Returns undefined once either keyword can't be found at the top level, e.g. before
	// FROM has been typed yet.
	static getCurrentSelectListText(sql: string): Nullable<string> {
		let selectRanges = SqlParser.findTopLevelKeywordRanges(sql, 'SELECT');
		let selectRange = selectRanges.length > 0 ? selectRanges[selectRanges.length - 1] : undefined;

		if(!selectRange) {
			return undefined;
		}

		let afterSelect = sql.substring(selectRange.end);
		let fromRange = SqlParser.findTopLevelKeywordRanges(afterSelect, 'FROM')[0];

		if(!fromRange) {
			return undefined;
		}

		return afterSelect.substring(0, fromRange.start).replace(/^\s*(DISTINCT|ALL)\s+/i, '');
	}

	// Every occurrence of "keyword" in "text" that sits outside any parens and outside any quoted
	// string literal -- used to find clause-boundary keywords (SELECT/FROM) without being fooled by
	// the same keyword appearing inside a scalar subquery or a string literal. Also used by
	// DangerousStatementChecker to find a top-level WHERE (as opposed to one buried in a subquery).
	static findTopLevelKeywordRanges(text: string, keyword: string): Array<{start: number; end: number}> {
		let pattern = new RegExp(`\\b${keyword}\\b`, 'gi');
		let depth = 0;
		let quoteChar: string | undefined;
		let ranges: Array<{start: number; end: number}> = [];
		let i = 0;

		while(i < text.length) {
			let char = text[i];

			if(quoteChar) {
				if(char === quoteChar) {
					quoteChar = undefined;
				}

				i++;
				continue;
			}

			if(char === `'` || char === `"`) {
				quoteChar = char;
				i++;
				continue;
			}

			if(char === '(') {
				depth++;
				i++;
				continue;
			}

			if(char === ')') {
				depth--;
				i++;
				continue;
			}

			if(depth === 0) {
				pattern.lastIndex = i;
				let match = pattern.exec(text);

				if(match && match.index === i) {
					ranges.push({start: match.index, end: match.index + match[0].length});
					i = match.index + match[0].length;
					continue;
				}
			}

			i++;
		}

		return ranges;
	}

	// Captures the explicit column list from "INSERT INTO table (colA, colB, ...)", if given, so
	// value content-assist can line up cursor position with the right column when no such list is
	// present the caller falls back to the table's full column order instead.
	//
	// The target may be schema-qualified and either part may be delimited: "INSERT INTO SALES.CUSTOMER"
	// and `INSERT INTO "SALES"."CUSTOMER"` are both ordinary ways to write this (the schema browser's
	// own generated SQL always qualifies), and reading no column list out of one costs every ":name"
	// marker in its VALUES list the data type that would have given the Parameters tab a typed input.
	private static parseInsertColumns(sql: string): string[] | undefined {
		let match = sql.match(/\bINSERT\s+INTO\s+"?[a-zA-Z0-9_$#@]+"?(?:\s*\.\s*"?[a-zA-Z0-9_$#@]+"?)?\s*\(([^)]*)\)/i);

		if (!match) {
			return undefined;
		}

		return match[1]
			.split(',')
			// Delimiters come off the column names too: every consumer matches these against catalog
			// names (SystemColumn.systemName/sqlName), which carry no quotes.
			.map(column => column.trim().replace(/^"(.*)"$/, '$1'))
			.filter(column => column.length > 0);
	}

	// Shared by parseTables and findAliasDeclarationOffset so a table reference (schema + name +
	// alias) is recognized identically by both - the latter needs to re-find the exact same
	// occurrence parseTables originally matched, not just any occurrence of the same name.
	private static buildTableReferenceRegexes(): {tableRegex: RegExp; commaTableRegex: RegExp} {
		let reservedWordPattern = SqlParser.RESERVED_WORDS.join('|');
		let tableRefPattern = `(?:([a-zA-Z0-9_]+)\\s*\\.\\s*)?([a-zA-Z0-9_]+)(?:\\s+(?:AS\\s+)?((?!(?:${reservedWordPattern})\\b)[a-zA-Z0-9_]+))?`;

		return {
			tableRegex: new RegExp(`\\b(?:${SqlParser.TABLE_KEY_WORDS.join('|')})\\s+${tableRefPattern}`, 'gi'),
			// Old-style comma joins ("FROM a, b, c") have no keyword of their own in front of "b"/"c" --
			// peeled off separately, contiguously from wherever the previous table reference ended.
			commaTableRegex: new RegExp(`^\\s*,\\s*${tableRefPattern}`, 'i')
		};
	}

	// Locates the exact source position of "tableReference"'s own alias (e.g. the "e" in "FROM
	// employee e") for Go to Definition navigation. Re-scans for the same (schema, table, alias)
	// occurrence rather than trusting a bare name search, since parseTables dedups by that whole
	// triple - this must land on the same first occurrence it did, not some unrelated later
	// reference that happens to share the alias text. Returns undefined if the reference has no
	// alias (nothing to jump to) or, in principle, if it can no longer be found (sql has changed).
	static findAliasDeclarationOffset(sql: string, tableReference: SqlParser.TableReference): Nullable<number> {
		if(StringUtils.isBlank(tableReference.alias)) {
			return undefined;
		}

		let {tableRegex, commaTableRegex} = SqlParser.buildTableReferenceRegexes();

		let isMatch = (schema?: string, table?: string, alias?: string) =>
			StringUtils.isNotBlank(table)
			&& StringUtils.equalsIgnoreCase(table, tableReference.table)
			&& StringUtils.equalsIgnoreCase(alias ?? '', <string>tableReference.alias)
			&& StringUtils.equalsIgnoreCase(schema ?? '', tableReference.schema ?? '');

		// Locates "alias" within one already-matched reference's own text, searching only after
		// where "table" itself was found -- otherwise a short alias (e.g. "o") could false-match
		// inside the table name (e.g. "orders") instead of the real alias further along.
		let aliasOffsetWithin = (matchText: string, table: string, alias: string): number => {
			let tableEnd = matchText.indexOf(table) + table.length;
			return tableEnd + matchText.slice(tableEnd).indexOf(alias);
		};

		let match;

		while((match = tableRegex.exec(sql)) !== null) {
			if(isMatch(match[1], match[2], match[3])) {
				return match.index + aliasOffsetWithin(match[0], match[2], <string>match[3]);
			}

			let position = tableRegex.lastIndex;
			let commaMatch;

			while((commaMatch = commaTableRegex.exec(sql.substring(position))) !== null) {
				if(isMatch(commaMatch[1], commaMatch[2], commaMatch[3])) {
					return position + aliasOffsetWithin(commaMatch[0], commaMatch[2], <string>commaMatch[3]);
				}

				position += commaMatch[0].length;
			}

			tableRegex.lastIndex = position;
		}

		return undefined;
	}

	// Locates which specific table-reference OCCURRENCE (not just which table/alias NAME) "offset"
	// (the cursor's position within "sql", the current statement's own text) sits directly on top
	// of. Unlike findTable - a name lookup content-assist uses to resolve what a typed qualifier like
	// "e." refers to, wherever in the statement that alias happens to be declared - this is for Go to
	// Definition, where the exact same table+alias pair can legitimately appear more than once in one
	// statement (e.g. a table aliased to its own name, once inside a CTE body and again in the outer
	// query: "from appuser appuser" ... "join appuser") and a plain name search would arbitrarily
	// land on whichever happens to come first in the text, ignoring which one the cursor is actually
	// on. Returns undefined if "offset" isn't sitting on any FROM/JOIN/etc. table-name or alias token
	// at all (e.g. it's on a column qualifier elsewhere in the statement) - callers fall back to a
	// name-based lookup for that case, same as before this positional check existed.
	static findTableReferenceOccurrenceAt(sql: string, offset: number): Nullable<SqlParser.TableReferenceOccurrence> {
		let {tableRegex, commaTableRegex} = SqlParser.buildTableReferenceRegexes();

		let matchOccurrence = (matchText: string, matchIndex: number, schema?: string, rawTable?: string, alias?: string): Nullable<SqlParser.TableReferenceOccurrence> => {
			if(StringUtils.isBlank(rawTable)) {
				return undefined;
			}

			let table = <string>rawTable;
			let localOffset = offset - matchIndex;
			let tableStart = matchText.indexOf(table);
			let tableEnd = tableStart + table.length;

			if(StringUtils.isNotBlank(alias)) {
				let aliasStart = tableEnd + matchText.slice(tableEnd).indexOf(<string>alias);
				let aliasEnd = aliasStart + (<string>alias).length;

				if(localOffset >= aliasStart && localOffset <= aliasEnd) {
					return {reference: {schema: schema, table: table, alias: alias}, matchedAs: 'alias'};
				}
			}

			return localOffset >= tableStart && localOffset <= tableEnd
				? {reference: {schema: schema, table: table, alias: alias}, matchedAs: 'table'}
				: undefined;
		};

		let match;

		while((match = tableRegex.exec(sql)) !== null) {
			let occurrence = matchOccurrence(match[0], match.index, match[1], match[2], match[3]);

			if(occurrence) {
				return occurrence;
			}

			let position = tableRegex.lastIndex;
			let commaMatch;

			while((commaMatch = commaTableRegex.exec(sql.substring(position))) !== null) {
				let commaOccurrence = matchOccurrence(commaMatch[0], position, commaMatch[1], commaMatch[2], commaMatch[3]);

				if(commaOccurrence) {
					return commaOccurrence;
				}

				position += commaMatch[0].length;
			}

			tableRegex.lastIndex = position;
		}

		return undefined;
	}

	// The routine call "offset" sits on, for Go to Definition. A procedure is the name after CALL - with or
	// without an argument list, so "CALL proc", "{CALL proc(?)}" and a CALL inside a routine body all count.
	// A function is a name, optionally schema-qualified, followed by "(". Regex-level like the rest of this
	// class, so it errs toward finding a call: the caller looks the name up and falls back to the table path
	// when there's no such routine, which is what keeps a false positive harmless. Two cases are ruled out here because they would
	// otherwise shadow a real table: a name right after a keyword that introduces one ("INSERT INTO t (",
	// "CREATE TABLE t (") and a type in a cast ("AS VARCHAR(10)"). Keywords themselves ("IN (", "VALUES (",
	// "CAST(") are never calls.
	static findRoutineCallAt(sql: string, offset: number): Nullable<SqlParser.RoutineCall> {
		let procedureRegex = /\bCALL\s+(?:(\w+)\s*\.\s*)?(\w+)/gi;
		let match;

		while((match = procedureRegex.exec(sql)) !== null) {
			let nameEnd = match.index + match[0].length;
			let start = nameEnd - match[0].replace(/^CALL\s+/i, '').length;

			if(offset >= start && offset <= nameEnd) {
				return {schema: match[1], name: match[2], routineType: 'PROCEDURE'};
			}
		}

		return SqlParser.findFunctionCallAt(sql, offset);
	}

	private static findFunctionCallAt(sql: string, offset: number): Nullable<SqlParser.RoutineCall> {
		let callRegex = /(?:(\w+)\s*\.\s*)?(\w+)\s*\(/g;
		let match;

		while((match = callRegex.exec(sql)) !== null) {
			let schema = match[1];
			let name = match[2];
			let nameEnd = match.index + match[0].replace(/\s*\($/, '').length;
			let nameStart = nameEnd - name.length;
			let start = schema != null ? match.index : nameStart;

			// Resume right after the name, so a call nested in this one's arguments is still found.
			callRegex.lastIndex = nameEnd;

			if(offset < start || offset > nameEnd) {
				continue;
			}

			let previousWord = sql.slice(0, start).match(/(\w+)\s*$/)?.[1]?.toUpperCase();

			if(SqlParser.NOT_FUNCTION_NAMES.has(name.toUpperCase()) || (previousWord != null && SqlParser.NOT_AFTER_WORDS.has(previousWord))) {
				return undefined;
			}

			return {schema: schema, name: name, routineType: 'FUNCTION'};
		}

		return undefined;
	}

	private static readonly NOT_FUNCTION_NAMES = new Set([
		...KeywordTable.RESERVED_WORDS,
		'CAST', 'TABLE', 'EXISTS', 'CALL', 'LATERAL', 'ROW', 'WITH', 'OVER', 'NOT', 'ANY', 'ALL', 'SOME', 'UNION', 'EXCEPT', 'INTERSECT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'BETWEEN', 'LIKE', 'DISTINCT', 'BY', 'USING'
	]);

	private static readonly NOT_AFTER_WORDS = new Set([
		...KeywordTable.TABLE_KEYWORDS.map(keyword => <string>keyword.split(/\s+/).pop()),
		'AS', 'TABLE', 'VIEW', 'INDEX', 'FUNCTION', 'PROCEDURE', 'CALL'
	]);

	private static parseTables(sql: string): SqlParser.TableReference[] {
		let {tableRegex, commaTableRegex} = SqlParser.buildTableReferenceRegexes();
		let tables: SqlParser.TableReference[] = [];
		let seen = new Set<string>();
		let match;

		let addTable = (schema?: string, table?: string, alias?: string) => {
			if (!table) {
				return;
			}

			let key = `${schema?.toLowerCase() ?? ''}|${table.toLowerCase()}|${alias?.toLowerCase() ?? ''}`;

			if (!seen.has(key)) {
				seen.add(key);
				tables.push({table, alias, schema});
			}
		};

		while ((match = tableRegex.exec(sql)) !== null) {
			addTable(match[1], match[2], match[3]);

			let position = tableRegex.lastIndex;
			let commaMatch;

			while ((commaMatch = commaTableRegex.exec(sql.substring(position))) !== null) {
				addTable(commaMatch[1], commaMatch[2], commaMatch[3]);
				position += commaMatch[0].length;
			}

			tableRegex.lastIndex = position;
		}

		// A derived table ("FROM (SELECT ...) alias") has no plain identifier for the main loop
		// above to match at all -- it only finds whatever real table happens to be named *inside*
		// the subquery (unaliased, and not actually reachable from the outer scope; CteAssist's
		// accessibility tracking already excludes it, so no special-casing needed for that part
		// here). This second pass recovers the alias itself, which is what the outer query actually
		// references and what needs to resolve to the subquery's own exposed columns (CteAssist,
		// same as a CTE) instead of nothing.
		for (let alias of SqlParser.parseDerivedTableAliases(sql)) {
			addTable(undefined, alias, undefined);
		}

		return tables;
	}

	private static parseDerivedTableAliases(sql: string): string[] {
		let reservedWordPattern = SqlParser.RESERVED_WORDS.join('|');
		let keywordParenRegex = new RegExp(`\\b(?:${SqlParser.TABLE_KEY_WORDS.join('|')})\\s*\\(`, 'gi');
		let aliasPattern = new RegExp(`^\\s+(?:AS\\s+)?((?!(?:${reservedWordPattern})\\b)[a-zA-Z0-9_]+)`, 'i');
		let aliases: string[] = [];
		let match;

		while ((match = keywordParenRegex.exec(sql)) !== null) {
			let openParenIndex = match.index + match[0].length - 1;
			let closeParenIndex = SqlParser.findMatchingParen(sql, openParenIndex);

			if (closeParenIndex === -1) {
				continue;
			}

			let aliasMatch = sql.substring(closeParenIndex + 1).match(aliasPattern);

			if (aliasMatch) {
				aliases.push(aliasMatch[1]);
			}
		}

		return aliases;
	}

	// Returns the index of the ")" that closes the "(" at openIndex, respecting nesting, or -1 if
	// unbalanced (e.g. the user is still typing the subquery and hasn't closed it yet).
	private static findMatchingParen(text: string, openIndex: number): number {
		let depth = 0;

		for (let i = openIndex; i < text.length; i++) {
			if (text[i] === '(') {
				depth++;
			} else if (text[i] === ')') {
				depth--;

				if (depth === 0) {
					return i;
				}
			}
		}

		return -1;
	}
}

export namespace SqlParser {
	export interface TableReference {
		// The schema segment parsed from a "schema.table" reference — purely syntactic (whatever
		// came before the dot), not validated against real schemas the way DbAssist.getDotMatch
		// validates a reference typed at the cursor. Consumers that need a validated/resolved
		// schema (e.g. content-assist reacting to what's being typed right now) should still use
		// getDotMatch; this is for tables established earlier in the statement (FROM/JOIN/INTO/etc.)
		// that getDotMatch, which only looks at the trailing text near the cursor, can't see.
		schema?: string;
		table: string;
		alias?: string;
	}

	export interface SqlParseResults extends StatementParser.ParseResults {
		statementType: StatementParser.StatementType.SQL;
		tables?: TableReference[];
		insertColumns?: string[];
	}

	// Which specific token of a TableReference a Go to Definition click landed on - see
	// findTableReferenceOccurrenceAt.
	export interface TableReferenceOccurrence {
		reference: TableReference;
		matchedAs: 'table' | 'alias';
	}

	// A routine call a Go to Definition click landed on - see findRoutineCallAt. `schema` is whatever was
	// written before the dot, unvalidated, the same as TableReference.schema.
	export interface RoutineCall {
		schema?: string;
		name: string;
		routineType: SystemRoutine.RoutineType;
	}
}