import { SystemColumn } from '../models/system-column.js';
import { FieldUtils } from './field-utils.js';
import { RowEditUtils, RowValue } from './row-edit-utils.js';

// The values a new row starts with in the schema browser's Data tab (Add Row). Pure - read by the
// webview to seed the Add Row dialog, and by the host only for the settings' shape, so no vscode or
// React import belongs here.
//
// Each column type has an app default (APP_DEFAULTS); the user can replace any of them, NULL included,
// through the Data tab's Settings dialog or the db2-workbench.dataEdit.defaultValues setting. Which
// columns get a type's default at all is the user's call for two kinds of column - see
// DataEditSettings - while a NOT NULL column without a table default always gets one, since that's
// the field the user would otherwise have to fill in by hand.
export class DataEditDefaults {
	/** Every type the Settings dialog lists, in the order it lists them, with the app's own default. */
	static readonly APP_DEFAULTS: ReadonlyArray<DataEditDefaults.TypeDefault> = [
		{ type: 'CHAR', appDefault: '' },
		{ type: 'VARCHAR', appDefault: '' },
		{ type: 'GRAPHIC', appDefault: '' },
		{ type: 'VARGRAPHIC', appDefault: '' },
		{ type: 'DECIMAL', appDefault: '0' },
		{ type: 'NUMERIC', appDefault: '0' },
		{ type: 'SMALLINT', appDefault: '0' },
		{ type: 'INTEGER', appDefault: '0' },
		{ type: 'BIGINT', appDefault: '0' },
		{ type: 'REAL', appDefault: '0' },
		{ type: 'DOUBLE', appDefault: '0' },
		{ type: 'FLOAT', appDefault: '0' },
		{ type: 'DECFLOAT', appDefault: '0' },
		{ type: 'DATE', appDefault: FieldUtils.LOW_DATE },
		// DB2 TIME has no fractional seconds.
		{ type: 'TIME', appDefault: FieldUtils.LOW_TIME },
		{ type: 'TIMESTAMP', appDefault: `${FieldUtils.LOW_DATE} 00:00:00.000000` },
		{ type: 'BOOLEAN', appDefault: 'FALSE' },
		// An empty string literal doesn't suit a binary column, and there's no blank to fall back on.
		{ type: 'BINARY', appDefault: null },
		{ type: 'VARBINARY', appDefault: null }
	];

	static readonly DEFAULT_SETTINGS: DataEditSettings = { defaultValues: {}, columnsWithTableDefault: 'tableDefault', nullableColumns: 'null' };

	// SYSCOLUMNS2's COLTYPE spells some types its own way - map them onto the names the dialog lists.
	private static readonly TYPE_ALIASES: Record<string, string> = {
		CHARACTER: 'CHAR',
		VARG: 'VARGRAPHIC',
		VARBIN: 'VARBINARY',
		TIMESTMP: 'TIMESTAMP'
	};

	/** The listed type a column's data type falls under, or undefined for one with no default (a LOB,
	 * ROWID, XML, DATALINK...). */
	static typeKey(dataType: string | undefined): string | undefined {
		let upper = dataType?.trim().toUpperCase() ?? '';
		let key = DataEditDefaults.TYPE_ALIASES[upper] ?? upper;
		return DataEditDefaults.APP_DEFAULTS.some(entry => entry.type === key) ? key : undefined;
	}

	static appDefault(type: string): RowValue | undefined {
		return DataEditDefaults.APP_DEFAULTS.find(entry => entry.type === type)?.appDefault;
	}

	/** A type's default as the user has it: their own value (NULL included) if they set one, else the
	 * app's. undefined for a type that has none. */
	static resolve(type: string | undefined, userDefaults: Record<string, RowValue>): RowValue | undefined {
		if (type == null) {
			return undefined;
		}

		return type in userDefaults ? userDefaults[type] : DataEditDefaults.appDefault(type);
	}

	// A new row's starting values, keyed by systemName, for its insertable fields. NULL is a field left
	// empty - for a column with a table default, the INSERT then leaves it out so DB2 fills it
	// (RowEditUtils.buildInsertValues), which is what "Table Default" means.
	static newRowValues(columns: SystemColumn[], settings: DataEditSettings): Record<string, RowValue> {
		return Object.fromEntries(columns.map(column => [column.systemName, DataEditDefaults.startingValue(column, settings)]));
	}

	// Drops every user value that's the same as the app's own default, so the setting only ever holds
	// real changes, and an app default changed in a later release still reaches a type left alone.
	static withoutAppDefaults(userDefaults: Record<string, RowValue>): Record<string, RowValue> {
		return Object.fromEntries(Object.entries(userDefaults).filter(([type, value]) => DataEditDefaults.appDefault(type) !== value));
	}

	private static startingValue(column: SystemColumn, settings: DataEditSettings): RowValue {
		let useAppDefault = RowEditUtils.hasTableDefault(column)
			? settings.columnsWithTableDefault === 'appDefault'
			: !RowEditUtils.isNotNull(column) ? settings.nullableColumns === 'appDefault' : true;

		if (!useAppDefault) {
			return null;
		}

		let value = DataEditDefaults.resolve(DataEditDefaults.typeKey(column.dataType), settings.defaultValues);
		// Sanitized for this column the way typing it would be - a CHAR(1) gets the first character of a
		// longer default rather than a value DB2 would reject.
		return value == null ? null : FieldUtils.sanitizeFieldInput(value, column);
	}
}

export namespace DataEditDefaults {
	export interface TypeDefault {
		type: string;
		/** null is NULL. */
		appDefault: RowValue;
	}
}

/** The Data tab's edit settings - db2-workbench.dataEdit.* in the user's settings. */
export interface DataEditSettings {
	/** The user's own default per listed type (DataEditDefaults.APP_DEFAULTS), null for NULL. A type
	 * that isn't here uses the app's default. */
	defaultValues: Record<string, RowValue>;
	/** A column with a table default: left for DB2 to fill, or given its type's default like any other. */
	columnsWithTableDefault: 'tableDefault' | 'appDefault';
	/** A nullable column without a table default: starts NULL, or with its type's default. */
	nullableColumns: 'null' | 'appDefault';
}
