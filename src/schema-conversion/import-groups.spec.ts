import { expect } from 'chai';
import { findFullyDisabledImports, findImportsToDelete, findImportsToUnlink, groupImports, importEntryKey, importedTableKey } from './import-groups.js';
import { ImportedTableSchema } from './schema-format-converter.js';
import { NO_SCHEMA_BUCKET, SchemaImportSummary } from '../webview-messages/schemas-messages.js';

function importedTable(importId: string, name: string, schema?: string, sourceLabel = 'orders.dbml'): ImportedTableSchema {
	return {
		schema: schema,
		name: name,
		columns: [],
		primaryKeyColumns: [],
		uniqueKeys: [],
		foreignKeys: [],
		indexes: [],
		provenance: {
			importId: importId,
			sourceFormat: 'dbml',
			sourceLabel: sourceLabel,
			importedAt: '2026-09-15T14:30:00.000Z'
		}
	};
}

describe('groupImports', () => {
	it('groups tables by import, keeping import and table order', () => {
		let summaries = groupImports([
			importedTable('import-1', 'ORDERS', 'MYSCHEMA'),
			importedTable('import-2', 'CUSTOMERS', 'MYSCHEMA', 'customers.dbml'),
			importedTable('import-1', 'ORDER_LINES', 'MYSCHEMA')
		]);

		expect(summaries.map(summary => summary.importId)).to.eql(['import-1', 'import-2']);
		expect(summaries[0].tables.map(table => table.table)).to.eql(['ORDERS', 'ORDER_LINES']);
		expect(summaries[0].sourceLabel).to.equal('orders.dbml');
		expect(summaries[1].tables.map(table => table.table)).to.eql(['CUSTOMERS']);
	});

	it('buckets a schema-less table the same way the tree does', () => {
		let summaries = groupImports([importedTable('import-1', 'ORDERS')]);

		expect(summaries[0].tables[0].schema).to.equal(NO_SCHEMA_BUCKET);
	});

	it('keeps two imports of the same table separate', () => {
		let summaries = groupImports([
			importedTable('import-1', 'ORDERS', 'MYSCHEMA'),
			importedTable('import-2', 'ORDERS', 'MYSCHEMA', 'orders-v2.dbml')
		]);

		expect(summaries).to.have.length(2);
		expect(summaries.every(summary => summary.tables.length === 1)).to.equal(true);
	});

	it('returns nothing for no imports', () => {
		expect(groupImports([])).to.eql([]);
	});

	it('marks every table enabled when nothing is disabled', () => {
		let summaries = groupImports([importedTable('import-1', 'ORDERS', 'MYSCHEMA')]);

		expect(summaries[0].tables[0].enabled).to.equal(true);
	});

	it('marks a disabled table as not enabled, leaving it listed', () => {
		let tables = [importedTable('import-1', 'ORDERS', 'MYSCHEMA'), importedTable('import-1', 'ORDER_LINES', 'MYSCHEMA')];
		let summaries = groupImports(tables, new Set([importedTableKey(tables[0])]));

		expect(summaries[0].tables.map(table => table.table)).to.eql(['ORDERS', 'ORDER_LINES']);
		expect(summaries[0].tables.map(table => table.enabled)).to.eql([false, true]);
	});

	// The same table disabled under one import stays applied under another - the key carries the import id.
	it('disables only the import the key names', () => {
		let tables = [importedTable('import-1', 'ORDERS', 'MYSCHEMA'), importedTable('import-2', 'ORDERS', 'MYSCHEMA', 'orders-v2.dbml')];
		let summaries = groupImports(tables, new Set([importedTableKey(tables[0])]));

		expect(summaries[0].tables[0].enabled).to.equal(false);
		expect(summaries[1].tables[0].enabled).to.equal(true);
	});
});

