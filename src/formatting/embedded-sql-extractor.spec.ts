import { expect } from 'chai';
import { EmbeddedSqlExtractor } from './embedded-sql-extractor.js';

describe('EmbeddedSqlExtractor', () => {
	it('extracts Java/C#-style string concatenation, parameterizing the variable by name', () => {
		let text = `String sql = "SELECT * FROM foo WHERE id = " + custId + " AND active = 1";`;
		let result = EmbeddedSqlExtractor.extract(text);
		expect(result.replaced).to.equal(true);
		expect(result.sql).to.equal('SELECT * FROM foo WHERE id = :custId AND active = 1');
		expect(result.parameters).to.deep.equal([{expression: 'custId', name: 'custId'}]);
	});

	it('extracts a JS template literal with a bare identifier interpolation', () => {
		let text = 'const sql = `SELECT * FROM foo WHERE id = ${custId}`;';
		let result = EmbeddedSqlExtractor.extract(text);
		expect(result.replaced).to.equal(true);
		expect(result.sql).to.equal('SELECT * FROM foo WHERE id = :custId');
		expect(result.parameters).to.deep.equal([{expression: 'custId', name: 'custId'}]);
	});

	it('derives a parameter name from a property-access interpolation', () => {
		let text = 'const sql = `SELECT * FROM foo WHERE id = ${order.customerId}`;';
		let result = EmbeddedSqlExtractor.extract(text);
		expect(result.sql).to.equal('SELECT * FROM foo WHERE id = :customerId');
		expect(result.parameters).to.deep.equal([{expression: 'order.customerId', name: 'customerId'}]);
	});

	it('derives a parameter name from an accessor method call', () => {
		let text = 'String sql = "SELECT * FROM foo WHERE id = " + order.getCustomerId() + "";';
		let result = EmbeddedSqlExtractor.extract(text);
		expect(result.parameters).to.deep.equal([{expression: 'order.getCustomerId()', name: 'customerId'}]);
	});

	it('reuses one parameter when the same variable is used twice', () => {
		let text = `String sql = "SELECT * FROM foo WHERE a = " + custId + " OR b = " + custId + "";`;
		let result = EmbeddedSqlExtractor.extract(text);
		expect(result.sql).to.equal('SELECT * FROM foo WHERE a = :custId OR b = :custId');
		expect(result.parameters).to.have.length(1);
	});

	it('suffixes colliding parameter names derived from different expressions', () => {
		let text = `String sql = "SELECT * FROM foo WHERE a = " + a.id + " OR b = " + b.id + "";`;
		let result = EmbeddedSqlExtractor.extract(text);
		expect(result.parameters.map(p => p.name)).to.deep.equal(['id', 'id2']);
	});

	it('falls back to a generic name for an expression it cannot name meaningfully', () => {
		let text = `String sql = "SELECT * FROM foo WHERE a = " + (flag ? 1 : 2) + "";`;
		let result = EmbeddedSqlExtractor.extract(text);
		expect(result.parameters[0].name).to.equal('param');
	});

	it('does not treat plain SQL as embedded host code (no replacement, passthrough)', () => {
		let sql = 'SELECT * FROM foo WHERE id = 1';
		let result = EmbeddedSqlExtractor.extract(sql);
		expect(result).to.deep.equal({sql, replaced: false, parameters: []});
	});

	it('does not mistake ordinary string concatenation with no SQL keyword for embedded SQL', () => {
		let text = `String greeting = "Hello " + name + "!";`;
		let result = EmbeddedSqlExtractor.extract(text);
		expect(result.replaced).to.equal(false);
		expect(result.sql).to.equal(text);
	});

	it('does not treat a single bare string literal (no concatenation) as embedded SQL', () => {
		let text = `String sql = "SELECT * FROM foo";`;
		let result = EmbeddedSqlExtractor.extract(text);
		expect(result.replaced).to.equal(false);
	});

	it('recognizes a trailing clause built with no SELECT/FROM/WHERE in the same call', () => {
		let text = `String sql = base + " ORDER BY " + sortCol + " ASC";`;
		let result = EmbeddedSqlExtractor.extract(text);
		expect(result.replaced).to.equal(true);
		expect(result.sql).to.equal('ORDER BY :sortCol ASC');
	});

	it('still does not mistake "order" alone (not "ORDER BY") for the clause keyword', () => {
		let text = `String msg = "Please order " + item + " before " + date;`;
		let result = EmbeddedSqlExtractor.extract(text);
		expect(result.replaced).to.equal(false);
	});

	it('does not mistake DB2\'s own "||" concatenation (dynamic SQL built with EXECUTE IMMEDIATE) for host-code glue', () => {
		let text = `SET stmt = 'SELECT * FROM ' || tabname || ' WHERE 1=1';`;
		let result = EmbeddedSqlExtractor.extract(text);
		expect(result).to.deep.equal({sql: text, replaced: false, parameters: []});
	});

	it('drops the host language\'s own declaration syntax around the concatenation', () => {
		let text = `String sql = "SELECT * FROM foo WHERE id = " + custId + "";`;
		let result = EmbeddedSqlExtractor.extract(text);
		expect(result.sql).to.not.include('String sql');
		expect(result.sql).to.not.include(';');
	});

	it('converts a "//" comment tagging along on the concatenation into a "--" comment, without letting it swallow the rest of the query', () => {
		let text = '`select rcid, rcdsts, usrtype, fnam, lnam, mnam, prfnam, email ` + //test\n'
			+ '`from appuser ` +\n'
			+ '`where 1 = 1 `;';
		let result = EmbeddedSqlExtractor.extract(text);
		expect(result.sql).to.equal('select rcid, rcdsts, usrtype, fnam, lnam, mnam, prfnam, email --test\nfrom appuser where 1 = 1');
	});

	it('joins a query built up over several "sql +=" statements, comments included, without turning the statements into parameters', () => {
		let text = 'let sql = ``;\n\n'
			+ '\t\t// select statement\n'
			+ '\t\tsql += `SELECT u.uid, u.fnam, RIGHT(p.phdptn, 3) as DPDEPT `;\n'
			+ '\t\tsql += `FROM gppuser as u `;\n'
			+ '\t\t// join statement\n'
			+ '\t\tsql += `JOIN pdpphms as p on p.phemcd = u.emcd `;\n'
			+ '\t\tsql += `JOIN gppdptm as d on (d.department_code = RIGHT(p.phdptn, 3) and d.record_status <> \'I\') `;';
		let result = EmbeddedSqlExtractor.extract(text);
		expect(result.replaced).to.equal(true);
		expect(result.sql).to.equal('--select statement\n'
			+ 'SELECT u.uid, u.fnam, RIGHT(p.phdptn, 3) as DPDEPT FROM gppuser as u --join statement\n'
			+ 'JOIN pdpphms as p on p.phemcd = u.emcd JOIN gppdptm as d on (d.department_code = RIGHT(p.phdptn, 3) and d.record_status <> \'I\')');
		expect(result.parameters).to.deep.equal([]);
	});

	it('joins "+=" statements written without semicolons', () => {
		let text = 'let q = `SELECT *`\nq += ` FROM t WHERE id = ${id}`';
		let result = EmbeddedSqlExtractor.extract(text);
		expect(result.sql).to.equal('SELECT * FROM t WHERE id = :id');
		expect(result.parameters).to.deep.equal([{expression: 'id', name: 'id'}]);
	});

	it('joins "sql = sql + ..." statements and keeps a value appended after the last string', () => {
		let text = 'String sql = "SELECT a ";\nsql = sql + "FROM t WHERE b = " + b;\nsql += " AND c = " + (flag ? 1 : 2);\nreturn sql;';
		let result = EmbeddedSqlExtractor.extract(text);
		expect(result.sql).to.equal('SELECT a FROM t WHERE b = :b AND c = :param');
		expect(result.parameters).to.deep.equal([{expression: 'b', name: 'b'}, {expression: '(flag ? 1 : 2)', name: 'param'}]);
	});

	it('extracts a query built with StringBuilder.append, dropping statements that append nothing', () => {
		let text = 'StringBuilder sb = new StringBuilder();\n'
			+ 'sb.append("SELECT * FROM t ");\n'
			+ 'sb.append("WHERE id = ").append(id);\n'
			+ 'int n = 5;\n'
			+ 'sb.Append(" AND x = ").append(getX()).append(" ORDER BY a");';
		let result = EmbeddedSqlExtractor.extract(text);
		expect(result.replaced).to.equal(true);
		expect(result.sql).to.equal('SELECT * FROM t WHERE id = :id AND x = :x ORDER BY a');
		expect(result.parameters).to.deep.equal([{expression: 'id', name: 'id'}, {expression: 'getX()', name: 'x'}]);
	});

	it('still leaves a single SQL string with a value added after it alone, since DB2 itself allows that', () => {
		let text = `SELECT * FROM t WHERE code = '1' + 2`;
		expect(EmbeddedSqlExtractor.extract(text)).to.deep.equal({sql: text, replaced: false, parameters: []});
	});

	it('passes a "/* */" comment already sitting in the concatenation glue through unchanged', () => {
		let text = `String sql = "SELECT * FROM foo WHERE id = " + /* customer id */ custId + "";`;
		let result = EmbeddedSqlExtractor.extract(text);
		expect(result.sql).to.equal('SELECT * FROM foo WHERE id = /* customer id */ :custId');
		expect(result.parameters).to.deep.equal([{expression: 'custId', name: 'custId'}]);
	});
});
