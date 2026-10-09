import { expect } from 'chai';
import { CteAssist } from './cte-assist.js';

describe('CteAssist', () => {
	describe('getCteColumns', () => {
		it('returns an empty map when there is no CTE at all', () => {
			let columns = CteAssist.getCteColumns('select id from employees');
			expect(columns.size).to.equal(0);
		});

		it('resolves a simple CTE\'s explicitly-named columns', () => {
			let sql = 'with emp_cte as (select id, name, dept_id from employees) select emp_cte.id from emp_cte';
			let columns = CteAssist.getCteColumns(sql);
			expect(columns.get('emp_cte')).to.deep.equal({
				literalColumns: [
					{name: 'id', sourceTable: 'employees', sourceColumn: 'id'},
					{name: 'name', sourceTable: 'employees', sourceColumn: 'name'},
					{name: 'dept_id', sourceTable: 'employees', sourceColumn: 'dept_id'}
				],
				wildcardTables: []
			});
		});

		it('is case-insensitive for both the CTE name and its lookup key', () => {
			let sql = 'WITH Emp_Cte AS (SELECT id FROM employees) SELECT EMP_CTE.id FROM EMP_CTE';
			let columns = CteAssist.getCteColumns(sql);
			expect(columns.get('emp_cte')).to.deep.equal({literalColumns: [{name: 'id', sourceTable: 'employees', sourceColumn: 'id'}], wildcardTables: []});
		});

		it('resolves every CTE in a multi-CTE WITH clause independently', () => {
			let sql = 'with a as (select id from t1), b as (select name from t2) select a.id, b.name from a, b';
			let columns = CteAssist.getCteColumns(sql);
			expect(columns.get('a')).to.deep.equal({literalColumns: [{name: 'id', sourceTable: 't1', sourceColumn: 'id'}], wildcardTables: []});
			expect(columns.get('b')).to.deep.equal({literalColumns: [{name: 'name', sourceTable: 't2', sourceColumn: 'name'}], wildcardTables: []});
		});

		it('resolves a CTE from its own declaration alone, even with no outer reference to it anywhere', () => {
			// Pairing is by declaration position (the Nth queryResult = the Nth declared CTE), not
			// by finding the CTE's own reference and working backward -- so this doesn't need "FROM
			// data" to exist anywhere in the text. Callers should still always pass the FULL
			// statement (parseResults.originalSql), never the cursor-truncated prefix, though: the
			// CTE's outer reference is what SqlParser's flat regex needs to produce a TableReference
			// for it in the first place, even though CteAssist itself no longer needs it.
			let sql = 'with data as (select id from employees) select ';
			let columns = CteAssist.getCteColumns(sql);
			expect(columns.get('data')).to.deep.equal({literalColumns: [{name: 'id', sourceTable: 'employees', sourceColumn: 'id'}], wildcardTables: []});
		});

		describe('column aliasing', () => {
			it('exposes the alias, not the source column, when one is given', () => {
				let sql = 'with data as (select t.a as x, t.b as y from mytable t) select data.x from data';
				let columns = CteAssist.getCteColumns(sql);
				expect(columns.get('data')?.literalColumns).to.deep.equal([
					{name: 'x', sourceTable: 'mytable', sourceColumn: 'a'},
					{name: 'y', sourceTable: 'mytable', sourceColumn: 'b'}
				]);
			});

			it('strips the qualifier from a plain qualified reference with no alias', () => {
				let sql = 'with data as (select t.id from mytable t) select data.id from data';
				let columns = CteAssist.getCteColumns(sql);
				expect(columns.get('data')?.literalColumns).to.deep.equal([{name: 'id', sourceTable: 'mytable', sourceColumn: 'id'}]);
			});

			it('skips an unaliased expression/function-call column -- it has no name the outer query could reference', () => {
				let sql = 'with data as (select upper(name), id from t) select data.id from data';
				let columns = CteAssist.getCteColumns(sql);
				expect(columns.get('data')?.literalColumns).to.deep.equal([{name: 'id', sourceTable: 't', sourceColumn: 'id'}]);
			});

			it('uses the alias of an aliased expression/function-call column, with no source to resolve metadata from', () => {
				let sql = 'with data as (select upper(name) as upper_name, id from t) select data.id from data';
				let columns = CteAssist.getCteColumns(sql);
				expect(columns.get('data')?.literalColumns).to.deep.equal([
					{name: 'upper_name'},
					{name: 'id', sourceTable: 't', sourceColumn: 'id'}
				]);
			});
		});

		describe('RECURSIVE and explicit column-rename lists', () => {
			it('resolves a RECURSIVE CTE the same as a non-recursive one', () => {
				let sql = 'with recursive data as (select id from t) select data.id from data';
				let columns = CteAssist.getCteColumns(sql);
				expect(columns.get('data')).to.deep.equal({literalColumns: [{name: 'id', sourceTable: 't', sourceColumn: 'id'}], wildcardTables: []});
			});

			it('uses an explicit column-rename list over the inner SELECT list\'s own names, with no source to resolve metadata from', () => {
				let sql = 'with data (col1, col2) as (select a, b from t) select data.col1 from data';
				let columns = CteAssist.getCteColumns(sql);
				expect(columns.get('data')?.literalColumns).to.deep.equal([{name: 'col1'}, {name: 'col2'}]);
			});

			it('handles RECURSIVE combined with an explicit column-rename list', () => {
				let sql = 'with recursive data (a, b) as (select x, y from t) select data.a from data';
				let columns = CteAssist.getCteColumns(sql);
				expect(columns.get('data')?.literalColumns).to.deep.equal([{name: 'a'}, {name: 'b'}]);
			});

			it('handles a second CTE (after the first, comma-separated) having its own column-rename list', () => {
				let sql = 'with a as (select id from t1), b (x, y) as (select p, q from t2) select b.x from a, b';
				let columns = CteAssist.getCteColumns(sql);
				expect(columns.get('a')?.literalColumns).to.deep.equal([{name: 'id', sourceTable: 't1', sourceColumn: 'id'}]);
				expect(columns.get('b')?.literalColumns).to.deep.equal([{name: 'x'}, {name: 'y'}]);
			});
		});

		describe('wildcard ("*") passthrough', () => {
			it('resolves a bare "*" over a single source table', () => {
				let sql = 'with data as (select * from appuser limit 1000) select * from data';
				let columns = CteAssist.getCteColumns(sql);
				expect(columns.get('data')).to.deep.equal({literalColumns: [], wildcardTables: ['appuser']});
			});

			it('resolves a bare "*" over every table in a multi-table join', () => {
				let sql = 'with data as (select * from appuser g join other o on g.id = o.id) select * from data';
				let columns = CteAssist.getCteColumns(sql);
				expect(columns.get('data')?.wildcardTables).to.have.members(['appuser', 'other']);
			});

			it('narrows "alias.*" to just the one matching table in a join', () => {
				let sql = 'with data as (select g.* from appuser g join other o on g.id = o.id) select * from data';
				let columns = CteAssist.getCteColumns(sql);
				expect(columns.get('data')?.wildcardTables).to.deep.equal(['appuser']);
			});

			it('mixes explicitly-named columns with a wildcarded table', () => {
				let sql = 'with data as (select id, * from appuser) select * from data';
				let columns = CteAssist.getCteColumns(sql);
				expect(columns.get('data')).to.deep.equal({literalColumns: [{name: 'id', sourceTable: 'appuser', sourceColumn: 'id'}], wildcardTables: ['appuser']});
			});

			it('does not resolve the wildcard\'s target directly for a CTE-of-a-CTE chain (that is SqlAssist\'s job, via recursion)', () => {
				// getCteColumns operates one level at a time; cascading a wildcard through a chain
				// of CTEs is SqlAssist.getColumnItems' responsibility (it recurses), not this
				// method's. This test documents that boundary.
				let sql = 'with data as (select * from appuser), data2 as (select * from data) select * from data2';
				let columns = CteAssist.getCteColumns(sql);
				expect(columns.get('data')?.wildcardTables).to.deep.equal(['appuser']);
				expect(columns.get('data2')?.wildcardTables).to.deep.equal(['data']);
			});
		});

		describe('interplay with Db2SyntaxShim', () => {
			it('still resolves correctly when the statement has a trailing WITH UR clause', () => {
				let sql = 'with data as (select id from employees) select data.id from data with ur';
				let columns = CteAssist.getCteColumns(sql);
				expect(columns.get('data')).to.deep.equal({literalColumns: [{name: 'id', sourceTable: 'employees', sourceColumn: 'id'}], wildcardTables: []});
			});

			it('resolves a CTE literally named "ur" without the shim mistaking it for the isolation clause', () => {
				let sql = 'with ur as (select id from t) select ur.id from ur';
				let columns = CteAssist.getCteColumns(sql);
				expect(columns.get('ur')).to.deep.equal({literalColumns: [{name: 'id', sourceTable: 't', sourceColumn: 'id'}], wildcardTables: []});
			});
		});

		it('does not throw on malformed SQL, and resolves whatever it still can', () => {
			// dt-sql-parser logs a syntax error to stderr for the garbage tail -- expected noise,
			// not a test failure; the point of this test is that nothing throws and the CTE
			// (unaffected by the later garbage) still resolves.
			let sql = 'with data as (select id from employees) select data.id from data, from garbage(((';
			expect(() => CteAssist.getCteColumns(sql)).to.not.throw();
			expect(CteAssist.getCteColumns(sql).get('data')).to.deep.equal({literalColumns: [{name: 'id', sourceTable: 'employees', sourceColumn: 'id'}], wildcardTables: []});
		});
	});

	describe('getVirtualTableColumns', () => {
		it('returns an empty map when there is no CTE or derived table at all', () => {
			let columns = CteAssist.getVirtualTableColumns('select id from employees');
			expect(columns.size).to.equal(0);
		});

		it('resolves a simple derived table\'s explicitly-named columns', () => {
			let sql = 'select id from employees e join (select dept_id, dept_name from departments) d on e.dept_id = d.dept_id';
			let columns = CteAssist.getVirtualTableColumns(sql);
			expect(columns.get('d')).to.deep.equal({
				literalColumns: [
					{name: 'dept_id', sourceTable: 'departments', sourceColumn: 'dept_id'},
					{name: 'dept_name', sourceTable: 'departments', sourceColumn: 'dept_name'}
				],
				wildcardTables: []
			});
		});

		it('resolves a wildcard passthrough inside a derived table', () => {
			let sql = 'select id from employees e join (select * from departments) d on e.dept_id = d.dept_id';
			let columns = CteAssist.getVirtualTableColumns(sql);
			expect(columns.get('d')).to.deep.equal({literalColumns: [], wildcardTables: ['departments']});
		});

		it('resolves an AS-aliased derived table the same as a bare-alias one', () => {
			let sql = 'select id from employees e join (select dept_id from departments) as d on e.dept_id = d.dept_id';
			let columns = CteAssist.getVirtualTableColumns(sql);
			expect(columns.get('d')?.literalColumns).to.deep.equal([{name: 'dept_id', sourceTable: 'departments', sourceColumn: 'dept_id'}]);
		});

		it('resolves a derived table alone in the FROM clause (no join at all)', () => {
			let sql = 'select id from (select dept_id, dept_name from departments) d';
			let columns = CteAssist.getVirtualTableColumns(sql);
			expect(columns.get('d')).to.deep.equal({
				literalColumns: [
					{name: 'dept_id', sourceTable: 'departments', sourceColumn: 'dept_id'},
					{name: 'dept_name', sourceTable: 'departments', sourceColumn: 'dept_name'}
				],
				wildcardTables: []
			});
		});

		it('resolves each derived table independently when two are joined together', () => {
			// The risky case: without its own re-parse per derived table, this shape (no queryResult
			// between the two outer table entities) is exactly what broke the equivalent CTE case.
			let sql = 'select id from (select a from t1) x join (select b from t2) y on x.a = y.b';
			let columns = CteAssist.getVirtualTableColumns(sql);
			expect(columns.get('x')).to.deep.equal({literalColumns: [{name: 'a', sourceTable: 't1', sourceColumn: 'a'}], wildcardTables: []});
			expect(columns.get('y')).to.deep.equal({literalColumns: [{name: 'b', sourceTable: 't2', sourceColumn: 'b'}], wildcardTables: []});
		});

		it('resolves a nested derived table (subquery inside subquery)', () => {
			let sql = 'select id from (select a from (select b as a from t2) inner_sub) x';
			let columns = CteAssist.getVirtualTableColumns(sql);
			// x's own FROM is the derived table "inner_sub" itself, not a real table -- its sibling
			// table entity's own text is the raw "(select b as a from t2)" it was matched from (see
			// getDerivedTableColumns), not a usable table name, so this is a known, accepted gap:
			// resolveCteLiteralColumnHeading harmlessly finds no columns for that "table" and falls
			// back to no heading, same as any other unresolvable source.
			expect(columns.get('x')?.literalColumns).to.deep.equal([{name: 'a', sourceTable: '(select b as a from t2)', sourceColumn: 'a'}]);
			expect(columns.get('inner_sub')?.literalColumns).to.deep.equal([{name: 'a', sourceTable: 't2', sourceColumn: 'b'}]);
		});

		it('resolves column aliasing inside a derived table\'s own SELECT list', () => {
			let sql = 'select id from (select dept_id as did, dept_name as dname from departments) d';
			let columns = CteAssist.getVirtualTableColumns(sql);
			expect(columns.get('d')?.literalColumns).to.deep.equal([
				{name: 'did', sourceTable: 'departments', sourceColumn: 'dept_id'},
				{name: 'dname', sourceTable: 'departments', sourceColumn: 'dept_name'}
			]);
		});

		it('resolves a real CTE and a derived table together without misattributing columns between them', () => {
			let sql = 'with c as (select id from t3) select id from c join (select a from t1) x on c.id = x.a';
			let columns = CteAssist.getVirtualTableColumns(sql);
			expect(columns.get('c')).to.deep.equal({literalColumns: [{name: 'id', sourceTable: 't3', sourceColumn: 'id'}], wildcardTables: []});
			expect(columns.get('x')).to.deep.equal({literalColumns: [{name: 'a', sourceTable: 't1', sourceColumn: 'a'}], wildcardTables: []});
		});

		it('does not throw on malformed SQL, and resolves whatever it still can', () => {
			let sql = 'select id from (select a from t1) x join garbage(((';
			expect(() => CteAssist.getVirtualTableColumns(sql)).to.not.throw();
		});
	});

	describe('getInaccessibleTableNames', () => {
		function caretAtEndOf(sqlUpToCursor: string) {
			let lines = sqlUpToCursor.split('\n');
			return {lineNumber: lines.length, column: lines[lines.length - 1].length + 1};
		}

		it('flags a table used only inside a CTE\'s own body as inaccessible at the outer cursor', () => {
			let sqlUpToCursor = 'with data as (\nselect fnam\nfrom appuser\nlimit 1000\n)\n\nselect ';
			let fullSql = sqlUpToCursor + 'from data';
			let inaccessible = CteAssist.getInaccessibleTableNames(fullSql, caretAtEndOf(sqlUpToCursor));
			expect(Array.from(inaccessible)).to.deep.equal([CteAssist.getTableKey('appuser')]);
		});

		it('does not flag an aliased outer occurrence as inaccessible just because an unaliased reference to the same table name is used inside a CTE\'s body', () => {
			let sqlUpToCursor = 'with data as (select id from appuser) select ';
			let fullSql = sqlUpToCursor + 'from data join appuser g2 on data.id = g2.id';
			let inaccessible = CteAssist.getInaccessibleTableNames(fullSql, caretAtEndOf(sqlUpToCursor));
			expect(inaccessible.has(CteAssist.getTableKey('appuser', 'g2'))).to.equal(false);
			// The unaliased, CTE-internal occurrence is a *different* occurrence (no alias, vs. "g2")
			// and is correctly still blocked -- the aliased one being accessible must not rescue it.
			expect(inaccessible.has(CteAssist.getTableKey('appuser'))).to.equal(true);
		});

		it('flags nothing for a plain query with no CTEs at all (fail-open safety)', () => {
			let sqlUpToCursor = 'select ';
			let fullSql = sqlUpToCursor + 'from employees e join departments d on e.dept_id = d.id';
			let inaccessible = CteAssist.getInaccessibleTableNames(fullSql, caretAtEndOf(sqlUpToCursor));
			expect(inaccessible.size).to.equal(0);
		});

		it('flags only the deeper-nested table when the cursor is at the outermost scope of a CTE chain', () => {
			let sqlUpToCursor = 'with a as (select id from t1), b as (select a.id from a) select b.';
			let fullSql = sqlUpToCursor + ' from b';
			let inaccessible = CteAssist.getInaccessibleTableNames(fullSql, caretAtEndOf(sqlUpToCursor));
			expect(inaccessible.has(CteAssist.getTableKey('t1'))).to.equal(true);
			expect(inaccessible.has(CteAssist.getTableKey('a'))).to.equal(true);
			expect(inaccessible.has(CteAssist.getTableKey('b'))).to.equal(false);
		});

		it('does not throw on malformed SQL, and returns an empty (fail-open) set', () => {
			let sqlUpToCursor = 'with data as (select id, from employees) select ';
			let fullSql = sqlUpToCursor + 'from data, from garbage(((';
			expect(() => CteAssist.getInaccessibleTableNames(fullSql, caretAtEndOf(sqlUpToCursor))).to.not.throw();
		});

		it('does not flag a joined table\'s alias as inaccessible just because the join has no ON clause yet', () => {
			// Regression: a bare "JOIN table alias" with no ON/USING is genuinely invalid SQL on its
			// own (real SQL requires one, same as dt-sql-parser) -- but it's also exactly what the
			// statement looks like while the user is still typing the join, which used to fail the
			// WHOLE parse and, worse, leave a same-named table used elsewhere (e.g. inside another
			// CTE's body) with no accessible occurrence left to override its inaccessible one.
			let sqlUpToCursor = 'with data as (\nselect fnam\nfrom appuser\nlimit 1000\n),\n\ndata2 as (\n\tselect *\n\tfrom apphost\n)\n\nselect ';
			let fullSql = sqlUpToCursor + 'from data\njoin apphost b';
			let inaccessible = CteAssist.getInaccessibleTableNames(fullSql, caretAtEndOf(sqlUpToCursor));
			expect(inaccessible.has(CteAssist.getTableKey('apphost', 'b'))).to.equal(false);
			expect(inaccessible.has(CteAssist.getTableKey('appuser'))).to.equal(true);
		});

		it('is unaffected by a caretPosition that overshoots fullSql\'s own last column, e.g. from untyped trailing whitespace', () => {
			// Regression: fullSql (parseResults.originalSql) is trimmed on both ends by
			// StatementParser.parse, but callers' caretPosition is computed against the raw,
			// untrimmed document text -- typing "order by " (nothing after the trailing space, at
			// the very end of the statement) desyncs the two by exactly that trailing space,
			// pointing the caret one column past fullSql's real end. Without clamping, dt-sql-parser
			// responded to that out-of-range position by marking "employees" inaccessible, wiping
			// out every ORDER BY column completion until another character was typed.
			let fullSql = 'select id, name\nfrom employees\norder by';
			let overshootCaretPosition = {lineNumber: 3, column: 10}; // real last line is only 8 chars ("order by")
			let inaccessible = CteAssist.getInaccessibleTableNames(fullSql, overshootCaretPosition);
			expect(inaccessible.has(CteAssist.getTableKey('employees'))).to.equal(false);
		});

		it('does not let an unrelated, unused CTE\'s own unaliased table leak in just because an outer JOIN happens to alias the same table name', () => {
			// Regression: this used to be keyed by bare table name alone, so data2's own unaliased
			// "apphost" (never actually referenced anywhere outside its own CTE body) was wrongly
			// treated as accessible, purely because the OUTER "join apphost b" alias existed --
			// letting data2's unrelated table silently leak into the outer scope's results.
			let sqlUpToCursor = 'with data as (\nselect fnam\nfrom appuser\nlimit 1000\n),\n\ndata2 as (\n\tselect *\n\tfrom apphost\n)\n\nselect ';
			let fullSql = sqlUpToCursor + 'from data\njoin apphost b';
			let inaccessible = CteAssist.getInaccessibleTableNames(fullSql, caretAtEndOf(sqlUpToCursor));
			expect(inaccessible.has(CteAssist.getTableKey('apphost'))).to.equal(true);
			expect(inaccessible.has(CteAssist.getTableKey('apphost', 'b'))).to.equal(false);
		});
	});
});
