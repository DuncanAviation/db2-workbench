import { expect } from 'chai';
import { IndexKeyUtils } from './index-key-utils.js';

// The COLUMN_NAMES values below were returned by a live system.
describe('IndexKeyUtils', () => {
	describe('parseKeyColumns()', () => {
		it('keeps key order, which is not alphabetical', () => {
			expect(IndexKeyUtils.parseKeyColumns('JOBTYPE, JOBSTAT, JOBPRTY, BILLDT, JOBDEPT, JOBNO').map(key => key.name))
				.to.deep.equal(['JOBTYPE', 'JOBSTAT', 'JOBPRTY', 'BILLDT', 'JOBDEPT', 'JOBNO']);
		});

		it('numbers the keys from 1 and reads a trailing DESC as descending', () => {
			expect(IndexKeyUtils.parseKeyColumns('OPENDT DESC, JOBPRTY, CUSTNO')).to.deep.equal([
				{position: 1, name: 'OPENDT', descending: true},
				{position: 2, name: 'JOBPRTY', descending: false},
				{position: 3, name: 'CUSTNO', descending: false}
			]);
		});

		it('reads a column named DESC as a column, and only a word after it as a direction', () => {
			expect(IndexKeyUtils.parseKeyColumns('DESC, JOBSTAT, JOBPRTY, DONEDT')[0]).to.deep.equal({position: 1, name: 'DESC', descending: false});
			expect(IndexKeyUtils.parseKeyColumns('DESC DESC')).to.deep.equal([{position: 1, name: 'DESC', descending: true}]);
			expect(IndexKeyUtils.parseKeyColumns('JOBHIST, JOBMODL, DEPT, JOBSTAT, DSC').map(key => key.name)).to.deep.equal(['JOBHIST', 'JOBMODL', 'DEPT', 'JOBSTAT', 'DSC']);
		});

		it('treats ASC as a direction too, in any case', () => {
			expect(IndexKeyUtils.parseKeyColumns('A asc, B desc')).to.deep.equal([
				{position: 1, name: 'A', descending: false},
				{position: 2, name: 'B', descending: true}
			]);
		});

		it('keeps an expression key whole, commas and all', () => {
			expect(IndexKeyUtils.parseKeyColumns('CHAR ( SUBSTR ( JOBNO , 1 , 4 ) , 5 ), JOBSTAT DESC')).to.deep.equal([
				{position: 1, name: 'CHAR ( SUBSTR ( JOBNO , 1 , 4 ) , 5 )', descending: false},
				{position: 2, name: 'JOBSTAT', descending: true}
			]);
		});

		it('keeps a quoted name with a comma in it whole', () => {
			expect(IndexKeyUtils.parseKeyColumns('"A,B" DESC, C').map(key => key.name)).to.deep.equal(['"A,B"', 'C']);
		});

		it('gives no keys for a blank or absent value', () => {
			for(let value of [undefined, null, '', '  ', ' , ']) {
				expect(IndexKeyUtils.parseKeyColumns(value), String(value)).to.deep.equal([]);
			}
		});
	});

	describe('label()', () => {
		it('labels keys the way the green screen does', () => {
			expect(IndexKeyUtils.label({position: 1, descending: false})).to.equal('K01');
			expect(IndexKeyUtils.label({position: 12, descending: true})).to.equal('K12 D');
			expect(IndexKeyUtils.label({position: 120, descending: false})).to.equal('K120');
		});
	});
});