describe('importEntryKey', () => {
	it('upper-cases schema and table so the set matches case-insensitively', () => {
		expect(importEntryKey('import-1', 'myschema', 'orders')).to.equal(importEntryKey('import-1', 'MYSCHEMA', 'ORDERS'));
	});

	it('buckets a schema-less table under the no-schema sentinel', () => {
		expect(importEntryKey('import-1', undefined, 'ORDERS')).to.equal(importEntryKey('import-1', NO_SCHEMA_BUCKET, 'ORDERS'));
	});

	it('keeps two imports of the same table apart', () => {
		expect(importEntryKey('import-1', 'MYSCHEMA', 'ORDERS')).to.not.equal(importEntryKey('import-2', 'MYSCHEMA', 'ORDERS'));
	});

	// The prefix is what clearDisabledKeysFor matches on when a re-merge wipes one import's keys, so an
	// import id has to be followed by the separator rather than running into the schema name.
	it('separates the import id from the rest of the key', () => {
		expect(importEntryKey('import-1', 'MYSCHEMA', 'ORDERS').startsWith('import-1|')).to.equal(true);
	});
});

describe('importedTableKey', () => {
	it('matches the entry key the webviews send back for the same table', () => {
		let table = importedTable('import-1', 'ORDERS', 'MYSCHEMA');

		expect(importedTableKey(table)).to.equal(importEntryKey('import-1', 'myschema', 'orders'));
	});

	it('keys a schema-less table under the no-schema bucket', () => {
		let table = importedTable('import-1', 'ORDERS');

		expect(importedTableKey(table)).to.equal(importEntryKey('import-1', NO_SCHEMA_BUCKET, 'ORDERS'));
		expect(importedTableKey(table)).to.not.equal(importEntryKey('import-1', 'MYSCHEMA', 'ORDERS'));
	});
});

// The apply's OUTCOME, not its disable list alone - which is what makes an already-disabled table count
// toward "this import ends up with nothing applied".
describe('findFullyDisabledImports', () => {
	function summary(importId: string, tables: {table: string; enabled?: boolean}[]): SchemaImportSummary {
		return {
			importId: importId,
			sourceLabel: `Import ${importId}`,
			sourceFormat: 'sql',
			importedAt: '2026-09-16T00:00:00.000Z',
			tables: tables.map(entry => ({schema: 'ACME', table: entry.table, enabled: entry.enabled ?? true}))
		};
	}

	it('reports an import whose every table this apply disables', () => {
		let emptied = findFullyDisabledImports([summary('import-1', [{table: 'APPUSER'}, {table: 'APPUSJB'}])], [
			{importId: 'import-1', schema: 'ACME', table: 'APPUSER'},
			{importId: 'import-1', schema: 'ACME', table: 'APPUSJB'}
		], []);

		expect(emptied.map(entry => entry.importId)).to.deep.equal(['import-1']);
	});

	it('does not report an import that keeps a table applied', () => {
		let emptied = findFullyDisabledImports([summary('import-1', [{table: 'APPUSER'}, {table: 'APPUSJB'}])], [
			{importId: 'import-1', schema: 'ACME', table: 'APPUSER'}
		], []);

		expect(emptied).to.deep.equal([]);
	});

	// Disabling the last APPLIED table of an import whose others were switched off earlier still leaves it
	// with nothing applied - the earlier ones do not have to be named again.
	it('counts a table that was already disabled', () => {
		let emptied = findFullyDisabledImports([summary('import-1', [{table: 'APPUSER', enabled: false}, {table: 'APPUSJB'}])], [
			{importId: 'import-1', schema: 'ACME', table: 'APPUSJB'}
		], []);

		expect(emptied.map(entry => entry.importId)).to.deep.equal(['import-1']);
	});

	// ...unless the same apply is switching that one back on, in which case the import still has something.
	it('does not count an already-disabled table this apply re-enables', () => {
		let emptied = findFullyDisabledImports([summary('import-1', [{table: 'APPUSER', enabled: false}, {table: 'APPUSJB'}])], [
			{importId: 'import-1', schema: 'ACME', table: 'APPUSJB'}
		], [
			{importId: 'import-1', schema: 'ACME', table: 'APPUSER'}
		]);

		expect(emptied).to.deep.equal([]);
	});

	// An import already fully disabled before this apply is reported again - the confirmation has to be
	// able to offer unlink/delete for one the user disabled earlier and is now taking off the list.
	it('reports an import that was already fully disabled', () => {
		let emptied = findFullyDisabledImports([summary('import-1', [{table: 'APPUSER', enabled: false}])], [], []);

		expect(emptied.map(entry => entry.importId)).to.deep.equal(['import-1']);
	});

	it('matches schema and table case-insensitively', () => {
		let emptied = findFullyDisabledImports([summary('import-1', [{table: 'APPUSER'}])], [
			{importId: 'import-1', schema: 'acme', table: 'appuser'}
		], []);

		expect(emptied.map(entry => entry.importId)).to.deep.equal(['import-1']);
	});

	// Another import's entries say nothing about this one, however identical the tables look.
	it('ignores entries belonging to a different import', () => {
		let emptied = findFullyDisabledImports([summary('import-1', [{table: 'APPUSER'}])], [
			{importId: 'import-2', schema: 'ACME', table: 'APPUSER'}
		], []);

		expect(emptied).to.deep.equal([]);
	});
});

