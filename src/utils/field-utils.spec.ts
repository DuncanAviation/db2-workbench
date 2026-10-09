import { expect } from 'chai';
import { FieldUtils } from './field-utils.js';

describe('FieldUtils', () => {
	// The Data tab right-trims a fetched value only when its trailing blanks can be nothing but DB2's
	// padding. A VARCHAR's trailing blanks are data, and "VARCHAR" contains "CHAR", so the match is exact.
	describe('isFixedLengthCharacterType', () => {
		it('is true only for the blank-padded fixed-length types', () => {
			expect(['CHAR', 'char', 'CHARACTER', 'GRAPHIC', 'NCHAR'].map(type => FieldUtils.isFixedLengthCharacterType(type))).to.deep.equal([true, true, true, true, true]);
			expect(['VARCHAR', 'VARG', 'VARGRAPHIC', 'CLOB', 'BINARY', 'DECIMAL', undefined].map(type => FieldUtils.isFixedLengthCharacterType(type))).to.deep.equal([false, false, false, false, false, false, false]);
		});
	});
});
