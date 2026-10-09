import { ResultHeadingLabel } from '../models/result-heading-label.js';
import type { ImportedColumn } from '../schema-conversion/schema-format-converter.js';
import type { DiagramColumn } from '../webview-messages/diagram-messages.js';

import { StringUtils } from './string-utils.js';

// The one place a column's several name forms (DB2's short system name, its long SQL name, and its
// heading/description) are turned into either of two things, which are deliberately kept apart:
//
// DISPLAY - what the user reads. Follows `db2-workbench.resultHeadingLabels`, so a column reads the same
// way in the results grid, the schema browser, the diagram and every message or dialog that names one.
// A raw row key, catalog name or imported name is never shown directly; it goes through labels()/
// displayName() here, or through labelForKey()/labelsForKey() for a webview that only holds an
// already-built label map.
//
// MATCHING - whether a name refers to a column. Never depends on the user's setting, and considers every
// real NAME form (identity, short, long) but never the description: a heading isn't a name, two columns
// can share one, and an imported foreign key must not anchor to a column by its heading. Case-insensitive,
// since the two sides of a comparison come from different places (DB2's catalog, an imported file, SQL a
// user typed, an older saved diagram) and DB2's own name matching is.
//
// Pure - only type imports beyond src/utils and the label enum - so it's unit-testable and importable from
// the webview bundles as well as the host.

/** Every name form a column is known by. `identity` is whatever the caller keys the column by. */
export interface ColumnNames {
	identity: string;
	shortName?: string;
	longName?: string;
	description?: string;
}

export class ColumnNameUtils {
	/** A catalog column (or anything shaped like one, e.g. ResolvedColumn), keyed by its short name. */
	static fromSystemColumn(column: ColumnNameUtils.CatalogColumn): ColumnNames {
		return {identity: column.systemName, shortName: column.systemName, longName: column.sqlName, description: column.heading};
	}

	/** An imported column, keyed by the name its source file declared it with. No description: an
	 * import's is free text (it lands on `text`), not a heading. */
	static fromImportedColumn(column: Pick<ImportedColumn, 'name' | 'sqlName'>): ColumnNames {
		return {identity: column.name, longName: column.sqlName};
	}

	/** A diagram column, keyed by its relationship-anchoring identity (see DiagramColumn.name). */
	static fromDiagramColumn(column: DiagramColumn): ColumnNames {
		return {identity: column.name, shortName: column.shortName, longName: column.longName, description: column.description};
	}

	// ----- Display -----

	/**
	 * Every configured label option this column has a value for, in the configured order, without
	 * repeats - the stacked form a grid header shows. Falls back to the identity when none apply, so the
	 * result is never empty.
	 */
	static labels(names: ColumnNames, headingLabels: readonly string[]): string[] {
		let parts: string[] = [];

		for(let label of headingLabels) {
			let value = ColumnNameUtils.valueForLabel(names, label);

			if(value !== undefined && StringUtils.isNotBlank(value) && !parts.includes(value)) {
				parts.push(value);
			}
		}

		return parts.length > 0 ? parts : [names.identity];
	}

	/** The single-line form: the first configured label option this column has a value for, else its identity. */
	static displayName(names: ColumnNames, headingLabels: readonly string[]): string {
		return ColumnNameUtils.labels(names, headingLabels)[0];
	}

	/**
	 * Builds the `Record<key, labels>` map a results/table-data webview receives. `lookup` is keyed by the
	 * uppercased form the raw keys are in - long names for the results grid (ordinary unaliased DB2 query
	 * behavior), short names for the schema browser's Data tab (DataQueries.listTableData selects by
	 * systemName). A key with no catalog match (a computed or aliased column) is treated as its own long
	 * name, which is what it is from DB2's point of view. Every key gets an entry.
	 */
	static buildLabelMap(lookup: ReadonlyMap<string, ColumnNameUtils.CatalogColumn>, columnKeys: readonly string[], headingLabels: readonly string[]): Record<string, string[]> {
		let labelMap: Record<string, string[]> = {};

		for(let key of columnKeys) {
			let metadata = lookup.get(key.toUpperCase());
			let names: ColumnNames = metadata ? {...ColumnNameUtils.fromSystemColumn(metadata), identity: key} : {identity: key, longName: key};
			labelMap[key] = ColumnNameUtils.labels(names, headingLabels);
		}

		return labelMap;
	}

	/** The single-line label for a raw key out of a label map built by buildLabelMap, else the key itself. */
	static labelForKey(labelMap: Readonly<Record<string, readonly string[]>>, key: string): string {
		return ColumnNameUtils.labelsForKey(labelMap, key)[0];
	}

	/** The stacked labels for a raw key out of a label map built by buildLabelMap, else just the key. */
	static labelsForKey(labelMap: Readonly<Record<string, readonly string[]>>, key: string): string[] {
		let parts = labelMap[key];
		return parts && parts.length > 0 ? [...parts] : [key];
	}

	// ----- Matching -----

	/** Every NAME form this column answers to - identity, short and long - never its description. */
	static aliases(names: ColumnNames): string[] {
		let aliases: string[] = [];

		for(let name of [names.identity, names.shortName, names.longName]) {
			if(name !== undefined && StringUtils.isNotBlank(name) && !aliases.some(alias => StringUtils.equalsIgnoreCase(alias, name))) {
				aliases.push(name);
			}
		}

		return aliases;
	}

	/** True when `name` refers to this column in any of its name forms. */
	static matches(names: ColumnNames, name: string): boolean {
		return ColumnNameUtils.aliases(names).some(alias => StringUtils.equalsIgnoreCase(alias, name));
	}

	/** The first column `name` refers to, in any of its name forms. */
	static find<T>(columns: readonly T[], name: string, toNames: (column: T) => ColumnNames): T | undefined {
		return columns.find(column => ColumnNameUtils.matches(toNames(column), name));
	}

	/** find() over catalog columns - the common case. */
	static findSystemColumn<T extends ColumnNameUtils.CatalogColumn>(columns: readonly T[], name: string): T | undefined {
		return ColumnNameUtils.find(columns, name, ColumnNameUtils.fromSystemColumn);
	}

	/**
	 * A lookup over many names at once, for building comparison signatures: every alias of every column
	 * maps to that column, the earlier column winning a name two columns both answer to (the same answer
	 * find() would give). Returns the matched column rather than a string, so each caller picks its own
	 * canonical form - a signature compares short names, a diagram keys by long-name identity.
	 */
	static buildResolver<T>(columns: readonly T[], toNames: (column: T) => ColumnNames): (name: string) => T | undefined {
		let byName = new Map<string, T>();

		for(let column of columns) {
			for(let alias of ColumnNameUtils.aliases(toNames(column))) {
				let key = alias.toUpperCase();

				if(!byName.has(key)) {
					byName.set(key, column);
				}
			}
		}

		return name => byName.get(name.toUpperCase());
	}

	private static valueForLabel(names: ColumnNames, label: string): string | undefined {
		if(label === ResultHeadingLabel.SHORT_NAME) {
			return names.shortName;
		}

		if(label === ResultHeadingLabel.LONG_NAME) {
			return names.longName;
		}

		if(label === ResultHeadingLabel.DESCRIPTION) {
			return names.description;
		}

		return undefined;
	}
}

export namespace ColumnNameUtils {
	/** The name-bearing fields of a SystemColumn. Structural so ResolvedColumn (whose sqlName is optional,
	 * an imported-only column having none) fits too. */
	export interface CatalogColumn {
		systemName: string;
		sqlName?: string;
		heading?: string;
	}
}
