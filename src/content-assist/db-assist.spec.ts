import { expect } from 'chai';
import { SystemSchema } from '../models/system-schema.js';
import { DbAssist } from './db-assist.js';

function schema(name: string, description = ''): SystemSchema {
	return {name: name, type: 'SCHEMA', description: description};
}

// Extension is only ever used as a type here (never a real runtime import), so a plain object
// shaped like the handful of methods DbAssist actually calls stands in fine -- no mocking
// framework needed. Cast past the real class's structural shape rather than trying to satisfy it.
function fakeExtension(schemas: SystemSchema[] = []) {
	return {
		memoryCache: {
			getSchemas: async () => schemas
		},
		connections: {
			getConnectionConfig: async () => undefined
		},
		configurations: {
			useAlias: 'Smart'
		}
	} as unknown as import('../extension.js').Extension;
}

describe('DbAssist', () => {
	describe('getLastKeyword', () => {
		let core = new DbAssist(fakeExtension());

		it('finds the nearest keyword searching backward', () => {
			expect(core.getLastKeyword('SELECT id FROM employees WHERE ')).to.equal('WHERE');
		});

		it('returns undefined when there is no keyword at all', () => {
			expect(core.getLastKeyword('employees')).to.equal(undefined);
		});

		it('matches a multi-word keyword that wraps across lines', () => {
			expect(core.getLastKeyword('SELECT * FROM a LEFT\nJOIN b ')).to.equal('LEFT\nJOIN');
		});

		it('is case-insensitive', () => {
			expect(core.getLastKeyword('select * from t where ')).to.equal('where');
		});
	});

	describe('includeAlias', () => {
		it('is always true when useAlias is "Always", regardless of smartInclude', () => {
			let core = new DbAssist(fakeExtension());
			(<any>core.extension).configurations.useAlias = 'Always';
			expect(core.includeAlias({smartInclude: () => false})).to.equal(true);
		});

		it('is always false when useAlias is "Never", regardless of smartInclude', () => {
			let core = new DbAssist(fakeExtension());
			(<any>core.extension).configurations.useAlias = 'Never';
			expect(core.includeAlias({smartInclude: () => true})).to.equal(false);
		});

		it('defers to smartInclude when useAlias is "Smart"', () => {
			let core = new DbAssist(fakeExtension());
			(<any>core.extension).configurations.useAlias = 'Smart';
			expect(core.includeAlias({smartInclude: () => true})).to.equal(true);
			expect(core.includeAlias({smartInclude: () => false})).to.equal(false);
		});
	});

	describe('getDotMatch', () => {
		it('resolves a schema-qualified reference', async () => {
			let core = new DbAssist(fakeExtension([schema('MYSCHEMA')]));
			let dotMatch = await core.getDotMatch({key: 'k', sql: 'SELECT * FROM myschema.', caretPosition: {lineNumber: 1, column: 1}});
			expect(dotMatch?.schema?.name).to.equal('MYSCHEMA');
			expect(dotMatch?.value).to.equal('');
		});

		it('treats an unresolved name as a table/alias reference, not a schema', async () => {
			let core = new DbAssist(fakeExtension([schema('MYSCHEMA')]));
			let dotMatch = await core.getDotMatch({key: 'k', sql: 'SELECT * FROM mytable.', caretPosition: {lineNumber: 1, column: 1}});
			expect(dotMatch?.schema).to.equal(undefined);
			expect(dotMatch?.tableReference).to.equal('mytable');
		});

		it('resolves "qualifier.name." as schema + table reference', async () => {
			let core = new DbAssist(fakeExtension([schema('MYSCHEMA')]));
			let dotMatch = await core.getDotMatch({key: 'k', sql: 'SELECT * FROM myschema.mytable.', caretPosition: {lineNumber: 1, column: 1}});
			expect(dotMatch?.schema?.name).to.equal('MYSCHEMA');
			expect(dotMatch?.tableReference).to.equal('mytable');
		});

		it('captures the partial value typed after the last resolved segment', async () => {
			let core = new DbAssist(fakeExtension([schema('MYSCHEMA')]));
			let dotMatch = await core.getDotMatch({key: 'k', sql: 'SELECT * FROM myschema.mytable.co', caretPosition: {lineNumber: 1, column: 1}});
			expect(dotMatch?.value).to.equal('co');
		});

		it('returns just a value when there is no dot at all', async () => {
			let core = new DbAssist(fakeExtension());
			let dotMatch = await core.getDotMatch({key: 'k', sql: 'SELECT * FROM mytab', caretPosition: {lineNumber: 1, column: 1}});
			expect(dotMatch?.schema).to.equal(undefined);
			expect(dotMatch?.tableReference).to.equal(undefined);
			expect(dotMatch?.value).to.equal('mytab');
		});

		it('strips a trailing open paren before matching', async () => {
			// With no trailing dot, "mytable" lands in .value (not .tableReference) -- same
			// convention SqlAssist.resolveInsertTable already relies on for "INSERT INTO
			// schema.table (col1, ..." (it reads dotMatch.value as the table name). The point of
			// this test is specifically that the trailing "(" doesn't break the match at all: without
			// stripping it first, the regex (anchored to "$") wouldn't match anything past it.
			let core = new DbAssist(fakeExtension([schema('MYSCHEMA')]));
			let dotMatch = await core.getDotMatch({key: 'k', sql: 'INSERT INTO myschema.mytable (', caretPosition: {lineNumber: 1, column: 1}});
			expect(dotMatch?.schema?.name).to.equal('MYSCHEMA');
			expect(dotMatch?.value).to.equal('mytable');
		});
	});

	describe('getKeyWordItems', () => {
		it('returns one descriptor per keyword, defaulting to ALL_KEYWORDS', () => {
			let core = new DbAssist(fakeExtension());
			let items = core.getKeyWordItems();
			expect(items.length).to.equal(DbAssist.ALL_KEYWORDS.length);
			expect(items[0]).to.deep.equal({
				label: DbAssist.ALL_KEYWORDS[0],
				insertText: DbAssist.ALL_KEYWORDS[0],
				kind: 'Keyword',
				sortText: DbAssist.ItemSortOrder.KEY_WORDS
			});
		});

		it('uses a custom keyword list when given one', () => {
			let core = new DbAssist(fakeExtension());
			let items = core.getKeyWordItems(['FROM', 'WHERE']);
			expect(items).to.deep.equal([
				{label: 'FROM', insertText: 'FROM', kind: 'Keyword', sortText: DbAssist.ItemSortOrder.KEY_WORDS},
				{label: 'WHERE', insertText: 'WHERE', kind: 'Keyword', sortText: DbAssist.ItemSortOrder.KEY_WORDS}
			]);
		});
	});

	describe('getSchemaItems', () => {
		it('returns an empty array when there are no schemas', async () => {
			let core = new DbAssist(fakeExtension([]));
			expect(await core.getSchemaItems('k')).to.deep.equal([]);
		});

		it('includes the description in the label when present', async () => {
			let core = new DbAssist(fakeExtension([schema('MYSCHEMA', 'My schema')]));
			let items = await core.getSchemaItems('k');
			expect(items).to.deep.equal([{
				label: 'MYSCHEMA (My schema)',
				insertText: 'MYSCHEMA',
				kind: 'Module',
				sortText: DbAssist.ItemSortOrder.SCHEMAS
			}]);
		});

		it('falls back to just the name when there is no description', async () => {
			let core = new DbAssist(fakeExtension([schema('MYSCHEMA')]));
			let items = await core.getSchemaItems('k');
			expect(items).to.deep.equal([{
				label: 'MYSCHEMA',
				insertText: 'MYSCHEMA',
				kind: 'Module',
				sortText: DbAssist.ItemSortOrder.SCHEMAS
			}]);
		});

		it('returns one descriptor per schema, in order', async () => {
			let core = new DbAssist(fakeExtension([schema('AAA'), schema('BBB')]));
			let items = await core.getSchemaItems('k');
			expect(items.map(i => i.label)).to.deep.equal(['AAA', 'BBB']);
		});
	});
});

describe('DbAssist.getDominantCasing', () => {
	it('defaults to lower for blank/undefined input', () => {
		expect(DbAssist.getDominantCasing(undefined)).to.equal('lower');
		expect(DbAssist.getDominantCasing('')).to.equal('lower');
	});

	it('detects predominantly uppercase keywords', () => {
		expect(DbAssist.getDominantCasing('SELECT id FROM employees WHERE active = 1')).to.equal('upper');
	});

	it('detects predominantly lowercase keywords', () => {
		expect(DbAssist.getDominantCasing('select id from employees where active = 1')).to.equal('lower');
	});

	it('ignores non-keyword words when tallying casing', () => {
		// Only SELECT/FROM/WHERE count -- table/column names shouldn't skew the tally.
		expect(DbAssist.getDominantCasing('SELECT MyColumn FROM MyTable WHERE MyFlag = 1')).to.equal('upper');
	});

	it('falls back to lower on an exact tie', () => {
		expect(DbAssist.getDominantCasing('select id FROM employees')).to.equal('lower');
	});
});
