import { expect } from 'chai';
import { SqlStatementText } from './sql-statement-text.js';

describe('SqlStatementText', () => {
	describe('extractSelectedStatements', () => {
		describe('with an empty selection (a plain cursor)', () => {
			it('returns the whole text when there is no semicolon at all', () => {
				let text = 'select * from t';
				expect(SqlStatementText.extractSelectedStatements(text, 5, 5)).to.deep.equal(['select * from t']);
			});

			it('bounds to the statement containing the cursor when multiple statements exist', () => {
				let text = 'select * from a; select * from b; select * from c';
				let offset = text.indexOf('from b');
				expect(SqlStatementText.extractSelectedStatements(text, offset, offset)).to.deep.equal(['select * from b']);
			});

			it('trims leading/trailing whitespace', () => {
				let text = '  select * from t  ;';
				expect(SqlStatementText.extractSelectedStatements(text, 5, 5)).to.deep.equal(['select * from t']);
			});

			it('returns an empty array for a blank statement', () => {
				let text = ';   ;';
				expect(SqlStatementText.extractSelectedStatements(text, 2, 2)).to.deep.equal([]);
			});

			it('includes text after the cursor up to the next semicolon', () => {
				let text = 'select * from t';
				let offset = 'select '.length;
				expect(SqlStatementText.extractSelectedStatements(text, offset, offset)).to.deep.equal(['select * from t']);
			});
		});

		describe('with a non-empty (highlighted) selection', () => {
			it('returns only the one statement when the selection sits entirely inside it', () => {
				let text = 'select * from a; select * from b; select * from c';
				let start = text.indexOf('from b');
				let end = start + 'from b'.length;
				expect(SqlStatementText.extractSelectedStatements(text, start, end)).to.deep.equal(['select * from b']);
			});

			it('returns every statement the selection touches at all, in document order', () => {
				let text = 'select * from a; select * from b; select * from c';
				let start = text.indexOf('from a');
				let end = text.indexOf('from c') + 1;
				expect(SqlStatementText.extractSelectedStatements(text, start, end)).to.deep.equal([
					'select * from a',
					'select * from b',
					'select * from c'
				]);
			});

			it('does not include a statement the selection merely touches at its boundary', () => {
				let text = 'select * from a; select * from b;';
				let secondStart = text.indexOf('select * from b');
				expect(SqlStatementText.extractSelectedStatements(text, secondStart, text.length)).to.deep.equal(['select * from b']);
			});

			it('does not split on a ";" inside a quoted string', () => {
				let text = `call proc('a;b'); select * from t;`;
				let start = text.indexOf(`'a;b'`);
				expect(SqlStatementText.extractSelectedStatements(text, start, start + 1)).to.deep.equal([`call proc('a;b')`]);
			});
		});
	});

	describe('extractStatementUpToCursor', () => {
		it('stops exactly at the cursor, not the trailing semicolon', () => {
			let text = 'select * from t;';
			let offset = 'select * '.length;
			expect(SqlStatementText.extractStatementUpToCursor(text, offset)).to.equal('select * ');
		});

		it('does not include a prior statement', () => {
			let text = 'select * from a; select ';
			expect(SqlStatementText.extractStatementUpToCursor(text, text.length)).to.equal(' select ');
		});

		it('spans multiple lines', () => {
			let text = 'select a,\nb\nfrom t';
			let offset = text.indexOf('from');
			expect(SqlStatementText.extractStatementUpToCursor(text, offset)).to.equal('select a,\nb\n');
		});
	});

	describe('getCaretPosition', () => {
		it('is 1-based and relative to the statement, not the document', () => {
			let text = 'select * from a;\nselect *\nfrom b';
			let offset = text.indexOf('from b');
			let position = SqlStatementText.getCaretPosition(text, offset);
			// The second statement starts right after "a;\n", so within ITS OWN text
			// ("select *\nfrom b") the cursor sits on line 2, not document line 3.
			expect(position).to.deep.equal({lineNumber: 2, column: 1});
		});

		it('reports column 1 at the very start of a statement', () => {
			let text = 'select * from a;\nselect';
			let offset = text.indexOf('select', 1);
			expect(SqlStatementText.getCaretPosition(text, offset)).to.deep.equal({lineNumber: 1, column: 1});
		});

		it('counts columns correctly on a single-line statement', () => {
			let text = 'select ';
			expect(SqlStatementText.getCaretPosition(text, text.length)).to.deep.equal({lineNumber: 1, column: 8});
		});
	});

	describe('getStatementStart', () => {
		it('is 0 when there is no preceding semicolon', () => {
			expect(SqlStatementText.getStatementStart('select * from t', 5)).to.equal(0);
		});

		it('is right after the nearest preceding semicolon', () => {
			let text = 'select * from a; select * from b';
			let offset = text.indexOf('from b');
			expect(SqlStatementText.getStatementStart(text, offset)).to.equal(text.indexOf(';') + 1);
		});

		it('ignores a ";" inside a comment or string', () => {
			let text = `-- a; b\nselect ';' /* c; */ from a`;
			expect(SqlStatementText.getStatementStart(text, text.length)).to.equal(0);
		});
	});

	describe('extractAllStatements', () => {
		it('does not let an apostrophe in a line comment swallow later statements', () => {
			let text = `--the body's length\nselect a from b\n;\nselect c from d\n;\nselect e from f where g = 'X'\n;\nselect h from i`;
			expect(SqlStatementText.extractAllStatements(text)).to.deep.equal([
				`--the body's length\nselect a from b`,
				'select c from d',
				`select e from f where g = 'X'`,
				'select h from i',
			]);
		});

		it('ignores a ";" inside a block comment, a delimited identifier or a string with a doubled quote', () => {
			let text = `select 'it''s; here', "x;y" /* ; */ from a; select 1 from b`;
			expect(SqlStatementText.extractAllStatements(text)).to.deep.equal([
				`select 'it''s; here', "x;y" /* ; */ from a`,
				'select 1 from b',
			]);
		});

		it('drops blank statements', () => {
			expect(SqlStatementText.extractAllStatements(';  ;\n')).to.deep.equal([]);
		});
	});

	describe('extractSelectedStatements with comments', () => {
		it('resolves the last statement when an earlier comment holds an apostrophe', () => {
			let text = `--the body's length\nselect a from b\n;\nselect c from d where e = 'X'\n;\nselect f from g`;
			let offset = text.indexOf('from g');
			expect(SqlStatementText.extractSelectedStatements(text, offset, offset)).to.deep.equal(['select f from g']);
		});
	});
});
