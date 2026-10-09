import { expect } from 'chai';
import { buildSqlImportStatement, findDuplicateResultColumn } from './sql-import-statement.js';

describe('buildSqlImportStatement', () => {
	it('returns the statement untouched when there is nothing to add', () => {
		expect(buildSqlImportStatement('select * from appdbrl')).to.equal('select * from appdbrl');
	});

	it('strips a trailing semicolon', () => {
		expect(buildSqlImportStatement('select * from appdbrl ;')).to.equal('select * from appdbrl');
	});

	it('wraps the statement and filters on schema and table', () => {
		let statement = buildSqlImportStatement('select schema1, name1 from appdbrl', {
			filter: {schemaColumn: 'SCHEMA1', tableColumn: 'NAME1', tables: [{schema: 'ACME', table: 'APPUSER'}]}
		});

		expect(statement).to.equal([
			'select * from (select schema1, name1 from appdbrl) SRC',
			'where (SRC."SCHEMA1" = \'ACME\' and SRC."NAME1" = \'APPUSER\')'
		].join('\n'));
	});

	it('batches multiple tables into one OR chain', () => {
		let statement = buildSqlImportStatement('select * from appdbrl', {
			filter: {
				schemaColumn: 'SCHEMA1',
				tableColumn: 'NAME1',
				tables: [{schema: 'ACME', table: 'APPUSER'}, {schema: 'ACME', table: 'APPUSJB'}]
			}
		});

		expect(statement).to.contain('(SRC."SCHEMA1" = \'ACME\' and SRC."NAME1" = \'APPUSER\')\n   or (SRC."SCHEMA1" = \'ACME\' and SRC."NAME1" = \'APPUSJB\')');
	});

	it('escapes quotes in values and column names', () => {
		let statement = buildSqlImportStatement('select * from t', {
			filter: {schemaColumn: 'my"col', tableColumn: 'NAME1', tables: [{schema: 'O\'ACME', table: 'T'}]}
		});

		expect(statement).to.contain('SRC."my""col" = \'O\'\'ACME\'');
	});

	it('applies a row limit without a filter', () => {
		expect(buildSqlImportStatement('select * from appdbrl', {rowLimit: 500})).to.equal([
			'select * from (select * from appdbrl) SRC',
			'fetch first 500 rows only'
		].join('\n'));
	});

	it('lifts a trailing ORDER BY onto the wrapper', () => {
		let statement = buildSqlImportStatement('select a, b from t order by a, b', {rowLimit: 10});

		expect(statement).to.equal([
			'select * from (select a, b from t) SRC',
			'order by a, b',
			'fetch first 10 rows only'
		].join('\n'));
	});

	it('lifts the ORDER BY above the filter so the wrapper is valid', () => {
		let statement = buildSqlImportStatement('select s, n from t order by 1', {
			filter: {schemaColumn: 'S', tableColumn: 'N', tables: [{schema: 'ACME', table: 'T1'}]}
		});

		expect(statement).to.equal([
			'select * from (select s, n from t) SRC',
			'where (SRC."S" = \'ACME\' and SRC."N" = \'T1\')',
			'order by 1'
		].join('\n'));
	});

	it('leaves a window function ORDER BY inside the derived table', () => {
		let statement = buildSqlImportStatement('select row_number() over (order by a) as rn, a from t', {rowLimit: 5});

		expect(statement).to.contain('(select row_number() over (order by a) as rn, a from t) SRC');
		expect(statement).to.not.contain('SRC\norder by');
	});

	it('leaves a subquery ORDER BY alone and lifts only the statement\'s own', () => {
		let statement = buildSqlImportStatement('select * from (select a from t order by a) x order by a desc', {rowLimit: 5});

		expect(statement).to.contain('(select * from (select a from t order by a) x) SRC');
		expect(statement).to.contain('\norder by a desc\n');
	});

	it('hoists a leading common table expression in front of the wrapper', () => {
		let sql = [
			'with tables as (',
			'\tselect schema1 as schema, name1 as name from appdbrl',
			'\tunion',
			'\tselect schema2 as schema, name2 as name from appdbrl',
			')',
			'select distinct schema, name from tables'
		].join('\n');

		let statement = buildSqlImportStatement(sql, {rowLimit: 50001});

		expect(statement).to.equal([
			'with tables as (',
			'\tselect schema1 as schema, name1 as name from appdbrl',
			'\tunion',
			'\tselect schema2 as schema, name2 as name from appdbrl',
			')',
			'select * from (select distinct schema, name from tables) SRC',
			'fetch first 50001 rows only'
		].join('\n'));
	});

	it('hoists a multi-expression WITH clause and still filters', () => {
		let sql = 'with a as (select 1 as x from t), b (y) as (select x from a) select s, n from b';
		let statement = buildSqlImportStatement(sql, {
			filter: {schemaColumn: 'S', tableColumn: 'N', tables: [{schema: 'ACME', table: 'T1'}]}
		});

		expect(statement).to.equal([
			'with a as (select 1 as x from t), b (y) as (select x from a)',
			'select * from (select s, n from b) SRC',
			'where (SRC."S" = \'ACME\' and SRC."N" = \'T1\')'
		].join('\n'));
	});

	it('lifts a trailing ORDER BY out of a hoisted WITH statement', () => {
		let statement = buildSqlImportStatement('with a as (select x from t order by x) select x from a order by 1', {rowLimit: 10});

		expect(statement).to.equal([
			'with a as (select x from t order by x)',
			'select * from (select x from a) SRC',
			'order by 1',
			'fetch first 10 rows only'
		].join('\n'));
	});

	it('caps an unparseable WITH statement without wrapping it', () => {
		let statement = buildSqlImportStatement('with a as select x from t', {rowLimit: 10});

		expect(statement).to.equal('with a as select x from t\nfetch first 10 rows only');
	});

	it('does not add a second cap to a statement that already has one', () => {
		let statement = buildSqlImportStatement('with a as select x from t fetch first 5 rows only', {rowLimit: 10});

		expect(statement).to.equal('with a as select x from t fetch first 5 rows only');
	});

	it('ignores ORDER BY text inside a literal', () => {
		let statement = buildSqlImportStatement('select \'order by x\' as note from t', {rowLimit: 5});

		expect(statement).to.contain('(select \'order by x\' as note from t) SRC');
	});
});

describe('findDuplicateResultColumn', () => {
	it('returns undefined when every name is distinct', () => {
		expect(findDuplicateResultColumn(['SCHEMA1', 'NAME1', 'COLNAME1'])).to.be.undefined;
	});

	it('compares case-insensitively', () => {
		expect(findDuplicateResultColumn(['name', 'NAME'])).to.equal('NAME');
	});
});
