import { expect } from 'chai';
import { IndexAdviceUtils } from './index-advice-utils.js';

describe('IndexAdviceUtils', () => {
	describe('parseKeyColumns', () => {
		it('splits a comma-separated column list and trims whitespace', () => {
			expect(IndexAdviceUtils.parseKeyColumns('COL1, COL2,  COL3')).to.deep.equal(['COL1', 'COL2', 'COL3']);
		});

		it('returns a single-element array for one column', () => {
			expect(IndexAdviceUtils.parseKeyColumns('COL1')).to.deep.equal(['COL1']);
		});

		it('returns an empty array for a blank value', () => {
			expect(IndexAdviceUtils.parseKeyColumns('')).to.deep.equal([]);
		});
	});

	describe('buildCreateIndexSql', () => {
		it('builds a CREATE INDEX statement with a generated name', () => {
			let sql = IndexAdviceUtils.buildCreateIndexSql({schema: 'MYSCHEMA', table: 'EMPLOYEES', keyColumnsAdvised: 'DEPT_ID, LAST_NAME'});
			expect(sql).to.equal('CREATE INDEX MYSCHEMA.IDXADV_EMPLOYEES_DEPT_ID_LAST_NAME ON MYSCHEMA.EMPLOYEES (DEPT_ID, LAST_NAME)');
		});

		it('handles a single advised column', () => {
			let sql = IndexAdviceUtils.buildCreateIndexSql({schema: 'MYSCHEMA', table: 'ORDERS', keyColumnsAdvised: 'CUSTOMER_ID'});
			expect(sql).to.equal('CREATE INDEX MYSCHEMA.IDXADV_ORDERS_CUSTOMER_ID ON MYSCHEMA.ORDERS (CUSTOMER_ID)');
		});

		it('sanitizes non-alphanumeric characters out of the generated index name', () => {
			let sql = IndexAdviceUtils.buildCreateIndexSql({schema: 'MYSCHEMA', table: 'ORDER-LINES', keyColumnsAdvised: 'ORDER#ID'});
			expect(sql).to.include('CREATE INDEX MYSCHEMA.IDXADV_ORDERLINES_ORDERID ON');
		});

		it('truncates a generated index name that would otherwise exceed the max length', () => {
			let longColumn = 'A'.repeat(150);
			let sql = IndexAdviceUtils.buildCreateIndexSql({schema: 'MYSCHEMA', table: 'T', keyColumnsAdvised: longColumn});
			let indexName = sql.match(/CREATE INDEX MYSCHEMA\.(\w+) ON/)?.[1];
			expect(indexName?.length).to.equal(128);
		});
	});
});
