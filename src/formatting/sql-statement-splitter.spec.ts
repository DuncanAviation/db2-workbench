import { expect } from 'chai';
import { SqlStatementSplitter } from './sql-statement-splitter.js';
import { SqlTokenizer } from './sql-tokenizer.js';

function joined(span: SqlTokenizer.SqlToken[]): string {
	return span.map(token => token.text).join('');
}

describe('SqlStatementSplitter', () => {
	it('splits a simple multi-statement document', () => {
		let spans = SqlStatementSplitter.split(SqlTokenizer.tokenize('SELECT 1; SELECT 2;'));
		expect(spans.map(joined)).to.deep.equal(['SELECT 1;', ' SELECT 2;']);
	});

	it('does not split on a ";" inside a string literal', () => {
		let spans = SqlStatementSplitter.split(SqlTokenizer.tokenize(`SELECT 'a;b' FROM t;`));
		expect(spans).to.have.length(1);
		expect(joined(spans[0])).to.equal(`SELECT 'a;b' FROM t;`);
	});

	it('does not split on a ";" inside a line comment -- the regression this was built to fix', () => {
		let sql = 'SELECT id FROM t -- see note; discuss later\nWHERE id = 1;';
		let spans = SqlStatementSplitter.split(SqlTokenizer.tokenize(sql));
		expect(spans).to.have.length(1);
		expect(joined(spans[0])).to.equal(sql);
	});

	it('does not split on a ";" inside a block comment', () => {
		let sql = 'SELECT id FROM t /* a; b */ WHERE id = 1;';
		let spans = SqlStatementSplitter.split(SqlTokenizer.tokenize(sql));
		expect(spans).to.have.length(1);
		expect(joined(spans[0])).to.equal(sql);
	});

	it('does not split on a ";" nested inside parens', () => {
		let sql = `CALL myproc('a;b', 1);`;
		let spans = SqlStatementSplitter.split(SqlTokenizer.tokenize(sql));
		expect(spans).to.have.length(1);
	});

	it('keeps a CTE body\'s own dangling join/paren nesting intact across statements', () => {
		let sql = 'WITH x AS (SELECT id FROM t) SELECT id FROM x; SELECT 2;';
		let spans = SqlStatementSplitter.split(SqlTokenizer.tokenize(sql));
		expect(spans).to.have.length(2);
		expect(joined(spans[0])).to.equal('WITH x AS (SELECT id FROM t) SELECT id FROM x;');
	});

	it('handles a statement with no trailing semicolon at all', () => {
		let spans = SqlStatementSplitter.split(SqlTokenizer.tokenize('SELECT 1'));
		expect(spans).to.have.length(1);
		expect(joined(spans[0])).to.equal('SELECT 1');
	});

	it('drops an empty span produced by a stray extra semicolon', () => {
		let spans = SqlStatementSplitter.split(SqlTokenizer.tokenize('SELECT 1;;SELECT 2;'));
		expect(spans).to.have.length(2);
	});

	it('handles an empty document', () => {
		expect(SqlStatementSplitter.split(SqlTokenizer.tokenize(''))).to.deep.equal([]);
	});
});
