import { expect } from 'chai';
import { SystemColumn } from '../models/system-column.js';
import { SystemForeignKey } from '../models/system-foreign-key.js';
import { SystemIndex } from '../models/system-index.js';
import { SystemTable } from '../models/system-table.js';
import { SystemTableKey } from '../models/system-table-key.js';
import { TableSchema } from '../models/table-schema.js';
import { ImportedTableSchema, ImportProvenance } from './schema-format-converter.js';
import { resolveColumns, resolveForeignKeys, resolveIndexes, resolveTable, resolveTableKeys } from './table-resolver.js';

function systemColumn(overrides: Partial<SystemColumn> = {}): SystemColumn {
	return {
		schema: 'MYSCHEMA', tableName: 'MYTABLE', colNo: 1, systemName: 'COL1', sqlName: 'COL1',
		heading: '', text: '', dataType: 'VARCHAR', nulls: 'Y', identity: 'NO', generated: '',
		cycle: 'NO', hasDefault: 'N', hidden: 'N', updatable: 'YES',
		...overrides
	};
}

function systemTableKey(overrides: Partial<SystemTableKey> = {}): SystemTableKey {
	return {
		schema: 'MYSCHEMA', tableName: 'MYTABLE', constraintName: 'PK1', constraintType: 'PRIMARY KEY',
		columnName: 'COL1', systemColumnName: 'COL1', ordinalPosition: 1,
		...overrides
	};
}

function systemForeignKey(overrides: Partial<SystemForeignKey> = {}): SystemForeignKey {
	return {
		schema: 'MYSCHEMA', tableName: 'MYTABLE', constraintName: 'FK1', columnName: 'PARENT_ID', systemColumnName: 'PARENT_ID',
		ordinalPosition: 1, updateRule: 'NO ACTION', deleteRule: 'NO ACTION',
		referencedSchema: 'MYSCHEMA', referencedTable: 'PARENT', referencedColumnName: 'ID', referencedSystemColumnName: 'ID',
		...overrides
	};
}

function systemIndex(overrides: Partial<SystemIndex> = {}): SystemIndex {
	return {
		schema: 'MYSCHEMA', tableName: 'MYTABLE', partition: 'MYTABLE', indexSchema: 'MYSCHEMA', indexName: 'IDX1',
		indexType: 'INDEX', uniqueness: 'Not Unique', keyColumns: 'COL1', size: 0,
		created: new Date('2024-01-01T00:00:00.000Z'), lastBuild: new Date('2024-01-02T00:00:00.000Z'),
		lastQueryUsed: undefined, queryUseCount: 0, queryStatisticsUseCount: 0, lastUsed: undefined,
		indexOwner: undefined, comment: undefined,
		...overrides
	};
}

function systemTable(overrides: Partial<SystemTable> = {}): SystemTable {
	return <SystemTable>{schema: 'MYSCHEMA', name: 'MYTABLE', description: '', ...overrides};
}

function provenance(): ImportProvenance {
	return {importId: 'import-1', sourceFormat: 'dbml', sourceLabel: 'test.dbml', importedAt: '2024-01-01T00:00:00.000Z'};
}

function importedTable(overrides: Partial<ImportedTableSchema> = {}): ImportedTableSchema {
	return {
		name: 'MYTABLE',
		columns: [],
		primaryKeyColumns: [],
		uniqueKeys: [],
		foreignKeys: [],
		indexes: [],
		provenance: provenance(),
		...overrides
	};
}

