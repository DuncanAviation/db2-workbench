import { expect } from 'chai';
import { SpParser } from './sp-parser.js';

function parameters(statement: string) {
	return SpParser.parse(statement)?.parameters;
}

describe('SpParser', () => {
	describe('parameters', () => {
		it('keeps an unquoted NULL in its position', () => {
			expect(parameters(`call MYPROC('A', null, 1, NULL)`)).to.deep.equal(['A', null, 1, null]);
		});

		it('keeps a trailing NULL', () => {
			expect(parameters(`call MYPROC('A', null)`)).to.deep.equal(['A', null]);
		});

		it('treats a quoted value as a string even when it reads as a number or null', () => {
			expect(parameters(`call MYPROC('0', '12.5', 'null', 7)`)).to.deep.equal(['0', '12.5', 'null', 7]);
		});

		it('keeps empty quoted strings and escaped quotes', () => {
			expect(parameters(`call MYPROC('', 'it''s', '')`)).to.deep.equal(['', 'it\'s', '']);
		});

		it('returns no parameters for an empty list', () => {
			expect(parameters('call MYPROC()')).to.deep.equal([]);
		});
	});
});
