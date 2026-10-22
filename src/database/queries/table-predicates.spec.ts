import { expect } from 'chai';
import { buildTablePredicate, chunkSchemaNames, chunkTableTargets, MAX_SCHEMAS_PER_QUERY, tableTargetKey, toTableTargets } from './table-predicates.js';

const COLUMNS = {schema: 'dbname', table: 'tbname'};

describe('toTableTargets', () => {
	it('widens a single target into a one-element batch', () => {
		expect(toTableTargets({schema: 'hr', table: 'employee'})).to.deep.equal([{schema: 'HR', table: 'EMPLOYEE'}]);
	});

	it('is empty for undefined, so a caller asking about nothing needs no guard of its own', () => {
		expect(toTableTargets(undefined)).to.deep.equal([]);
	});

	it('is empty for an empty array', () => {
		expect(toTableTargets([])).to.deep.equal([]);
	});

	it('uppercases and trims both parts', () => {
		expect(toTableTargets([{schema: ' hr ', table: ' employee '}])).to.deep.equal([{schema: 'HR', table: 'EMPLOYEE'}]);
	});

	it('keeps a target with no schema, which autocomplete asks with', () => {
		expect(toTableTargets([{table: 'employee'}])).to.deep.equal([{schema: undefined, table: 'EMPLOYEE'}]);
	});

	it('treats a blank schema as no schema', () => {
		expect(toTableTargets([{schema: '   ', table: 'employee'}])).to.deep.equal([{schema: undefined, table: 'EMPLOYEE'}]);
	});

	it('drops a target naming no table', () => {
		expect(toTableTargets([{schema: 'HR', table: '  '}, {schema: 'HR', table: 'EMPLOYEE'}]))
			.to.deep.equal([{schema: 'HR', table: 'EMPLOYEE'}]);
	});

	it('de-duplicates targets that differ only by case', () => {
		expect(toTableTargets([{schema: 'HR', table: 'EMPLOYEE'}, {schema: 'hr', table: 'employee'}]))
			.to.deep.equal([{schema: 'HR', table: 'EMPLOYEE'}]);
	});

	it('keeps the same table in two schemas apart', () => {
		expect(toTableTargets([{schema: 'HR', table: 'EMPLOYEE'}, {schema: 'PAYROLL', table: 'EMPLOYEE'}])).to.have.lengthOf(2);
	});

	it('keeps a schema-less target apart from the same table with a schema', () => {
		expect(toTableTargets([{table: 'EMPLOYEE'}, {schema: 'HR', table: 'EMPLOYEE'}])).to.have.lengthOf(2);
	});

	it('preserves the order targets were asked in', () => {
		let targets = toTableTargets([{schema: 'B', table: 'TWO'}, {schema: 'A', table: 'ONE'}]);
		expect(targets.map(target => target.table)).to.deep.equal(['TWO', 'ONE']);
	});
});

describe('tableTargetKey', () => {
	it('is case insensitive', () => {
		expect(tableTargetKey('HR', 'EMPLOYEE')).to.equal(tableTargetKey('hr', 'employee'));
	});

	it('distinguishes no schema from a schema', () => {
		expect(tableTargetKey(undefined, 'EMPLOYEE')).to.not.equal(tableTargetKey('HR', 'EMPLOYEE'));
	});
});