describe('resolveColumns', () => {
	it('passes a connected table\'s columns through unchanged, flagged as not new', () => {
		let columns = [systemColumn({systemName: 'A'})];
		expect(resolveColumns(columns, [])).to.deep.equal([{...columns[0], isNew: false, importedFields: []}]);
	});

	// A connected table with zero real columns of its own (empty array, distinct from `undefined` meaning
	// no connected table at all) still takes the connected branch - there's just nothing for an import to
	// match against, so every imported column surfaces as new (see the "surfaces a column..." test below),
	// rather than every field of every import being trusted wholesale the way the `undefined` branch does.
	it('still resolves via the connected branch for a connected table with zero columns of its own', () => {
		let imported = [importedTable({columns: [{name: 'GHOST', type: 'CHAR', nullable: true}]})];
		expect(resolveColumns([], imported)).to.deep.equal([
			{systemName: 'GHOST', sqlName: undefined, dataType: 'CHAR', nulls: 'Y', text: undefined, isNew: true, importedFields: []}
		]);
	});

	it('returns imported columns, flagged as new, when there is no connected table at all', () => {
		let imported = [importedTable({columns: [{name: 'A', type: 'VARCHAR(50)', nullable: true, sqlName: 'LONG_A', description: 'desc'}]})];
		let resolved = resolveColumns(undefined, imported);
		expect(resolved).to.deep.equal([{
			systemName: 'A', sqlName: 'LONG_A', dataType: 'VARCHAR(50)', nulls: 'Y', text: 'desc', isNew: true, importedFields: []
		}]);
	});

	it('keeps the first import\'s column when the same column name appears in more than one import', () => {
		let imported = [
			importedTable({columns: [{name: 'A', type: 'FIRST', nullable: true}]}),
			importedTable({columns: [{name: 'A', type: 'SECOND', nullable: false}]})
		];
		let resolved = resolveColumns(undefined, imported);
		expect(resolved).to.have.length(1);
		expect(resolved[0].dataType).to.equal('FIRST');
	});

	it('treats two imports naming the same new column by its short and long names as one column', () => {
		let imported = [
			importedTable({columns: [{name: 'EMNO', sqlName: 'EMPLOYEE_CODE', type: 'CHAR(5)', nullable: false}]}),
			importedTable({columns: [{name: 'EMPLOYEE_CODE', type: 'CHAR(5)', nullable: false}]})
		];
		let resolved = resolveColumns(undefined, imported);
		expect(resolved.map(column => column.systemName)).to.deep.equal(['EMNO']);
	});

	describe('enhanced case (a connected column matched against imported data)', () => {
		it('gap-fills text from a matching import when DB2\'s own is blank', () => {
			let columns = [systemColumn({systemName: 'EMLNFY', sqlName: 'ACCT_EMAILNOTIFY', text: ''})];
			let imported = [importedTable({columns: [{name: 'ACCT_EMAILNOTIFY', type: 'CHAR', nullable: false, description: 'Use email for notifications'}]})];
			let resolved = resolveColumns(columns, imported);
			expect(resolved[0].text).to.equal('Use email for notifications');
			expect(resolved[0].importedFields).to.deep.equal(['text']);
		});

		it('matches an imported column by systemName as well as sqlName', () => {
			let columns = [systemColumn({systemName: 'EMNO', sqlName: 'ACCT_EMPLOYEENO', text: ''})];
			let imported = [importedTable({columns: [{name: 'EMNO', type: 'CHAR', nullable: false, description: 'Employee code'}]})];
			expect(resolveColumns(columns, imported)[0].text).to.equal('Employee code');
		});

		it('does not override a real DB2 text value that is already present - gap-fill only, not override', () => {
			let columns = [systemColumn({systemName: 'EMLNFY', sqlName: 'ACCT_EMAILNOTIFY', text: 'Original DB2 text'})];
			let imported = [importedTable({columns: [{name: 'ACCT_EMAILNOTIFY', type: 'CHAR', nullable: false, description: 'Relabeled by import'}]})];
			let resolved = resolveColumns(columns, imported);
			expect(resolved[0].text).to.equal('Original DB2 text');
			expect(resolved[0].importedFields).to.deep.equal([]);
		});

		it('leaves a column with no matching imported column untouched', () => {
			let columns = [systemColumn({systemName: 'UNMATCHED', sqlName: 'USER_UNMATCHED', text: ''})];
			let imported = [importedTable({columns: [{name: 'SOMETHING_ELSE', type: 'CHAR', nullable: false, description: 'Not a match'}]})];
			let resolved = resolveColumns(columns, imported);
			expect(resolved[0].text).to.equal('');
			expect(resolved[0].importedFields).to.deep.equal([]);
		});

		it('does not gap-fill from a matching import with no description of its own', () => {
			let columns = [systemColumn({systemName: 'A', text: ''})];
			let imported = [importedTable({columns: [{name: 'A', type: 'CHAR', nullable: false}]})];
			let resolved = resolveColumns(columns, imported);
			expect(resolved[0].text).to.equal('');
			expect(resolved[0].importedFields).to.deep.equal([]);
		});

		// Revisited from the original phase-1 "nothing net-new appears for columns" plan: real testing
		// showed a genuinely new imported column (no DB2 counterpart at all) silently vanishing on an
		// Enhanced table was surprising, not useful - the user asked for it to show, flagged, instead.
		it('surfaces a column that exists only in the import as a new, flagged row', () => {
			let columns = [systemColumn({systemName: 'UID'})];
			let imported = [importedTable({columns: [
				{name: 'UID', type: 'CHAR', nullable: false},
				{name: 'TMZN', type: 'CHAR(50)', nullable: false, sqlName: 'ACCT_TIMEZONE', description: 'Time Zone'}
			]})];
			let resolved = resolveColumns(columns, imported);
			expect(resolved).to.have.length(2);
			expect(resolved[0]).to.include({systemName: 'UID', isNew: false});
			expect(resolved[1]).to.deep.equal({
				systemName: 'TMZN', sqlName: 'ACCT_TIMEZONE', dataType: 'CHAR(50)', nulls: 'N', text: 'Time Zone', isNew: true, importedFields: []
			});
		});

		it('does not also surface an imported column as a new row once it has already matched a connected column', () => {
			let columns = [systemColumn({systemName: 'EMNO', sqlName: 'ACCT_EMPLOYEENO', text: ''})];
			let imported = [importedTable({columns: [{name: 'ACCT_EMPLOYEENO', type: 'CHAR', nullable: false, description: 'Employee code'}]})];
			expect(resolveColumns(columns, imported)).to.have.length(1);
		});
	});
});

