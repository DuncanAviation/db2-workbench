import * as vscode from 'vscode';
import { Extension } from '../extension.js';
import { Parameter } from '../interfaces/parameter.js';
import { SystemProcedureParam } from '../models/system-procedure-param.js';
import { ColumnNameUtils } from './column-name-utils.js';
import { Nullable } from './nullable.js';
import { SpParser } from './sp-parser.js';
import { SqlParser } from './sql-parser.js';
import { StatementParser } from './statement-parser.js';
import { EditorUtils } from './editor-utils.js';

// Finds ":paramName" bind markers in SQL/SP text and best-effort associates each one with a
// column (SQL) or procedure parameter (CALL) to get a data-type hint, without a real SQL AST -
// same lightweight regex-based philosophy as SqlParser/SpParser. findOccurrences/substituteMarkers
// are pure and assume comment-stripped input (offsets must line up with whatever text they're
// later applied to); resolveTypesForStatement strips comments itself, so it's safe to call with
// either raw or already-stripped text.
export class ParameterParser {
	private static readonly COMPARISON_OPERATORS = '=|<>|!=|<=|>=|<|>|\\bLIKE\\b';

	static findOccurrences(sql: string): ParameterParser.ParameterOccurrence[] {
		let occurrences: ParameterParser.ParameterOccurrence[] = [];
		let quoteChar: string | undefined;

		for(let i = 0; i < sql.length; i++) {
			let char = sql[i];

			if(quoteChar) {
				if(char === quoteChar) {
					quoteChar = undefined;
				}

				continue;
			}

			if(char === `'` || char === `"`) {
				quoteChar = char;
				continue;
			}

			if(char === ':' && sql[i - 1] !== ':' && sql[i + 1] !== ':') {
				let match = sql.substring(i + 1).match(/^[a-zA-Z_]\w*/);

				if(match) {
					occurrences.push({name: match[0], start: i, end: i + 1 + match[0].length});
					i += match[0].length;
				}
			}
		}

		return occurrences;
	}

	// Replaces each region span with one or more "?" (comma-joined when count > 1 - the multi-value
	// "field IN (:field)" case, where count is how many chip values were actually entered), processed
	// right-to-left so earlier offsets stay valid. A plain ParameterOccurrence[] (count always 1)
	// works here too, since SqlParameter's substitutionStart/End default to the occurrence's own span.
	static substituteMarkers(sql: string, regions: ParameterParser.SubstitutionRegion[]): string {
		let result = sql;

		for(let region of [...regions].sort((a, b) => b.start - a.start)) {
			let markers = new Array(region.count ?? 1).fill('?').join(', ');
			result = result.substring(0, region.start) + markers + result.substring(region.end);
		}

		return result;
	}

	// One entry per occurrence, in order, duplicates kept - needed to build a positional values array.
	static async resolveTypesForStatement(extension: Extension, key: string, sql: string): Promise<ParameterParser.SqlParameter[]> {
		let statement = StatementParser.stripComments(sql);
		let occurrences = ParameterParser.findOccurrences(statement);

		if(occurrences.length === 0) {
			return [];
		}

		let parseResults = StatementParser.parse(statement);

		if(parseResults == null) {
			return occurrences.map(occurrence => ParameterParser.toSqlParameter(occurrence.name, occurrence));
		}

		if(parseResults.statementType === StatementParser.StatementType.SP) {
			return ParameterParser.resolveSpParameterTypes(extension, key, statement, occurrences, parseResults);
		}

		return ParameterParser.resolveSqlParameterTypes(extension, key, statement, occurrences, parseResults);
	}

	// CALL statements bind positionally - the driver's callProcedure never sees the SQL text (no "?"
	// markers involved at all, unlike a query), only a "name" plus one Parameter per declared
	// procedure argument, in order. SpParser.parse() already parses every OTHER argument correctly
	// (it's existed since before this feature and is untouched here) - it just has no notion of a
	// ":name" marker, so a marker token comes back as the literal string ":name" rather than a real
	// value. This fills in that gap: swap each "^:name$" literal for its resolved value, leaving
	// every already-correct literal position (numbers, quoted strings, etc.) exactly as parsed.
	static buildCallParameters(sql: string, resolvedParams: ParameterParser.SqlParameter[], parameterValues?: Record<string, string | string[]>): Array<Parameter> {
		let parseResults = StatementParser.parse(sql);

		if(parseResults == null || parseResults.statementType !== StatementParser.StatementType.SP) {
			return [];
		}

		let byName = new Map(resolvedParams.map(param => [param.name.toLowerCase(), param]));

		return (parseResults.parameters ?? []).map(literal => {
			let markerMatch = typeof literal === 'string' ? literal.match(/^:([a-zA-Z_]\w*)$/) : null;

			if(!markerMatch) {
				return literal;
			}

			let resolvedParam = byName.get(markerMatch[1].toLowerCase());
			let raw = resolvedParam ? parameterValues?.[resolvedParam.key] : undefined;
			return <Parameter>(Array.isArray(raw) ? raw[0] : raw);
		});
	}

