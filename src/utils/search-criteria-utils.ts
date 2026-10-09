import { FieldUtils } from './field-utils.js';

const ALL_OPERATORS: SearchCriteriaUtils.Operator[] = ['=', '<>', '<', '>', '<=', '>=', 'LIKE', 'IN', 'IS NULL', 'IS NOT NULL'];
const NO_LIKE_OPERATORS = ALL_OPERATORS.filter(operator => operator !== 'LIKE');
const BOOLEAN_OPERATORS: SearchCriteriaUtils.Operator[] = ['=', '<>', 'IS NULL', 'IS NOT NULL'];

// No vscode/React dependency - safe to import from both extension-host code and webview code, same
// reasoning as FieldUtils/IndexAdviceUtils. Only the webview calls these today (the schema browser's
// Data tab's Edit Search dialog), kept here rather than in webviews/ so it sits alongside the app's
// other SQL-fragment builders (e.g. IndexAdviceUtils.buildCreateIndexSql).
export class SearchCriteriaUtils {
	static readonly OPERATOR_LABELS: Record<SearchCriteriaUtils.Operator, string> = {
		'=': 'Equals',
		'<>': 'Not Equals',
		'<': 'Less Than',
		'>': 'Greater Than',
		'<=': 'Less Than or Equal',
		'>=': 'Greater Than or Equal',
		'LIKE': 'Contains',
		'IN': 'In List',
		'IS NULL': 'Is Null',
		'IS NOT NULL': 'Is Not Null'
	};

	// The same three buckets getAvailableOperators() partitions by - exposed separately so the Edit
	// Search dialog can tell whether switching a condition to a different column should keep the
	// entered value (same category - the value's still meaningful and every operator on the old
	// column is still available) or reset it (different category - e.g. a typed-out character value
	// doesn't carry over to a numeric column).
	static getTypeCategory(dataType?: string): SearchCriteriaUtils.TypeCategory {
		let upper = dataType?.toUpperCase() ?? '';

		if(FieldUtils.BOOLEAN_TYPES.some(type => upper.includes(type))) {
			return 'boolean';
		}

		let isDateOrTimeType = [...FieldUtils.TIMESTAMP_TYPES, ...FieldUtils.DATE_TYPES, ...FieldUtils.TIME_TYPES].some(type => upper.includes(type));

		if(FieldUtils.isNumericType(dataType) || isDateOrTimeType) {
			return 'numeric-or-date';
		}

		// Character types, and anything unrecognized (permissive default).
		return 'character';
	}

	// Type-aware: LIKE only makes sense for character data. Boolean columns drop the ordering/IN
	// operators, which aren't meaningful there. Anything unrecognized falls back to the full
	// (character-type) list rather than guessing wrong and hiding a valid operator.
	static getAvailableOperators(dataType?: string): SearchCriteriaUtils.Operator[] {
		switch(SearchCriteriaUtils.getTypeCategory(dataType)) {
			case 'boolean': return BOOLEAN_OPERATORS;
			case 'numeric-or-date': return NO_LIKE_OPERATORS;
			case 'character': return ALL_OPERATORS;
		}
	}

	// Builds a full WHERE clause body (no leading "where" keyword - the caller owns that) from a list
	// of Fields-tab conditions, always AND'd together. Rows with no value for a value-requiring
	// operator are silently skipped rather than producing invalid SQL - the caller doesn't need to
	// validate row completeness before calling this.
	static buildWhereClause(criteria: SearchCriteriaUtils.SearchCriterion[]): string {
		return criteria
			.map(criterion => SearchCriteriaUtils.buildClause(criterion))
			.filter((clause): clause is string => clause !== null)
			.join(' and ');
	}

	// Every identifier is delimited (double-quoted), matching DataQueries.listTableData's convention
	// for this table's generated SQL - systemName is the real DB2 column, not the sqlName alias the
	// grid displays (a WHERE clause evaluates against the table's actual columns, before the SELECT
	// list's aliases exist).
	private static buildClause(criterion: SearchCriteriaUtils.SearchCriterion): string | null {
		let quotedColumn = `"${criterion.systemName.replace(/"/g, '""')}"`;

		if(criterion.operator === 'IS NULL' || criterion.operator === 'IS NOT NULL') {
			return `${quotedColumn} ${criterion.operator}`;
		}

		if(criterion.operator === 'IN') {
			let values = criterion.values.map(value => value.trim()).filter(value => value.length > 0);

			if(values.length === 0) {
				return null;
			}

			return `${quotedColumn} IN (${values.map(value => FieldUtils.formatValueLiteral(criterion.dataType, value)).join(', ')})`;
		}

		if(!criterion.value.trim()) {
			return null;
		}

		if(criterion.operator === 'LIKE') {
			// Contains-style, matching what the results grid's client-side global filter did before
			// this feature moved search server-side.
			return `${quotedColumn} LIKE ${FieldUtils.formatValueLiteral(criterion.dataType, `%${criterion.value.trim()}%`)}`;
		}

		return `${quotedColumn} ${criterion.operator} ${FieldUtils.formatValueLiteral(criterion.dataType, criterion.value)}`;
	}
}

export namespace SearchCriteriaUtils {
	export type Operator = '=' | '<>' | '<' | '>' | '<=' | '>=' | 'LIKE' | 'IN' | 'IS NULL' | 'IS NOT NULL';
	export type TypeCategory = 'boolean' | 'numeric-or-date' | 'character';

	export interface SearchCriterion {
		systemName: string;
		dataType?: string;
		operator: Operator;
		/** Used by every operator except IN (see `values`) and IS NULL/IS NOT NULL (which need no value). */
		value: string;
		/** Used only by the IN operator - one entry per chip in the Fields tab's multi-value input. */
		values: string[];
	}
}
