import { expect } from 'chai';
import { isYes, parseBasedOnFiles, toSourceMember } from './logical-file-detail.js';

describe('logical-file-detail', () => {
	describe('parseBasedOnFiles()', () => {
		// SYSFILES.BASED_ON as a live system returned it.
		it('reads every based-on file, member and format', () => {
			let value = '{"BASED_ON_FILES":[{"LIBRARY":"SALESLIB","FILE":"JOBHDR","MEMBER":"JOBHDR","LF_FORMAT":"JOBLIN"},{"LIBRARY":"SALESLIB","FILE":"CUSTHDR","MEMBER":"CUSTHDR","LF_FORMAT":"CUSTREC"}]}';

			expect(parseBasedOnFiles(value)).to.deep.equal([
				{library: 'SALESLIB', file: 'JOBHDR', member: 'JOBHDR', format: 'JOBLIN'},
				{library: 'SALESLIB', file: 'CUSTHDR', member: 'CUSTHDR', format: 'CUSTREC'}
			]);
		});

		it('trims padded values and leaves a blank member or format out', () => {
			expect(parseBasedOnFiles('{"BASED_ON_FILES":[{"LIBRARY":"SALESLIB  ","FILE":" JOBHDR","MEMBER":"","LF_FORMAT":"  "}]}')).to.deep.equal([
				{library: 'SALESLIB', file: 'JOBHDR', member: undefined, format: undefined}
			]);
		});

		it('skips an entry with no library or file', () => {
			expect(parseBasedOnFiles('{"BASED_ON_FILES":[{"FILE":"JOBHDR"},{"LIBRARY":"SALESLIB","FILE":"JOBHDR"}]}')).to.deep.equal([
				{library: 'SALESLIB', file: 'JOBHDR', member: undefined, format: undefined}
			]);
		});

		it('gives no files for null, blank, malformed or unexpected JSON', () => {
			for(let value of [null, undefined, '', '   ', '{not json', '[]', '{"BASED_ON_FILES":"SALESLIB/JOBHDR"}', '{}', 42]) {
				expect(parseBasedOnFiles(value), String(value)).to.deep.equal([]);
			}
		});
	});

	describe('isYes()', () => {
		it('is true only for YES, in any case and padding', () => {
			expect([isYes('YES'), isYes(' yes '), isYes('NO'), isYes(''), isYes(null), isYes(1)]).to.deep.equal([true, true, false, false, false, false]);
		});
	});

	describe('toSourceMember()', () => {
		it('names the member when library, file and member are all recorded', () => {
			expect(toSourceMember('DEVSRC ', 'DDSSRC', 'JOBHDRL1')).to.deep.equal({library: 'DEVSRC', file: 'DDSSRC', member: 'JOBHDRL1'});
		});

		it('is undefined when any part is missing', () => {
			expect(toSourceMember('', 'DDSSRC', 'JOBHDRL1')).to.be.undefined;
			expect(toSourceMember('DEVSRC', null, 'JOBHDRL1')).to.be.undefined;
			expect(toSourceMember('DEVSRC', 'DDSSRC', undefined)).to.be.undefined;
		});
	});
});
