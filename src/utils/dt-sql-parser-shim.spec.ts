import { expect } from 'chai';
import { Db2SyntaxShim, DanglingJoinRepair } from './dt-sql-parser-shim.js';

describe('Db2SyntaxShim', () => {
	describe('strip', () => {
		it('leaves ordinary SQL untouched', () => {
			let sql = 'select id, name from employees where active = 1';
			expect(Db2SyntaxShim.strip(sql)).to.equal(sql);
		});

		for(let keyword of ['UR', 'RR', 'CS', 'RS', 'RESET']) {
			it(`strips a trailing WITH ${keyword} isolation clause`, () => {
				let sql = `select id from employees WITH ${keyword}`;
				expect(Db2SyntaxShim.strip(sql)).to.equal('select id from employees ');
			});

			it(`is case-insensitive for WITH ${keyword.toLowerCase()}`, () => {
				let sql = `select id from employees with ${keyword.toLowerCase()}`;
				expect(Db2SyntaxShim.strip(sql)).to.equal('select id from employees ');
			});
		}

		it('strips OPTIMIZE FOR n ROWS', () => {
			let sql = 'select id from employees OPTIMIZE FOR 10 ROWS';
			expect(Db2SyntaxShim.strip(sql)).to.equal('select id from employees ');
		});

		it('strips OPTIMIZE FOR 1 ROW (singular)', () => {
			let sql = 'select id from employees OPTIMIZE FOR 1 ROW';
			expect(Db2SyntaxShim.strip(sql)).to.equal('select id from employees ');
		});

		it('strips both an isolation clause and OPTIMIZE FOR together', () => {
			let sql = 'select id from employees OPTIMIZE FOR 10 ROWS WITH UR';
			expect(Db2SyntaxShim.strip(sql)).to.equal('select id from employees  ');
		});

		// Regression: a CTE literally named "ur"/"rs"/etc. must not be mistaken for the isolation
		// clause of the same name -- only a bare "WITH <keyword>" not followed by "AS" (a CTE
		// definition) is a real isolation clause.
		for(let keyword of ['ur', 'rr', 'cs', 'rs', 'reset']) {
			it(`does not strip a CTE literally named "${keyword}"`, () => {
				let sql = `with ${keyword} as (select * from t) select * from ${keyword}`;
				expect(Db2SyntaxShim.strip(sql)).to.equal(sql);
			});
		}

		it('does not strip a table/column literally named "optimize" or "rows"', () => {
			let sql = 'select optimize, rows from t';
			expect(Db2SyntaxShim.strip(sql)).to.equal(sql);
		});

		it('handles an empty string', () => {
			expect(Db2SyntaxShim.strip('')).to.equal('');
		});
	});
});

describe('DanglingJoinRepair', () => {
	describe('repair', () => {
		it('leaves ordinary SQL with no join at all untouched', () => {
			let sql = 'select id from employees where active = 1';
			expect(DanglingJoinRepair.repair(sql)).to.equal(sql);
		});

		it('appends "ON 1=1" to a dangling join at the end of the text', () => {
			expect(DanglingJoinRepair.repair('select from data join apphost b')).to.equal('select from data join apphost b ON 1=1');
		});

		it('appends "ON 1=1" to a dangling join before a following clause keyword', () => {
			expect(DanglingJoinRepair.repair('select id from a join b c where c.id = 1')).to.equal('select id from a join b c ON 1=1 where c.id = 1');
		});

		it('leaves a join that already has ON untouched', () => {
			let sql = 'select from data join apphost b on data.x = b.id';
			expect(DanglingJoinRepair.repair(sql)).to.equal(sql);
		});

		it('leaves a join that already has USING untouched', () => {
			let sql = 'select from a join b using (id)';
			expect(DanglingJoinRepair.repair(sql)).to.equal(sql);
		});

		it('leaves CROSS JOIN untouched -- it never takes ON/USING', () => {
			let sql = 'select from a cross join b';
			expect(DanglingJoinRepair.repair(sql)).to.equal(sql);
		});

		it('leaves NATURAL JOIN untouched -- it never takes ON/USING', () => {
			let sql = 'select from a natural join b';
			expect(DanglingJoinRepair.repair(sql)).to.equal(sql);
		});

		it('repairs only the dangling join in a chain where an earlier join already has ON', () => {
			expect(DanglingJoinRepair.repair('select from a join b on a.id=b.id join c')).to.equal('select from a join b on a.id=b.id join c ON 1=1');
		});

		it('repairs a dangling join immediately followed by another join', () => {
			expect(DanglingJoinRepair.repair('select from a join b join c on b.id = c.id')).to.equal('select from a join b ON 1=1 join c on b.id = c.id');
		});

		it('repairs a dangling join inside a CTE body, before the closing paren', () => {
			expect(DanglingJoinRepair.repair('with data as (select * from a join b) select * from data')).to.equal('with data as (select * from a join b ON 1=1) select * from data');
		});

		it('repairs LEFT OUTER JOIN the same as a plain JOIN', () => {
			expect(DanglingJoinRepair.repair('select from a left outer join b')).to.equal('select from a left outer join b ON 1=1');
		});

		it('repairs a schema-qualified dangling join', () => {
			expect(DanglingJoinRepair.repair('select from a join myschema.b c')).to.equal('select from a join myschema.b c ON 1=1');
		});

		it('handles an empty string', () => {
			expect(DanglingJoinRepair.repair('')).to.equal('');
		});

		it('appends "1=1" to a join whose ON has no condition yet, at the end of the text', () => {
			expect(DanglingJoinRepair.repair('select * from a join b on ')).to.equal('select * from a join b on 1=1 ');
		});

		it('appends "1=1" to a dangling ON immediately followed by another join, without swallowing it as an alias', () => {
			// Regression: the alias group in DANGLING_JOIN used to accept any word, including "on"
			// itself -- "join b on" (nothing typed after ON yet) parsed as "join b AS on" missing its
			// OWN on/using clause, so DANGLING_JOIN's own repair fired too and appended a second,
			// conflicting "ON 1=1" right after the real "on", breaking the whole statement's parse.
			expect(DanglingJoinRepair.repair('select * from a join b on\njoin c on b.id = c.id'))
				.to.equal('select * from a join b on 1=1\njoin c on b.id = c.id');
		});

		it('leaves ON untouched once a condition has started, even if incomplete', () => {
			let sql = 'select * from a join b on b.id = ';
			expect(DanglingJoinRepair.repair(sql)).to.equal(sql);
		});
	});
});