describe('resolveTableKeys', () => {
	it('passes a connected table\'s keys through unchanged, flagged as not new', () => {
		let keys = [systemTableKey()];
		expect(resolveTableKeys(keys, [])).to.deep.equal([{...keys[0], isNew: false}]);
	});

	// A connected table with zero real keys of its own (empty array, distinct from `undefined` meaning no
	// connected table at all) still surfaces an imported primary key/unique constraint as new, the same
	// as a genuinely new imported column now does - see the "whole-row" tests below for the more typical
	// case (a connected table that already has its own keys, plus something new from an import).
	it('surfaces an imported primary key as new for a connected table with zero keys of its own', () => {
		let imported = [importedTable({primaryKeyColumns: ['GHOST'], primaryKeyName: 'GHOST_PK'})];
		expect(resolveTableKeys([], imported)).to.deep.equal([
			{constraintName: 'GHOST_PK', constraintType: 'PRIMARY KEY', systemColumnName: 'GHOST', ordinalPosition: 1, isNew: true}
		]);
	});

	it('builds a primary key from the first import that declares one, using its real name', () => {
		let imported = [importedTable({primaryKeyColumns: ['UID'], primaryKeyName: 'APPUSER_PRIMARY'})];
		expect(resolveTableKeys(undefined, imported)).to.deep.equal([
			{constraintName: 'APPUSER_PRIMARY', constraintType: 'PRIMARY KEY', systemColumnName: 'UID', ordinalPosition: 1, isNew: true}
		]);
	});

	it('falls back to a synthetic shared name when the source format could not name the primary key', () => {
		let imported = [importedTable({primaryKeyColumns: ['UID']})];
		expect(resolveTableKeys(undefined, imported)[0].constraintName).to.equal('imported-pk');
	});

	it('takes the whole primary key from the first import that declares one, not a merge of partial imports', () => {
		let imported = [
			importedTable({primaryKeyColumns: []}),
			importedTable({primaryKeyColumns: ['A', 'B'], primaryKeyName: 'PK1'}),
			importedTable({primaryKeyColumns: ['C'], primaryKeyName: 'PK2'})
		];
		let resolved = resolveTableKeys(undefined, imported);
		expect(resolved.map(row => row.systemColumnName)).to.deep.equal(['A', 'B']);
		expect(resolved.every(row => row.constraintName === 'PK1')).to.equal(true);
	});

	it('builds a named unique key group and preserves column order', () => {
		let imported = [importedTable({uniqueKeys: [{name: 'APPUSER_RCID', columns: ['RCID']}]})];
		expect(resolveTableKeys(undefined, imported)).to.deep.equal([
			{constraintName: 'APPUSER_RCID', constraintType: 'UNIQUE', systemColumnName: 'RCID', ordinalPosition: 1, isNew: true}
		]);
	});

	it('deduplicates unique key groups with the same column set across imports, first import wins', () => {
		let imported = [
			importedTable({uniqueKeys: [{name: 'FIRST_NAME', columns: ['CODE']}]}),
			importedTable({uniqueKeys: [{name: 'SECOND_NAME', columns: ['CODE']}]})
		];
		let resolved = resolveTableKeys(undefined, imported);
		expect(resolved).to.have.length(1);
		expect(resolved[0].constraintName).to.equal('FIRST_NAME');
	});

	it('assigns distinct synthetic names to different nameless unique key groups', () => {
		let imported = [importedTable({uniqueKeys: [{columns: ['A']}, {columns: ['B']}]})];
		let resolved = resolveTableKeys(undefined, imported);
		let names = new Set(resolved.map(row => row.constraintName));
		expect(names.size).to.equal(2);
	});

	describe('enhanced case (a connected table with real keys of its own)', () => {
		it('surfaces a genuinely new imported unique constraint alongside the connected table\'s own keys', () => {
			let keys = [systemTableKey({constraintName: 'APPUSER_PRIMARY', constraintType: 'PRIMARY KEY', systemColumnName: 'UID'})];
			let imported = [importedTable({uniqueKeys: [{name: 'APPUSER_EMAIL_UQ', columns: ['EMAIL']}]})];
			let resolved = resolveTableKeys(keys, imported);
			expect(resolved).to.have.length(2);
			expect(resolved[0]).to.include({constraintName: 'APPUSER_PRIMARY', isNew: false});
			expect(resolved[1]).to.deep.equal({constraintName: 'APPUSER_EMAIL_UQ', constraintType: 'UNIQUE', systemColumnName: 'EMAIL', ordinalPosition: 1, isNew: true});
		});

		it('does not duplicate an imported unique constraint that covers the same column set as a real one', () => {
			let keys = [systemTableKey({constraintName: 'APPUSER_RCID', constraintType: 'UNIQUE', systemColumnName: 'RCID'})];
			let imported = [importedTable({uniqueKeys: [{name: 'DIFFERENT_NAME', columns: ['RCID']}]})];
			expect(resolveTableKeys(keys, imported)).to.have.length(1);
		});

		it('does not duplicate a unique constraint an import names by the long column names', () => {
			let columns = [systemColumn({systemName: 'EMNO', sqlName: 'EMPLOYEE_CODE'})];
			let keys = [systemTableKey({constraintName: 'EMP_UQ', constraintType: 'UNIQUE', systemColumnName: 'EMNO'})];
			let imported = [importedTable({uniqueKeys: [{name: 'IMPORTED_UQ', columns: ['EMPLOYEE_CODE']}]})];
			expect(resolveTableKeys(keys, imported, columns)).to.have.length(1);
		});

		it('does not surface an imported primary key when the connected table already has one of its own', () => {
			let keys = [systemTableKey({constraintName: 'APPUSER_PRIMARY', constraintType: 'PRIMARY KEY', systemColumnName: 'UID'})];
			let imported = [importedTable({primaryKeyColumns: ['SOMETHING_ELSE'], primaryKeyName: 'BOGUS_PK'})];
			let resolved = resolveTableKeys(keys, imported);
			expect(resolved).to.have.length(1);
			expect(resolved[0].constraintName).to.equal('APPUSER_PRIMARY');
		});
	});
});

