import { expect } from 'chai';
import { SystemColumn } from '../models/system-column.js';
import { RowEditUtils } from './row-edit-utils.js';

/**
 * The SQL text behind Add Row, inline editing and Delete Row in the schema browser's Data tab.
 *
 * This is the highest-consequence string in the extension: it is generated, it is run against a
 * production table, and the user only sees it after it has already been built. The cases that matter
 * are the ones where a statement stays valid but means something else - a value that ends the literal
 * early, a key that matches more rows than intended, an RRN rendered as if it were a column.
 */
describe('RowEditUtils', () => {
	function column(systemName: string, dataType: string, value: string) {
		return { systemName: systemName, dataType: dataType, value: value };
	}

	describe('buildInsertSql', () => {
		it('delimits the target and every column, and types each value by its column', () => {
			let sql = RowEditUtils.buildInsertSql('SALES', 'CUSTOMER', [
				column('CUSTNO', 'INTEGER', '4'),
				column('CUSTNM', 'VARCHAR', 'Example Air'),
				column('ORDDT', 'DATE', '2026-02-01')
			]);

			expect(sql).to.equal('INSERT INTO "SALES"."CUSTOMER" ("CUSTNO", "CUSTNM", "ORDDT") VALUES (4, \'Example Air\', \'2026-02-01\')');
		});

		// An apostrophe in a name is the everyday case that a naive builder turns into a syntax error
		// at best, and into a statement that means something else at worst.
		it('doubles a quote inside a value rather than ending the literal', () => {
			let sql = RowEditUtils.buildInsertSql('SALES', 'CUSTOMER', [column('CUSTNM', 'VARCHAR', 'O\'Brien Air')]);
			expect(sql).to.equal('INSERT INTO "SALES"."CUSTOMER" ("CUSTNM") VALUES (\'O\'\'Brien Air\')');
		});

		// Whitespace in a character value can be real data. Trimming it would store something else, and
		// for a key, would build a WHERE that matches no row at all.
		it('keeps leading and trailing spaces in a character value, but trims typed values', () => {
			let sql = RowEditUtils.buildInsertSql('SALES', 'CUSTOMER', [
				column('CUSTNM', 'VARCHAR', '  Example Air '),
				column('CUSTNO', 'INTEGER', ' 4 '),
				column('ORDDT', 'DATE', ' 2026-02-01 ')
			]);

			expect(sql).to.equal('INSERT INTO "SALES"."CUSTOMER" ("CUSTNM", "CUSTNO", "ORDDT") VALUES (\'  Example Air \', 4, \'2026-02-01\')');
		});

		// NULL is asked for explicitly (Set NULL) - a cleared character field means the empty string,
		// which is how a CHAR is set to blanks. A number or date has no empty literal, so it's NULL.
		it('writes null as NULL, and empty as \'\' in a character column but NULL in any other', () => {
			let sql = RowEditUtils.buildInsertSql('SALES', 'CUSTOMER', [
				{ systemName: 'CUSTNM', dataType: 'VARCHAR', value: null },
				column('CUSTCD', 'CHAR', ''),
				column('CUSTNO', 'INTEGER', ''),
				column('ORDDT', 'DATE', ' ')
			]);
			expect(sql).to.equal('INSERT INTO "SALES"."CUSTOMER" ("CUSTNM", "CUSTCD", "CUSTNO", "ORDDT") VALUES (NULL, \'\', NULL, NULL)');
		});
	});

	describe('buildUpdateSql', () => {
		it('sets each column and keys the row by every key column', () => {
			let sql = RowEditUtils.buildUpdateSql(
				'SALES',
				'SHIPMENT',
				[column('SHPCAR', 'CHAR', 'UPS')],
				[
					{ systemName: 'SHPCUS', dataType: 'INTEGER', value: '2', isRrn: false },
					{ systemName: 'SHPDT', dataType: 'DATE', value: '2026-02-01', isRrn: false }
				]
			);

			expect(sql).to.equal('UPDATE "SALES"."SHIPMENT" SET "SHPCAR" = \'UPS\' WHERE "SHPCUS" = 2 AND "SHPDT" = \'2026-02-01\'');
		});

		// RRN is a function of the table, not a column: "$RRN" only ever exists as a SELECT-list alias
		// (see DataQueries.listTableData), so keying off it as a column would target nothing at all.
		it('keys by RRN(table) when the table has no key of its own', () => {
			let sql = RowEditUtils.buildUpdateSql('SALES', 'ORDNOTE', [column('NOTEBY', 'CHAR', 'QSECOFR')], [{ systemName: '$RRN', value: '3', isRrn: true }]);
			expect(sql).to.equal('UPDATE "SALES"."ORDNOTE" SET "NOTEBY" = \'QSECOFR\' WHERE RRN("ORDNOTE") = 3');
		});
	});

	describe('buildDeleteSql', () => {
		it('deletes by key, delimited the same way as the other statements', () => {
			let sql = RowEditUtils.buildDeleteSql('SALES', 'CUSTOMER', [{ systemName: 'CUSTNO', dataType: 'INTEGER', value: '2', isRrn: false }]);
			expect(sql).to.equal('DELETE FROM "SALES"."CUSTOMER" WHERE "CUSTNO" = 2');
		});

		it('matches a character key with a leading space exactly', () => {
			let sql = RowEditUtils.buildDeleteSql('SALES', 'CUSTOMER', [{ systemName: 'CUSTCD', dataType: 'CHAR', value: ' A1', isRrn: false }]);
			expect(sql).to.equal('DELETE FROM "SALES"."CUSTOMER" WHERE "CUSTCD" = \' A1\'');
		});

		// "= NULL" is never true, so a key written that way silently matches no row. A NULL key is IS
		// NULL; a CHAR key of only blanks arrives trimmed to '', which DB2 compares equal to the blanks.
		it('matches a NULL key with IS NULL and an all-blank character key with \'\'', () => {
			let sql = RowEditUtils.buildDeleteSql('SALES', 'CUSTOMER', [
				{ systemName: 'CUSTCD', dataType: 'CHAR', value: '', isRrn: false },
				{ systemName: 'ALTCD', dataType: 'VARCHAR', value: null, isRrn: false }
			]);
			expect(sql).to.equal('DELETE FROM "SALES"."CUSTOMER" WHERE "CUSTCD" = \'\' AND "ALTCD" IS NULL');
		});

		it('deletes by RRN when that is what keys the row', () => {
			let sql = RowEditUtils.buildDeleteSql('SALES', 'ORDNOTE', [{ systemName: '$RRN', value: '2', isRrn: true }]);
			expect(sql).to.equal('DELETE FROM "SALES"."ORDNOTE" WHERE RRN("ORDNOTE") = 2');
		});
	});

	// A column the database will supply a value for is not the user's problem to fill in. Both
	// spellings are checked because SYSCOLUMNS2 reports these flags inconsistently - see isRequired.
	describe('isRequired', () => {
		function systemColumn(nulls: string, hasDefault: string): SystemColumn {
			return <SystemColumn>{ nulls: nulls, hasDefault: hasDefault };
		}

		it('is required only when the column is NOT NULL and has no default', () => {
			expect(RowEditUtils.isRequired(systemColumn('N', 'N'))).to.equal(true);
			expect(RowEditUtils.isRequired(systemColumn('NO', 'NO'))).to.equal(true);
			expect(RowEditUtils.isRequired(systemColumn('Y', 'N'))).to.equal(false);
			expect(RowEditUtils.isRequired(systemColumn('N', 'Y'))).to.equal(false);
			expect(RowEditUtils.isRequired(systemColumn('YES', 'YES'))).to.equal(false);
		});
	});

	// What a statement would write NULL into a column that can't take it - the check that keeps the
	// Data tab from queueing SQL DB2 is certain to reject.
	describe('findMissingRequired', () => {
		function systemColumn(systemName: string, dataType: string, nulls: string, hasDefault = 'N'): SystemColumn {
			return <SystemColumn>{ systemName, dataType, nulls, hasDefault };
		}

		const PARTNO = systemColumn('PARTNO', 'CHAR', 'N');
		const DESCR = systemColumn('DESCR', 'VARCHAR', 'Y');
		const QTY = systemColumn('QTY', 'DECIMAL', 'N', 'Y');
		const COLUMNS = [PARTNO, DESCR, QTY];

		it('an insert needs every NOT NULL column without a default, entered or not', () => {
			expect(RowEditUtils.findMissingRequired('insert', COLUMNS, {})).to.deep.equal([PARTNO]);
			expect(RowEditUtils.findMissingRequired('insert', COLUMNS, { PARTNO: null, QTY: null })).to.deep.equal([PARTNO]);
			expect(RowEditUtils.findMissingRequired('insert', COLUMNS, { PARTNO: 'A100' })).to.deep.equal([]);
		});

		// A default fills a column an INSERT leaves out, never one an UPDATE sets.
		it('an update needs every NOT NULL column it sets, default or not, and nothing it leaves alone', () => {
			expect(RowEditUtils.findMissingRequired('update', COLUMNS, { PARTNO: null, QTY: null, DESCR: null })).to.deep.equal([PARTNO, QTY]);
			expect(RowEditUtils.findMissingRequired('update', COLUMNS, { DESCR: null })).to.deep.equal([]);
		});

		// A cleared character field is the empty string - blanks, for a CHAR, which DB2 for i stores all
		// the time - so it satisfies NOT NULL. A number or date has no literal for empty or spaces.
		it('counts empty and spaces as a value only in a character column', () => {
			expect(RowEditUtils.findMissingRequired('update', COLUMNS, { PARTNO: '', QTY: '' })).to.deep.equal([QTY]);
			expect(RowEditUtils.findMissingRequired('update', COLUMNS, { PARTNO: '  ', QTY: '  ' })).to.deep.equal([QTY]);
		});
	});

	describe('buildInsertValues', () => {
		function systemColumn(systemName: string, dataType: string, nulls: string, hasDefault: string): SystemColumn {
			return <SystemColumn>{ systemName, dataType, nulls, hasDefault };
		}

		// A column with a table default left NULL is what "Table Default" means: leaving it out of the
		// column list is what makes DB2 use the default (and a NOT NULL one would reject the NULL). A
		// nullable column without one still gets NULL.
		it('leaves out a NULL column with a table default, and keeps every other column in order', () => {
			let columns = [
				systemColumn('PARTNO', 'CHAR', 'N', 'N'),
				systemColumn('QTY', 'DECIMAL', 'N', 'Y'),
				systemColumn('DESCR', 'VARCHAR', 'Y', 'Y'),
				systemColumn('NOTE', 'VARCHAR', 'Y', 'N')
			];

			expect(RowEditUtils.buildInsertValues(columns, { PARTNO: 'A100' })).to.deep.equal([
				{ systemName: 'PARTNO', dataType: 'CHAR', value: 'A100' },
				{ systemName: 'NOTE', dataType: 'VARCHAR', value: null }
			]);
			expect(RowEditUtils.buildInsertValues(columns, { PARTNO: 'A100', QTY: '3', DESCR: '' }).map(value => value.systemName)).to.deep.equal(['PARTNO', 'QTY', 'DESCR', 'NOTE']);
		});
	});
});
