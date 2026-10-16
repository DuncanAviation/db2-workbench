import type { DbColumnDefinition } from '../database/drivers/db-driver.js';
import { ResultHeadingLabel } from '../models/result-heading-label.js';
import type { SystemColumn } from '../models/system-column.js';

import { StringUtils } from './string-utils.js';

// What a column's hover tooltip says about it - the diagram's column rows and every data grid's column
// headers - and what a header's Copy Name / Copy Long Name / Copy Description menu copies. One shape and
// one line builder, so the diagram and the grids describe a column the same way.
//
// Only ever built from what a caller already has in hand: the catalog columns MemoryCache already holds,
// the result set's own column definitions, or a diagram column. Nothing here is a reason to query.
//
// Pure - only type imports beyond src/utils and the label enum - so it's unit-testable and importable from
// the webview bundles as well as the host.

/** Everything a column tooltip can show. Every field is optional: a computed result column has no catalog
 * entry, so no short name or description, and a flag is only set when it was actually known. */
export interface ColumnDetails {
	/** DB2's short system name (SystemColumn.systemName). */
	shortName?: string;
	/** DB2's long SQL name (SystemColumn.sqlName). */
	longName?: string;
	/** The column heading (SystemColumn.heading). */
	description?: string;
	/** DDL-style type, e.g. CHAR(10) or DECIMAL(7,2). */
	type?: string;
	identity?: boolean;
	primaryKey?: boolean;
	notNull?: boolean;
}

export interface ColumnDetailLine {
	label: string;
	value: string;
}

export class ColumnDetailsUtils {
	/** A catalog column. `primaryKey` comes from the caller, since SYSCOLUMNS2 doesn't say. */
	static fromSystemColumn(column: SystemColumn, primaryKey?: boolean): ColumnDetails {
		return {
			shortName: StringUtils.trim(column.systemName, {toUndefined: true}),
			longName: StringUtils.trim(column.sqlName, {toUndefined: true}),
			description: StringUtils.trim(column.heading, {toUndefined: true}),
			type: ColumnDetailsUtils.formatType(column) || undefined,
			identity: (column.identity ?? '').toUpperCase() === 'YES',
			...(primaryKey != null ? {primaryKey: primaryKey} : {}),
			// 'Y' nullable, 'N' NOT NULL - the same reading toDiagramColumn and RowEditUtils.isNotNull make.
			notNull: (column.nulls ?? '').toUpperCase() === 'N'
		};
	}

	/**
	 * A result column with no catalog match - a computed or aliased column. From DB2's point of view its
	 * key is its long name, the same assumption ColumnNameUtils.buildLabelMap makes. The type and
	 * nullability come from the driver's own description of the result set, when there is one.
	 */
	static fromResultColumn(key: string, definition?: DbColumnDefinition): ColumnDetails {
		return {
			longName: key,
			...(definition ? {type: ColumnDetailsUtils.formatDriverType(definition) || undefined, notNull: definition.nullable === false} : {})
		};
	}

	/**
	 * Builds the `Record<key, details>` map the results webview receives, alongside the label map from
	 * ColumnNameUtils.buildLabelMap - `lookup` is keyed the same way (uppercased row key). A key with a
	 * catalog match is described from the catalog; any other key from the driver's column definitions.
	 */
	static buildDetailsMap(lookup: ReadonlyMap<string, SystemColumn>, columnKeys: readonly string[], definitions: readonly DbColumnDefinition[] = []): Record<string, ColumnDetails> {
		let definitionsByName = new Map(definitions.map(definition => [definition.name, definition]));
		let detailsMap: Record<string, ColumnDetails> = {};

		for(let key of columnKeys) {
			let metadata = lookup.get(key.toUpperCase());
			detailsMap[key] = metadata ? ColumnDetailsUtils.fromSystemColumn(metadata) : ColumnDetailsUtils.fromResultColumn(key, definitionsByName.get(key));
		}

		return detailsMap;
	}

