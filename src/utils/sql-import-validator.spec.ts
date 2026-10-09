import { expect } from 'chai';
import { SqlImportValidator } from './sql-import-validator.js';

function reason(sql: string): string | undefined {
	return SqlImportValidator.check(sql)?.reason;
}

describe('SqlImportValidator.check', () => {
	it('accepts a plain SELECT', () => {
		expect(reason('select schema1, name1 from appdbrl')).to.be.undefined;
	});

	it('accepts a common table expression', () => {
		expect(reason('with source as (select * from appdbrl) select * from source')).to.be.undefined;
	});

	it('accepts a trailing semicolon', () => {
		expect(reason('select * from appdbrl;')).to.be.undefined;
	});

	it('rejects an empty statement', () => {
		expect(reason('   \n-- nothing here\n')).to.equal('The statement is empty.');
	});

	it('rejects a statement that does not start with SELECT or WITH', () => {
		expect(reason('values 1')).to.equal('An import statement must start with SELECT or WITH.');
	});

	it('rejects a second statement', () => {
		expect(reason('select * from appdbrl; delete from appdbrl')).to.contain('single statement');
	});

	it('rejects data change keywords', () => {
		expect(reason('select * from t where x in (select y from z) and flag = 1')).to.be.undefined;
		expect(reason('select a from t union all select b from t2 where c = 1 and delete_flag = 0')).to.be.undefined;
		expect(reason('select * from t; drop table t')).to.contain('single statement');
		expect(reason('with x as (select 1 from t) select * from x')).to.be.undefined;
	});

	it('rejects a data change statement hidden in a FROM clause', () => {
		expect(reason('select * from new table (update t set x = 1)')).to.contain('FINAL/NEW/OLD TABLE');
		expect(reason('select * from final table (insert into x values(1))')).to.contain('FINAL/NEW/OLD TABLE');
	});

	it('ignores keywords inside string literals', () => {
		expect(reason('select \'delete from everything\' as note from t')).to.be.undefined;
	});

	it('ignores keywords inside delimited identifiers', () => {
		expect(reason('select "DROP" from t')).to.be.undefined;
	});

	it('ignores keywords inside comments', () => {
		expect(reason('select x -- delete this later\nfrom t')).to.be.undefined;
		expect(reason('select x /* update later */ from t')).to.be.undefined;
	});

	it('ignores a semicolon inside a literal', () => {
		expect(reason('select \';\' as separator from t')).to.be.undefined;
	});

	it('does not treat OFFSET as SET', () => {
		expect(reason('select x from t order by x offset 10 rows')).to.be.undefined;
	});
});

describe('SqlImportValidator.mask', () => {
	it('keeps the text the same length so offsets still line up', () => {
		let sql = 'select \'abc\' /* note */ from t -- trailing\n';
		expect(SqlImportValidator.mask(sql)).to.have.lengthOf(sql.length);
	});

	it('keeps the quotes around a masked literal', () => {
		expect(SqlImportValidator.mask('select \'abc\' from t')).to.equal('select \'   \' from t');
	});

	it('treats a doubled quote as an escape, not the end of the literal', () => {
		expect(SqlImportValidator.mask('select \'O\'\'Brien; drop\' from t')).to.equal('select \'              \' from t');
	});

	it('masks an unterminated literal to the end of the text', () => {
		expect(SqlImportValidator.mask('select \'abc')).to.equal('select \'   ');
	});
});