describe('buildTablePredicate', () => {
	it('matches on schema and table when both are known', () => {
		let predicate = buildTablePredicate(toTableTargets({schema: 'hr', table: 'employee'}), COLUMNS);

		expect(predicate.clause).to.equal('(dbname = ? and tbname = ?)');
		expect(predicate.parameters).to.deep.equal(['HR', 'EMPLOYEE']);
	});

	it('matches on table alone when no schema is known', () => {
		let predicate = buildTablePredicate(toTableTargets({table: 'employee'}), COLUMNS);

		expect(predicate.clause).to.equal('tbname = ?');
		expect(predicate.parameters).to.deep.equal(['EMPLOYEE']);
	});

	it('lists one schema\'s tables in a single IN, in order', () => {
		let predicate = buildTablePredicate(toTableTargets([{schema: 'HR', table: 'EMPLOYEE'}, {schema: 'HR', table: 'DEPARTMENT'}]), COLUMNS);

		expect(predicate.clause).to.equal('(dbname = ? and tbname in (?, ?))');
		expect(predicate.parameters).to.deep.equal(['HR', 'EMPLOYEE', 'DEPARTMENT']);
	});

	it('ors one clause per schema, in the order each schema first appears', () => {
		let predicate = buildTablePredicate(toTableTargets([
			{schema: 'HR', table: 'EMPLOYEE'},
			{schema: 'SALES', table: 'ORDERS'},
			{schema: 'HR', table: 'DEPARTMENT'}
		]), COLUMNS);

		expect(predicate.clause).to.equal('(dbname = ? and tbname in (?, ?)) or (dbname = ? and tbname = ?)');
		expect(predicate.parameters).to.deep.equal(['HR', 'EMPLOYEE', 'DEPARTMENT', 'SALES', 'ORDERS']);
	});

	it('mixes schema-qualified and bare targets in one clause', () => {
		let predicate = buildTablePredicate(toTableTargets([{schema: 'HR', table: 'EMPLOYEE'}, {table: 'DEPARTMENT'}]), COLUMNS);

		expect(predicate.clause).to.equal('(dbname = ? and tbname = ?) or tbname = ?');
		expect(predicate.parameters).to.deep.equal(['HR', 'EMPLOYEE', 'DEPARTMENT']);
	});

	it('lists several bare targets in one IN', () => {
		let predicate = buildTablePredicate(toTableTargets([{table: 'EMPLOYEE'}, {table: 'DEPARTMENT'}]), COLUMNS);

		expect(predicate.clause).to.equal('tbname in (?, ?)');
		expect(predicate.parameters).to.deep.equal(['EMPLOYEE', 'DEPARTMENT']);
	});

	it('uses the catalog column names it is given', () => {
		let predicate = buildTablePredicate(toTableTargets({schema: 'HR', table: 'EMPLOYEE'}), {schema: 'a.system_table_schema', table: 'a.system_table_name'});

		expect(predicate.clause).to.equal('(a.system_table_schema = ? and a.system_table_name = ?)');
	});

	it('is an empty clause for no targets, so callers must not run the query', () => {
		expect(buildTablePredicate([], COLUMNS)).to.deep.equal({clause: '', parameters: []});
	});
});

describe('chunkTableTargets', () => {
	function targets(count: number) {
		return toTableTargets(Array.from({length: count}, (ignored, index) => ({schema: 'HR', table: `TABLE${index}`})));
	}

	it('is empty for no targets', () => {
		expect(chunkTableTargets([])).to.deep.equal([]);
	});

	it('keeps a batch under the limit as one chunk', () => {
		expect(chunkTableTargets(targets(5), 25)).to.have.lengthOf(1);
	});

	it('splits a batch over the limit', () => {
		let chunks = chunkTableTargets(targets(60), 25);

		expect(chunks.map(chunk => chunk.length)).to.deep.equal([25, 25, 10]);
	});

	it('covers every target exactly once', () => {
		let chunks = chunkTableTargets(targets(60), 25);
		let names = chunks.flat().map(target => target.table);

		expect(names).to.deep.equal(targets(60).map(target => target.table));
	});

	it('never loops forever on a nonsense size', () => {
		expect(chunkTableTargets(targets(3), 0)).to.have.lengthOf(3);
	});
});

describe('chunkSchemaNames', () => {
	function schemas(count: number) {
		return Array.from({length: count}, (ignored, index) => `LIB${index}`);
	}

	it('returns no chunks for no schemas, so no statement runs', () => {
		expect(chunkSchemaNames([])).to.deep.equal([]);
	});

	it('splits a long library list, keeping its order', () => {
		let chunks = chunkSchemaNames(schemas(120), 50);

		expect(chunks.map(chunk => chunk.length)).to.deep.equal([50, 50, 20]);
		expect(chunks.flat()).to.deep.equal(schemas(120));
	});

	it('upper-cases, trims and de-duplicates names, and drops blanks', () => {
		expect(chunkSchemaNames(['sales', ' SALES ', '', '  ', 'archive'])).to.deep.equal([['SALES', 'ARCHIVE']]);
	});

	it('defaults to a bounded chunk size', () => {
		expect(chunkSchemaNames(schemas(MAX_SCHEMAS_PER_QUERY + 1))).to.have.lengthOf(2);
	});
});