	// Unique by name+dataType (composite key), first-seen order preserved - a parameter used twice
	// with the same resolved type collapses to one entry; the same name resolving to two different
	// types (e.g. compared against a character column in one statement, numeric in another) stays
	// as two separate entries. allowMultiple is OR'd across duplicates, so a key that's a scalar
	// comparison in one statement and an "IN (:x)" list in another still shows the tab's chip input.
	static dedupeParameters(resolved: ParameterParser.SqlParameter[]): ParameterParser.SqlParameter[] {
		let seen = new Map<string, ParameterParser.SqlParameter>();

		for(let param of resolved) {
			let existing = seen.get(param.key);

			if(!existing) {
				seen.set(param.key, {...param});
			} else if(param.allowMultiple && !existing.allowMultiple) {
				existing.allowMultiple = true;
			}
		}

		return Array.from(seen.values());
	}

	static async resolveDocumentParameters(extension: Extension, key: string, document: vscode.TextDocument): Promise<ParameterParser.SqlParameter[]> {
		let statements = EditorUtils.getAllSql(document);
		let all: ParameterParser.SqlParameter[] = [];

		for(let statement of statements) {
			all.push(...await ParameterParser.resolveTypesForStatement(extension, key, statement));
		}

		return ParameterParser.dedupeParameters(all);
	}

	private static toSqlParameter(name: string, span: {start: number; end: number}, size?: ParameterParser.SizeInfo, allowMultiple?: boolean): ParameterParser.SqlParameter {
		return {
			key: `${name.toLowerCase()}|${size?.dataType ?? ''}`,
			name: name,
			label: `:${name}`,
			dataType: size?.dataType,
			length: size?.length,
			scale: size?.scale,
			allowMultiple: allowMultiple,
			substitutionStart: span.start,
			substitutionEnd: span.end
		};
	}

	private static async resolveSpParameterTypes(extension: Extension, key: string, statement: string, occurrences: ParameterParser.ParameterOccurrence[], parseResults: SpParser.SpParseResults): Promise<ParameterParser.SqlParameter[]> {
		let openParenIndex = statement.indexOf('(');
		let procedureParams: Nullable<SystemProcedureParam[]>;

		if(openParenIndex !== -1 && parseResults.name) {
			// An unqualified name is left for getProcedureParams to resolve against the library list, the same
			// way the CALL itself is resolved when it runs.
			let params = await extension.memoryCache.getProcedureParams({key, schema: parseResults.schema, procedure: <string>parseResults.name});
			procedureParams = [...params].sort((a, b) => a.position - b.position);
		}

		return occurrences.map(occurrence => {
			let size: ParameterParser.SizeInfo | undefined;

			if(procedureParams && openParenIndex !== -1) {
				let argIndex = SqlParser.countTopLevelCommas(statement.substring(openParenIndex + 1, occurrence.start));
				let param = procedureParams[argIndex];

				if(param) {
					// SYSPARMS reports character length and numeric precision as separate columns (unlike
					// SYSCOLUMNS' single dual-purpose LENGTH) - only one of the two is populated for any
					// given parameter, depending on its type.
					size = {dataType: param.dataType, length: param.length ?? param.precision, scale: param.scale};
				}
			}

			return ParameterParser.toSqlParameter(occurrence.name, occurrence, size);
		});
	}

