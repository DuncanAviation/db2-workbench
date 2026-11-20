import { expect } from 'chai';
import { isYes, parseBasedOnFiles, toSourceMember } from './logical-file-detail.js';

describe('logical-file-detail', () => {
	describe('parseBasedOnFiles()', () => {
		// SYSFILES.BASED_ON as a live system returned it.
		it('reads every based-on file, member and format', () => {
			let value = '{"BASED_ON_FILES":[{"LIBRARY":"DUND","FILE":"WOPMAS","MEMBER":"WOPMAS","LF_FORMAT":"WORMAS"},{"LIBRARY":"DUND","FILE":"CUSMAS","MEMBER":"CUSMAS","LF_FORMAT":"CUSREC"}]}';

			expect(parseBasedOnFiles(value)).to.deep.equal([
				{library: 'DUND', file: 'WOPMAS', member: 'WOPMAS', format: 'WORMAS'},
				{library: 'DUND', file: 'CUSMAS', member: 'CUSMAS', format: 'CUSREC'}
			]);
		});

		it('trims padded values and leaves a blank member or format out', () => {
			expect(parseBasedOnFiles('{"BASED_ON_FILES":[{"LIBRARY":"DUND  ","FILE":" WOPMAS","MEMBER":"","LF_FORMAT":"  "}]}')).to.deep.equal([
				{library: 'DUND', file: 'WOPMAS', member: undefined, format: undefined}
			]);
		});

		it('skips an entry with no library or file', () => {
			expect(parseBasedOnFiles('{"BASED_ON_FILES":[{"FILE":"WOPMAS"},{"LIBRARY":"DUND","FILE":"WOPMAS"}]}')).to.deep.equal([
				{library: 'DUND', file: 'WOPMAS', member: undefined, format: undefined}
			]);
		});

		it('gives no files for null, blank, malformed or unexpected JSON', () => {
			for(let value of [null, undefined, '', '   ', '{not json', '[]', '{"BASED_ON_FILES":"DUND/WOPMAS"}', '{}', 42]) {
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
			expect(toSourceMember('OWDEV ', 'WOSOURCE', 'WOLMAS1')).to.deep.equal({library: 'OWDEV', file: 'WOSOURCE', member: 'WOLMAS1'});
		});

		it('is undefined when any part is missing', () => {
			expect(toSourceMember('', 'WOSOURCE', 'WOLMAS1')).to.be.undefined;
			expect(toSourceMember('OWDEV', null, 'WOLMAS1')).to.be.undefined;
			expect(toSourceMember('OWDEV', 'WOSOURCE', undefined)).to.be.undefined;
		});
	});
});
