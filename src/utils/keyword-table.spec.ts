import { expect } from 'chai';
import { KeywordTable } from './keyword-table.js';

function words(text: string): {text: string}[] {
	return text.split(/\s+/).map(word => ({text: word}));
}

describe('KeywordTable', () => {
	describe('matchKeywordPhrase', () => {
		it('prefers the longest matching phrase over a shorter prefix', () => {
			let tokens = words('LEFT OUTER JOIN t');
			expect(KeywordTable.matchKeywordPhrase(tokens, 0, KeywordTable.CLAUSE_STARTER_PHRASES)).to.equal(3);
		});

		it('falls back to a shorter phrase when the longer one does not match', () => {
			let tokens = words('LEFT JOIN t');
			expect(KeywordTable.matchKeywordPhrase(tokens, 0, KeywordTable.CLAUSE_STARTER_PHRASES)).to.equal(2);
		});

		it('is case-insensitive', () => {
			let tokens = words('group by x');
			expect(KeywordTable.matchKeywordPhrase(tokens, 0, KeywordTable.CLAUSE_STARTER_PHRASES)).to.equal(2);
		});

		it('returns 0 when nothing in the phrase list matches', () => {
			let tokens = words('employees e');
			expect(KeywordTable.matchKeywordPhrase(tokens, 0, KeywordTable.CLAUSE_STARTER_PHRASES)).to.equal(0);
		});

		it('does not match past the end of the token array', () => {
			let tokens = words('t LEFT');
			expect(KeywordTable.matchKeywordPhrase(tokens, 1, KeywordTable.CLAUSE_STARTER_PHRASES)).to.equal(0);
		});
	});

	describe('isWithCte', () => {
		it('treats a bare "WITH <isolation word>" as an isolation clause, not a CTE', () => {
			let tokens = words('WITH UR');
			expect(KeywordTable.isWithCte(tokens, 0)).to.equal(false);
		});

		it('treats "WITH <isolation word> AS" as a CTE (a CTE literally named that word)', () => {
			let tokens = words('WITH ur AS');
			expect(KeywordTable.isWithCte(tokens, 0)).to.equal(true);
		});

		it('treats an ordinary "WITH name AS" as a CTE', () => {
			let tokens = words('WITH data AS');
			expect(KeywordTable.isWithCte(tokens, 0)).to.equal(true);
		});

		it('treats "WITH" with nothing after it as a CTE (degrade gracefully, not an isolation clause)', () => {
			let tokens = words('WITH');
			expect(KeywordTable.isWithCte(tokens, 0)).to.equal(true);
		});
	});
});
