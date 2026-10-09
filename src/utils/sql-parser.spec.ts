import { expect } from 'chai';
import { SqlParser } from './sql-parser.js';

describe('SqlParser', () => {
	describe('findRoutineCallAt', () => {
		// The offset of the first character of `word` in `sql`, plus `into` characters.
		function at(sql: string, word: string, into = 1): number {
			return sql.indexOf(word) + into;
		}

		it('finds an unqualified call under the cursor', () => {
			let sql = 'SELECT order_total(ordno) FROM orders';
			expect(SqlParser.findRoutineCallAt(sql, at(sql, 'order_total'))).to.deep.equal({schema: undefined, name: 'order_total', routineType: 'FUNCTION'});
		});

		it('finds a schema-qualified call with the cursor on either part', () => {
			let sql = 'SELECT sales.order_total(ordno) FROM orders';
			expect(SqlParser.findRoutineCallAt(sql, at(sql, 'order_total'))).to.deep.equal({schema: 'sales', name: 'order_total', routineType: 'FUNCTION'});
			expect(SqlParser.findRoutineCallAt(sql, at(sql, 'sales'))).to.deep.equal({schema: 'sales', name: 'order_total', routineType: 'FUNCTION'});
		});

		it('finds a call nested in another call\'s arguments', () => {
			let sql = 'SELECT outer_fn(inner_fn(ordno), 1) FROM orders';
			expect(SqlParser.findRoutineCallAt(sql, at(sql, 'inner_fn'))?.name).to.equal('inner_fn');
			expect(SqlParser.findRoutineCallAt(sql, at(sql, 'outer_fn'))?.name).to.equal('outer_fn');
		});

		it('finds a table function inside TABLE(...)', () => {
			let sql = 'SELECT * FROM TABLE(sales.open_orders(\'C1\')) x';
			expect(SqlParser.findRoutineCallAt(sql, at(sql, 'open_orders'))).to.deep.equal({schema: 'sales', name: 'open_orders', routineType: 'FUNCTION'});
		});

		it('is undefined off any call, or on a column next to one', () => {
			let sql = 'SELECT ordno, order_total(ordno) FROM orders';
			expect(SqlParser.findRoutineCallAt(sql, at(sql, 'ordno'))).to.equal(undefined);
			expect(SqlParser.findRoutineCallAt(sql, at(sql, 'orders'))).to.equal(undefined);
		});

		// The name after CALL is a procedure, with or without an argument list, in the ODBC escape, or inside a
		// routine body - and the schema before it counts too.
		it('finds the procedure a CALL names, in every form a CALL is written', () => {
			let plain = 'CALL sales.next_order_number(\'ORD\', ?)';
			expect(SqlParser.findRoutineCallAt(plain, at(plain, 'next_order_number'))).to.deep.equal({schema: 'sales', name: 'next_order_number', routineType: 'PROCEDURE'});
			expect(SqlParser.findRoutineCallAt(plain, at(plain, 'sales'))).to.deep.equal({schema: 'sales', name: 'next_order_number', routineType: 'PROCEDURE'});

			let noArguments = 'call refresh_totals';
			expect(SqlParser.findRoutineCallAt(noArguments, at(noArguments, 'refresh_totals'))).to.deep.equal({schema: undefined, name: 'refresh_totals', routineType: 'PROCEDURE'});

			let escape = '{CALL next_order_number(?, ?)}';
			expect(SqlParser.findRoutineCallAt(escape, at(escape, 'next_order_number'))?.routineType).to.equal('PROCEDURE');

			let body = 'CREATE PROCEDURE sales.recalc() BEGIN CALL sales.order_total(1); SET x = order_total(2); END';
			expect(SqlParser.findRoutineCallAt(body, at(body, 'order_total'))?.routineType).to.equal('PROCEDURE');
			expect(SqlParser.findRoutineCallAt(body, body.lastIndexOf('order_total') + 1)?.routineType).to.equal('FUNCTION');
		});

		it('takes neither the CALL keyword nor an argument of a CALL for the procedure', () => {
			let sql = 'CALL next_order_number(order_total(1))';
			expect(SqlParser.findRoutineCallAt(sql, at(sql, 'CALL'))).to.equal(undefined);
			expect(SqlParser.findRoutineCallAt(sql, at(sql, 'order_total'))).to.deep.equal({schema: undefined, name: 'order_total', routineType: 'FUNCTION'});
		});

		// Each of these is a word followed by "(" that isn't a call, and the first two would otherwise
		// take a real table's Go to Definition away from it.
		it('ignores a keyword, a table before its column list, and a type in a cast', () => {
			let insert = 'INSERT INTO orders (ordno) VALUES (1)';
			expect(SqlParser.findRoutineCallAt(insert, at(insert, 'orders'))).to.equal(undefined);
			expect(SqlParser.findRoutineCallAt(insert, at(insert, 'VALUES'))).to.equal(undefined);

			let create = 'CREATE TABLE orders (ordno INTEGER)';
			expect(SqlParser.findRoutineCallAt(create, at(create, 'orders'))).to.equal(undefined);

			let cast = 'SELECT CAST(ordno AS VARCHAR(10)) FROM orders WHERE ordno IN (1, 2)';
			expect(SqlParser.findRoutineCallAt(cast, at(cast, 'CAST'))).to.equal(undefined);
			expect(SqlParser.findRoutineCallAt(cast, at(cast, 'VARCHAR'))).to.equal(undefined);
			expect(SqlParser.findRoutineCallAt(cast, at(cast, 'IN ('))).to.equal(undefined);
		});
	});

	describe('parseTables', () => {
		it('finds a single FROM table with an alias', () => {
			let tables = SqlParser.parse('SELECT id FROM employees e').tables;
			expect(tables).to.deep.equal([{table: 'employees', alias: 'e', schema: undefined}]);
		});

		it('finds a schema-qualified table', () => {
			let tables = SqlParser.parse('SELECT id FROM myschema.employees e').tables;
			expect(tables).to.deep.equal([{table: 'employees', alias: 'e', schema: 'myschema'}]);
		});

		it('finds a table with no alias at all', () => {
			let tables = SqlParser.parse('SELECT id FROM employees').tables;
			expect(tables).to.deep.equal([{table: 'employees', alias: undefined, schema: undefined}]);
		});

		it('finds an AS-aliased table', () => {
			let tables = SqlParser.parse('SELECT id FROM employees AS e').tables;
			expect(tables?.[0]).to.deep.equal({table: 'employees', alias: 'e', schema: undefined});
		});

		for(let joinType of ['JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'LEFT OUTER JOIN', 'RIGHT OUTER JOIN', 'FULL OUTER JOIN', 'CROSS JOIN']) {
			it(`finds a table introduced by ${joinType}`, () => {
				let tables = SqlParser.parse(`SELECT id FROM employees e ${joinType} departments d ON e.dept_id = d.id`).tables;
				expect(tables?.map(t => t.table)).to.deep.equal(['employees', 'departments']);
			});
		}

		it('finds every table in a multi-join chain', () => {
			let sql = 'SELECT id FROM employees e INNER JOIN departments d ON e.dept_id = d.id JOIN locations l ON d.loc_id = l.id';
			let tables = SqlParser.parse(sql).tables;
			expect(tables?.map(t => t.table)).to.deep.equal(['employees', 'departments', 'locations']);
		});

		it('finds a self-join (same table, two aliases) as two distinct entries', () => {
			let sql = 'SELECT id FROM employees e1 JOIN employees e2 ON e1.manager_id = e2.id';
			let tables = SqlParser.parse(sql).tables;
			expect(tables).to.deep.equal([
				{table: 'employees', alias: 'e1', schema: undefined},
				{table: 'employees', alias: 'e2', schema: undefined}
			]);
		});

		it('does not mistake "ON" for an alias', () => {
			let tables = SqlParser.parse('SELECT id FROM employees JOIN departments ON employees.dept_id = departments.id').tables;
			expect(tables).to.deep.equal([
				{table: 'employees', alias: undefined, schema: undefined},
				{table: 'departments', alias: undefined, schema: undefined}
			]);
		});

		describe('old-style comma joins', () => {
			it('finds both tables in a two-table comma join', () => {
				let sql = 'SELECT id FROM employees e, departments d WHERE e.dept_id = d.id';
				let tables = SqlParser.parse(sql).tables;
				expect(tables).to.deep.equal([
					{table: 'employees', alias: 'e', schema: undefined},
					{table: 'departments', alias: 'd', schema: undefined}
				]);
			});

			it('finds every table in a three-table comma join', () => {
				let sql = 'SELECT id FROM employees e, departments d, locations l WHERE e.dept_id = d.id AND d.loc_id = l.id';
				let tables = SqlParser.parse(sql).tables;
				expect(tables?.map(t => t.table)).to.deep.equal(['employees', 'departments', 'locations']);
			});

			it('handles schema-qualified tables in a comma join', () => {
				let sql = 'SELECT id FROM myschema.employees e, myschema.departments d WHERE e.dept_id = d.id';
				let tables = SqlParser.parse(sql).tables;
				expect(tables).to.deep.equal([
					{table: 'employees', alias: 'e', schema: 'myschema'},
					{table: 'departments', alias: 'd', schema: 'myschema'}
				]);
			});

			it('handles a comma join with no aliases at all', () => {
				let sql = 'SELECT id FROM employees, departments WHERE employees.dept_id = departments.id';
				let tables = SqlParser.parse(sql).tables;
				expect(tables?.map(t => t.table)).to.deep.equal(['employees', 'departments']);
			});

			it('handles a comma join mixed with an ANSI JOIN', () => {
				let sql = 'SELECT id FROM a, b JOIN c ON b.id = c.id WHERE a.x = b.y';
				let tables = SqlParser.parse(sql).tables;
				expect(tables?.map(t => t.table)).to.deep.equal(['a', 'b', 'c']);
			});
		});

		describe('does not mistake unrelated comma lists for joined tables', () => {
			it('does not treat an INSERT column list as comma-joined tables', () => {
				let tables = SqlParser.parse('INSERT INTO mytable (col1, col2) VALUES (1, 2)').tables;
				expect(tables?.map(t => t.table)).to.deep.equal(['mytable']);
			});

			it('does not treat an UPDATE SET list as comma-joined tables', () => {
				let tables = SqlParser.parse('UPDATE mytable SET x = 1, y = 2 WHERE id = 1').tables;
				expect(tables?.map(t => t.table)).to.deep.equal(['mytable']);
			});
		});

		it('deduplicates the same table+alias combination referenced more than once', () => {
			let sql = 'SELECT id FROM employees e WHERE e.id IN (SELECT manager_id FROM employees e)';
			let tables = SqlParser.parse(sql).tables;
			expect(tables?.length).to.equal(1);
		});

		describe('derived table aliases', () => {
			it('recovers a derived table\'s alias', () => {
				let sql = 'SELECT id FROM employees e JOIN (SELECT dept_id, dept_name FROM departments) d ON e.dept_id = d.dept_id';
				let tables = SqlParser.parse(sql).tables;
				expect(tables?.map(t => t.table)).to.deep.equal(['employees', 'departments', 'd']);
			});

			it('recovers an AS-aliased derived table\'s alias', () => {
				let sql = 'SELECT id FROM employees e JOIN (SELECT dept_id FROM departments) AS d ON e.dept_id = d.dept_id';
				let tables = SqlParser.parse(sql).tables;
				expect(tables?.map(t => t.table)).to.deep.equal(['employees', 'departments', 'd']);
			});

			it('recovers both aliases when two derived tables are joined together', () => {
				let sql = 'SELECT id FROM (SELECT a FROM t1) x JOIN (SELECT b FROM t2) y ON x.a = y.b';
				let tables = SqlParser.parse(sql).tables;
				expect(tables?.map(t => t.table)).to.deep.equal(['t1', 't2', 'x', 'y']);
			});

			it('recovers a derived table\'s alias when it is alone in the FROM clause', () => {
				let sql = 'SELECT id FROM (SELECT dept_id FROM departments) d';
				let tables = SqlParser.parse(sql).tables;
				expect(tables?.map(t => t.table)).to.deep.equal(['departments', 'd']);
			});

			it('recovers both aliases of a nested derived table (subquery inside subquery)', () => {
				let sql = 'SELECT id FROM (SELECT a FROM (SELECT b AS a FROM t2) inner_sub) x';
				let tables = SqlParser.parse(sql).tables;
				expect(tables?.map(t => t.table)).to.deep.equal(['t2', 'x', 'inner_sub']);
			});

			it('does not invent an alias for a derived table with no alias at all', () => {
				let sql = 'SELECT id FROM (SELECT dept_id FROM departments)';
				let tables = SqlParser.parse(sql).tables;
				expect(tables?.map(t => t.table)).to.deep.equal(['departments']);
			});

			it('does not treat an unclosed (still-being-typed) derived table as having an alias', () => {
				let sql = 'SELECT id FROM employees e JOIN (SELECT dept_id FROM departments';
				let tables = SqlParser.parse(sql).tables;
				expect(tables?.map(t => t.table)).to.deep.equal(['employees', 'departments']);
			});
		});
	});

	// The column list is what lines a VALUES position up with a column - for value content assist, and
	// for typing the ":name" markers in an INSERT (see ParameterParser.associateInsertValues). Reading
	// none out of a statement is silent: the markers still work, they just lose their data types.
	describe('parseInsertColumns', () => {
		it('reads the column list from a bare table name', () => {
			expect(SqlParser.parse('insert into customer (custno, custnm) values (1, \'x\')').insertColumns).to.deep.equal(['custno', 'custnm']);
		});

		it('reads it from a schema-qualified target, delimited or not', () => {
			expect(SqlParser.parse('insert into sales.customer (custno, custnm) values (1, \'x\')').insertColumns).to.deep.equal(['custno', 'custnm']);
			expect(SqlParser.parse('INSERT INTO "SALES"."CUSTOMER" ("CUSTNO", "CUSTNM") VALUES (1, \'x\')').insertColumns).to.deep.equal(['CUSTNO', 'CUSTNM'], 'delimiters come off, since these are matched against catalog names');
		});

		it('is undefined when the statement names no column list', () => {
			expect(SqlParser.parse('insert into sales.customer values (1, \'x\')').insertColumns).to.equal(undefined);
		});
	});

	describe('splitTopLevelCommas', () => {
		it('splits a simple comma-separated list', () => {
			expect(SqlParser.splitTopLevelCommas('a, b, c')).to.deep.equal(['a', ' b', ' c']);
		});

		it('does not split on a comma nested inside parens', () => {
			expect(SqlParser.splitTopLevelCommas('SUM(a, b), c')).to.deep.equal(['SUM(a, b)', ' c']);
		});

		it('does not split on a comma inside a quoted string literal', () => {
			expect(SqlParser.splitTopLevelCommas(`'Smith, John', c`)).to.deep.equal([`'Smith, John'`, ' c']);
		});

		it('returns the whole text as a single item when there is no comma at all', () => {
			expect(SqlParser.splitTopLevelCommas('a')).to.deep.equal(['a']);
		});
	});

	describe('countTopLevelCommas', () => {
		it('counts only top-level commas, not ones nested inside parens', () => {
			expect(SqlParser.countTopLevelCommas('SUM(a, b), c, d')).to.equal(2);
		});
	});

	describe('getCurrentSelectListText', () => {
		it('isolates the text between SELECT and FROM', () => {
			expect(SqlParser.getCurrentSelectListText('SELECT dept_id, name FROM employees')).to.equal(' dept_id, name ');
		});

		it('strips a leading DISTINCT', () => {
			expect(SqlParser.getCurrentSelectListText('SELECT DISTINCT dept_id FROM employees')).to.equal('dept_id ');
		});

		it('strips a leading ALL', () => {
			expect(SqlParser.getCurrentSelectListText('SELECT ALL dept_id FROM employees')).to.equal('dept_id ');
		});

		it('is not fooled by a FROM nested inside a scalar subquery in the select list', () => {
			let sql = 'SELECT (SELECT MAX(x) FROM other) AS m FROM employees';
			expect(SqlParser.getCurrentSelectListText(sql)).to.equal(' (SELECT MAX(x) FROM other) AS m ');
		});

		it('uses the outer statement\'s own SELECT, not a CTE\'s, when a WITH clause precedes it', () => {
			let sql = 'WITH data AS (SELECT x FROM t) SELECT dept_id FROM employees';
			expect(SqlParser.getCurrentSelectListText(sql)).to.equal(' dept_id ');
		});

		it('returns undefined when there is no SELECT at all', () => {
			expect(SqlParser.getCurrentSelectListText('FROM employees')).to.equal(undefined);
		});

		it('returns undefined when FROM has not been typed yet', () => {
			expect(SqlParser.getCurrentSelectListText('SELECT dept_id')).to.equal(undefined);
		});
	});
});
