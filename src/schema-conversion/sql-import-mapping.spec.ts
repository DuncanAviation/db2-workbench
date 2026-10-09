import { expect } from 'chai';
import { autoMapSqlImportColumns } from './sql-import-mapping.js';

describe('autoMapSqlImportColumns', () => {
	it('maps the motivating relationships statement', () => {
		let mapping = autoMapSqlImportColumns('relationships', ['SCHEMA1', 'NAME1', 'COLNAME1', 'SCHEMA2', 'NAME2', 'COLNAME2']);

		expect(mapping).to.eql({
			SCHEMA1: 'childSchema',
			NAME1: 'childTableSystemName',
			COLNAME1: 'childColumnSystemName',
			SCHEMA2: 'parentSchema',
			NAME2: 'parentTableSystemName',
			COLNAME2: 'parentColumnSystemName'
		});
	});

	it('reads the side off a leading word as well as a trailing digit', () => {
		let mapping = autoMapSqlImportColumns('relationships', ['CHILD_SCHEMA', 'CHILD_TABLE', 'CHILD_COLUMN', 'PARENT_SCHEMA', 'PARENT_TABLE', 'PARENT_COLUMN']);

		expect(mapping.CHILD_SCHEMA).to.equal('childSchema');
		expect(mapping.CHILD_TABLE).to.equal('childTableSystemName');
		expect(mapping.CHILD_COLUMN).to.equal('childColumnSystemName');
		expect(mapping.PARENT_COLUMN).to.equal('parentColumnSystemName');
	});

	it('maps the unsided relationship targets', () => {
		let mapping = autoMapSqlImportColumns('relationships', ['FK_NAME', 'KEY_POSITION', 'UPDATE_RULE', 'DELETE_RULE']);

		expect(mapping).to.eql({
			FK_NAME: 'foreignKeyName',
			KEY_POSITION: 'keyPosition',
			UPDATE_RULE: 'updateRule',
			DELETE_RULE: 'deleteRule'
		});
	});

	it('leaves a relationship column with no readable side alone', () => {
		expect(autoMapSqlImportColumns('relationships', ['SCHEMA', 'TABLE'])).to.eql({});
	});

	it('maps a tables statement', () => {
		let mapping = autoMapSqlImportColumns('tables', ['TABLE_SCHEMA', 'TABLE_NAME', 'LONG_NAME', 'TABLE_TEXT']);

		expect(mapping).to.eql({
			TABLE_SCHEMA: 'schema',
			TABLE_NAME: 'tableSystemName',
			LONG_NAME: 'tableSqlName',
			TABLE_TEXT: 'tableDescription'
		});
	});

	it('ignores case and separators', () => {
		expect(autoMapSqlImportColumns('tables', ['library', 'sysName'])).to.eql({library: 'schema', sysName: 'tableSystemName'});
	});

	it('maps a columns statement', () => {
		let mapping = autoMapSqlImportColumns('columns', ['SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE', 'LENGTH', 'SCALE', 'NULLS', 'IS_PK', 'DEFAULT_VALUE', 'ORDINAL_POSITION']);

		expect(mapping).to.eql({
			SCHEMA: 'schema',
			TABLE_NAME: 'tableSystemName',
			COLUMN_NAME: 'columnSystemName',
			DATA_TYPE: 'dataType',
			LENGTH: 'length',
			SCALE: 'scale',
			NULLS: 'nullable',
			IS_PK: 'primaryKey',
			DEFAULT_VALUE: 'defaultValue',
			ORDINAL_POSITION: 'columnPosition'
		});
	});

	it('gives a target to the first result column that claims it', () => {
		let mapping = autoMapSqlImportColumns('tables', ['NAME', 'TABLE_NAME']);

		expect(mapping).to.eql({NAME: 'tableSystemName'});
	});

	it('leaves an unrecognized column unmapped', () => {
		expect(autoMapSqlImportColumns('tables', ['APPDBRL_RCID'])).to.eql({});
	});

	it('never maps a target that belongs to another section', () => {
		let mapping = autoMapSqlImportColumns('tables', ['COLUMN_NAME', 'DATA_TYPE']);

		expect(mapping).to.eql({});
	});
});