	private static async resolveSqlParameterTypes(extension: Extension, key: string, statement: string, occurrences: ParameterParser.ParameterOccurrence[], parseResults: SqlParser.SqlParseResults): Promise<ParameterParser.SqlParameter[]> {
		let {columnsByOccurrence, multiValueGroups, absorbed} = ParameterParser.associateColumns(statement, occurrences, parseResults.insertColumns);
		let connectionConfig = await extension.connections.getConnectionConfig({key});
		let defaultSchema = connectionConfig?.defaultTableSchema;
		let sizeCache = new Map<string, Nullable<ParameterParser.SizeInfo>>();
		let entries: {start: number; param: ParameterParser.SqlParameter}[] = [];

		let resolveSize = async (columnRef?: string): Promise<Nullable<ParameterParser.SizeInfo>> => {
			if(!columnRef) {
				return;
			}

			if(!sizeCache.has(columnRef)) {
				sizeCache.set(columnRef, await ParameterParser.resolveColumnSize(extension, key, parseResults.tables, columnRef, defaultSchema));
			}

			return sizeCache.get(columnRef);
		};

		for(let occurrence of occurrences) {
			// Duplicate occurrences of the same name inside a single-name "IN (:x, :x, :x)" list are
			// folded into one multiValueGroup below instead of being treated as individual parameters.
			if(absorbed.has(occurrence.start)) {
				continue;
			}

			let size = await resolveSize(columnsByOccurrence.get(occurrence.start));
			entries.push({start: occurrence.start, param: ParameterParser.toSqlParameter(occurrence.name, occurrence, size ?? undefined)});
		}

		for(let group of multiValueGroups) {
			let size = await resolveSize(group.column);
			entries.push({start: group.start, param: ParameterParser.toSqlParameter(group.name, group, size ?? undefined, true)});
		}

		// Sorted back into source order - multiValueGroups' positions (paren content) interleave with
		// the remaining individual occurrences', and callers rely on this order matching the "?"
		// markers left-to-right in the eventually substituted SQL text.
		return entries.sort((a, b) => a.start - b.start).map(entry => entry.param);
	}

	private static async resolveColumnSize(extension: Extension, key: string, tables: Nullable<SqlParser.TableReference[]>, columnRef: string, defaultSchema?: string): Promise<Nullable<ParameterParser.SizeInfo>> {
		let parts = columnRef.split('.');
		let columnName = parts[parts.length - 1];
		let tableRef = parts.length > 1 ? SqlParser.findTable(tables, parts[0]) : undefined;
		let candidateTables = tableRef ? [tableRef] : tables ?? [];

		for(let table of candidateTables) {
			let columns = await extension.memoryCache.getColumns({key, tables: {schema: table.schema ?? defaultSchema, table: table.table}});
			// DB2 for i exposes each column under two names - the short "system" name (SystemColumn.systemName,
			// e.g. "EMNO") that's what most hand-written SQL against these files actually uses, and the
			// long SQL name (SystemColumn.sqlName, e.g. "ACCT_EMPLOYEENO"). Either can appear in the
			// statement text, so both need to be checked.
			let column = ColumnNameUtils.findSystemColumn(columns, columnName);

			if(column) {
				return {dataType: column.dataType, length: column.length, scale: column.scale};
			}
		}

		return;
	}

	// Maps each occurrence's start offset to the column reference (possibly "alias.column") it's
	// bound to, using (in priority order) positional INSERT...VALUES matching, "col IN (:a, :b)",
	// "col BETWEEN :a AND :b", then generic comparison-operator adjacency (which also unwraps a
	// scalar-function call on the other side of the operator, e.g. "UPPER(:p) = UPPER(lastName)").
	// Occurrences with no resolvable association are simply absent from columnsByOccurrence.
	private static associateColumns(sql: string, occurrences: ParameterParser.ParameterOccurrence[], insertColumns?: string[]): {columnsByOccurrence: Map<number, string>; multiValueGroups: ParameterParser.MultiValueGroup[]; absorbed: Set<number>} {
		let columnsByOccurrence = new Map<number, string>();
		let multiValueGroups: ParameterParser.MultiValueGroup[] = [];
		let absorbed = new Set<number>();
		let remaining = new Set(occurrences);

		if(insertColumns?.length) {
			ParameterParser.associateInsertValues(sql, remaining, columnsByOccurrence, <string[]>insertColumns);
		}

		ParameterParser.associateInLists(sql, remaining, columnsByOccurrence, multiValueGroups, absorbed);
		ParameterParser.associateBetween(sql, remaining, columnsByOccurrence);
		ParameterParser.associateAdjacent(sql, remaining, columnsByOccurrence);

		return {columnsByOccurrence, multiValueGroups, absorbed};
	}