describe('resolveForeignKeys', () => {
	it('passes a connected table\'s foreign keys through unchanged, flagged as not new', () => {
		let foreignKeys = [systemForeignKey()];
		expect(resolveForeignKeys(foreignKeys, [])).to.deep.equal([{...foreignKeys[0], isNew: false}]);
	});

	// Same reasoning as resolveTableKeys' equivalent test above - an empty (not undefined) connected array
	// still surfaces an imported relationship as new, since there's nothing real to match it against.
	it('surfaces an imported foreign key as new for a connected table with zero foreign keys of its own', () => {
		let imported = [importedTable({foreignKeys: [{name: 'GHOST_FK', columns: ['GHOST'], referencedTable: 'PARENT', referencedColumns: ['ID']}]})];
		expect(resolveForeignKeys([], imported)).to.deep.equal([{
			constraintName: 'GHOST_FK', systemColumnName: 'GHOST', ordinalPosition: 1,
			updateRule: undefined, deleteRule: undefined,
			referencedSchema: undefined, referencedTable: 'PARENT', referencedSystemColumnName: 'ID', isNew: true
		}]);
	});

	it('resolves an imported foreign key, flagged as new, with a synthetic constraint name', () => {
		let imported = [importedTable({foreignKeys: [{columns: ['PARENT_ID'], referencedSchema: 'SCH', referencedTable: 'PARENT', referencedColumns: ['ID']}]})];
		let resolved = resolveForeignKeys(undefined, imported);
		expect(resolved).to.deep.equal([{
			constraintName: 'imported-fk-0', systemColumnName: 'PARENT_ID', ordinalPosition: 1,
			updateRule: undefined, deleteRule: undefined,
			referencedSchema: 'SCH', referencedTable: 'PARENT', referencedSystemColumnName: 'ID', isNew: true
		}]);
	});

	it('uses a real imported constraint name and its referential actions when the source format provided them', () => {
		let imported = [importedTable({
			foreignKeys: [{name: 'APPUSRL_ROLE', columns: ['RLID'], referencedSchema: 'SCH', referencedTable: 'PARENT', referencedColumns: ['ID'], updateRule: 'NO ACTION', deleteRule: 'CASCADE'}]
		})];
		let resolved = resolveForeignKeys(undefined, imported);
		expect(resolved[0]).to.include({constraintName: 'APPUSRL_ROLE', updateRule: 'NO ACTION', deleteRule: 'CASCADE'});
	});

	it('treats the whole relationship (columns + referenced table/columns) as identity when deduplicating', () => {
		let imported = [
			importedTable({foreignKeys: [{columns: ['PARENT_ID'], referencedSchema: 'SCH', referencedTable: 'PARENT', referencedColumns: ['ID']}]}),
			// Same local column, different target - a genuinely different relationship, must not be dropped.
			importedTable({foreignKeys: [{columns: ['PARENT_ID'], referencedSchema: 'SCH', referencedTable: 'OTHER', referencedColumns: ['ID']}]})
		];
		expect(resolveForeignKeys(undefined, imported)).to.have.length(2);
	});

	it('keeps the first import\'s foreign key when the exact same relationship repeats', () => {
		let sameRelationship = {columns: ['PARENT_ID'], referencedSchema: 'SCH', referencedTable: 'PARENT', referencedColumns: ['ID']};
		let imported = [importedTable({foreignKeys: [sameRelationship]}), importedTable({foreignKeys: [sameRelationship]})];
		expect(resolveForeignKeys(undefined, imported)).to.have.length(1);
	});

	describe('enhanced case (a connected table with real foreign keys of its own)', () => {
		it('surfaces a genuinely new imported relationship alongside the connected table\'s own foreign keys - the motivating use case', () => {
			let foreignKeys = [systemForeignKey({constraintName: 'REAL_FK', systemColumnName: 'A', referencedTable: 'REAL_PARENT', referencedSystemColumnName: 'ID'})];
			let imported = [importedTable({foreignKeys: [{name: 'RPTOWNER_FK', columns: ['RPTOWNER'], referencedSchema: 'ACME', referencedTable: 'APPUSER', referencedColumns: ['UID']}]})];
			let resolved = resolveForeignKeys(foreignKeys, imported);
			expect(resolved).to.have.length(2);
			expect(resolved[0]).to.include({constraintName: 'REAL_FK', isNew: false});
			expect(resolved[1]).to.include({constraintName: 'RPTOWNER_FK', systemColumnName: 'RPTOWNER', referencedTable: 'APPUSER', isNew: true});
		});

		it('does not duplicate an imported relationship that already matches a real one exactly', () => {
			let foreignKeys = [systemForeignKey({constraintName: 'REAL_FK', systemColumnName: 'PARENT_ID', referencedSchema: 'SCH', referencedTable: 'PARENT', referencedSystemColumnName: 'ID'})];
			let imported = [importedTable({foreignKeys: [{name: 'DIFFERENT_NAME', columns: ['PARENT_ID'], referencedSchema: 'SCH', referencedTable: 'PARENT', referencedColumns: ['ID']}]})];
			expect(resolveForeignKeys(foreignKeys, imported)).to.have.length(1);
		});

		it('surfaces an imported relationship whose columns overlap a real one but whose target differs', () => {
			let foreignKeys = [systemForeignKey({constraintName: 'REAL_FK', systemColumnName: 'PARENT_ID', referencedSchema: 'SCH', referencedTable: 'PARENT', referencedSystemColumnName: 'ID'})];
			let imported = [importedTable({foreignKeys: [{name: 'NEW_FK', columns: ['PARENT_ID'], referencedSchema: 'SCH', referencedTable: 'OTHER_PARENT', referencedColumns: ['ID']}]})];
			expect(resolveForeignKeys(foreignKeys, imported)).to.have.length(2);
		});

		it('does not duplicate a relationship an import names by the long column name', () => {
			let columns = [systemColumn({systemName: 'PARID', sqlName: 'PARENT_IDENTIFIER'})];
			let foreignKeys = [systemForeignKey({constraintName: 'REAL_FK', systemColumnName: 'PARID', referencedSchema: 'SCH', referencedTable: 'PARENT', referencedSystemColumnName: 'ID'})];
			let imported = [importedTable({foreignKeys: [{name: 'IMPORTED_FK', columns: ['PARENT_IDENTIFIER'], referencedSchema: 'SCH', referencedTable: 'PARENT', referencedColumns: ['ID']}]})];
			expect(resolveForeignKeys(foreignKeys, imported, columns)).to.have.length(1);
		});
	});
});

