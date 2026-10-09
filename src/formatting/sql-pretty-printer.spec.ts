import { expect } from 'chai';
import { SqlPrettyPrinter } from './sql-pretty-printer.js';

// clauseLayout defaults to 'expanded' for this suite (the production default is 'compact', see
// Configurations.formattingClauseLayout) -- 'expanded' puts every clause on its own line, which
// makes the structural assertions below easier to read/verify. The dedicated 'clauseLayout'
// describe block below tests 'compact' (what actually ships) explicitly.
const options: SqlPrettyPrinter.Options = {
	tabWidth: 2,
	useTabs: false,
	keywordCase: 'upper',
	denseOperators: false,
	removeComments: false,
	expressionMaxWidth: 40,
	selectFieldWrapping: 'oneColumnPerLine',
	clauseLayout: 'expanded',
	indentJoins: false,
	indentWhere: false
};

// A fallback hands back the original text, which an assertion can mistake for a real format -- so
// any test that hits one fails outright instead.
function format(sql: string, overrides: Partial<SqlPrettyPrinter.Options> = {}): string {
	return SqlPrettyPrinter.format(sql, {...options, ...overrides}, {
		onFallback: error => {
			throw new Error(`formatting fell back to the original text: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}

describe('SqlPrettyPrinter', () => {
	it('formats a SELECT with WHERE (AND on its own line) and ORDER BY', () => {
		let result = format('select id, name from employees e where e.active = 1 and e.dept_id = 3 order by e.name');
		expect(result).to.equal(
			'SELECT\n' +
			'  id,\n' +
			'  name\n' +
			'FROM\n' +
			'  employees e\n' +
			'WHERE\n' +
			'  e.active = 1\n' +
			'  AND e.dept_id = 3\n' +
			'ORDER BY\n' +
			'  e.name'
		);
	});

	it('formats a JOIN...ON clause as its own segment', () => {
		let result = format('select e.id, d.name from employees e join departments d on e.dept_id = d.id where e.active = 1');
		expect(result).to.equal(
			'SELECT\n' +
			'  e.id,\n' +
			'  d.name\n' +
			'FROM\n' +
			'  employees e\n' +
			'JOIN\n' +
			'  departments d ON e.dept_id = d.id\n' +
			'WHERE\n' +
			'  e.active = 1'
		);
	});

	it('formats GROUP BY/HAVING', () => {
		let result = format('select dept_id, count(*) from employees group by dept_id having count(*) > 5');
		expect(result).to.equal(
			'SELECT\n' +
			'  dept_id,\n' +
			'  count(*)\n' +
			'FROM\n' +
			'  employees\n' +
			'GROUP BY\n' +
			'  dept_id\n' +
			'HAVING\n' +
			'  count(*) > 5'
		);
	});

	it('recurses into a derived table (subquery in FROM)', () => {
		let result = format('select x.id from (select id from employees where active = 1) x');
		expect(result).to.equal(
			'SELECT\n' +
			'  x.id\n' +
			'FROM\n' +
			'  (\n' +
			'    SELECT\n' +
			'      id\n' +
			'    FROM\n' +
			'      employees\n' +
			'    WHERE\n' +
			'      active = 1\n' +
			'  ) x'
		);
	});

	it('recurses into a scalar subquery inside a SELECT list item without splitting it', () => {
		let result = format('select (select max(x) from other) as m from employees');
		expect(result).to.equal(
			'SELECT\n' +
			'  (\n' +
			'    SELECT\n' +
			'      max(x)\n' +
			'    FROM\n' +
			'      other\n' +
			'  ) AS m\n' +
			'FROM\n' +
			'  employees'
		);
	});

	it('formats a CTE, preserving the CTE\'s own name casing (an identifier, not a keyword)', () => {
		let result = format('with recent as (select id, name from employees where active = 1) select id, name from recent order by name');
		expect(result).to.equal(
			'WITH\n' +
			'  recent AS (\n' +
			'    SELECT\n' +
			'      id,\n' +
			'      name\n' +
			'    FROM\n' +
			'      employees\n' +
			'    WHERE\n' +
			'      active = 1\n' +
			'  )\n' +
			'SELECT\n' +
			'  id,\n' +
			'  name\n' +
			'FROM\n' +
			'  recent\n' +
			'ORDER BY\n' +
			'  name'
		);
	});

	it('formats multiple CTEs in one WITH list', () => {
		let result = format('with a as (select id from t1), b as (select a.id from a) select b.id from b');
		expect(result).to.equal(
			'WITH\n' +
			'  a AS (\n' +
			'    SELECT\n' +
			'      id\n' +
			'    FROM\n' +
			'      t1\n' +
			'  ),\n' +
			'  b AS (\n' +
			'    SELECT\n' +
			'      a.id\n' +
			'    FROM\n' +
			'      a\n' +
			'  )\n' +
			'SELECT\n' +
			'  b.id\n' +
			'FROM\n' +
			'  b'
		);
	});

	it('glues a comment immediately after a CTE\'s closing paren to that same line instead of a fresh one', () => {
		let result = format('with data as (\n  select 1\n)-- note\nselect * from data');
		expect(result).to.equal(
			'WITH\n' +
			'  data AS (\n' +
			'    SELECT\n' +
			'      1\n' +
			'  ) -- note\n' +
			'SELECT\n' +
			'  *\n' +
			'FROM\n' +
			'  data'
		);
	});

	it('leaves a comment that was already on its own line below a CTE there, rather than pulling it up onto the closing paren', () => {
		let result = format('with data as (\n  select 1\n)\n-- note\nselect * from data');
		expect(result).to.equal(
			'WITH\n' +
			'  data AS (\n' +
			'    SELECT\n' +
			'      1\n' +
			'  )\n' +
			'-- note\n' +
			'SELECT\n' +
			'  *\n' +
			'FROM\n' +
			'  data'
		);
	});

	it('glues a comment immediately after a CTE\'s opening paren to that same line instead of the body\'s first line', () => {
		let result = format('with data as (-- note\n  select 1\n) select * from data');
		expect(result).to.equal(
			'WITH\n' +
			'  data AS ( -- note\n' +
			'    SELECT\n' +
			'      1\n' +
			'  )\n' +
			'SELECT\n' +
			'  *\n' +
			'FROM\n' +
			'  data'
		);
	});

	it('leaves a comment that was already on its own line as the first thing inside a CTE body there', () => {
		let result = format('with data as (\n  -- note\n  select 1\n) select * from data');
		expect(result).to.equal(
			'WITH\n' +
			'  data AS (\n' +
			'    -- note\n' +
			'    SELECT\n' +
			'      1\n' +
			'  )\n' +
			'SELECT\n' +
			'  *\n' +
			'FROM\n' +
			'  data'
		);
	});

	it('does not swallow a "," separating CTEs into a comment glued after the earlier one\'s closing paren', () => {
		let result = format('with a as (\n  select 1\n)-- note\n, b as (\n  select 2\n) select a.x from a, b');
		expect(result).to.equal(
			'WITH\n' +
			'  a AS (\n' +
			'    SELECT\n' +
			'      1\n' +
			'  ) -- note\n' +
			'  ,\n' +
			'  b AS (\n' +
			'    SELECT\n' +
			'      2\n' +
			'  )\n' +
			'SELECT\n' +
			'  a.x\n' +
			'FROM\n' +
			'  a,\n' +
			'  b'
		);
	});

	it('formats a UNION, resetting to a fresh clause sequence for the right-hand query', () => {
		let result = format('select id from a where x = 1 union select id from b where y = 2');
		expect(result).to.equal(
			'SELECT\n' +
			'  id\n' +
			'FROM\n' +
			'  a\n' +
			'WHERE\n' +
			'  x = 1\n' +
			'UNION\n' +
			'SELECT\n' +
			'  id\n' +
			'FROM\n' +
			'  b\n' +
			'WHERE\n' +
			'  y = 2'
		);
	});

	it('recognizes a DB2 "WITH UR" isolation clause as its own trailing clause, not a CTE', () => {
		let result = format('select id from employees where active = 1 with ur');
		expect(result).to.equal(
			'SELECT\n' +
			'  id\n' +
			'FROM\n' +
			'  employees\n' +
			'WHERE\n' +
			'  active = 1\n' +
			'WITH UR'
		);
	});

	it('formats old-style comma joins, each table on its own line', () => {
		let result = format('select e.id, d.name from employees e, departments d where e.dept_id = d.id');
		expect(result).to.equal(
			'SELECT\n' +
			'  e.id,\n' +
			'  d.name\n' +
			'FROM\n' +
			'  employees e,\n' +
			'  departments d\n' +
			'WHERE\n' +
			'  e.dept_id = d.id'
		);
	});

	describe('selectFieldWrapping', () => {
		it('oneColumnPerLine puts every column on its own line regardless of width', () => {
			let result = format('select id, name from t', {selectFieldWrapping: 'oneColumnPerLine'});
			expect(result).to.equal('SELECT\n  id,\n  name\nFROM\n  t');
		});

		it('wrapToWidth keeps columns on the same line, wrapping only past expressionMaxWidth', () => {
			let sql = 'select id, first_name, last_name, department_id, hire_date, salary, manager_id from employees';
			let result = format(sql, {selectFieldWrapping: 'wrapToWidth', expressionMaxWidth: 40});
			expect(result).to.equal(
				'SELECT\n' +
				'  id, first_name, last_name,\n' +
				'  department_id, hire_date, salary,\n' +
				'  manager_id\n' +
				'FROM\n' +
				'  employees'
			);
		});

		it('never splits a single item across lines even if it alone exceeds the width', () => {
			let result = format('select coalesce(a, b, c) as long_column_name_here from t', {selectFieldWrapping: 'wrapToWidth', expressionMaxWidth: 10});
			expect(result).to.equal('SELECT\n  coalesce(a, b, c) AS long_column_name_here\nFROM\n  t');
		});
	});

	describe('clauseLayout', () => {
		it('compact keeps a clause keyword on the same line as the start of its content', () => {
			let sql = 'select id, name from employees e join departments d on e.dept_id = d.id where e.active = 1 and e.dept_id = 3';
			let result = format(sql, {clauseLayout: 'compact'});
			expect(result).to.equal(
				'SELECT id,\n' +
				'  name\n' +
				'FROM employees e\n' +
				'JOIN departments d ON e.dept_id = d.id\n' +
				'WHERE e.active = 1\n' +
				'AND e.dept_id = 3'
			);
		});

		it('expanded always breaks after the clause keyword, even for a single short item', () => {
			expect(format('select id from t where id = 1', {clauseLayout: 'expanded'})).to.equal(
				'SELECT\n  id\nFROM\n  t\nWHERE\n  id = 1'
			);
		});

		it('compact still wraps once the keyword + content would exceed expressionMaxWidth', () => {
			let sql = 'select id, first_name, last_name, department_id, hire_date, salary from employees';
			let result = format(sql, {clauseLayout: 'compact', selectFieldWrapping: 'wrapToWidth', expressionMaxWidth: 30});
			expect(result).to.equal(
				'SELECT id, first_name,\n' +
				'  last_name, department_id,\n' +
				'  hire_date, salary\n' +
				'FROM employees'
			);
		});

		it('applies compact to the WITH...AS CTE header the same as any other clause', () => {
			let sql = 'with recent as (select id from employees) select id from recent';
			let result = format(sql, {clauseLayout: 'compact'});
			expect(result).to.equal(
				'WITH recent AS (\n' +
				'  SELECT id\n' +
				'  FROM employees\n' +
				')\n' +
				'SELECT id\n' +
				'FROM recent'
			);
		});

		// Under "compact", the CTE header line ("recent AS (") glues onto "WITH" itself and so
		// visually starts at indentLevel, not indentLevel+1 -- the body and closing paren need to
		// nest one level under *that* visual column, not under the header's own un-glued level (see
		// tryParseCteList's "openLevel"). "expanded" never glues the header, so it keeps its existing,
		// deeper nesting (covered by the CTE tests outside this describe block).
		it('nests a CTE body one level under the glued "WITH name AS (" line, not two', () => {
			let sql = 'with data as (select * from appuser) select * from data';
			let result = format(sql, {clauseLayout: 'compact'});
			expect(result).to.equal(
				'WITH data AS (\n' +
				'  SELECT *\n' +
				'  FROM appuser\n' +
				')\n' +
				'SELECT *\n' +
				'FROM data'
			);
		});

		it('never invents content for an empty clause (FOR UPDATE with nothing after it)', () => {
			expect(format('select id from t for update', {clauseLayout: 'compact'})).to.equal('SELECT id\nFROM t\nFOR UPDATE');
			expect(format('select id from t for update', {clauseLayout: 'expanded'})).to.equal('SELECT\n  id\nFROM\n  t\nFOR UPDATE');
		});
	});

	describe('keywordCase', () => {
		it('upper-cases recognized keywords, leaving identifiers untouched', () => {
			let result = format('select Id from Employees where Active = 1', {keywordCase: 'upper'});
			expect(result).to.equal('SELECT\n  Id\nFROM\n  Employees\nWHERE\n  Active = 1');
		});

		it('lower-cases recognized keywords', () => {
			let result = format('SELECT id FROM employees WHERE active = 1', {keywordCase: 'lower'});
			expect(result).to.equal('select\n  id\nfrom\n  employees\nwhere\n  active = 1');
		});

		it('preserve leaves keyword casing exactly as typed', () => {
			let result = format('select Id from Employees where Active = 1', {keywordCase: 'preserve'});
			expect(result).to.equal('select\n  Id\nfrom\n  Employees\nwhere\n  Active = 1');
		});

		it('never recases a scalar function name that happens to share a word with SQL vocabulary', () => {
			let result = format('select Count(*) from t', {keywordCase: 'upper'});
			expect(result).to.equal('SELECT\n  Count(*)\nFROM\n  t');
		});
	});

	describe('denseOperators', () => {
		it('removes spaces around infix operators but keeps them around AND/OR', () => {
			let result = format('select id from employees where id=1 and salary>=1000', {denseOperators: true});
			expect(result).to.equal('SELECT\n  id\nFROM\n  employees\nWHERE\n  id=1\n  AND salary>=1000');
		});

		it('does not densify a unary/prefix operator', () => {
			let result = format('select -5 from t', {denseOperators: true});
			expect(result).to.equal('SELECT\n  -5\nFROM\n  t');
		});
	});

	describe('indentJoins', () => {
		it('indents a JOIN one level deeper than FROM (expanded layout)', () => {
			let result = format('select e.id, d.name from employees e join departments d on e.dept_id = d.id where e.active = 1', {indentJoins: true});
			expect(result).to.equal(
				'SELECT\n' +
				'  e.id,\n' +
				'  d.name\n' +
				'FROM\n' +
				'  employees e\n' +
				'  JOIN\n' +
				'    departments d ON e.dept_id = d.id\n' +
				'WHERE\n' +
				'  e.active = 1'
			);
		});

		it('indents every JOIN variant (e.g. LEFT JOIN) the same as a plain JOIN', () => {
			let result = format('select * from t left join u on t.id = u.id', {indentJoins: true});
			expect(result).to.equal('SELECT\n  *\nFROM\n  t\n  LEFT JOIN\n    u ON t.id = u.id');
		});

		it('glues the JOIN header to its content one level deeper under compact layout', () => {
			let result = format('select * from table join otherTable', {
				indentJoins: true, clauseLayout: 'compact', useTabs: true, keywordCase: 'preserve'
			});
			expect(result).to.equal('select *\nfrom table\n\tjoin otherTable');
		});

		it('leaves JOIN at the same level as FROM when disabled', () => {
			let result = format('select * from t join u on t.id = u.id', {indentJoins: false});
			expect(result).to.equal('SELECT\n  *\nFROM\n  t\nJOIN\n  u ON t.id = u.id');
		});
	});

	describe('indentWhere', () => {
		it('lines AND/OR up with the WHERE line under compact layout when disabled', () => {
			let result = format('select * from e where e.status = \'ACTIVE\' and e.hireDate > \'2020-01-01\' or e.id = 1', {
				clauseLayout: 'compact', useTabs: true, keywordCase: 'preserve'
			});
			expect(result).to.equal('select *\nfrom e\nwhere e.status = \'ACTIVE\'\nand e.hireDate > \'2020-01-01\'\nor e.id = 1');
		});

		it('indents AND/OR one level under compact layout when enabled', () => {
			let result = format('select * from e where e.status = \'ACTIVE\' and e.hireDate > \'2020-01-01\'', {
				clauseLayout: 'compact', useTabs: true, keywordCase: 'preserve', indentWhere: true
			});
			expect(result).to.equal('select *\nfrom e\nwhere e.status = \'ACTIVE\'\n\tand e.hireDate > \'2020-01-01\'');
		});

		it('lines AND/OR up with the first condition under expanded layout when disabled', () => {
			expect(format('select * from t where a = 1 and b = 2')).to.equal('SELECT\n  *\nFROM\n  t\nWHERE\n  a = 1\n  AND b = 2');
		});

		it('indents AND/OR one level past the first condition under expanded layout when enabled', () => {
			expect(format('select * from t where a = 1 and b = 2', {indentWhere: true})).to.equal('SELECT\n  *\nFROM\n  t\nWHERE\n  a = 1\n    AND b = 2');
		});

		it('applies to HAVING the same way', () => {
			let result = format('select a from t group by a having count(*) > 1 and max(b) < 5', {clauseLayout: 'compact', keywordCase: 'preserve'});
			expect(result).to.equal('select a\nfrom t\ngroup by a\nhaving count(*) > 1\nand max(b) < 5');
		});

		it('nests a subquery under an AND line relative to that line', () => {
			let result = format('select * from t where a = 1 and b in (select b from u)', {clauseLayout: 'compact', keywordCase: 'preserve'});
			expect(result).to.equal('select *\nfrom t\nwhere a = 1\nand b in (\n  select b\n  from u\n)');
		});
	});

	describe('width budget', () => {
		it('counts a tab indent as tabWidth columns, not one character', () => {
			let result = format('select aaaa, bbbb from t', {useTabs: true, tabWidth: 4, selectFieldWrapping: 'wrapToWidth', expressionMaxWidth: 12});
			expect(result).to.equal('SELECT\n\taaaa,\n\tbbbb\nFROM\n\tt');
		});

		it('does not count the content indent a compact clause line no longer has', () => {
			let result = format('select aaaa, bbbb from t', {clauseLayout: 'compact', selectFieldWrapping: 'wrapToWidth', expressionMaxWidth: 17});
			expect(result).to.equal('SELECT aaaa, bbbb\nFROM t');
		});
	});

	describe('keywordCase preserve', () => {
		it('keeps the case of WITH, RECURSIVE and AS as written', () => {
			let result = format('with recursive r as (select 1 from t) select * from r', {clauseLayout: 'compact', keywordCase: 'preserve'});
			expect(result).to.match(/^with recursive r as \(/);
		});

		it('keeps the case of UNION as written', () => {
			let result = format('select a from t union all select a from u', {clauseLayout: 'compact', keywordCase: 'preserve'});
			expect(result).to.equal('select a\nfrom t\nunion all\nselect a\nfrom u');
		});
	});

	it('keeps trailing spaces inside a multi-line string literal', () => {
		let result = format('select \'line one  \nline two\' from t', {clauseLayout: 'compact'});
		expect(result).to.equal('SELECT \'line one  \nline two\'\nFROM t');
	});

	it('keeps the spaces around a dense operator next to a "?" marker, since "=?" would lex as one operator', () => {
		expect(format('select id from t where id = ? and x = 1', {clauseLayout: 'compact', denseOperators: true})).to.equal('SELECT id\nFROM t\nWHERE id = ?\nAND x=1');
	});

	describe('semicolon spacing', () => {
		it('preserves no gap at all between the last token and ";"', () => {
			expect(format('select id from t;')).to.equal('SELECT\n  id\nFROM\n  t;');
		});

		it('preserves a single space between the last token and ";"', () => {
			expect(format('select id from t ;')).to.equal('SELECT\n  id\nFROM\n  t ;');
		});

		it('preserves the semicolon already being on its own line', () => {
			expect(format('select id from t\n;')).to.equal('SELECT\n  id\nFROM\n  t\n;');
		});

		it('preserves original indentation before a semicolon already on its own line', () => {
			expect(format('select id from t\n\t;')).to.equal('SELECT\n  id\nFROM\n  t\n\t;');
		});

		it('never invents a semicolon that was not in the original', () => {
			expect(format('select id from t')).to.equal('SELECT\n  id\nFROM\n  t');
		});
	});

	describe('parameter markers', () => {
		it('glues a named parameter marker tightly to its name', () => {
			expect(format('select id from employees where id = :custId')).to.equal('SELECT\n  id\nFROM\n  employees\nWHERE\n  id = :custId');
		});

		it('leaves a positional "?" marker alone', () => {
			expect(format('select id from employees where id = ?')).to.equal('SELECT\n  id\nFROM\n  employees\nWHERE\n  id = ?');
		});
	});

	describe('comments', () => {
		it('preserves a line comment and never lets a trailing comma/keyword be swallowed into it', () => {
			let result = format('select id -- trailing note\nfrom employees');
			expect(result).to.include('-- trailing note');
			expect(result).to.match(/FROM\n {2}employees$/);
			// The line comment's forced break must land before "FROM" -- it must never share the
			// comment's own physical line (which would comment it out if the SQL were run again).
			expect(result).to.not.match(/-- trailing note[^\n]*FROM/);
		});

		it('leaves a block comment untouched inline', () => {
			expect(format('select id /* inline note */ from t')).to.equal('SELECT\n  id /* inline note */\nFROM\n  t');
		});

		it('never leaves trailing whitespace on any line', () => {
			let result = format('select id -- trailing note\nfrom employees');
			expect(result.split('\n').some(line => /[ \t]$/.test(line))).to.equal(false);
		});

		it('does not add a blank line before ";" when the statement ends with a line comment', () => {
			let result = format('select *\nfrom appuser --test\n;');
			expect(result).to.equal('SELECT\n  *\nFROM\n  appuser --test\n;');
		});

		it('still preserves extra blank lines the user had between a trailing line comment and ";"', () => {
			let result = format('select *\nfrom appuser --test\n\n\n;');
			expect(result).to.equal('SELECT\n  *\nFROM\n  appuser --test\n\n\n;');
		});

		it('leaves the gap before ";" alone when the statement ends with a block comment, not a line comment', () => {
			let result = format('select *\nfrom appuser /*test*/\n;');
			expect(result).to.equal('SELECT\n  *\nFROM\n  appuser /*test*/\n;');
		});

		it('does not add a blank line before ";" after a trailing line comment on a CRLF source, even an empty one', () => {
			let result = format('select *\r\nfrom appuser --\r\n;');
			expect(result).to.equal('SELECT\n  *\nFROM\n  appuser --\n;');
		});

		it('does not leave a blank line before FROM when a trailing comment sits on the last SELECT column', () => {
			let result = format('select rcid, email -- trailing note\nfrom appuser');
			expect(result).to.equal('SELECT\n  rcid,\n  email -- trailing note\nFROM\n  appuser');
		});

		it('does not knock the last SELECT column onto its own line just because a trailing comment follows it', () => {
			let result = format(
				'select rcid, rcdsts, usrtype, fnam, lnam, mnam, prfnam, email -- trailing note\nfrom appuser',
				{selectFieldWrapping: 'wrapToWidth', expressionMaxWidth: 80}
			);
			expect(result).to.equal('SELECT\n  rcid, rcdsts, usrtype, fnam, lnam, mnam, prfnam, email -- trailing note\nFROM\n  appuser');
		});

		it('moves the comma after a commented SELECT column to lead the next column, rather than leaving it alone on a line', () => {
			let sql = 'select column1 --comment1\n\t, column2 --comment1\nfrom table';
			let result = format(sql, {clauseLayout: 'compact', keywordCase: 'preserve', useTabs: true});
			expect(result).to.equal(sql);
		});

		it('leads with the comma after a commented column in the expanded layout too', () => {
			let result = format('select a --one\n, b --two\n, c\nfrom t');
			expect(result).to.equal('SELECT\n  a --one\n  , b --two\n  , c\nFROM\n  t');
		});

		it('keeps packing columns after a leading comma under wrapToWidth', () => {
			let result = format('select a --one\n, b, c, d\nfrom t', {selectFieldWrapping: 'wrapToWidth'});
			expect(result).to.equal('SELECT\n  a --one\n  , b, c, d\nFROM\n  t');
		});

		describe('placement (compact, tabs, case preserved)', () => {
			let formatCompact = (sql: string) => format(sql, {clauseLayout: 'compact', keywordCase: 'preserve', useTabs: true, selectFieldWrapping: 'wrapToWidth', expressionMaxWidth: 80});

			it('keeps a comment after a trailing comma on that comma\'s line', () => {
				let sql = 'select column1, --comment1\n\tcolumn2 --comment2\nfrom table';
				expect(formatCompact(sql)).to.equal(sql);
			});

			it('keeps a comment on its own line above the clause it precedes', () => {
				expect(formatCompact('select id\n-- note\nfrom t')).to.equal('select id\n-- note\nfrom t');
			});

			it('keeps a comment on its own line above an AND', () => {
				let sql = 'select a\nfrom t\nwhere a = 1\n-- before and\nand b = 2';
				expect(formatCompact(sql)).to.equal(sql);
			});

			it('keeps a leading statement comment above the statement', () => {
				expect(formatCompact('-- header comment\nselect a from t')).to.equal('-- header comment\nselect a\nfrom t');
			});

			it('starts the clause content on its own line when the keyword ends in a line comment', () => {
				let sql = 'select -- columns\n\ta, b\nfrom t';
				expect(formatCompact(sql)).to.equal(sql);
			});

			it('puts a comment before a subquery\'s closing paren at the paren\'s indent', () => {
				let result = formatCompact('select x from (\n\tselect x from t\n\t-- end of inner\n) d');
				expect(result).to.equal('select x\nfrom (\n\t\tselect x\n\t\tfrom t\n\t-- end of inner\n\t) d');
			});

			it('still recognizes a subquery whose opening paren carries a comment', () => {
				let result = formatCompact('select x from ( -- derived\n\tselect x from t\n) d');
				expect(result).to.equal('select x\nfrom ( -- derived\n\t\tselect x\n\t\tfrom t\n\t) d');
			});

			it('lines a CTE body up under its name when WITH ends in a line comment', () => {
				let result = formatCompact('with -- ctes\ndata as (select 1 from t) select * from data');
				expect(result).to.equal('with -- ctes\n\tdata as (\n\t\tselect 1\n\t\tfrom t\n\t)\nselect *\nfrom data');
			});

			it('keeps a comment after ";" on the semicolon\'s line', () => {
				expect(formatCompact('select a from t; -- after')).to.equal('select a\nfrom t; -- after');
			});

			it('keeps a comment inside a function call\'s argument list', () => {
				expect(formatCompact('select coalesce(a, -- first choice\n\tb) from t')).to.equal('select coalesce(a, -- first choice\n\tb)\nfrom t');
			});

			it('never drops a comma, even a stray one before FROM', () => {
				expect(formatCompact('select a, from t')).to.equal('select a,\nfrom t');
			});
		});
	});

	describe('removeComments', () => {
		it('strips a trailing line comment entirely, rather than just moving it', () => {
			let result = format('select id -- trailing note\nfrom employees', {removeComments: true});
			expect(result).to.equal('SELECT\n  id\nFROM\n  employees');
		});

		it('strips an inline block comment', () => {
			let result = format('select id /* inline note */ from t', {removeComments: true});
			expect(result).to.equal('SELECT\n  id\nFROM\n  t');
		});

		it('strips a comment that sits on its own line', () => {
			let result = format('select id\n-- note\nfrom t', {removeComments: true});
			expect(result).to.equal('SELECT\n  id\nFROM\n  t');
		});

		it('strips a "--" comment that originated from a host-language "//" comment via EmbeddedSqlExtractor', () => {
			// EmbeddedSqlExtractor normalizes a host "//" comment into a DB2 "--" comment before this
			// ever reaches the tokenizer -- by the time formatTokens runs there is no way to tell it
			// apart from a comment the user wrote directly in SQL, which is exactly why removeComments
			// only needs to strip LINE_COMMENT/BLOCK_COMMENT tokens once, here, to cover both.
			let result = format('select id --note\nfrom t', {removeComments: true});
			expect(result).to.equal('SELECT\n  id\nFROM\n  t');
		});

		it('never leaves trailing whitespace on any line once comments are gone', () => {
			let result = format('select id -- trailing note\nfrom employees', {removeComments: true});
			expect(result.split('\n').some(line => /[ \t]$/.test(line))).to.equal(false);
		});

		it('drops a comment-only trailing line before ";" instead of leaving a dangling comment', () => {
			let result = format('select *\nfrom appuser --test\n;', {removeComments: true});
			expect(result).to.equal('SELECT\n  *\nFROM\n  appuser\n;');
		});
	});

	describe('fault tolerance', () => {
		it('never throws on deliberately malformed SQL', () => {
			expect(() => format('select id from a join b where a.id = 1')).to.not.throw();
			expect(() => format('select id from employees where (a = 1 and b = 2 group by dept_id')).to.not.throw();
			expect(() => format('select from from where (((')).to.not.throw();
		});

		it('still structures the parts it can recognize around a dangling JOIN', () => {
			let result = format('select id from a join b where a.id = 1');
			expect(result).to.equal('SELECT\n  id\nFROM\n  a\nJOIN\n  b\nWHERE\n  a.id = 1');
		});

		it('degrades to inline content instead of losing text when a paren never balances', () => {
			let result = format('select id from employees where (a = 1 and b = 2 group by dept_id');
			expect(result).to.include('a = 1');
			expect(result).to.include('group by dept_id');
		});

		it('handles an empty statement', () => {
			expect(format('')).to.equal('');
		});
	});

	it('formats INSERT/VALUES', () => {
		// "employees(id, name)" (no space) is a known token-level ambiguity: a WORD immediately
		// followed by "(" is treated as a function call, since nothing at the tokenizer/printer
		// level distinguishes a table name from a scalar function name -- see class comment.
		expect(format(`insert into employees (id, name) values (1, 'a')`)).to.equal(`INSERT INTO\n  employees(id, name)\nVALUES\n  (1, 'a')`);
	});

	it('formats UPDATE/SET/WHERE', () => {
		expect(format(`update employees set active = 0 where id = 1`)).to.equal('UPDATE\n  employees\nSET\n  active = 0\nWHERE\n  id = 1');
	});

	it('formats DELETE FROM/WHERE', () => {
		expect(format('delete from employees where id = 1')).to.equal('DELETE FROM\n  employees\nWHERE\n  id = 1');
	});
});