	private static associateInsertValues(sql: string, remaining: Set<ParameterParser.ParameterOccurrence>, columnsByOccurrence: Map<number, string>, insertColumns: string[]): void {
		let valuesMatch = sql.match(/\bVALUES\s*\(/i);

		if(!valuesMatch) {
			return;
		}

		let openIndex = <number>valuesMatch.index + valuesMatch[0].length - 1;
		let closeIndex = ParameterParser.findMatchingParen(sql, openIndex);

		if(closeIndex === -1) {
			return;
		}

		for(let occurrence of Array.from(remaining)) {
			if(occurrence.start > openIndex && occurrence.end <= closeIndex) {
				let argIndex = SqlParser.countTopLevelCommas(sql.substring(openIndex + 1, occurrence.start));
				let column = insertColumns[argIndex];

				if(column) {
					columnsByOccurrence.set(occurrence.start, column);
					remaining.delete(occurrence);
				}
			}
		}
	}

	// "col IN (...)" lists are the one place a single ":name" marker can legitimately need more than
	// one bound value - "field IN (:field)" should let the user type several values for that one
	// marker. So: if every marker inside the parens shares the same name (however many times it's
	// repeated - "field IN (:field, :field, :field)" counts as the same case, extras just ignored),
	// collapse the whole parenthesized content into one multi-value group spanning it; the actual
	// number of "?" markers is decided later, from however many values the user enters. If the list
	// instead has two or more DISTINCT names ("field IN (:field1, :field2)"), leave each as its own
	// ordinary scalar occurrence - that's already exactly what today's single-value inputs handle.
	private static associateInLists(sql: string, remaining: Set<ParameterParser.ParameterOccurrence>, columnsByOccurrence: Map<number, string>, multiValueGroups: ParameterParser.MultiValueGroup[], absorbed: Set<number>): void {
		let inRegex = /\b([a-zA-Z_]\w*)\s+IN\s*\(([^()]*)\)/gi;
		let match;

		while((match = inRegex.exec(sql)) !== null) {
			let column = match[1];
			let openIndex = sql.indexOf('(', match.index);
			let closeIndex = match.index + match[0].length - 1;
			let spanOccurrences = Array.from(remaining).filter(occurrence => occurrence.start > openIndex && occurrence.end <= closeIndex);

			if(spanOccurrences.length === 0) {
				continue;
			}

			let distinctNames = new Set(spanOccurrences.map(occurrence => occurrence.name.toLowerCase()));

			if(distinctNames.size === 1) {
				let first = spanOccurrences.reduce((earliest, occurrence) => occurrence.start < earliest.start ? occurrence : earliest);
				multiValueGroups.push({name: first.name, column, start: openIndex + 1, end: closeIndex});
				spanOccurrences.forEach(occurrence => absorbed.add(occurrence.start));
			} else {
				spanOccurrences.forEach(occurrence => columnsByOccurrence.set(occurrence.start, column));
			}

			spanOccurrences.forEach(occurrence => remaining.delete(occurrence));
		}
	}

	private static associateBetween(sql: string, remaining: Set<ParameterParser.ParameterOccurrence>, columnsByOccurrence: Map<number, string>): void {
		let betweenRegex = /\b([a-zA-Z_][\w.]*)\s+BETWEEN\s+:([a-zA-Z_]\w*)\s+AND\s+:([a-zA-Z_]\w*)\b/gi;
		let match;

		while((match = betweenRegex.exec(sql)) !== null) {
			let spanStart = match.index;
			let spanEnd = match.index + match[0].length;

			for(let occurrence of Array.from(remaining)) {
				if(occurrence.start >= spanStart && occurrence.end <= spanEnd
				&& (occurrence.name === match[2] || occurrence.name === match[3])) {
					columnsByOccurrence.set(occurrence.start, match[1]);
					remaining.delete(occurrence);
				}
			}
		}
	}

	private static associateAdjacent(sql: string, remaining: Set<ParameterParser.ParameterOccurrence>, columnsByOccurrence: Map<number, string>): void {
		for(let occurrence of Array.from(remaining)) {
			// The marker's own side may be wrapped in a scalar function too - "UPPER(:name) =
			// UPPER(lastName)" is how a case-insensitive match is actually written, and the operator is
			// then a closing paren away rather than adjacent. Stepping out of that call first lets the
			// rest of this method work on it unchanged, whichever side the column is on.
			let {before, after} = ParameterParser.stepOutOfEnclosingCall(sql.substring(0, occurrence.start), sql.substring(occurrence.end));

			let opBeforeMatch = before.match(new RegExp(`(?:${ParameterParser.COMPARISON_OPERATORS})\\s*$`, 'i'));

			if(opBeforeMatch) {
				let column = ParameterParser.extractIdentifierBefore(before.substring(0, opBeforeMatch.index));

				if(column) {
					columnsByOccurrence.set(occurrence.start, column);
					continue;
				}
			}

			let opAfterMatch = after.match(new RegExp(`^\\s*(?:${ParameterParser.COMPARISON_OPERATORS})`, 'i'));

			if(opAfterMatch) {
				let column = ParameterParser.extractIdentifierAfter(after.substring(opAfterMatch[0].length));

				if(column) {
					columnsByOccurrence.set(occurrence.start, column);
				}
			}
		}
	}

	// The text either side of a marker, as it reads once a scalar function wrapping the marker itself is
	// stepped out of: "where UPPER(" / ") = UPPER(lastName)" becomes "where " / " = UPPER(lastName)".
	// Only a call whose one argument is this marker is stepped out of - anything else is an expression
	// whose type this class has no business guessing at.
	private static stepOutOfEnclosingCall(before: string, after: string): {before: string; after: string} {
		let callMatch = before.match(/([a-zA-Z_]\w*)\s*\(\s*$/);
		let closeMatch = after.match(/^\s*\)/);

		if(!callMatch || !closeMatch) {
			return {before: before, after: after};
		}

		return {before: before.substring(0, <number>callMatch.index), after: after.substring(closeMatch[0].length)};
	}

	// Trailing identifier immediately before the cursor, unwrapping a scalar-function call so
	// "UPPER(lastName)" resolves to "lastName" rather than being skipped for lack of a bare identifier.
	private static extractIdentifierBefore(text: string): Nullable<string> {
		let trimmed = text.trimEnd();

		if(trimmed.endsWith(')')) {
			let openIndex = ParameterParser.findMatchingParenBackwards(trimmed, trimmed.length - 1);

			if(openIndex !== -1) {
				let identifiers = trimmed.substring(openIndex + 1, trimmed.length - 1).match(/[a-zA-Z_][\w.]*/g);
				return identifiers?.[identifiers.length - 1];
			}
		}

		return trimmed.match(/([a-zA-Z_][\w.]*)\s*$/)?.[1];
	}

	// Leading identifier immediately after the cursor, unwrapping a scalar-function call the same way.
	private static extractIdentifierAfter(text: string): Nullable<string> {
		let trimmed = text.trimStart();
		let functionMatch = trimmed.match(/^[a-zA-Z_]\w*\s*\(([^()]*)\)/);

		if(functionMatch) {
			return functionMatch[1].match(/[a-zA-Z_][\w.]*/)?.[0];
		}

		return trimmed.match(/^([a-zA-Z_][\w.]*)/)?.[1];
	}

	private static findMatchingParen(text: string, openIndex: number): number {
		let depth = 0;

		for(let i = openIndex; i < text.length; i++) {
			if(text[i] === '(') {
				depth++;
			} else if(text[i] === ')') {
				depth--;

				if(depth === 0) {
					return i;
				}
			}
		}

		return -1;
	}

	private static findMatchingParenBackwards(text: string, closeIndex: number): number {
		let depth = 0;

		for(let i = closeIndex; i >= 0; i--) {
			if(text[i] === ')') {
				depth++;
			} else if(text[i] === '(') {
				depth--;

				if(depth === 0) {
					return i;
				}
			}
		}

		return -1;
	}
}

export namespace ParameterParser {
	export interface ParameterOccurrence {
		name: string;
		start: number;
		end: number;
	}

	export interface SqlParameter {
		key: string;
		name: string;
		label: string;
		dataType?: string;
		length?: number;
		scale?: number;
		/** True if this parameter is used as a whole "col IN (:name)" list - the Parameters tab
		 * should let the user enter more than one value for it. */
		allowMultiple?: boolean;
		/** Span in the (comment-stripped) statement text that substituteMarkers should replace -
		 * either the ":name" token itself, or (for an allowMultiple group) the whole parenthesized
		 * IN-list content. Only meaningful for the per-statement resolution used at execute time;
		 * unused once flattened into the document-wide, deduped Parameters tab list. */
		substitutionStart?: number;
		substitutionEnd?: number;
	}

	export interface SizeInfo {
		dataType?: string;
		length?: number;
		scale?: number;
	}

	export interface MultiValueGroup {
		name: string;
		column: string;
		start: number;
		end: number;
	}

	export interface SubstitutionRegion {
		start: number;
		end: number;
		count?: number;
	}
}
