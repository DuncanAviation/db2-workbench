import { expect } from 'chai';
import { ResolvedColumn, ResolvedForeignKey, ResolvedTable, ResolvedTableKey } from '../schema-format-converter.js';
import { FrictionlessResource } from '../frictionless-table-schema.js';
import { frictionlessFormat } from './frictionless-format.js';

function resolvedColumn(overrides: Partial<ResolvedColumn> = {}): ResolvedColumn {
	return {
		systemName: 'COL1',
		dataType: 'CHAR',
		length: 10,
		nulls: 'Y',
		isNew: false,
		importedFields: [],
		...overrides
	};
}

function resolvedTableKey(overrides: Partial<ResolvedTableKey> = {}): ResolvedTableKey {
	return {
		constraintName: 'PK1',
		constraintType: 'PRIMARY KEY',
		systemColumnName: 'ID',
		ordinalPosition: 1,
		isNew: false,
		...overrides
	};
}

function resolvedForeignKey(overrides: Partial<ResolvedForeignKey> = {}): ResolvedForeignKey {
	return {
		constraintName: 'FK1',
		systemColumnName: 'PARENT_ID',
		ordinalPosition: 1,
		referencedTable: 'PARENT',
		referencedSystemColumnName: 'ID',
		isNew: false,
		...overrides
	};
}

function resolvedTable(overrides: Partial<ResolvedTable> = {}): ResolvedTable {
	return {
		schema: 'MYSCHEMA',
		name: 'MYTABLE',
		existsInDatabase: true,
		columns: [],
		keys: [],
		foreignKeys: [],
		indexes: [],
		...overrides
	};
}

function exportedField(table: ResolvedTable, systemName: string) {
	let resource: FrictionlessResource = JSON.parse(frictionlessFormat.export([table]));
	let field = resource.schema.fields.find(candidate => candidate.name === systemName);

	if(!field) {
		throw new Error(`No exported field named ${systemName}`);
	}

	return field;
}

