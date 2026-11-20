import { expect } from 'chai';
import { EmbeddedSqlExtractor } from './embedded-sql-extractor.js';

// Every table and column name here is made up.

// The one query extracted from "text", asserting the text was read as host code with nothing else in it.
function extractOne(text: string): EmbeddedSqlExtractor.Segment {
	let result = EmbeddedSqlExtractor.extract(text);
	expect(result.hostCode, 'read as host code').to.equal(true);
	expect(result.segments).to.have.length(1);
	expect(result.segments[0].kind).to.equal('extracted');
	return result.segments[0];
}

// The extracted SQL with each run of whitespace made one space, for comparing queries whose line
// breaks the formatter decides anyway. Line comments keep their line break.
function flat(sql: string): string {
	let lines = sql.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(line => line.length > 0);
	return lines.reduce((text, line, index) => {
		let ownLine = index > 0 && (line.startsWith('--') || lines[index - 1].includes('--'));
		return index === 0 ? line : `${text}${ownLine ? '\n' : ' '}${line}`;
	}, '');
}

function expectNotHostCode(text: string): void {
	expect(EmbeddedSqlExtractor.extract(text)).to.deep.equal({hostCode: false, segments: []});
}

describe('EmbeddedSqlExtractor', () => {
	describe('concatenation', () => {
		it('extracts Java/C#-style string concatenation, parameterizing the variable by name', () => {
			let segment = extractOne(`String sql = "SELECT * FROM widget WHERE id = " + widgetId + " AND active = 1";`);
			expect(segment.sql).to.equal('SELECT * FROM widget WHERE id = :widgetId AND active = 1');
			expect(segment.parameters).to.deep.equal([{expression: 'widgetId', name: 'widgetId'}]);
		});

		it('extracts a value appended after the last string', () => {
			let segment = extractOne(`String sql = "SELECT * FROM widget WHERE id = " + widgetId;`);
			expect(segment.sql).to.equal('SELECT * FROM widget WHERE id = :widgetId');
		});

		it('extracts a bare concatenation with no variable, as pasted from the middle of a statement', () => {
			let text = '`SELECT w.id, w.label ` +\n'
				+ '\t\t\t`FROM widget AS w ` +\n'
				+ '\t\t\t`WHERE w.owner = :ownerId ` +\n'
				+ '\t\t\t\t`AND NOT EXISTS ( ` +\n'
				+ '\t\t\t\t\t`SELECT 1 FROM gadget AS g WHERE g.widget_id = w.id ` +\n'
				+ '\t\t\t\t`) `;';
			let segment = extractOne(text);
			expect(flat(segment.sql)).to.equal('SELECT w.id, w.label FROM widget AS w WHERE w.owner = :ownerId AND NOT EXISTS ( SELECT 1 FROM gadget AS g WHERE g.widget_id = w.id )');
			expect(segment.parameters).to.deep.equal([]);
		});

		it('ignores a dangling "+" left where the paste was cut off', () => {
			let segment = extractOne('`SELECT a FROM widget ` +\n\t`WHERE b = 1` +');
			expect(flat(segment.sql)).to.equal('SELECT a FROM widget WHERE b = 1');
		});

		it('keeps a numeric literal as SQL rather than a parameter', () => {
			let segment = extractOne(`String sql = "SELECT * FROM widget FETCH FIRST " + 10 + " ROWS ONLY";`);
			expect(segment.sql).to.equal('SELECT * FROM widget FETCH FIRST 10 ROWS ONLY');
			expect(segment.parameters).to.deep.equal([]);
		});

		it('extracts the SQL argument of a call, leaving the call and its other arguments behind', () => {
			let segment = extractOne('const rows = await db.query("SELECT * FROM widget WHERE id = " + widgetId + " ORDER BY id", [widgetId]);');
			expect(segment.sql).to.equal('SELECT * FROM widget WHERE id = :widgetId ORDER BY id');
		});

		it('extracts a returned concatenation', () => {
			let segment = extractOne('return "SELECT * FROM widget " + "WHERE id = " + id;');
			expect(segment.sql).to.equal('SELECT * FROM widget WHERE id = :id');
		});

		it('renders a parenthesized concatenation in place', () => {
			let segment = extractOne(`String sql = "SELECT * FROM widget" + (" WHERE id = " + id);`);
			expect(segment.sql).to.equal('SELECT * FROM widget WHERE id = :id');
		});

		it('recognizes a trailing clause built with no SELECT/FROM/WHERE in the same statement', () => {
			let segment = extractOne(`String sql = base + " ORDER BY " + sortCol + " ASC";`);
			expect(segment.sql).to.equal('ORDER BY :sortCol ASC');
		});
	});

	describe('parameters', () => {
		it('extracts a JS template literal with a bare identifier interpolation', () => {
			let segment = extractOne('const sql = `SELECT * FROM widget WHERE id = ${widgetId}`;');
			expect(segment.sql).to.equal('SELECT * FROM widget WHERE id = :widgetId');
			expect(segment.parameters).to.deep.equal([{expression: 'widgetId', name: 'widgetId'}]);
		});

		it('derives a parameter name from a property-access interpolation', () => {
			let segment = extractOne('const sql = `SELECT * FROM widget WHERE id = ${order.widgetId}`;');
			expect(segment.sql).to.equal('SELECT * FROM widget WHERE id = :widgetId');
			expect(segment.parameters).to.deep.equal([{expression: 'order.widgetId', name: 'widgetId'}]);
		});

		it('derives a parameter name from an accessor method call', () => {
			let segment = extractOne('String sql = "SELECT * FROM widget WHERE id = " + order.getWidgetId() + "";');
			expect(segment.parameters).to.deep.equal([{expression: 'order.getWidgetId()', name: 'widgetId'}]);
		});

		it('reuses one parameter when the same variable is used twice', () => {
			let segment = extractOne(`String sql = "SELECT * FROM widget WHERE a = " + widgetId + " OR b = " + widgetId + "";`);
			expect(segment.sql).to.equal('SELECT * FROM widget WHERE a = :widgetId OR b = :widgetId');
			expect(segment.parameters).to.have.length(1);
		});

		it('suffixes colliding parameter names derived from different expressions', () => {
			let segment = extractOne(`String sql = "SELECT * FROM widget WHERE a = " + a.id + " OR b = " + b.id + "";`);
			expect(segment.parameters.map(parameter => parameter.name)).to.deep.equal(['id', 'id2']);
		});

		it('falls back to a generic name for an expression it cannot name meaningfully', () => {
			let segment = extractOne(`String sql = "SELECT * FROM widget WHERE a = " + (flag + 1) + "";`);
			expect(segment.parameters[0].name).to.equal('param');
		});

		it('replaces a quoted SQL literal the value was spliced into', () => {
			let segment = extractOne(`String sql = "SELECT * FROM widget WHERE code = '" + code + "' AND kind = 'A'";`);
			expect(segment.sql).to.equal(`SELECT * FROM widget WHERE code = :code AND kind = 'A'`);
		});

		it('concatenates a value spliced into the middle of a SQL literal', () => {
			let segment = extractOne(`String sql = "SELECT * FROM widget WHERE label LIKE '%" + term + "%'";`);
			expect(segment.sql).to.equal(`SELECT * FROM widget WHERE label LIKE '%' || :term || '%'`);
		});

		it('extracts C# interpolated and verbatim strings', () => {
			let segment = extractOne('var sql = $"SELECT * FROM widget WHERE id = {widget.Id} AND n > {count,5:N0}";');
			expect(segment.sql).to.equal('SELECT * FROM widget WHERE id = :Id AND n > :count');

			let verbatim = extractOne('var sql = @"SELECT ""label""\n FROM widget";');
			expect(verbatim.sql).to.equal('SELECT "label"\n FROM widget');
		});

		it('extracts a Java text block', () => {
			let segment = extractOne('String sql = """\n    SELECT *\n    FROM widget\n    """;');
			expect(flat(segment.sql)).to.equal('SELECT * FROM widget');
		});

		it('decodes the host language\'s escapes', () => {
			let segment = extractOne(`String sql = "SELECT * FROM widget\\nWHERE label = 'a\\"b'" + "";`);
			expect(segment.sql).to.equal(`SELECT * FROM widget\nWHERE label = 'a"b'`);
		});
	});

	describe('queries built over several statements', () => {
		it('joins a query built up over several "sql +=" statements, keeping comments where they were', () => {
			let text = 'let sql = ``;\n\n'
				+ '\t\t// select statement\n'
				+ '\t\tsql += `SELECT s.id, s.first_name, RIGHT(d.code, 3) as DEPT `;\n'
				+ '\t\tsql += `FROM staff as s `;\n'
				+ '\t\t// join statement\n'
				+ '\t\tsql += `JOIN department as d on d.id = s.dept_id `;';
			let segment = extractOne(text);
			expect(flat(segment.sql)).to.equal('-- select statement\n'
				+ 'SELECT s.id, s.first_name, RIGHT(d.code, 3) as DEPT FROM staff as s\n'
				+ '-- join statement\n'
				+ 'JOIN department as d on d.id = s.dept_id');
			expect(segment.parameters).to.deep.equal([]);
		});

		it('starts a query at "sql +=" when the paste begins after the declaration', () => {
			let segment = extractOne('sql += `SELECT * `;\nsql += `FROM widget `;');
			expect(flat(segment.sql)).to.equal('SELECT * FROM widget');
		});

		it('joins "+=" statements written without semicolons', () => {
			let segment = extractOne('let q = `SELECT *`\nq += ` FROM t WHERE id = ${id}`');
			expect(segment.sql).to.equal('SELECT * FROM t WHERE id = :id');
			expect(segment.parameters).to.deep.equal([{expression: 'id', name: 'id'}]);
		});

		it('joins "sql = sql + ..." statements and keeps a value appended after the last string', () => {
			let segment = extractOne('String sql = "SELECT a ";\nsql = sql + "FROM t WHERE b = " + b;\nsql += " AND c = " + (flag ? 1 : 2);\nreturn sql;');
			expect(segment.sql).to.equal('SELECT a FROM t WHERE b = :b AND c = :param');
			expect(segment.parameters).to.deep.equal([{expression: 'b', name: 'b'}, {expression: '(flag ? 1 : 2)', name: 'param'}]);
		});

		it('extracts a query built with StringBuilder.append, dropping statements that append nothing', () => {
			let text = 'StringBuilder sb = new StringBuilder();\n'
				+ 'sb.append("SELECT * FROM t ");\n'
				+ 'sb.append("WHERE id = ").append(id);\n'
				+ 'int n = 5;\n'
				+ 'sb.Append(" AND x = ").append(getX()).append(" ORDER BY a");';
			let segment = extractOne(text);
			expect(segment.sql).to.equal('SELECT * FROM t WHERE id = :id AND x = :x ORDER BY a');
			expect(segment.parameters).to.deep.equal([{expression: 'id', name: 'id'}, {expression: 'getX()', name: 'x'}]);
		});

		it('extracts each query variable as its own query', () => {
			let text = 'let countSql = `SELECT COUNT(*) FROM widget `;\n'
				+ 'let sql = `SELECT * FROM widget `;\n'
				+ 'countSql += `WHERE active = 1`;\n'
				+ 'sql += `WHERE active = 1`;';
			let result = EmbeddedSqlExtractor.extract(text);
			expect(result.segments.map(segment => flat(segment.sql))).to.deep.equal([
				'SELECT COUNT(*) FROM widget WHERE active = 1',
				'SELECT * FROM widget WHERE active = 1'
			]);
		});

		it('covers every statement that built the query in its source range', () => {
			let text = 'foo();\nlet sql = `SELECT * `;\nbar();\nsql += `FROM widget`;\nbaz();';
			let segment = extractOne(text);
			expect(text.substring(segment.start, segment.end)).to.equal('let sql = `SELECT * `;\nbar();\nsql += `FROM widget`;');
		});
	});

	describe('control flow', () => {
		const SEARCH = 'sql += `SELECT s.id, s.last_name FROM staff as s `;\n'
			+ '\t\t// where statement\n'
			+ '\t\tsql += `WHERE 1 = 1 `;\n'
			+ '\t\tif(StringUtils.isNotEmpty(search.site)) {\n'
			+ '\t\t\tsql += `AND s.site = :site `;\n'
			+ '\t\t}\n'
			+ '\t\t\n'
			+ '\t\tif(StringUtils.isNotEmpty(search.deptNumber)) {\n'
			+ '\t\t\tsql += `AND SUBSTR(CHAR(s.dept), LENGTH(CHAR(s.dept)) - 2, 3)  = :deptNumber `;\n'
			+ '\t\t}\n';

		it('keeps the appends inside an if, each under a comment naming its condition', () => {
			let segment = extractOne(SEARCH);
			expect(flat(segment.sql)).to.equal('SELECT s.id, s.last_name FROM staff as s\n'
				+ '-- where statement\n'
				+ 'WHERE 1 = 1\n'
				+ '-- if (StringUtils.isNotEmpty(search.site))\n'
				+ 'AND s.site = :site\n'
				+ '-- if (StringUtils.isNotEmpty(search.deptNumber))\n'
				+ 'AND SUBSTR(CHAR(s.dept), LENGTH(CHAR(s.dept)) - 2, 3) = :deptNumber');
		});

		it('names a condition once for several appends under it, and handles an if with no braces', () => {
			let text = 'let sql = "SELECT * FROM widget WHERE 1 = 1";\n'
				+ 'if (a) {\n  sql += " AND x = 1";\n  sql += " AND y = 2";\n}\n'
				+ 'if (b) sql += " AND z = 3";';
			let segment = extractOne(text);
			expect(flat(segment.sql)).to.equal('SELECT * FROM widget WHERE 1 = 1\n-- if (a)\nAND x = 1 AND y = 2\n-- if (b)\nAND z = 3');
		});

		it('comments out an else branch, and every else-if, as alternatives to the first branch', () => {
			let text = 'let sql = "SELECT * FROM widget ";\n'
				+ 'if (byName) {\n  sql += "ORDER BY label";\n} else if (byDate) {\n  sql += "ORDER BY created";\n} else {\n  sql += "ORDER BY id";\n}';
			let segment = extractOne(text);
			expect(flat(segment.sql)).to.equal('SELECT * FROM widget\n-- if (byName)\nORDER BY label\n-- else if (byDate): ORDER BY created\n-- else: ORDER BY id');
		});

		it('keeps a loop body once, under its header', () => {
			let text = 'let sql = "SELECT * FROM widget WHERE id IN (0";\nfor (const id of ids) {\n  sql += ", " + id;\n}\nsql += ")";';
			let segment = extractOne(text);
			expect(flat(segment.sql)).to.equal('SELECT * FROM widget WHERE id IN (0\n-- for (const id of ids)\n, :id)');
		});

		it('keeps a switch\'s first case and comments out the rest', () => {
			let text = 'String sql = "SELECT * FROM widget ";\nswitch (sort) {\n  case "name":\n    sql += "ORDER BY label";\n    break;\n  default:\n    sql += "ORDER BY id";\n}';
			let segment = extractOne(text);
			expect(flat(segment.sql)).to.equal('SELECT * FROM widget\n-- switch (sort) case "name"\nORDER BY label\n-- default: ORDER BY id');
		});

		it('keeps the first branch of a ternary choosing between SQL strings', () => {
			let segment = extractOne('let sql = "SELECT * FROM widget " + (desc ? "ORDER BY id DESC" : "ORDER BY id");');
			expect(flat(segment.sql)).to.equal('SELECT * FROM widget\n-- if (desc)\nORDER BY id DESC\n-- else: ORDER BY id');
		});
	});

	describe('comments', () => {
		it('converts a "//" comment tagging along on the concatenation into a "--" comment, without letting it swallow the rest of the query', () => {
			let text = '`select id, first_name, last_name, email ` + //test\n'
				+ '`from appuser ` +\n'
				+ '`where 1 = 1 `;';
			let segment = extractOne(text);
			expect(flat(segment.sql)).to.equal('select id, first_name, last_name, email --test\nfrom appuser where 1 = 1');
		});

		it('passes a "/* */" comment already sitting in the concatenation through unchanged', () => {
			let segment = extractOne(`String sql = "SELECT * FROM widget WHERE id = " + /* widget id */ widgetId + "";`);
			expect(flat(segment.sql)).to.equal('SELECT * FROM widget WHERE id = /* widget id */ :widgetId');
			expect(segment.parameters).to.deep.equal([{expression: 'widgetId', name: 'widgetId'}]);
		});

		it('drops a comment that comes before host code building no SQL', () => {
			let segment = extractOne('// load the rows\nconst rows = load();\nlet sql = `SELECT * FROM widget ` +\n `WHERE 1 = 1`;');
			expect(segment.sql).to.not.include('load the rows');
		});
	});

	describe('mixed host code and SQL', () => {
		it('passes a plain DB2 statement among host code through unchanged, in source order', () => {
			let text = 'String sql = "SELECT a ";\nsql += "FROM t";\n\nSELECT id\n  FROM departments;';
			let result = EmbeddedSqlExtractor.extract(text);
			expect(result.segments.map(segment => [segment.kind, segment.sql])).to.deep.equal([
				['extracted', 'SELECT a FROM t'],
				['sql', 'SELECT id\n  FROM departments;']
			]);
		});
	});

	describe('text that is not host code', () => {
		it('leaves plain SQL alone', () => {
			expectNotHostCode('SELECT * FROM widget WHERE id = 1');
		});

		it('leaves several plain SQL statements alone, comments with apostrophes included', () => {
			expectNotHostCode(`-- don't touch\nSELECT * FROM widget WHERE label = 'it''s';\nUPDATE widget SET label = 'a' WHERE id = 2;`);
		});

		it('does not mistake ordinary string concatenation with no SQL keyword for embedded SQL', () => {
			expectNotHostCode(`String greeting = "Hello " + name + "!";`);
		});

		it('does not mistake "order" alone (not "ORDER BY") for the clause keyword', () => {
			expectNotHostCode(`String msg = "Please order " + item + " before " + date;`);
		});

		it('does not mistake DB2\'s own "||" concatenation (dynamic SQL) for host code', () => {
			expectNotHostCode(`SET stmt = 'SELECT * FROM ' || tabname || ' WHERE 1=1';`);
		});

		it('does not mistake an SQL PL assignment building dynamic SQL for a host declaration', () => {
			expectNotHostCode(`IF v_sort = 1 THEN SET v_stmt = 'SELECT * FROM widget ' || v_order; END IF;`);
		});

		it('leaves a single SQL string with a value added after it alone, since DB2 itself allows that', () => {
			expectNotHostCode(`SELECT * FROM t WHERE code = '1' + 2`);
		});

		it('leaves "+=" statements that build no SQL alone', () => {
			expectNotHostCode('msg = "Hello";\nmsg += "world";');
		});

		it('leaves a single double-quoted string with no declaration alone, since DB2 reads it as a name', () => {
			expectNotHostCode('"SELECT * FROM widget"');
		});

		it('reads a declared variable holding one SQL string as host code', () => {
			expect(extractOne(`String sql = "SELECT * FROM widget";`).sql).to.equal('SELECT * FROM widget');
		});
	});
});
