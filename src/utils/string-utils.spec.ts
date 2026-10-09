import { expect } from 'chai';
import { StringUtils } from './string-utils.js';

describe('StringUtils', () => {
	it('isBlank treats absent, empty and whitespace-only values as blank', () => {
		expect([undefined, null, '', '  \t\n'].map(value => StringUtils.isBlank(value))).to.deep.equal([true, true, true, true]);
		expect(StringUtils.isBlank(' a ')).to.equal(false);
		expect(StringUtils.isNotBlank(' a ')).to.equal(true);
	});

	it('equalsIgnoreCase matches two absent values, never one', () => {
		expect(StringUtils.equalsIgnoreCase('Abc', 'aBC')).to.equal(true);
		expect(StringUtils.equalsIgnoreCase(undefined, null)).to.equal(true);
		expect(StringUtils.equalsIgnoreCase('abc', undefined)).to.equal(false);
		expect(StringUtils.equalsIgnoreCase('abc', 'abd')).to.equal(false);
	});

	it('beginsWithIgnoreCase', () => {
		expect(StringUtils.beginsWithIgnoreCase('QSYS2.SYSTABLES', 'qsys2.')).to.equal(true);
		expect(StringUtils.beginsWithIgnoreCase('QSYS2', 'x')).to.equal(false);
		expect(StringUtils.beginsWithIgnoreCase(undefined, 'x')).to.equal(false);
	});

	it('default trims a present value and falls back for a blank one', () => {
		expect(StringUtils.default('  a  ', () => 'b')).to.equal('a');
		expect(StringUtils.default('   ', () => 'b')).to.equal('b');
		expect(StringUtils.default(undefined, () => 'b')).to.equal('b');
	});

	it('trim collapses inner whitespace or turns blank into undefined only when asked', () => {
		expect(StringUtils.trim('  a   b  ')).to.equal('a   b');
		expect(StringUtils.trim('  a \t  b  ', {removeDuplicateWhiteSpace: true})).to.equal('a b');
		expect(StringUtils.trim('   ')).to.equal('');
		expect(StringUtils.trim('   ', {toUndefined: true})).to.equal(undefined);
		expect(StringUtils.trim(undefined)).to.equal(undefined);
	});

	it('getPlural', () => {
		expect([0, 1, 2, -1, -2].map(count => StringUtils.getPlural(count))).to.deep.equal(['s', '', 's', '', 's']);
		expect(StringUtils.getPlural(3, 'ies', 'y')).to.equal('ies');
	});
});