describe('frictionlessFormat.export()', () => {
	describe('type mapping', () => {
		let cases: Array<[string, string]> = [
			['SMALLINT', 'integer'], ['INTEGER', 'integer'], ['BIGINT', 'integer'],
			['NUMERIC', 'number'], ['DECIMAL', 'number'], ['DECFLOAT', 'number'], ['FLOAT', 'number'], ['REAL', 'number'], ['DOUBLE', 'number'],
			['DATE', 'date'], ['TIME', 'time'], ['TIMESTAMP', 'datetime'], ['BOOLEAN', 'boolean'],
			['BLOB', 'any'], ['BINARY', 'any'], ['VARBINARY', 'any'],
			['CHAR', 'string'], ['VARCHAR', 'string'], ['SOMETHING_UNKNOWN', 'string']
		];

		for(let [dataType, expectedType] of cases) {
			it(`maps ${dataType} to "${expectedType}"`, () => {
				let table = resolvedTable({columns: [resolvedColumn({systemName: 'A', dataType})]});
				expect(exportedField(table, 'A').type).to.equal(expectedType);
			});
		}
	});

	describe('description', () => {
		it('prefers text over heading', () => {
			let table = resolvedTable({columns: [resolvedColumn({systemName: 'A', text: 'The text', heading: 'The heading'})]});
			expect(exportedField(table, 'A').description).to.equal('The text');
		});

		it('falls back to heading when there is no text', () => {
			let table = resolvedTable({columns: [resolvedColumn({systemName: 'A', text: '', heading: 'The heading'})]});
			expect(exportedField(table, 'A').description).to.equal('The heading');
		});
	});

	describe('required constraint', () => {
		it('is required when not-null and has no default', () => {
			let table = resolvedTable({columns: [resolvedColumn({systemName: 'A', nulls: 'N', hasDefault: 'NO'})]});
			expect(exportedField(table, 'A').constraints?.required).to.equal(true);
		});

		it('is not required when not-null but a default exists', () => {
			let table = resolvedTable({columns: [resolvedColumn({systemName: 'A', nulls: 'N', hasDefault: 'YES'})]});
			expect(exportedField(table, 'A').constraints?.required).to.be.undefined;
		});

		it('is not required when nullable', () => {
			let table = resolvedTable({columns: [resolvedColumn({systemName: 'A', nulls: 'Y', hasDefault: 'NO'})]});
			expect(exportedField(table, 'A').constraints?.required).to.be.undefined;
		});

		it('is not required when hasDefault is unknown (imported-only column)', () => {
			let table = resolvedTable({columns: [resolvedColumn({systemName: 'A', nulls: 'N', hasDefault: undefined})]});
			expect(exportedField(table, 'A').constraints?.required).to.be.undefined;
		});
	});

	describe('unique constraint', () => {
		it('marks a single-column unique constraint', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'CODE'})],
				keys: [resolvedTableKey({constraintName: 'UQ1', constraintType: 'UNIQUE', systemColumnName: 'CODE'})]
			});
			expect(exportedField(table, 'CODE').constraints?.unique).to.equal(true);
		});

		it('leaves a composite unique constraint unmarked - Table Schema has no table-level unique concept', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'A'}), resolvedColumn({systemName: 'B'})],
				keys: [
					resolvedTableKey({constraintName: 'UQ1', constraintType: 'UNIQUE', systemColumnName: 'A', ordinalPosition: 1}),
					resolvedTableKey({constraintName: 'UQ1', constraintType: 'UNIQUE', systemColumnName: 'B', ordinalPosition: 2})
				]
			});
			expect(exportedField(table, 'A').constraints?.unique).to.be.undefined;
			expect(exportedField(table, 'B').constraints?.unique).to.be.undefined;
		});
	});

	describe('length constraints', () => {
		it('sets minLength and maxLength to the same value for a fixed-width CHAR column', () => {
			let table = resolvedTable({columns: [resolvedColumn({systemName: 'UID', dataType: 'CHAR', length: 10})]});
			let field = exportedField(table, 'UID');
			expect(field.constraints?.minLength).to.equal(10);
			expect(field.constraints?.maxLength).to.equal(10);
		});

		it('sets only maxLength for a variable-width VARCHAR column', () => {
			let table = resolvedTable({columns: [resolvedColumn({systemName: 'NAM', dataType: 'VARCHAR', length: 50})]});
			let field = exportedField(table, 'NAM');
			expect(field.constraints?.minLength).to.be.undefined;
			expect(field.constraints?.maxLength).to.equal(50);
		});

		it('does not add length constraints to a non-string field type', () => {
			let table = resolvedTable({columns: [resolvedColumn({systemName: 'AMT', dataType: 'DECIMAL', length: 9})]});
			expect(exportedField(table, 'AMT').constraints).to.be.undefined;
		});
	});

	it('carries the long SQL name as x-sqlName', () => {
		let table = resolvedTable({columns: [resolvedColumn({systemName: 'EMNO', sqlName: 'ACCT_EMPLOYEENO'})]});
		expect(exportedField(table, 'EMNO')['x-sqlName']).to.equal('ACCT_EMPLOYEENO');
	});

	describe('primary key', () => {
		it('exports a single-column primary key', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'ID'})],
				keys: [resolvedTableKey({constraintName: 'PK1', constraintType: 'PRIMARY KEY', systemColumnName: 'ID'})]
			});
			let resource: FrictionlessResource = JSON.parse(frictionlessFormat.export([table]));
			expect(resource.schema.primaryKey).to.deep.equal(['ID']);
		});

		it('exports a composite primary key in ordinal order', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'A'}), resolvedColumn({systemName: 'B'})],
				keys: [
					resolvedTableKey({constraintName: 'PK1', constraintType: 'PRIMARY KEY', systemColumnName: 'B', ordinalPosition: 2}),
					resolvedTableKey({constraintName: 'PK1', constraintType: 'PRIMARY KEY', systemColumnName: 'A', ordinalPosition: 1})
				]
			});
			let resource: FrictionlessResource = JSON.parse(frictionlessFormat.export([table]));
			expect(resource.schema.primaryKey).to.deep.equal(['A', 'B']);
		});
	});

	describe('foreign keys', () => {
		it('exports a single-column foreign key', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'PARENT_ID'})],
				foreignKeys: [resolvedForeignKey({referencedSchema: 'SCH'})]
			});
			let resource: FrictionlessResource = JSON.parse(frictionlessFormat.export([table]));
			expect(resource.schema.foreignKeys).to.deep.equal([{fields: ['PARENT_ID'], reference: {resource: 'SCH.PARENT', fields: ['ID']}}]);
		});

		it('groups a composite foreign key by constraint name, sorted by ordinal', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'A'}), resolvedColumn({systemName: 'B'})],
				foreignKeys: [
					resolvedForeignKey({constraintName: 'FK1', systemColumnName: 'B', ordinalPosition: 2, referencedSystemColumnName: 'PB', referencedSchema: 'SCH'}),
					resolvedForeignKey({constraintName: 'FK1', systemColumnName: 'A', ordinalPosition: 1, referencedSystemColumnName: 'PA', referencedSchema: 'SCH'})
				]
			});
			let resource: FrictionlessResource = JSON.parse(frictionlessFormat.export([table]));
			expect(resource.schema.foreignKeys).to.deep.equal([{fields: ['A', 'B'], reference: {resource: 'SCH.PARENT', fields: ['PA', 'PB']}}]);
		});

		it('keeps two imported-only (nameless) foreign keys as separate groups', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'A'}), resolvedColumn({systemName: 'B'})],
				foreignKeys: [
					resolvedForeignKey({constraintName: undefined, systemColumnName: 'A', referencedTable: 'PARENT', referencedSystemColumnName: 'ID', isNew: true}),
					resolvedForeignKey({constraintName: undefined, systemColumnName: 'B', referencedTable: 'OTHER', referencedSystemColumnName: 'ID', isNew: true})
				]
			});
			let resource: FrictionlessResource = JSON.parse(frictionlessFormat.export([table]));
			expect(resource.schema.foreignKeys).to.have.length(2);
		});
	});

	it('exports a single table as a bare object, and multiple tables as an array', () => {
		let table = resolvedTable({columns: [resolvedColumn({systemName: 'A'})]});
		expect(JSON.parse(frictionlessFormat.export([table]))).to.not.be.an('array');
		expect(JSON.parse(frictionlessFormat.export([table, resolvedTable({name: 'OTHER'})]))).to.be.an('array').with.length(2);
	});
});

