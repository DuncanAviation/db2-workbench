import { expect } from 'chai';
import { ArrayUtils } from './array-utils.js';

describe('ArrayUtils', () => {
	it('toArray wraps a single value, keeps an array and empties an absent value', () => {
		let array = [1, 2];
		expect(ArrayUtils.toArray(array)).to.equal(array);
		expect(ArrayUtils.toArray(3)).to.deep.equal([3]);
		expect(ArrayUtils.toArray<number>(undefined)).to.deep.equal([]);
		expect(ArrayUtils.toArray<number>(null)).to.deep.equal([]);
	});

	it('toMapOfArrays groups in order, optionally mapping each value', () => {
		let rows = [{schema: 'A', name: 't1'}, {schema: 'B', name: 't2'}, {schema: 'A', name: 't3'}];
		expect([...ArrayUtils.toMapOfArrays(rows, row => row.schema, row => row.name)]).to.deep.equal([['A', ['t1', 't3']], ['B', ['t2']]]);
		expect(ArrayUtils.toMapOfArrays(rows, row => row.schema).get('B')).to.deep.equal([rows[1]]);
	});

	it('removeIf removes matches in place and returns them', () => {
		let array = [1, 2, 3, 4, 5];
		expect(ArrayUtils.removeIf(array, value => value % 2 === 0)).to.deep.equal([2, 4]);
		expect(array).to.deep.equal([1, 3, 5]);
	});
});
