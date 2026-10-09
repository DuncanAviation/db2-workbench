import { expect } from 'chai';
import { SystemColumn } from '../models/system-column.js';
import { DataEditDefaults, DataEditSettings } from './data-edit-defaults.js';

/**
 * The values a new row starts with in the Data tab's Add Row: a default per column type (the app's,
 * or the user's own), and the user's two choices about which columns get one at all.
 */
describe('DataEditDefaults', () => {
	function systemColumn(systemName: string, dataType: string, nulls: string, hasDefault = 'N', length?: number): SystemColumn {
		return <SystemColumn>{ systemName, dataType, nulls, hasDefault, length };
	}

	function settings(overrides: Partial<DataEditSettings> = {}): DataEditSettings {
		return { ...DataEditDefaults.DEFAULT_SETTINGS, ...overrides };
	}

	describe('typeKey', () => {
		// SYSCOLUMNS2's COLTYPE has its own spellings for some types.
		it('maps DB2 for i\'s own type spellings onto the listed types, and has none for a LOB', () => {
			expect(['CHAR', 'character', 'VARG', 'VARBIN', 'TIMESTMP', 'DECIMAL'].map(type => DataEditDefaults.typeKey(type)))
				.to.deep.equal(['CHAR', 'CHAR', 'VARGRAPHIC', 'VARBINARY', 'TIMESTAMP', 'DECIMAL']);
			expect(['CLOB', 'BLOB', 'ROWID', 'XML', undefined].map(type => DataEditDefaults.typeKey(type))).to.deep.equal([undefined, undefined, undefined, undefined, undefined]);
		});
	});

	describe('resolve', () => {
		it('uses the user\'s value for a type, NULL included, and the app\'s for any other', () => {
			let userDefaults = { CHAR: 'N/A', DATE: null };

			expect(DataEditDefaults.resolve('CHAR', userDefaults)).to.equal('N/A');
			expect(DataEditDefaults.resolve('DATE', userDefaults)).to.equal(null);
			expect(DataEditDefaults.resolve('DECIMAL', userDefaults)).to.equal('0');
			expect(DataEditDefaults.resolve('TIME', userDefaults)).to.equal('00:00:00');
			expect(DataEditDefaults.resolve('TIMESTAMP', userDefaults)).to.equal('0001-01-01 00:00:00.000000');
			expect(DataEditDefaults.resolve(undefined, userDefaults)).to.equal(undefined);
		});
	});

	describe('newRowValues', () => {
		const PARTNO = systemColumn('PARTNO', 'CHAR', 'N', 'N', 10);
		const QTY = systemColumn('QTY', 'DECIMAL', 'N');
		const ORDDT = systemColumn('ORDDT', 'DATE', 'N');
		const DESCR = systemColumn('DESCR', 'VARCHAR', 'Y');
		const STATUS = systemColumn('STATUS', 'CHAR', 'N', 'Y', 1);
		const NOTE = systemColumn('NOTE', 'VARCHAR', 'Y', 'Y');
		const HASH = systemColumn('HASH', 'BINARY', 'N');
		const COLUMNS = [PARTNO, QTY, ORDDT, DESCR, STATUS, NOTE, HASH];

		// The fields the user would otherwise have to fill in by hand - a NOT NULL column with no table
		// default - always start at their type's default.
		it('by default fills NOT NULL columns without a table default, and leaves the rest NULL', () => {
			expect(DataEditDefaults.newRowValues(COLUMNS, settings())).to.deep.equal({
				PARTNO: '', QTY: '0', ORDDT: '0001-01-01', DESCR: null, STATUS: null, NOTE: null, HASH: null
			});
		});

		it('fills nullable columns too when asked', () => {
			expect(DataEditDefaults.newRowValues(COLUMNS, settings({ nullableColumns: 'appDefault' }))).to.include({ DESCR: '', NOTE: null });
		});

		// Either kind, nullable or not.
		it('fills columns with a table default too when asked, instead of leaving them to DB2', () => {
			expect(DataEditDefaults.newRowValues(COLUMNS, settings({ columnsWithTableDefault: 'appDefault' }))).to.include({ STATUS: '', NOTE: '', DESCR: null });
		});

		it('uses the user\'s own defaults, fitted to the column, and NULL where they chose it', () => {
			let values = DataEditDefaults.newRowValues(COLUMNS, settings({ columnsWithTableDefault: 'appDefault', defaultValues: { CHAR: 'NONE', DECIMAL: null } }));
			expect(values).to.include({ PARTNO: 'NONE', STATUS: 'N', QTY: null });
		});
	});

	describe('withoutAppDefaults', () => {
		// So the setting only holds real changes - and an app default changed later still reaches a type
		// the user never touched.
		it('drops a user value that\'s the same as the app\'s', () => {
			expect(DataEditDefaults.withoutAppDefaults({ CHAR: '', DECIMAL: '1', BINARY: null, DATE: null })).to.deep.equal({ DECIMAL: '1', DATE: null });
		});
	});
});
