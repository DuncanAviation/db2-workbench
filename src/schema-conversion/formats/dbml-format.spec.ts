import { expect } from 'chai';
import { ResolvedColumn, ResolvedForeignKey, ResolvedIndex, ResolvedTable, ResolvedTableKey } from '../schema-format-converter.js';
import { dbmlFormat } from './dbml-format.js';

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

function resolvedIndex(overrides: Partial<ResolvedIndex> = {}): ResolvedIndex {
	return {
		indexName: 'IDX1',
		uniqueness: 'Not Unique',
		keyColumns: 'COL1',
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

describe('dbmlFormat.export()', () => {
	describe('column type text', () => {
		it('renders a CHAR column with its length', () => {
			let table = resolvedTable({columns: [resolvedColumn({systemName: 'UID', dataType: 'CHAR', length: 10, nulls: 'N'})]});
			expect(dbmlFormat.export([table])).to.include('"UID" "CHAR(10)" [not null]');
		});

		it('renders a DECIMAL column with precision and scale', () => {
			let table = resolvedTable({columns: [resolvedColumn({systemName: 'AMT', dataType: 'DECIMAL', precision: 9, scale: 2, nulls: 'Y'})]});
			expect(dbmlFormat.export([table])).to.include('"AMT" "DECIMAL(9,2)"');
		});

		// QSYS2.SYSCOLUMNS2 returns PRECISION/SCALE as 0 (not null) for CHAR/VARCHAR columns - a `0` must
		// fall through to the length branch, not be mistaken for "this column really has 0 precision".
		it('falls back to length when precision is 0, the DB2 CHAR/VARCHAR quirk', () => {
			let table = resolvedTable({columns: [resolvedColumn({systemName: 'NAM', dataType: 'VARCHAR', length: 50, precision: 0, scale: 0, nulls: 'Y'})]});
			expect(dbmlFormat.export([table])).to.include('"NAM" "VARCHAR(50)"');
		});

		it('renders a bare type when there is neither length nor precision', () => {
			let table = resolvedTable({columns: [resolvedColumn({systemName: 'FLG', dataType: 'BOOLEAN', length: undefined, nulls: 'Y'})]});
			expect(dbmlFormat.export([table])).to.include('"FLG" "BOOLEAN"');
		});
	});

	describe('column note', () => {
		it('builds a note from the long name and text', () => {
			let table = resolvedTable({columns: [resolvedColumn({systemName: 'EMNO', sqlName: 'ACCT_EMPLOYEENO', text: 'Employee Code'})]});
			expect(dbmlFormat.export([table])).to.include('note: \'Long name: ACCT_EMPLOYEENO - Employee Code\'');
		});

		it('adds heading to the note only when it differs from text', () => {
			let same = resolvedTable({columns: [resolvedColumn({systemName: 'A', heading: 'Same', text: 'Same'})]});
			expect(dbmlFormat.export([same])).to.not.include('Heading:');

			let different = resolvedTable({columns: [resolvedColumn({systemName: 'A', heading: 'Short', text: 'A much longer description'})]});
			expect(dbmlFormat.export([different])).to.include('Heading: Short');
		});

		it('omits the note entirely when there is nothing to say', () => {
			let table = resolvedTable({columns: [resolvedColumn({systemName: 'A'})]});
			expect(dbmlFormat.export([table])).to.not.include('note:');
		});
	});

	describe('default value export', () => {
		it('passes through an already-quoted string literal default', () => {
			let table = resolvedTable({columns: [resolvedColumn({systemName: 'FLAG', defaultValue: '\'N\''})]});
			expect(dbmlFormat.export([table])).to.include('default: \'N\'');
		});

		it('passes through a bare numeric default', () => {
			let table = resolvedTable({columns: [resolvedColumn({systemName: 'CNT', defaultValue: '0'})]});
			expect(dbmlFormat.export([table])).to.include('default: 0');
		});

		it('wraps an unrecognized default (e.g. a special register) as a backtick expression', () => {
			let table = resolvedTable({columns: [resolvedColumn({systemName: 'TS', defaultValue: 'CURRENT TIMESTAMP'})]});
			expect(dbmlFormat.export([table])).to.include('default: `CURRENT TIMESTAMP`');
		});
	});

	describe('identity columns', () => {
		it('flags an identity column with increment and folds the generation details into the note', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({
					systemName: 'RCID', identity: 'YES', generated: 'BY DEFAULT', identityStart: 1, increment: 1,
					minValue: 1, maxValue: 999999999, cycle: 'NO', cache: 10
				})]
			});
			let dbml = dbmlFormat.export([table]);
			expect(dbml).to.match(/"RCID" ".*"\s*\[[^\]]*\bincrement\b[^\]]*\]/);
			expect(dbml).to.include('Identity (generated by default, start 1, increment 1, min 1, max 999999999, cache 10)');
		});
	});

	describe('primary key / unique flags', () => {
		it('marks a single-column primary key and a single-column unique column inline', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'ID'}), resolvedColumn({systemName: 'CODE'})],
				keys: [
					resolvedTableKey({constraintName: 'PK1', constraintType: 'PRIMARY KEY', systemColumnName: 'ID'}),
					resolvedTableKey({constraintName: 'UQ1', constraintType: 'UNIQUE', systemColumnName: 'CODE'})
				]
			});
			let dbml = dbmlFormat.export([table]);
			expect(dbml).to.match(/"ID" "CHAR\(10\)" \[pk/);
			expect(dbml).to.match(/"CODE" "CHAR\(10\)" \[unique/);
		});
	});

	describe('constraint-name preservation', () => {
		it('emits a named indexes-block entry for a single-column pk/unique with a real constraint name', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'ID'}), resolvedColumn({systemName: 'CODE'})],
				keys: [
					resolvedTableKey({constraintName: 'APPUSER_PRIMARY', constraintType: 'PRIMARY KEY', systemColumnName: 'ID'}),
					resolvedTableKey({constraintName: 'APPUSER_CODE', constraintType: 'UNIQUE', systemColumnName: 'CODE'})
				]
			});
			let dbml = dbmlFormat.export([table]);
			expect(dbml).to.include('("ID") [pk, name: \'APPUSER_PRIMARY\']');
			expect(dbml).to.include('("CODE") [unique, name: \'APPUSER_CODE\']');
		});

		it('does not fabricate a name from table-resolver\'s synthetic placeholders', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'ID'})],
				keys: [resolvedTableKey({constraintName: 'imported-pk', constraintType: 'PRIMARY KEY', systemColumnName: 'ID'})]
			});
			expect(dbmlFormat.export([table])).to.not.include('indexes {');
		});

		it('names a composite primary key and a composite unique constraint', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'A'}), resolvedColumn({systemName: 'B'}), resolvedColumn({systemName: 'C'}), resolvedColumn({systemName: 'D'})],
				keys: [
					resolvedTableKey({constraintName: 'PK1', constraintType: 'PRIMARY KEY', systemColumnName: 'A', ordinalPosition: 1}),
					resolvedTableKey({constraintName: 'PK1', constraintType: 'PRIMARY KEY', systemColumnName: 'B', ordinalPosition: 2}),
					resolvedTableKey({constraintName: 'UQ1', constraintType: 'UNIQUE', systemColumnName: 'C', ordinalPosition: 1}),
					resolvedTableKey({constraintName: 'UQ1', constraintType: 'UNIQUE', systemColumnName: 'D', ordinalPosition: 2})
				]
			});
			let dbml = dbmlFormat.export([table]);
			expect(dbml).to.include('("A", "B") [pk, name: \'PK1\']');
			expect(dbml).to.include('("C", "D") [unique, name: \'UQ1\']');
		});
	});

	describe('physical indexes', () => {
		it('strips a trailing DESC and resolves a long index-column name to the short one', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'LCTS', sqlName: 'ACCT_WHENCHANGED'})],
				indexes: [resolvedIndex({indexName: 'APLUSER99', keyColumns: 'ACCT_WHENCHANGED DESC'})]
			});
			expect(dbmlFormat.export([table])).to.include('("LCTS") [name: \'APLUSER99\']');
		});

		it('adds a note for an index comment that says something the table-level note does not', () => {
			let table = resolvedTable({
				description: 'Users',
				columns: [resolvedColumn({systemName: 'USRTYPE'}), resolvedColumn({systemName: 'EMNO'})],
				indexes: [resolvedIndex({indexName: 'APXUSER01', keyColumns: 'USRTYPE, EMNO', comment: 'Index generated from Index Advisor'})]
			});
			expect(dbmlFormat.export([table])).to.include('("USRTYPE", "EMNO") [name: \'APXUSER01\', note: \'Index generated from Index Advisor\']');
		});

		it('does not repeat an index comment that just restates the table\'s own note', () => {
			let table = resolvedTable({
				description: 'Users',
				columns: [resolvedColumn({systemName: 'EMNO'})],
				indexes: [resolvedIndex({indexName: 'APLUSER09', keyColumns: 'EMNO', comment: 'Users'})]
			});
			expect(dbmlFormat.export([table])).to.include('("EMNO") [name: \'APLUSER09\']');
		});

		it('skips a real index whose column set duplicates a pk/unique constraint', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'ID'})],
				keys: [resolvedTableKey({constraintName: 'PK1', constraintType: 'PRIMARY KEY', systemColumnName: 'ID'})],
				indexes: [resolvedIndex({indexName: 'DUP_IDX', keyColumns: 'ID'})]
			});
			expect(dbmlFormat.export([table])).to.not.include('DUP_IDX');
		});

		it('marks a unique physical index', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'EMAIL'})],
				indexes: [resolvedIndex({indexName: 'UQ_EMAIL', uniqueness: 'Unique', keyColumns: 'EMAIL'})]
			});
			expect(dbmlFormat.export([table])).to.include('("EMAIL") [unique, name: \'UQ_EMAIL\']');
		});

		// IndexQueries.describeIndexUniqueness maps DB2's UNIQUE_CODE 1 to this string - still a real
		// uniqueness rule (enforced except among NULLs), not the same as the plain non-unique "Non-Unique
		// (...)" strings the other codes produce, and previously missed here since only an exact 'Unique'
		// match was recognized.
		it('marks a "Unique Where Not Null" physical index as unique too', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'EMAIL'})],
				indexes: [resolvedIndex({indexName: 'UQ_EMAIL', uniqueness: 'Unique Where Not Null', keyColumns: 'EMAIL'})]
			});
			expect(dbmlFormat.export([table])).to.include('("EMAIL") [unique, name: \'UQ_EMAIL\']');
		});
	});

	describe('foreign key Refs', () => {
		it('emits an unnamed many-to-one Ref when there is no real constraint name', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'PARENT_ID'})],
				foreignKeys: [resolvedForeignKey({constraintName: undefined, referencedSchema: 'SCH'})]
			});
			expect(dbmlFormat.export([table])).to.include('Ref: "MYSCHEMA"."MYTABLE".("PARENT_ID") > "SCH"."PARENT".("ID")');
		});

		it('emits a one-to-one Ref when the FK columns are also a table key', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'ID'})],
				keys: [resolvedTableKey({constraintName: 'PK1', constraintType: 'PRIMARY KEY', systemColumnName: 'ID'})],
				foreignKeys: [resolvedForeignKey({constraintName: undefined, systemColumnName: 'ID', referencedSchema: 'SCH'})]
			});
			expect(dbmlFormat.export([table])).to.include('Ref: "MYSCHEMA"."MYTABLE".("ID") - "SCH"."PARENT".("ID")');
		});

		it('names the Ref after a real constraint name', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'PARENT_ID'})],
				foreignKeys: [resolvedForeignKey({constraintName: 'APPUSRL_ROLE', referencedSchema: 'SCH'})]
			});
			expect(dbmlFormat.export([table])).to.include('Ref "APPUSRL_ROLE": "MYSCHEMA"."MYTABLE".("PARENT_ID") > "SCH"."PARENT".("ID")');
		});

		it('does not name a Ref from table-resolver\'s synthetic imported-fk placeholder', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'PARENT_ID'})],
				foreignKeys: [resolvedForeignKey({constraintName: 'imported-fk-0', referencedSchema: 'SCH'})]
			});
			expect(dbmlFormat.export([table])).to.include('Ref: "MYSCHEMA"."MYTABLE".("PARENT_ID")');
		});

		it('carries recognized update/delete referential actions as Ref settings', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'PARENT_ID'})],
				foreignKeys: [resolvedForeignKey({constraintName: undefined, referencedSchema: 'SCH', updateRule: 'NO ACTION', deleteRule: 'CASCADE'})]
			});
			expect(dbmlFormat.export([table])).to.include('> "SCH"."PARENT".("ID") [update: no action, delete: cascade]');
		});

		it('omits an unrecognized referential action rather than risk unparseable output', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'PARENT_ID'})],
				foreignKeys: [resolvedForeignKey({constraintName: undefined, referencedSchema: 'SCH', updateRule: 'SOMETHING WEIRD'})]
			});
			expect(dbmlFormat.export([table])).to.not.include('update:');
		});

		it('emits a minimal stub table for an FK target not included in the export', () => {
			let table = resolvedTable({
				columns: [resolvedColumn({systemName: 'PARENT_ID'})],
				foreignKeys: [resolvedForeignKey({referencedSchema: 'SCH'})]
			});
			let dbml = dbmlFormat.export([table]);
			expect(dbml).to.include('Table "SCH"."PARENT"');
			expect(dbml).to.include('Referenced table - not included in this export');
		});

		it('does not emit a stub table for an FK target that is included in the export', () => {
			let parent = resolvedTable({schema: 'SCH', name: 'PARENT', columns: [resolvedColumn({systemName: 'ID'})]});
			let child = resolvedTable({
				schema: 'SCH', name: 'CHILD',
				columns: [resolvedColumn({systemName: 'PARENT_ID'})],
				foreignKeys: [resolvedForeignKey({referencedSchema: 'SCH'})]
			});
			expect(dbmlFormat.export([parent, child])).to.not.include('not included in this export');
		});
	});

	it('includes the table description as a note on the header', () => {
		let table = resolvedTable({description: 'Users'});
		expect(dbmlFormat.export([table])).to.include('Table "MYSCHEMA"."MYTABLE" [note: \'Users\'] {');
	});
});

