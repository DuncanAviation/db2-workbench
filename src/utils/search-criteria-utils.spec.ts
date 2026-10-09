import { expect } from 'chai';
import { SearchCriteriaUtils } from './search-criteria-utils.js';

/**
 * The WHERE clause body behind the Data tab's Edit Search dialog. It goes straight into the
 * statement DataQueries.listTableData runs, so a wrong clause here is a query that quietly reads the
 * wrong rows rather than one that fails.
 *
 * The operator lists are tested alongside it because they are the only thing stopping the dialog
 * offering an operator that cannot work on the column - a LIKE against a DATE is a runtime error the
 * user would only meet after filling the dialog in.
 */
describe('SearchCriteriaUtils', () => {
	function criterion(overrides: Partial<SearchCriteriaUtils.SearchCriterion>): SearchCriteriaUtils.SearchCriterion {
		return { systemName: 'CUSTNM', dataType: 'VARCHAR', operator: '=', value: '', values: [], ...overrides };
	}

	describe('buildWhereClause', () => {
		it('ANDs the conditions together, quoting each column and typing each value', () => {
			let clause = SearchCriteriaUtils.buildWhereClause([
				criterion({ systemName: 'CUSTNO', dataType: 'INTEGER', operator: '>=', value: '2' }),
				criterion({ systemName: 'CUSTNM', operator: '=', value: 'Example Air' })
			]);

			expect(clause).to.equal('"CUSTNO" >= 2 and "CUSTNM" = \'Example Air\'');
		});

		// Same risk as a row edit's values: the search term is free text, and an apostrophe in it must
		// not end the literal early.
		it('doubles a quote inside a search value', () => {
			expect(SearchCriteriaUtils.buildWhereClause([criterion({ operator: '=', value: 'O\'Brien' })])).to.equal('"CUSTNM" = \'O\'\'Brien\'');
		});

		it('turns LIKE into a contains match around the term', () => {
			expect(SearchCriteriaUtils.buildWhereClause([criterion({ operator: 'LIKE', value: 'Air' })])).to.equal('"CUSTNM" LIKE \'%Air%\'');
		});

		it('writes IS NULL and IS NOT NULL without a value', () => {
			expect(SearchCriteriaUtils.buildWhereClause([criterion({ operator: 'IS NULL' })])).to.equal('"CUSTNM" IS NULL');
			expect(SearchCriteriaUtils.buildWhereClause([criterion({ operator: 'IS NOT NULL' })])).to.equal('"CUSTNM" IS NOT NULL');
		});

		it('builds an IN list from its own values, ignoring blank entries', () => {
			let clause = SearchCriteriaUtils.buildWhereClause([criterion({ systemName: 'CUSTNO', dataType: 'INTEGER', operator: 'IN', values: ['1', ' ', '2'] })]);
			expect(clause).to.equal('"CUSTNO" IN (1, 2)');
		});

		// A half-filled row in the dialog is normal while the user is still typing. Skipping it keeps
		// the generated clause valid instead of producing "CUSTNM = " and failing on the database.
		it('skips a condition with no value rather than emitting invalid SQL', () => {
			expect(SearchCriteriaUtils.buildWhereClause([criterion({ operator: '=', value: '   ' })])).to.equal('');
			expect(SearchCriteriaUtils.buildWhereClause([criterion({ operator: 'IN', values: [] })])).to.equal('');

			let mixed = SearchCriteriaUtils.buildWhereClause([criterion({ operator: '=', value: '' }), criterion({ systemName: 'ACTIVE', dataType: 'CHAR', operator: '=', value: 'Y' })]);
			expect(mixed).to.equal('"ACTIVE" = \'Y\'');
		});
	});

	describe('getAvailableOperators', () => {
		it('offers LIKE on character data only', () => {
			expect(SearchCriteriaUtils.getAvailableOperators('VARCHAR')).to.include('LIKE');
			expect(SearchCriteriaUtils.getAvailableOperators('INTEGER')).to.not.include('LIKE');
			expect(SearchCriteriaUtils.getAvailableOperators('DATE')).to.not.include('LIKE');
		});

		it('drops the ordering and list operators for a boolean column', () => {
			expect(SearchCriteriaUtils.getAvailableOperators('BOOLEAN')).to.deep.equal(['=', '<>', 'IS NULL', 'IS NOT NULL']);
		});

		// An unrecognized type is treated as character rather than guessed at, so no valid operator is
		// hidden from the user.
		it('falls back to the full list for an unknown or missing type', () => {
			expect(SearchCriteriaUtils.getAvailableOperators('SOMETHINGNEW')).to.include('LIKE');
			expect(SearchCriteriaUtils.getAvailableOperators(undefined)).to.include('LIKE');
		});
	});

	describe('getTypeCategory', () => {
		it('groups the types the dialog has to tell apart when a condition changes column', () => {
			expect(SearchCriteriaUtils.getTypeCategory('BOOLEAN')).to.equal('boolean');
			expect(SearchCriteriaUtils.getTypeCategory('DECIMAL')).to.equal('numeric-or-date');
			expect(SearchCriteriaUtils.getTypeCategory('TIMESTMP')).to.equal('numeric-or-date');
			expect(SearchCriteriaUtils.getTypeCategory('CHAR')).to.equal('character');
			expect(SearchCriteriaUtils.getTypeCategory(undefined)).to.equal('character');
		});
	});
});
