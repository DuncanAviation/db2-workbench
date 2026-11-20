import { expect } from 'chai';
import { SqlDocumentFormatter } from './sql-document-formatter.js';

// Every table and column name here is made up.

const options: SqlDocumentFormatter.Options = {
	tabWidth: 2,
	useTabs: false,
	keywordCase: 'upper',
	denseOperators: false,
	removeComments: false,
	expressionMaxWidth: 40,
	selectFieldWrapping: 'wrapToWidth',
	clauseLayout: 'compact',
	indentJoins: false,
	indentWhere: false,
	linesBetweenQueries: 1
};

// The extension's default formatting settings.
const defaults: SqlDocumentFormatter.Options = {
	tabWidth: 4,
	useTabs: true,
	keywordCase: 'preserve',
	denseOperators: false,
	removeComments: false,
	expressionMaxWidth: 120,
	selectFieldWrapping: 'wrapToWidth',
	clauseLayout: 'compact',
	indentJoins: false,
	indentWhere: false,
	linesBetweenQueries: 1
};

describe('SqlDocumentFormatter', () => {
	const HOST_CODE = 'let sql = ``;\n\n'
		+ '\t\t// select statement\n'
		+ '\t\tsql += `SELECT s.id, s.first_name FROM staff as s `;\n'
		+ '\t\t// join statement\n'
		+ '\t\tsql += `JOIN team as t on t.lead_id = s.id `;\n'
		+ '\t\tsql += `JOIN location as l on (l.dept_code = RIGHT(s.dept_code, 3) and l.status <> \'I\') `;\n';

	for(let [name, format] of [['Format Document', SqlDocumentFormatter.formatDocumentText], ['Format Selection', SqlDocumentFormatter.formatSelectionText]] as const) {
		it(`${name} joins a query built over several "sql +=" statements into one, with no host code left`, () => {
			let text = format(HOST_CODE, options);
			expect(text).to.not.match(/`|sql \+=|let sql|;/);
			expect(text).to.match(/^-- ?select statement\nSELECT/);
			expect(text).to.match(/-- ?join statement\nJOIN team/);
			expect(text).to.match(/JOIN team AS t ON t\.lead_id = s\.id\s+JOIN location/);
		});
	}

	it('keeps a plain DB2 statement after the host code as its own statement', () => {
		let text = SqlDocumentFormatter.formatDocumentText('String sql = "SELECT a ";\nsql += "FROM t";\n\nSELECT id FROM departments;', options);
		expect(text).to.not.match(/String|sql \+=|"/);
		expect(text.split(';').length - 1).to.equal(2);
		expect(text).to.match(/FROM t;\s+SELECT id\s+FROM departments;$/);
	});

	it('leaves "+=" statements that build no SQL to format one at a time', () => {
		let text = SqlDocumentFormatter.formatDocumentText('msg = "Hello";\nmsg += "world";', options);
		expect(text.split(';').length - 1).to.equal(2);
	});

	// Pastes shaped like real application code, each formatted with the default settings.
	describe('pasted application code', () => {
		const examples: {name: string; input: string; expected: string}[] = [
			{
				name: 'a query built with "sql +=" under if statements',
				input: 'sql += `SELECT s.id, s.first_name, s.last_name, l.region as REGION, RIGHT(s.dept_code, 3) as DEPT, t.id as TEAM_ID `;\n'
					+ '\t\tsql += `FROM staff as s `;\n'
					+ '\t\t// join statement\n'
					+ '\t\tsql += `JOIN team as t on t.lead_id = s.id `;\n'
					+ '\t\tsql += `JOIN location as l on (l.dept_code = RIGHT(s.dept_code, 3) and l.status <> \'I\') `;\n'
					+ '\t\t// where statement\n'
					+ '\t\tsql += `WHERE 1 = 1 `;\n'
					+ '\t\tif(StringUtils.isNotEmpty(search.site)) {\n'
					+ '\t\t\tsql += `AND s.site = :site `;\n'
					+ '\t\t}\n'
					+ '\t\t\n'
					+ '\t\tif(StringUtils.isNotEmpty(search.deptNumber)) {\n'
					+ '\t\t\tsql += `AND SUBSTR(CHAR(s.dept_code), LENGTH(CHAR(s.dept_code)) - 2, 3)  = :deptNumber `;\n'
					+ '\t\t}\n',
				expected: 'SELECT s.id, s.first_name, s.last_name, l.region as REGION, RIGHT(s.dept_code, 3) as DEPT, t.id as TEAM_ID\n'
					+ 'FROM staff as s\n'
					+ '-- join statement\n'
					+ 'JOIN team as t on t.lead_id = s.id\n'
					+ 'JOIN location as l on (l.dept_code = RIGHT(s.dept_code, 3) and l.status <> \'I\')\n'
					+ '-- where statement\n'
					+ 'WHERE 1 = 1\n'
					+ '-- if (StringUtils.isNotEmpty(search.site))\n'
					+ 'AND s.site = :site\n'
					+ '-- if (StringUtils.isNotEmpty(search.deptNumber))\n'
					+ 'AND SUBSTR(CHAR(s.dept_code), LENGTH(CHAR(s.dept_code)) - 2, 3) = :deptNumber'
			},
			{
				name: 'a bare concatenation with an EXCEPTION JOIN and a correlated subquery',
				input: '`SELECT \'\', c.cust_no, c.name, ct.email, 0, \'Y\' ` +\n'
					+ '\t\t\t`FROM customer AS c ` +\n'
					+ '\t\t\t`JOIN contact AS ct ON ct.request_id = c.request_id ` +\n'
					+ '\t\t\t`EXCEPTION JOIN request_log as rl on (rl.request_id = c.request_id and rl.kind = \'NEW\') ` +\n'
					+ '\t\t\t`WHERE c.cust_no = :customerNumber ` +\n'
					+ '\t\t\t\t`AND NOT EXISTS ( ` +\n'
					+ '\t\t\t\t\t`SELECT 1 FROM app_user AS u ` +\n'
					+ '\t\t\t\t\t`WHERE u.contact_id = ct.id ` +\n'
					+ '\t\t\t\t`) `;',
				expected: 'SELECT \'\', c.cust_no, c.name, ct.email, 0, \'Y\'\n'
					+ 'FROM customer AS c\n'
					+ 'JOIN contact AS ct ON ct.request_id = c.request_id\n'
					+ 'EXCEPTION JOIN request_log as rl on (rl.request_id = c.request_id and rl.kind = \'NEW\')\n'
					+ 'WHERE c.cust_no = :customerNumber\n'
					+ 'AND NOT EXISTS (\n'
					+ '\tSELECT 1\n'
					+ '\tFROM app_user AS u\n'
					+ '\tWHERE u.contact_id = ct.id\n'
					+ ')'
			},
			{
				name: 'an interpolated select list, a CASE with AND inside it, and a dangling "+"',
				input: '`SELECT ${select} FROM request_log AS rl ` +\n'
					+ '\t\t\t`LEFT JOIN contact AS ct ON ct.request_id = rl.request_id ` +\n'
					+ '\t\t\t`WHERE rl.kind = \'NEW\' ` +\n'
					+ '\t\t\t\t`AND CASE WHEN rl.kind = \'NEW\' AND rl.new_value <> \'\' THEN dec(rl.new_value, 9, 0) END = u.id` +',
				expected: 'SELECT :select\n'
					+ 'FROM request_log AS rl\n'
					+ 'LEFT JOIN contact AS ct ON ct.request_id = rl.request_id\n'
					+ 'WHERE rl.kind = \'NEW\'\n'
					+ 'AND CASE WHEN rl.kind = \'NEW\' AND rl.new_value <> \'\' THEN dec(rl.new_value, 9, 0) END = u.id'
			},
			{
				name: 'a declaration whose value starts on the next line',
				input: 'let sql =\n'
					+ '\t\t\t`select u.id, u.status, u.email, ` +\n'
					+ '\t\t\t`m.id as LINK_ID, m.title ` +\n'
					+ '\t\t\t`from app_user u ` +\n'
					+ '\t\t\t`join membership m on m.user_id = u.id and m.status = \'A\' and m.company_id in (:companyId) ` +\n'
					+ '\t\t\t`where u.status = \'A\' `;',
				expected: 'select u.id, u.status, u.email, m.id as LINK_ID, m.title\n'
					+ 'from app_user u\n'
					+ 'join membership m on m.user_id = u.id and m.status = \'A\' and m.company_id in (:companyId)\n'
					+ 'where u.status = \'A\''
			}
		];

		for(let example of examples) {
			it(`formats ${example.name}`, () => {
				let text = SqlDocumentFormatter.formatDocumentText(example.input, defaults);
				expect(text).to.equal(example.expected);
				expect(SqlDocumentFormatter.formatDocumentText(text, defaults), 'formatting the result again changes nothing').to.equal(text);
			});
		}
	});
});
