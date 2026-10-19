import { expect } from 'chai';
import { SqlDocumentFormatter } from './sql-document-formatter.js';

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

// The document is split on ";" before host code is extracted, so a query built over several host
// statements has to be put back together first - each "sql += ...;" alone holds no concatenation.
describe('SqlDocumentFormatter', () => {
	const HOST_CODE = 'let sql = ``;\n\n'
		+ '\t\t// select statement\n'
		+ '\t\tsql += `SELECT u.uid, u.fnam FROM gppuser as u `;\n'
		+ '\t\t// join statement\n'
		+ '\t\tsql += `JOIN gppteam as t on t.tmld = u.emcd `;\n'
		+ '\t\tsql += `JOIN gppdptm as d on (d.department_code = RIGHT(p.phdptn, 3) and d.record_status <> \'I\') `;\n';

	for(let [name, format] of [['Format Document', SqlDocumentFormatter.formatDocumentText], ['Format Selection', SqlDocumentFormatter.formatSelectionText]] as const) {
		it(`${name} joins a query built over several "sql +=" statements into one, with no host code left`, () => {
			let text = format(HOST_CODE, options);
			expect(text).to.not.match(/`|sql \+=|let sql|;/);
			expect(text).to.match(/^-- ?select statement\nSELECT/);
			expect(text).to.match(/-- ?join statement\n/);
			expect(text).to.match(/JOIN gppteam AS t ON t\.tmld = u\.emcd\s+JOIN gppdptm/);
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
});
