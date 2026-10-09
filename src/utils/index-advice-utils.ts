import { SystemIndexAdvice } from '../models/system-index-advice.js';

// No vscode/React dependency - safe to import from both extension-host code (src/) and webview
// code (webviews/), same reasoning as FieldUtils (see field-utils.ts).
export class IndexAdviceUtils {
	// Also reused by the Indexes tab to validate a Rename Index target name.
	static readonly MAX_INDEX_NAME_LENGTH = 128;

	// QSYS2.SYSIXADV.KEY_COLUMNS_ADVISED is a single comma-separated string (e.g. "COL1, COL2") -
	// this is the one place that format gets parsed, so callers never have to know about it.
	static parseKeyColumns(keyColumnsAdvised: string): string[] {
		return (keyColumnsAdvised ?? '')
			.split(',')
			.map(column => column.trim())
			.filter(column => column.length > 0);
	}

	// Suggests a starting name for a Create Index dialog - the same generated name buildCreateIndexSql()
	// falls back to when no explicit name is given, exposed separately so a dialog can seed an editable
	// Name field with it before the user (possibly) overrides it.
	static suggestIndexName(advice: Pick<SystemIndexAdvice, 'table' | 'keyColumnsAdvised'>): string {
		return IndexAdviceUtils.buildIndexName(advice.table, IndexAdviceUtils.parseKeyColumns(advice.keyColumnsAdvised));
	}

	// Builds a full CREATE INDEX statement from an advisor row - the single source of truth for both
	// the "Copy SQL" and "Create Index" actions in the Advised Indexes tab, so they can never drift
	// apart. indexName defaults to the generated name (suggestIndexName()) when the caller doesn't have
	// (or hasn't let the user override) a specific one to use.
	static buildCreateIndexSql(advice: Pick<SystemIndexAdvice, 'schema' | 'table' | 'keyColumnsAdvised'>, indexName?: string): string {
		let columns = IndexAdviceUtils.parseKeyColumns(advice.keyColumnsAdvised);
		let name = indexName ?? IndexAdviceUtils.buildIndexName(advice.table, columns);

		return `CREATE INDEX ${advice.schema}.${name} ON ${advice.schema}.${advice.table} (${columns.join(', ')})`;
	}

	// A generated name has to stay a valid SQL identifier even though table/column names feeding it
	// are already validated by the database - defensive sanitizing here is what keeps this safe to
	// call with anything QSYS2.SYSIXADV happens to return.
	private static buildIndexName(table: string, columns: string[]): string {
		let base = `IDXADV_${table}_${columns.join('_')}`.toUpperCase().replace(/[^A-Z0-9_]/g, '');
		return base.slice(0, IndexAdviceUtils.MAX_INDEX_NAME_LENGTH);
	}
}
