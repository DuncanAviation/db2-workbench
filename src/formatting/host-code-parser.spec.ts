import { expect } from 'chai';
import { HostCodeLexer } from './host-code-lexer.js';
import { HostCodeParser } from './host-code-parser.js';

function parse(text: string): HostCodeParser.Statement[] {
	return HostCodeParser.parse(HostCodeLexer.lex(text));
}

// Each statement as its kind and source text, nested statements in brackets.
function outline(text: string, statements = parse(text)): unknown[] {
	return statements.map(statement => {
		switch(statement.kind) {
			case 'control':
				return {[statement.keyword]: statement.header, body: outline(text, statement.body), ...(statement.elseBody ? {else: outline(text, statement.elseBody)} : {})};
			case 'block':
				return {block: outline(text, statement.body)};
			default:
				return `${statement.kind}: ${text.substring(statement.start, statement.end)}`;
		}
	});
}

describe('HostCodeLexer', () => {
	function values(text: string): unknown[] {
		return HostCodeLexer.lex(text).filter(token => HostCodeLexer.isString(token)).map(token => token.segments ?? token.value);
	}

	it('decodes escapes in quoted strings', () => {
		expect(values(`"a\\"b\\n" 'c\\'d'`)).to.deep.equal(['a"b\n', `c'd`]);
	});

	it('splits template literals and C# interpolated strings into literals and expressions', () => {
		expect(values('`a ${x.y} b ${f({k: 1})}`')).to.deep.equal([[
			{kind: 'literal', text: 'a '}, {kind: 'expression', text: 'x.y'}, {kind: 'literal', text: ' b '}, {kind: 'expression', text: 'f({k: 1})'}
		]]);
		expect(values('$"a {{b}} {c:N2}"')).to.deep.equal([[{kind: 'literal', text: 'a {b} '}, {kind: 'expression', text: 'c'}]]);
	});

	it('reads C# verbatim strings and Java text blocks', () => {
		expect(values('@"a ""b"" \\n"')).to.deep.equal(['a "b" \\n']);
		expect(values('"""\nSELECT 1\n"""')).to.deep.equal(['\nSELECT 1\n']);
	});

	it('reads a SQL "--" comment as a comment, so an apostrophe in it opens no string', () => {
		let tokens = HostCodeLexer.lex(`-- don't\nx = 1; i--;`);
		expect(tokens[0]).to.include({type: 'lineComment', text: `-- don't`});
		expect(tokens.some(token => token.type === 'string')).to.equal(false);
		expect(tokens.some(token => token.type === 'punctuation' && token.text === '--')).to.equal(true);
	});

	it('ends an unterminated quoted string at the end of its line', () => {
		let tokens = HostCodeLexer.lex(`"abc\nx`);
		expect(tokens[0]).to.include({type: 'string', value: 'abc'});
		expect(tokens.at(-1)).to.include({type: 'word', text: 'x'});
	});
});

describe('HostCodeParser', () => {
	it('ends statements at ";", and at a line break only where the line is complete', () => {
		expect(outline('let a = 1\nlet b =\n  2 +\n  3\nfoo()\n  .bar(); baz()')).to.deep.equal([
			'simple: let a = 1',
			'simple: let b =\n  2 +\n  3',
			'simple: foo()\n  .bar();',
			'simple: baz()'
		]);
	});

	it('nests if/else-if/else, loops and blocks', () => {
		expect(outline('if (a) { x(); } else if (b) y(); else { z(); }\nfor (const i of l) w();')).to.deep.equal([
			{if: '(a)', body: ['simple: x();'], else: [{if: '(b)', body: ['simple: y();'], else: ['simple: z();']}]},
			{for: '(const i of l)', body: ['simple: w();']}
		]);
	});

	it('keeps comments between statements as statements of their own', () => {
		expect(outline('// one\nx();\n/* two */')).to.deep.equal(['comment: // one', 'simple: x();', 'comment: /* two */']);
	});

	it('recognizes a plain SQL statement running over several lines, and a host call that only looks like one', () => {
		expect(outline('SELECT id\n  FROM t\n  WHERE a = 1;\nupdate(row);\nUpdate update = make();')).to.deep.equal([
			'sql: SELECT id\n  FROM t\n  WHERE a = 1;',
			'simple: update(row);',
			'simple: Update update = make();'
		]);
	});

	it('copes with a paste that starts or ends partway through a block', () => {
		expect(outline('  x();\n}\nif (a) {\n  y();')).to.deep.equal([
			'simple: x();',
			{if: '(a)', body: ['simple: y();']}
		]);
	});
});
