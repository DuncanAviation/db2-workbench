import { expect } from 'chai';
import { ConnectionConfig } from '../models/connection-config.js';
import { buildSqlImportConfig, linkSqlImportToConnections } from './sql-import-persistence.js';

function connection(id: string, sqlImportIds?: string[]): ConnectionConfig {
	return {id: id, name: `Connection ${id}`, host: 'AS400', userName: 'TESTUSER', defaultTableSchema: 'ACME', sqlImportIds: sqlImportIds};
}

describe('sql-import-persistence', () => {
	describe('buildSqlImportConfig', () => {
		it('saves every filled section with its mapping and the columns it returned', () => {
			let config = buildSqlImportConfig({
				importId: 'import-1',
				name: 'Site relationships',
				statements: [
					{section: 'tables', sql: 'select schema, name from catalog'},
					{section: 'relationships', sql: 'select schema1, name1 from appdbrl'}
				],
				mappings: {
					tables: {SCHEMA: 'schema', NAME: 'tableSystemName'},
					relationships: {SCHEMA1: 'childSchema', NAME1: 'childTableSystemName'}
				},
				resultColumns: {tables: ['SCHEMA', 'NAME'], relationships: ['SCHEMA1', 'NAME1']}
			});

			expect(config.id).to.equal('import-1');
			expect(config.tables.sql).to.equal('select schema, name from catalog');
			expect(config.tables.mapping).to.deep.equal({SCHEMA: 'schema', NAME: 'tableSystemName'});
			expect(config.tables.resultColumns).to.deep.equal(['SCHEMA', 'NAME']);
			expect(config.relationships?.sql).to.equal('select schema1, name1 from appdbrl');
		});

		it('leaves an empty section out entirely rather than saving a blank statement', () => {
			let config = buildSqlImportConfig({
				importId: 'import-1',
				name: 'Tables only',
				statements: [{section: 'tables', sql: 'select schema, name from catalog'}, {section: 'columns', sql: '   '}],
				mappings: {},
				resultColumns: {}
			});

			expect(config.columns).to.equal(undefined);
			expect(config.relationships).to.equal(undefined);
		});
	});

	describe('linkSqlImportToConnections', () => {
		it('links the checked connections and unlinks the rest', () => {
			let linked = linkSqlImportToConnections([connection('a'), connection('b', ['import-1'])], 'import-1', ['a']);

			expect(linked[0].sqlImportIds).to.deep.equal(['import-1']);
			expect(linked[1].sqlImportIds).to.equal(undefined);
		});

		it('leaves other imports\' links alone', () => {
			let linked = linkSqlImportToConnections([connection('a', ['import-other'])], 'import-1', ['a']);
			expect(linked[0].sqlImportIds).to.deep.equal(['import-other', 'import-1']);
		});

		it('does not link the same import twice', () => {
			let linked = linkSqlImportToConnections([connection('a', ['import-1'])], 'import-1', ['a']);
			expect(linked[0].sqlImportIds).to.deep.equal(['import-1']);
		});

		it('writes no empty array for a connection that links nothing', () => {
			let linked = linkSqlImportToConnections([connection('a'), connection('b')], 'import-1', ['b']);
			expect(linked[0].sqlImportIds).to.equal(undefined);
		});

		// What the View Imports confirmation's "Unlink from this connection" comes down to - see
		// SqlSchemaImports.unlinkSavedImport, which passes every linked connection except the current one.
		it('unlinks one connection while the others keep their link', () => {
			let linked = linkSqlImportToConnections([connection('a', ['import-1']), connection('b', ['import-1'])], 'import-1', ['b']);

			expect(linked[0].sqlImportIds).to.equal(undefined);
			expect(linked[1].sqlImportIds).to.deep.equal(['import-1']);
		});
	});
});