describe('resolveIndexes', () => {
	it('passes a connected table\'s indexes through unchanged, converting dates to ISO strings', () => {
		let index = systemIndex();
		let resolved = resolveIndexes([index], []);
		expect(resolved).to.deep.equal([{
			...index, created: index.created.toISOString(), lastBuild: index.lastBuild.toISOString(),
			lastQueryUsed: null, lastUsed: null, isNew: false
		}]);
	});

	// Same reasoning as resolveTableKeys/resolveForeignKeys' equivalent tests - an empty (not undefined)
	// connected array still surfaces an imported index as new, since there's nothing real to match it
	// against.
	it('surfaces an imported index as new for a connected table with zero indexes of its own', () => {
		let imported = [importedTable({indexes: [{columns: ['GHOST'], unique: false}]})];
		expect(resolveIndexes([], imported)).to.deep.equal([
			{indexName: undefined, uniqueness: 'Not Unique', keyColumns: 'GHOST', comment: undefined, isNew: true}
		]);
	});

	it('resolves an imported index, flagged as new', () => {
		let imported = [importedTable({indexes: [{name: 'IDX1', columns: ['A', 'B'], unique: true}]})];
		expect(resolveIndexes(undefined, imported)).to.deep.equal([
			{indexName: 'IDX1', uniqueness: 'Unique', keyColumns: 'A, B', comment: undefined, isNew: true}
		]);
	});

	it('carries an imported index\'s comment through', () => {
		let imported = [importedTable({indexes: [{name: 'IDX1', columns: ['A'], unique: false, comment: 'Generated by the index advisor'}]})];
		expect(resolveIndexes(undefined, imported)[0].comment).to.equal('Generated by the index advisor');
	});

	it('deduplicates imported indexes with the same column set, first import wins', () => {
		let imported = [
			importedTable({indexes: [{name: 'FIRST', columns: ['A'], unique: false}]}),
			importedTable({indexes: [{name: 'SECOND', columns: ['A'], unique: false}]})
		];
		let resolved = resolveIndexes(undefined, imported);
		expect(resolved).to.have.length(1);
		expect(resolved[0].indexName).to.equal('FIRST');
	});

	describe('enhanced case (a connected table with real indexes of its own)', () => {
		it('surfaces a genuinely new imported index alongside the connected table\'s own indexes', () => {
			let indexes = [systemIndex({indexName: 'REAL_IDX', keyColumns: 'A'})];
			let imported = [importedTable({indexes: [{name: 'NEW_IDX', columns: ['B'], unique: false}]})];
			let resolved = resolveIndexes(indexes, imported);
			expect(resolved).to.have.length(2);
			expect(resolved[0]).to.include({indexName: 'REAL_IDX', isNew: false});
			expect(resolved[1]).to.include({indexName: 'NEW_IDX', isNew: true});
		});

		it('does not duplicate an imported index whose column list exactly matches a real one', () => {
			let indexes = [systemIndex({indexName: 'REAL_IDX', keyColumns: 'A, B'})];
			let imported = [importedTable({indexes: [{name: 'DIFFERENT_NAME', columns: ['A', 'B'], unique: false}]})];
			expect(resolveIndexes(indexes, imported)).to.have.length(1);
		});

		it('strips a trailing DESC from a connected index before comparing, so it still matches an identically-shaped import', () => {
			let indexes = [systemIndex({indexName: 'REAL_IDX', keyColumns: 'A, B DESC'})];
			let imported = [importedTable({indexes: [{name: 'DIFFERENT_NAME', columns: ['A', 'B'], unique: false}]})];
			expect(resolveIndexes(indexes, imported)).to.have.length(1);
		});

		it('treats a different column order as a genuinely different index, not a duplicate', () => {
			let indexes = [systemIndex({indexName: 'REAL_IDX', keyColumns: 'A, B'})];
			let imported = [importedTable({indexes: [{name: 'REVERSED_IDX', columns: ['B', 'A'], unique: false}]})];
			expect(resolveIndexes(indexes, imported)).to.have.length(2);
		});

		// The bug this covers: SYSPARTITIONINDEXSTAT.COLUMN_NAMES can report a connected index's key
		// columns using DB2's long sqlName instead of the short systemName an imported file's table
		// fields are always declared with (see dbml-format.ts's export-time columnNameToSystemName map) -
		// without resolving both sides to the same identity, every index on a table like this would show
		// up "new" on every reimport of that table's own just-exported file, even though nothing changed.
		it('matches a connected index reported with long column names against an imported index using short names, given the table\'s column list', () => {
			let indexes = [systemIndex({indexName: 'REAL_IDX', keyColumns: 'ACCT_UNIVERSALID'})];
			let imported = [importedTable({indexes: [{name: 'REAL_IDX', columns: ['UID'], unique: false}]})];
			let columns = [systemColumn({systemName: 'UID', sqlName: 'ACCT_UNIVERSALID'})];
			expect(resolveIndexes(indexes, imported, columns)).to.have.length(1);
		});

		it('still treats a genuinely new imported index as new when the table\'s column list is supplied', () => {
			let indexes = [systemIndex({indexName: 'REAL_IDX', keyColumns: 'ACCT_UNIVERSALID'})];
			let imported = [importedTable({indexes: [{name: 'NEW_IDX', columns: ['USRTYPE'], unique: false}]})];
			let columns = [systemColumn({systemName: 'UID', sqlName: 'ACCT_UNIVERSALID'}), systemColumn({systemName: 'USRTYPE', sqlName: 'USER_TYPE'})];
			let resolved = resolveIndexes(indexes, imported, columns);
			expect(resolved).to.have.length(2);
			expect(resolved[1]).to.include({indexName: 'NEW_IDX', isNew: true});
		});
	});
});

