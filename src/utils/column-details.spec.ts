import { expect } from 'chai';
import type { DbColumnDefinition } from '../database/drivers/db-driver.js';
import { ResultHeadingLabel } from '../models/result-heading-label.js';
import type { SystemColumn } from '../models/system-column.js';
import { ColumnDetailsUtils } from './column-details.js';

function systemColumn(options: Partial<SystemColumn> = {}): SystemColumn {
	return {
		schema: 'ACME', tableName: 'EMPLOYEE', colNo: 1, systemName: 'EMNO', sqlName: 'EMPLOYEE_ID', heading: 'Employee Code', text: '',
		dataType: 'DECIMAL', length: 7, precision: 7, scale: 0, nulls: 'Y', identity: 'NO', generated: '', cycle: '', hasDefault: 'N', hidden: 'N', updatable: 'Y',
		...options
	};
}

function definition(options: Partial<DbColumnDefinition> = {}): DbColumnDefinition {
	return {name: 'TOTAL', dataType: 3, dataTypeName: 'SQL_DECIMAL', columnSize: 9, decimalDigits: 2, nullable: true, ...options};
}

describe('ColumnDetailsUtils', () => {
	describe('fromSystemColumn', () => {
		it('carries every name form, the formatted type and the catalog flags', () => {
			expect(ColumnDetailsUtils.fromSystemColumn(systemColumn({nulls: 'N', identity: 'YES'}))).to.deep.equal({
				shortName: 'EMNO', longName: 'EMPLOYEE_ID', description: 'Employee Code', type: 'DECIMAL(7,0)', identity: true, notNull: true
			});
		});

		it('leaves out a blank heading', () => {
			expect(ColumnDetailsUtils.fromSystemColumn(systemColumn({heading: '  '})).description).to.be.undefined;
		});

		it('only says primary key when the caller knows', () => {
			expect(ColumnDetailsUtils.fromSystemColumn(systemColumn())).to.not.have.property('primaryKey');
			expect(ColumnDetailsUtils.fromSystemColumn(systemColumn(), true).primaryKey).to.be.true;
		});
	});

	describe('fromResultColumn', () => {
		it('treats the key as the long name and takes the type from the driver', () => {
			expect(ColumnDetailsUtils.fromResultColumn('TOTAL', definition({nullable: false}))).to.deep.equal({longName: 'TOTAL', type: 'DECIMAL(9,2)', notNull: true});
		});

		it('is just the long name without a definition', () => {
			expect(ColumnDetailsUtils.fromResultColumn('TOTAL')).to.deep.equal({longName: 'TOTAL'});
		});
	});

	describe('buildDetailsMap', () => {
		it('describes a catalog match from the catalog and anything else from the driver', () => {
			let lookup = new Map([['EMPLOYEE_ID', systemColumn()]]);
			let details = ColumnDetailsUtils.buildDetailsMap(lookup, ['employee_id', 'TOTAL'], [definition()]);

			expect(details.employee_id.shortName).to.equal('EMNO');
			expect(details.TOTAL).to.deep.equal({longName: 'TOTAL', type: 'DECIMAL(9,2)', notNull: false});
		});
	});

	describe('lines', () => {
		it('lists the name forms, then the type, then each flag that is set', () => {
			expect(ColumnDetailsUtils.lines({shortName: 'EMNO', longName: 'EMPLOYEE_ID', description: 'Employee Code', type: 'INTEGER', identity: true, primaryKey: true, notNull: true})).to.deep.equal([
				{label: ResultHeadingLabel.SHORT_NAME, value: 'EMNO'},
				{label: ResultHeadingLabel.LONG_NAME, value: 'EMPLOYEE_ID'},
				{label: ResultHeadingLabel.DESCRIPTION, value: 'Employee Code'},
				{label: ColumnDetailsUtils.TYPE_LABEL, value: 'INTEGER'},
				{label: 'Identity', value: 'Yes'},
				{label: 'Primary Key', value: 'Yes'},
				{label: 'Not Null', value: 'Yes'}
			]);
		});

		it('skips whatever is missing', () => {
			expect(ColumnDetailsUtils.lines({longName: 'TOTAL', notNull: false})).to.deep.equal([{label: ResultHeadingLabel.LONG_NAME, value: 'TOTAL'}]);
		});
	});

	describe('formatType', () => {
		it('renders a length-bearing type with its length', () => {
			expect(ColumnDetailsUtils.formatType({dataType: 'CHAR', length: 10})).to.equal('CHAR(10)');
		});

		it('renders a type with no length bare', () => {
			expect(ColumnDetailsUtils.formatType({dataType: 'INTEGER'})).to.equal('INTEGER');
		});

		it('treats a reported length of zero as no length', () => {
			expect(ColumnDetailsUtils.formatType({dataType: 'DATE', length: 0})).to.equal('DATE');
		});

		it('renders precision and scale for a decimal type', () => {
			expect(ColumnDetailsUtils.formatType({dataType: 'DECIMAL', length: 7, precision: 7, scale: 2})).to.equal('DECIMAL(7,2)');
		});

		it('keeps a zero scale on a decimal type', () => {
			expect(ColumnDetailsUtils.formatType({dataType: 'NUMERIC', precision: 5, scale: 0})).to.equal('NUMERIC(5,0)');
		});

		it('ignores scale on a non-decimal type', () => {
			expect(ColumnDetailsUtils.formatType({dataType: 'TIMESTAMP', length: 26, scale: 6})).to.equal('TIMESTAMP(26)');
		});

		it('returns an empty string for a missing data type', () => {
			expect(ColumnDetailsUtils.formatType({dataType: '   '})).to.equal('');
		});
	});

	describe('formatDriverType', () => {
		it('drops the ODBC prefix', () => {
			expect(ColumnDetailsUtils.formatDriverType(definition({dataTypeName: 'SQL_TYPE_TIMESTAMP', columnSize: 26}))).to.equal('TIMESTAMP');
		});

		it('shows a length only for a type whose DDL has one', () => {
			expect(ColumnDetailsUtils.formatDriverType(definition({dataTypeName: 'SQL_VARCHAR', columnSize: 50}))).to.equal('VARCHAR(50)');
			expect(ColumnDetailsUtils.formatDriverType(definition({dataTypeName: 'SQL_INTEGER', columnSize: 10}))).to.equal('INTEGER');
		});

		it('shows precision and scale for a decimal type', () => {
			expect(ColumnDetailsUtils.formatDriverType(definition())).to.equal('DECIMAL(9,2)');
		});

		it('leaves an unprefixed name alone', () => {
			expect(ColumnDetailsUtils.formatDriverType(definition({dataTypeName: 'VARCHAR', columnSize: 255}))).to.equal('VARCHAR(255)');
		});
	});
});
