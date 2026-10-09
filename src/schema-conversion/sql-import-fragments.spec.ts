import { expect } from 'chai';
import { SqlImportTarget } from '../models/sql-import-config.js';
import { ImportedTableSchema } from './schema-format-converter.js';
import {
	getSqlImportFilterColumns,
	isEmptySqlImportFragment,
	mergeSqlImportFragments,
	SqlImportTableFragment,
	sqlImportFragmentKey
} from './sql-import-fragments.js';

function storedTable(importId: string, schema: string, name: string): ImportedTableSchema {
	return {
		schema: schema,
		name: name,
		columns: [],
		primaryKeyColumns: [],
		uniqueKeys: [],
		foreignKeys: [],
		indexes: [],
		provenance: {importId: importId, sourceFormat: 'sql', sourceLabel: 'Relationships import', importedAt: '2026-09-16T00:00:00.000Z'}
	};
}

function fragment(importId: string, overrides: Partial<SqlImportTableFragment> = {}): SqlImportTableFragment {
	return {
		importId: importId,
		importName: 'Relationships import',
		importedAt: '2026-09-16T00:00:00.000Z',
		schema: 'ACME',
		table: 'APPUSER',
		columns: [],
		primaryKeyColumns: [],
		foreignKeys: [],
		...overrides
	};
}

describe('sql-import-fragments', () => {
	describe('getSqlImportFilterColumns', () => {
		it('filters the Columns section on its schema and table system name', () => {
			let mapping: Record<string, SqlImportTarget> = {LIB: 'schema', TBL: 'tableSystemName', COL: 'columnSystemName'};
			expect(getSqlImportFilterColumns('columns', mapping)).to.deep.equal({schemaColumn: 'LIB', tableColumn: 'TBL'});
		});

		it('filters the Relationships section on the child side, never the parent', () => {
			let mapping: Record<string, SqlImportTarget> = {
				SCHEMA1: 'childSchema',
				NAME1: 'childTableSystemName',
				COLNAME1: 'childColumnSystemName',
				SCHEMA2: 'parentSchema',
				NAME2: 'parentTableSystemName',
				COLNAME2: 'parentColumnSystemName'
			};

			expect(getSqlImportFilterColumns('relationships', mapping)).to.deep.equal({schemaColumn: 'SCHEMA1', tableColumn: 'NAME1'});
		});

		it('is undefined when a required filter target is not mapped', () => {
			expect(getSqlImportFilterColumns('columns', {LIB: 'schema'})).to.equal(undefined);
			expect(getSqlImportFilterColumns('relationships', {SCHEMA1: 'childSchema'})).to.equal(undefined);
		});
	});

	describe('isEmptySqlImportFragment', () => {
		it('is empty only when the import contributed nothing at all', () => {
			expect(isEmptySqlImportFragment(fragment('one'))).to.equal(true);
			expect(isEmptySqlImportFragment(fragment('one', {primaryKeyColumns: ['EMNO']}))).to.equal(false);
		});
	});

	describe('mergeSqlImportFragments', () => {
		it('returns the stored tables untouched when nothing has been loaded', () => {
			let stored = [storedTable('one', 'ACME', 'APPUSER')];
			expect(mergeSqlImportFragments(stored, [])).to.equal(stored);
		});

		it('fills the matching import\'s entry with what its sections loaded', () => {
			let loaded = fragment('one', {
				columns: [{name: 'EMNO', type: 'CHAR', nullable: true}],
				primaryKeyColumns: ['EMNO'],
				foreignKeys: [{columns: ['EMNO'], referencedSchema: 'ACME', referencedTable: 'EMPXTND', referencedColumns: ['EMPTCD']}]
			});

			let merged = mergeSqlImportFragments([storedTable('one', 'ACME', 'APPUSER')], [loaded]);

			expect(merged).to.have.lengthOf(1);
			expect(merged[0].columns.map(column => column.name)).to.deep.equal(['EMNO']);
			expect(merged[0].primaryKeyColumns).to.deep.equal(['EMNO']);
			expect(merged[0].foreignKeys[0].referencedTable).to.equal('EMPXTND');
		});

		it('only fills the entry belonging to the import the fragment came from', () => {
			let merged = mergeSqlImportFragments(
				[storedTable('one', 'ACME', 'APPUSER'), storedTable('two', 'ACME', 'APPUSER')],
				[fragment('two', {primaryKeyColumns: ['UID']})]
			);

			expect(merged[0].primaryKeyColumns).to.deep.equal([]);
			expect(merged[1].primaryKeyColumns).to.deep.equal(['UID']);
		});

		// A table the import's own Tables statement never returned, but DB2 has - the relationship still
		// belongs on it, so it arrives as a table of its own rather than being dropped.
		it('synthesizes a transient table for a fragment with no stored entry', () => {
			let loaded = fragment('one', {
				table: 'APPUSJB',
				foreignKeys: [{columns: ['UID'], referencedSchema: 'ACME', referencedTable: 'APPUSER', referencedColumns: ['UID']}]
			});

			let merged = mergeSqlImportFragments([], [loaded]);

			expect(merged).to.have.lengthOf(1);
			expect(merged[0].name).to.equal('APPUSJB');
			expect(merged[0].schema).to.equal('ACME');
			expect(merged[0].provenance).to.deep.equal({
				importId: 'one',
				sourceFormat: 'sql',
				sourceLabel: 'Relationships import',
				importedAt: '2026-09-16T00:00:00.000Z'
			});
		});

		it('does not synthesize a table for a fragment that loaded nothing', () => {
			expect(mergeSqlImportFragments([], [fragment('one')])).to.deep.equal([]);
		});
	});

	describe('sqlImportFragmentKey', () => {
		it('identifies one import\'s one section for one table, per host', () => {
			expect(sqlImportFragmentKey('as400', 'one', 'columns', 'acme', 'appuser')).to.equal('AS400|one|columns|ACME.APPUSER');
		});

		it('keys the same host and table the same way whatever case they are written in', () => {
			expect(sqlImportFragmentKey('AS400', 'one', 'relationships', 'ACME', 'APPUSER'))
				.to.equal(sqlImportFragmentKey('as400', 'one', 'relationships', 'acme', 'appuser'));
		});
	});
});