describe('resolveTable', () => {
	function tableSchema(overrides: Partial<TableSchema> = {}): TableSchema {
		return {table: systemTable(), columns: [], keys: [], foreignKeys: [], indexes: [], ...overrides};
	}

	it('marks a connected table as existing in the database and resolves every sub-collection from it', () => {
		let connected = tableSchema({
			table: systemTable({schema: 'MYSCHEMA', name: 'MYTABLE', description: 'A table'}),
			columns: [systemColumn({systemName: 'A'})]
		});
		let resolved = resolveTable(connected, []);
		expect(resolved.schema).to.equal('MYSCHEMA');
		expect(resolved.name).to.equal('MYTABLE');
		expect(resolved.description).to.equal('A table');
		expect(resolved.existsInDatabase).to.equal(true);
		expect(resolved.columns).to.have.length(1);
	});

	it('marks an imported-only table as not existing in the database, taking its name from the first import', () => {
		let imported = [importedTable({schema: 'ACME', name: 'APPUSER', columns: [{name: 'A', type: 'CHAR', nullable: true}]})];
		let resolved = resolveTable(undefined, imported);
		expect(resolved.existsInDatabase).to.equal(false);
		expect(resolved.schema).to.equal('ACME');
		expect(resolved.name).to.equal('APPUSER');
		expect(resolved.columns).to.have.length(1);
	});

	it('throws when there is neither a connected table nor any imported name to fall back on', () => {
		expect(() => resolveTable(undefined, [])).to.throw();
	});
});