describe('dbmlFormat.import()', () => {
	it('parses column types including length/precision args', async () => {
		let dbml = `
Table "S"."T" {
  "A" "VARCHAR(50)"
  "B" "DECIMAL(9,2)"
}
`;
		let [table] = await dbmlFormat.import(dbml);
		expect(table.columns[0]).to.include({name: 'A', type: 'VARCHAR(50)', nullable: true});
		expect(table.columns[1]).to.include({name: 'B', type: 'DECIMAL(9,2)', nullable: true});
	});

	describe('note parsing (sqlName round trip)', () => {
		it('splits "Long name: X - description" back into sqlName and description', async () => {
			let dbml = `Table "S"."T" {\n  "A" "CHAR(1)" [note: 'Long name: USER_A - Some text']\n}`;
			let [table] = await dbmlFormat.import(dbml);
			expect(table.columns[0]).to.include({sqlName: 'USER_A', description: 'Some text'});
		});

		it('handles "Long name: X" with no trailing description', async () => {
			let dbml = `Table "S"."T" {\n  "A" "CHAR(1)" [note: 'Long name: USER_A']\n}`;
			let [table] = await dbmlFormat.import(dbml);
			expect(table.columns[0].sqlName).to.equal('USER_A');
			expect(table.columns[0].description).to.be.undefined;
		});

		it('leaves an ordinary note with no "Long name" prefix as plain description', async () => {
			let dbml = `Table "S"."T" {\n  "A" "CHAR(1)" [note: 'Just a note']\n}`;
			let [table] = await dbmlFormat.import(dbml);
			expect(table.columns[0].sqlName).to.be.undefined;
			expect(table.columns[0].description).to.equal('Just a note');
		});
	});

	describe('primary key / unique key import', () => {
		it('reads a single-column inline pk flag with no name', async () => {
			let dbml = 'Table "S"."T" {\n  "ID" "INTEGER" [pk]\n}';
			let [table] = await dbmlFormat.import(dbml);
			expect(table.primaryKeyColumns).to.deep.equal(['ID']);
			expect(table.primaryKeyName).to.be.undefined;
		});

		it('reads a named single-column pk from an indexes-block entry without duplicating the column', async () => {
			let dbml = `
Table "S"."T" {
  "ID" "INTEGER" [pk]

  indexes {
    (ID) [pk, name: 'T_PK']
  }
}
`;
			let [table] = await dbmlFormat.import(dbml);
			expect(table.primaryKeyColumns).to.deep.equal(['ID']);
			expect(table.primaryKeyName).to.equal('T_PK');
			expect(table.indexes).to.deep.equal([]);
		});

		it('reads a composite pk from an indexes-block entry', async () => {
			let dbml = `
Table "S"."T" {
  "A" "INTEGER"
  "B" "INTEGER"

  indexes {
    (A, B) [pk, name: 'T_PK']
  }
}
`;
			let [table] = await dbmlFormat.import(dbml);
			expect(table.primaryKeyColumns).to.deep.equal(['A', 'B']);
			expect(table.primaryKeyName).to.equal('T_PK');
		});

		it('reads a nameless single-column unique flag', async () => {
			let dbml = 'Table "S"."T" {\n  "CODE" "CHAR(1)" [unique]\n}';
			let [table] = await dbmlFormat.import(dbml);
			expect(table.uniqueKeys).to.deep.equal([{columns: ['CODE']}]);
		});

		it('reads a named single-column unique constraint without duplicating it as a plain index', async () => {
			let dbml = `
Table "S"."T" {
  "CODE" "CHAR(1)" [unique]

  indexes {
    (CODE) [unique, name: 'T_CODE']
  }
}
`;
			let [table] = await dbmlFormat.import(dbml);
			expect(table.uniqueKeys).to.deep.equal([{name: 'T_CODE', columns: ['CODE']}]);
			expect(table.indexes).to.deep.equal([]);
		});

		it('reads a composite unique constraint', async () => {
			let dbml = `
Table "S"."T" {
  "A" "INTEGER"
  "B" "INTEGER"

  indexes {
    (A, B) [unique, name: 'T_UQ']
  }
}
`;
			let [table] = await dbmlFormat.import(dbml);
			expect(table.uniqueKeys).to.deep.equal([{name: 'T_UQ', columns: ['A', 'B']}]);
		});

		it('keeps a plain physical index separate from pk/unique constraints', async () => {
			let dbml = `
Table "S"."T" {
  "A" "INTEGER" [pk]
  "B" "INTEGER"

  indexes {
    (B) [name: 'IDX_B']
  }
}
`;
			let [table] = await dbmlFormat.import(dbml);
			expect(table.indexes).to.deep.equal([{name: 'IDX_B', columns: ['B'], unique: false, comment: undefined}]);
		});

		it('reads an index\'s note back as its comment', async () => {
			let dbml = `
Table "S"."T" {
  "B" "INTEGER"

  indexes {
    (B) [name: 'IDX_B', note: 'Index generated from Index Advisor']
  }
}
`;
			let [table] = await dbmlFormat.import(dbml);
			expect(table.indexes[0].comment).to.equal('Index generated from Index Advisor');
		});
	});

	describe('foreign key import', () => {
		it('reads a many-to-one Ref into a foreign key', async () => {
			let dbml = `
Table "S"."CHILD" {
  "PARENT_ID" "INTEGER"
}

Table "S"."PARENT" {
  "ID" "INTEGER" [pk]
}

Ref: "S"."CHILD"."PARENT_ID" > "S"."PARENT"."ID"
`;
			let imported = await dbmlFormat.import(dbml);
			let child = imported.find(table => table.name === 'CHILD');
			expect(child?.foreignKeys).to.deep.equal([{
				name: undefined, columns: ['PARENT_ID'], referencedSchema: 'S', referencedTable: 'PARENT', referencedColumns: ['ID'],
				updateRule: undefined, deleteRule: undefined
			}]);
		});

		it('reads a named Ref and its update/delete referential actions', async () => {
			let dbml = `
Table "S"."CHILD" {
  "PARENT_ID" "INTEGER"
}

Table "S"."PARENT" {
  "ID" "INTEGER" [pk]
}

Ref "APPUSRL_ROLE": "S"."CHILD"."PARENT_ID" > "S"."PARENT"."ID" [update: no action, delete: cascade]
`;
			let imported = await dbmlFormat.import(dbml);
			let child = imported.find(table => table.name === 'CHILD');
			expect(child?.foreignKeys[0]).to.include({name: 'APPUSRL_ROLE', updateRule: 'NO ACTION', deleteRule: 'CASCADE'});
		});
	});

	describe('full export -> import round trip', () => {
		it('preserves columns, constraint names, and physical indexes end to end', async () => {
			let table = resolvedTable({
				schema: 'ACME', name: 'APPUSER', description: 'Users',
				columns: [
					resolvedColumn({
						systemName: 'RCID', sqlName: 'ACCT_RECORDID', text: 'Record ID', dataType: 'DECIMAL', precision: 9, scale: 0, length: undefined,
						identity: 'YES', generated: 'BY DEFAULT'
					}),
					resolvedColumn({systemName: 'UID', sqlName: 'ACCT_UNIVERSALID', text: 'Universal ID', dataType: 'CHAR', length: 10, nulls: 'N'}),
					resolvedColumn({systemName: 'EMNO', sqlName: 'ACCT_EMPLOYEENO', text: 'Employee Code', dataType: 'CHAR', length: 10, nulls: 'N'})
				],
				keys: [
					resolvedTableKey({constraintName: 'APPUSER_PRIMARY', constraintType: 'PRIMARY KEY', systemColumnName: 'UID'}),
					resolvedTableKey({constraintName: 'APPUSER_RCID', constraintType: 'UNIQUE', systemColumnName: 'RCID'})
				],
				indexes: [resolvedIndex({indexName: 'APLUSER09', keyColumns: 'EMNO'})]
			});

			let [reimported] = await dbmlFormat.import(dbmlFormat.export([table]));

			expect(reimported.columns).to.have.length(3);
			expect(reimported.primaryKeyColumns).to.deep.equal(['UID']);
			expect(reimported.primaryKeyName).to.equal('APPUSER_PRIMARY');
			expect(reimported.uniqueKeys).to.deep.equal([{name: 'APPUSER_RCID', columns: ['RCID']}]);
			expect(reimported.indexes).to.deep.equal([{name: 'APLUSER09', columns: ['EMNO'], unique: false, comment: undefined}]);
		});
	});
});
