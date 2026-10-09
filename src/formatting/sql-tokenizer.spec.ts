import { expect } from 'chai';
import { SqlTokenizer } from './sql-tokenizer.js';

function significant(sql: string): SqlTokenizer.SqlToken[] {
	return SqlTokenizer.tokenize(sql).filter(token => token.type !== SqlTokenizer.TokenType.WHITESPACE);
}

describe('SqlTokenizer', () => {
	it('classifies a simple SELECT statement', () => {
		let tokens = significant('SELECT id FROM t');
		expect(tokens.map(token => token.text)).to.deep.equal(['SELECT', 'id', 'FROM', 't']);
		expect(tokens.every(token => token.type === SqlTokenizer.TokenType.WORD)).to.equal(true);
	});

	it('classifies punctuation, strings, and numbers', () => {
		let tokens = significant(`SELECT 1, 'a' FROM t WHERE id = 2`);
		let byText = new Map(tokens.map(token => [token.text, token.type]));
		expect(byText.get(',')).to.equal(SqlTokenizer.TokenType.PUNCTUATION);
		expect(byText.get(`'a'`)).to.equal(SqlTokenizer.TokenType.STRING);
		expect(byText.get('1')).to.equal(SqlTokenizer.TokenType.NUMBER);
		expect(byText.get('=')).to.equal(SqlTokenizer.TokenType.OPERATOR);
	});

	it('classifies a quoted identifier', () => {
		let tokens = significant(`SELECT "My Column" FROM t`);
		expect(tokens[1].text).to.equal('"My Column"');
		expect(tokens[1].type).to.equal(SqlTokenizer.TokenType.QUOTED_IDENTIFIER);
	});

	it('classifies line and block comments', () => {
		let tokens = significant('SELECT id -- trailing note\nFROM t /* block */');
		let types = tokens.map(token => token.type);
		expect(types).to.include(SqlTokenizer.TokenType.LINE_COMMENT);
		expect(types).to.include(SqlTokenizer.TokenType.BLOCK_COMMENT);
	});

	it('classifies a named parameter marker', () => {
		// dt-sql-parser's own lexer already tokenizes ":custId" as one whole token (there's no
		// colon-less grammar rule it could otherwise match against) rather than ":" and "custId"
		// separately -- classify() matches on that whole token by prefix, see sql-tokenizer.ts.
		let tokens = significant('SELECT id FROM t WHERE id = :custId');
		let marker = tokens.find(token => token.text === ':custId');
		expect(marker?.type).to.equal(SqlTokenizer.TokenType.PARAM_MARKER);
	});

	it('classifies a positional parameter marker', () => {
		let tokens = significant('SELECT id FROM t WHERE id = ?');
		let marker = tokens.find(token => token.text === '?');
		expect(marker?.type).to.equal(SqlTokenizer.TokenType.PARAM_MARKER);
	});

	it('losslessly reconstructs the original text, including a DB2 identifier with "#"', () => {
		let sql = `SELECT id FROM my#lib.app#hist WHERE id = 1 -- note\n`;
		let tokens = SqlTokenizer.tokenize(sql);
		expect(tokens.map(token => token.text).join('')).to.equal(sql);
	});

	it('never throws on deliberately malformed SQL', () => {
		expect(() => SqlTokenizer.tokenize('SELECT FROM FROM WHERE (((')).to.not.throw();
	});

	it('losslessly reconstructs malformed SQL too', () => {
		let sql = 'SELECT FROM FROM WHERE (((';
		let tokens = SqlTokenizer.tokenize(sql);
		expect(tokens.map(token => token.text).join('')).to.equal(sql);
	});

	it('handles an empty string', () => {
		expect(SqlTokenizer.tokenize('')).to.deep.equal([]);
	});
});