// The host-side half of the View Imports confirmation's per-import choice - what the webview asked for,
// narrowed to what it is actually allowed to do.
describe('findImportsToUnlink / findImportsToDelete', () => {
	function summary(importId: string, tables: string[], saved: boolean): SchemaImportSummary {
		return {
			importId: importId,
			sourceLabel: `Import ${importId}`,
			sourceFormat: 'sql',
			importedAt: '2026-09-16T00:00:00.000Z',
			saved: saved,
			tables: tables.map(table => ({schema: 'ACME', table: table, enabled: true}))
		};
	}

	it('unlinks a saved import the apply empties out and that was asked for', () => {
		let unlinkable = findImportsToUnlink([summary('import-1', ['APPUSER'], true)], [
			{importId: 'import-1', schema: 'ACME', table: 'APPUSER'}
		], [], ['import-1']);

		expect(unlinkable.map(entry => entry.importId)).to.deep.equal(['import-1']);
	});

	// Nothing but a saved import has a settings entry to stay behind for another connection.
	it('refuses to unlink an import with no settings entry behind it', () => {
		let unlinkable = findImportsToUnlink([summary('import-1', ['APPUSER'], false)], [
			{importId: 'import-1', schema: 'ACME', table: 'APPUSER'}
		], [], ['import-1']);

		expect(unlinkable).to.deep.equal([]);
	});

	it('deletes a saved import the apply empties out and that was asked for', () => {
		let deletable = findImportsToDelete([summary('import-1', ['APPUSER'], true)], [
			{importId: 'import-1', schema: 'ACME', table: 'APPUSER'}
		], [], ['import-1']);

		expect(deletable.map(entry => entry.importId)).to.deep.equal(['import-1']);
	});

	// Unlike unlinking, deleting an unsaved import means something: drop the rows nothing else holds.
	it('deletes an unsaved import too', () => {
		let deletable = findImportsToDelete([summary('import-1', ['APPUSER'], false)], [
			{importId: 'import-1', schema: 'ACME', table: 'APPUSER'}
		], [], ['import-1']);

		expect(deletable.map(entry => entry.importId)).to.deep.equal(['import-1']);
	});

	// The choice was made against a list that has since changed - acting anyway would throw away far more
	// than this apply covers.
	it('refuses an import the apply does not empty out', () => {
		let deletable = findImportsToDelete([summary('import-1', ['APPUSER', 'APPUSJB'], true)], [
			{importId: 'import-1', schema: 'ACME', table: 'APPUSER'}
		], [], ['import-1']);

		expect(deletable).to.deep.equal([]);
	});

	it('does nothing when the apply asked for nothing', () => {
		let deletable = findImportsToDelete([summary('import-1', ['APPUSER'], true)], [
			{importId: 'import-1', schema: 'ACME', table: 'APPUSER'}
		], [], []);

		expect(deletable).to.deep.equal([]);
	});

	it('acts only on the imports that were asked for', () => {
		let summaries = [summary('import-1', ['APPUSER'], true), summary('import-2', ['APPJTTL'], true)];

		let deletable = findImportsToDelete(summaries, [
			{importId: 'import-1', schema: 'ACME', table: 'APPUSER'},
			{importId: 'import-2', schema: 'ACME', table: 'APPJTTL'}
		], [], ['import-2']);

		expect(deletable.map(entry => entry.importId)).to.deep.equal(['import-2']);
	});
});