describe('frictionlessFormat.import()', () => {
	it('parses basic column fields', async () => {
		let json = JSON.stringify({name: 'S.T', schema: {fields: [{name: 'A', type: 'string', description: 'Some text', 'x-sqlName': 'LONG_A'}]}});
		let [table] = await frictionlessFormat.import(json);
		expect(table.schema).to.equal('S');
		expect(table.name).to.equal('T');
		expect(table.columns[0]).to.include({name: 'A', type: 'string', sqlName: 'LONG_A', description: 'Some text', nullable: true});
	});

	it('marks a column not-nullable when constraints.required is true', async () => {
		let json = JSON.stringify({name: 'T', schema: {fields: [{name: 'A', type: 'string', constraints: {required: true}}]}});
		let [table] = await frictionlessFormat.import(json);
		expect(table.columns[0].nullable).to.equal(false);
	});

	it('reads a primary key given as a bare string or an array', async () => {
		let single = (await frictionlessFormat.import(JSON.stringify({name: 'T', schema: {fields: [{name: 'A', type: 'string'}], primaryKey: 'A'}})))[0];
		expect(single.primaryKeyColumns).to.deep.equal(['A']);

		let composite = (await frictionlessFormat.import(JSON.stringify({name: 'T', schema: {fields: [{name: 'A', type: 'string'}], primaryKey: ['A', 'B']}})))[0];
		expect(composite.primaryKeyColumns).to.deep.equal(['A', 'B']);
	});

	it('recovers a nameless unique key from constraints.unique - Frictionless has no name concept', async () => {
		let json = JSON.stringify({name: 'T', schema: {fields: [{name: 'CODE', type: 'string', constraints: {unique: true}}]}});
		let [table] = await frictionlessFormat.import(json);
		expect(table.uniqueKeys).to.deep.equal([{columns: ['CODE']}]);
		expect(table.primaryKeyName).to.be.undefined;
	});

	it('reads a foreign key, splitting the referenced resource name into schema and table', async () => {
		let json = JSON.stringify({
			name: 'T',
			schema: {fields: [{name: 'PARENT_ID', type: 'integer'}], foreignKeys: [{fields: 'PARENT_ID', reference: {resource: 'SCH.PARENT', fields: 'ID'}}]}
		});
		let [table] = await frictionlessFormat.import(json);
		expect(table.foreignKeys).to.deep.equal([{columns: ['PARENT_ID'], referencedSchema: 'SCH', referencedTable: 'PARENT', referencedColumns: ['ID']}]);
	});

	it('always reports no indexes - Table Schema has no index concept', async () => {
		let json = JSON.stringify({name: 'T', schema: {fields: [{name: 'A', type: 'string'}]}});
		let [table] = await frictionlessFormat.import(json);
		expect(table.indexes).to.deep.equal([]);
	});

	it('imports both a single resource object and an array of resources', async () => {
		let single = await frictionlessFormat.import(JSON.stringify({name: 'T', schema: {fields: [{name: 'A', type: 'string'}]}}));
		expect(single).to.have.length(1);

		let multiple = await frictionlessFormat.import(JSON.stringify([
			{name: 'T1', schema: {fields: [{name: 'A', type: 'string'}]}},
			{name: 'T2', schema: {fields: [{name: 'B', type: 'string'}]}}
		]));
		expect(multiple).to.have.length(2);
	});

	describe('export -> import round trip', () => {
		it('preserves columns, unique constraints, and foreign keys end to end', async () => {
			let table = resolvedTable({
				schema: 'ACME', name: 'APPUSER',
				columns: [
					resolvedColumn({systemName: 'RCID', sqlName: 'ACCT_RECORDID', dataType: 'DECIMAL', length: undefined, precision: 9, scale: 0}),
					resolvedColumn({systemName: 'UID', sqlName: 'ACCT_UNIVERSALID', dataType: 'CHAR', length: 10, nulls: 'N'})
				],
				keys: [
					resolvedTableKey({constraintName: 'APPUSER_PRIMARY', constraintType: 'PRIMARY KEY', systemColumnName: 'UID'}),
					resolvedTableKey({constraintName: 'APPUSER_RCID', constraintType: 'UNIQUE', systemColumnName: 'RCID'})
				]
			});

			let [reimported] = await frictionlessFormat.import(frictionlessFormat.export([table]));

			expect(reimported.columns).to.have.length(2);
			expect(reimported.primaryKeyColumns).to.deep.equal(['UID']);
			expect(reimported.uniqueKeys).to.deep.equal([{columns: ['RCID']}]);
		});
	});
});
