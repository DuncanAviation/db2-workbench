import { SystemColumn } from '../models/system-column.js';
import { FieldUtils } from './field-utils.js';

// No vscode/React dependency - safe to import from both extension-host code (src/) and webview code
// (webviews/), same reasoning as FieldUtils/SearchCriteriaUtils. The webview builds the actual
// INSERT/UPDATE/DELETE SQL text for a row edit (same "webview builds SQL, host just runs it"
// convention as SearchCriteriaUtils/IndexAdviceUtils) - this is where that generation lives so the
// Add/Edit Row dialog and inline grid editing share one implementation instead of drifting apart.
//
// A value is null for SQL NULL and a string for anything typed - an empty string included, which a
// character column stores as '' (blanks, for a CHAR) rather than as NULL. NULL only ever comes from
// the column already holding it or from an explicit Set NULL.
export class RowEditUtils {
	static buildInsertSql(schema: string, table: string, columnValues: RowFieldValue[]): string {
		let columnList = columnValues.map(column => RowEditUtils.quoteIdentifier(column.systemName)).join(', ');
		let valueList = columnValues.map(column => RowEditUtils.formatLiteral(column.dataType, column.value)).join(', ');

		return `INSERT INTO ${RowEditUtils.quoteTarget(schema, table)} (${columnList}) VALUES (${valueList})`;
	}

	static buildUpdateSql(schema: string, table: string, columnValues: RowFieldValue[], keyValues: RowKeyValue[]): string {
		let setClause = columnValues
			.map(column => `${RowEditUtils.quoteIdentifier(column.systemName)} = ${RowEditUtils.formatLiteral(column.dataType, column.value)}`)
			.join(', ');

		return `UPDATE ${RowEditUtils.quoteTarget(schema, table)} SET ${setClause} WHERE ${RowEditUtils.buildKeyWhereClause(table, keyValues)}`;
	}

	static buildDeleteSql(schema: string, table: string, keyValues: RowKeyValue[]): string {
		return `DELETE FROM ${RowEditUtils.quoteTarget(schema, table)} WHERE ${RowEditUtils.buildKeyWhereClause(table, keyValues)}`;
	}

	// Required on an INSERT when the column is NOT NULL and has no table default to fall back on - a
	// column that does have one is left out of the INSERT while it's NULL (buildInsertValues), so DB2
	// supplies the default. SYSCOLUMNS2's NULLS/HAS_DEFAULT flags mix 'Y'/'N' and 'YES'/'NO' across
	// different columns (identity is already compared as 'YES' elsewhere in this codebase, while nulls'
	// existing test mock uses 'Y'), so both conventions are checked here rather than assuming one.
	static isRequired(column: SystemColumn): boolean {
		return RowEditUtils.isNotNull(column) && RowEditUtils.isNegative(column.hasDefault);
	}

	// Unknown counts as having one, the same way isRequired reads it.
	static hasTableDefault(column: SystemColumn): boolean {
		return !RowEditUtils.isNegative(column.hasDefault);
	}

	// Required on an UPDATE: a default only applies to a column an INSERT leaves out, so SET col = NULL
	// fails on any NOT NULL column, default or not.
	static isNotNull(column: SystemColumn): boolean {
		return RowEditUtils.isNegative(column.nulls);
	}

	// Whether a value would be written as NULL (formatLiteral) - so can't go in a required column. A
	// character value is NULL only when it is one: empty is '', and only spaces is a real value DB2 for
	// i stores routinely. Any other type has no literal for empty or spaces, so writes NULL. undefined
	// is a field never entered, which is NULL as well.
	static writesNull(dataType: string | undefined, value: RowValue | undefined): boolean {
		return value == null || (!FieldUtils.isCharacterType(dataType) && !value.trim());
	}

	// The required columns an INSERT or UPDATE would write NULL into, in `columns` order. An insert
	// checks every one of `columns` (the row's insertable fields) - one missing from columnValues was
	// never entered. An update only checks the columns it sets, so a required column the row already
	// holds NULL in (or that this edit leaves alone) is not its problem.
	static findMissingRequired(kind: 'insert' | 'update', columns: SystemColumn[], columnValues: Record<string, RowValue>): SystemColumn[] {
		return columns.filter(column => kind === 'insert'
			? RowEditUtils.isRequired(column) && RowEditUtils.writesNull(column.dataType, columnValues[column.systemName])
			: column.systemName in columnValues && RowEditUtils.isNotNull(column) && RowEditUtils.writesNull(column.dataType, columnValues[column.systemName]));
	}

	// An INSERT's column list from the row's insertable fields, in `columns` order - except a column
	// with a table default that would be written as NULL, which is left out so DB2 applies the default
	// (a NOT NULL one would otherwise reject the NULL).
	static buildInsertValues(columns: SystemColumn[], columnValues: Record<string, RowValue>): RowFieldValue[] {
		return columns
			.filter(column => !(RowEditUtils.hasTableDefault(column) && RowEditUtils.writesNull(column.dataType, columnValues[column.systemName])))
			.map(column => ({ systemName: column.systemName, dataType: column.dataType, value: columnValues[column.systemName] ?? null }));
	}

	// FieldUtils.formatValueLiteral writes an empty value as NULL, which suits a search criterion or a
	// routine parameter. Here empty in a character column is the empty string, and NULL is only ever
	// asked for explicitly.
	private static formatLiteral(dataType: string | undefined, value: RowValue): string {
		if (RowEditUtils.writesNull(dataType, value)) {
			return 'NULL';
		}

		return value === '' ? '\'\'' : FieldUtils.formatValueLiteral(dataType, value as string);
	}

	private static isNegative(flag: string): boolean {
		let upper = flag?.toUpperCase();
		return upper === 'N' || upper === 'NO';
	}

	// A RowKeyValue with isRrn true renders as RRN(table) = <bare value> - RRN, unqualified since it's
	// evaluated against this same UPDATE/DELETE target, matching the fallback selected in
	// DataQueries.listTableData - rather than a quoted-literal comparison against "$RRN", which is only
	// a SELECT-list alias and not a real predicate target. A NULL key (a nullable unique column) is
	// matched with IS NULL, since "= NULL" is never true. An empty character key is '' - DB2 pads a
	// comparison with blanks, so that matches a CHAR key holding only blanks.
	private static buildKeyWhereClause(table: string, keyValues: RowKeyValue[]): string {
		return keyValues
			.map(key => {
				if (key.isRrn) {
					return `RRN(${RowEditUtils.quoteIdentifier(table)}) = ${key.value}`;
				}

				let column = RowEditUtils.quoteIdentifier(key.systemName);
				return key.value === null ? `${column} IS NULL` : `${column} = ${RowEditUtils.formatLiteral(key.dataType, key.value)}`;
			})
			.join(' AND ');
	}

	private static quoteIdentifier(identifier: string): string {
		return `"${identifier.replace(/"/g, '""')}"`;
	}

	private static quoteTarget(schema: string, table: string): string {
		return `${RowEditUtils.quoteIdentifier(schema)}.${RowEditUtils.quoteIdentifier(table)}`;
	}
}

/** null is SQL NULL; any string, '' included, is a value. */
export type RowValue = string | null;

export interface RowFieldValue {
	systemName: string;
	dataType?: string;
	value: RowValue;
}

export interface RowKeyValue extends RowFieldValue {
	isRrn: boolean;
}