	/**
	 * The tooltip's lines, in a fixed order: short name, long name and description (whichever the column
	 * has), its type, then an Identity, Primary Key and Not Null line for each flag that's set. A caller
	 * with more to say (the diagram's Unique, Index and Foreign Key lines) appends after these.
	 */
	static lines(details: ColumnDetails): ColumnDetailLine[] {
		let candidates: {label: string; value: string | undefined}[] = [
			{label: ResultHeadingLabel.SHORT_NAME, value: details.shortName},
			{label: ResultHeadingLabel.LONG_NAME, value: details.longName},
			{label: ResultHeadingLabel.DESCRIPTION, value: details.description},
			{label: ColumnDetailsUtils.TYPE_LABEL, value: details.type}
		];

		let lines = candidates.filter((line): line is ColumnDetailLine => StringUtils.isNotBlank(line.value));

		if(details.identity) {
			lines.push({label: 'Identity', value: 'Yes'});
		}

		if(details.primaryKey) {
			lines.push({label: 'Primary Key', value: 'Yes'});
		}

		if(details.notNull) {
			lines.push({label: 'Not Null', value: 'Yes'});
		}

		return lines;
	}

	/**
	 * A compact `CHAR(10)` / `DECIMAL(7,2)` / `INTEGER` type label. The Columns tab shows dataType, length,
	 * scale and precision as four separate sortable columns; a diagram row or a tooltip line has room for
	 * one, so they're folded into the conventional DDL-style rendering instead.
	 *
	 * Takes just the four fields it reads rather than a whole SystemColumn, so a ResolvedColumn - where
	 * every DB2-only field is optional, since an imported column can't honestly supply length/scale/
	 * precision - formats through the same function.
	 */
	static formatType(column: Partial<Pick<SystemColumn, 'dataType' | 'length' | 'scale' | 'precision'>>): string {
		let dataType = (column.dataType ?? '').trim();

		if(!dataType) {
			return '';
		}

		// DECIMAL/NUMERIC report both, and scale 0 is meaningful there (DECIMAL(7,0) is not DECIMAL(7)), so
		// it's included whenever a scale is present at all rather than only when non-zero.
		if(column.scale != null && ColumnDetailsUtils.isDecimalType(dataType)) {
			return `${dataType}(${column.precision ?? column.length ?? 0},${column.scale})`;
		}

		// A length of 0 is what the catalog reports for types that have no length at all (DATE, INTEGER,
		// TIMESTAMP), so it's treated as "no length" rather than printed as (0).
		return column.length ? `${dataType}(${column.length})` : dataType;
	}

	/**
	 * The same rendering for a driver-reported column. ODBC names its types `SQL_VARCHAR`,
	 * `SQL_TYPE_TIMESTAMP` and so on, so the prefix is dropped. Unlike the catalog, a driver reports a
	 * column size for every type (10 digits for an INTEGER), so a length is only shown for the types
	 * whose DDL carries one.
	 */
	static formatDriverType(definition: DbColumnDefinition): string {
		let dataType = (definition.dataTypeName ?? '').trim().replace(/^SQL_(TYPE_)?/i, '');

		if(ColumnDetailsUtils.isDecimalType(dataType)) {
			return ColumnDetailsUtils.formatType({dataType: dataType, precision: definition.columnSize, scale: definition.decimalDigits});
		}

		if(/CHAR|BINARY|GRAPHIC/i.test(dataType)) {
			return ColumnDetailsUtils.formatType({dataType: dataType, length: definition.columnSize});
		}

		return dataType;
	}

	private static isDecimalType(dataType: string): boolean {
		let normalized = dataType.toUpperCase();
		return normalized === 'DECIMAL' || normalized === 'NUMERIC' || normalized === 'DEC' || normalized === 'DECFLOAT';
	}
}

export namespace ColumnDetailsUtils {
	export const TYPE_LABEL = 'Type';
}
