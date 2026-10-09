import { expect } from 'chai';
import { SqlImportRow, SqlImportTarget } from '../models/sql-import-config.js';
import {
	buildSqlImportedTables,
	checkSqlImportMappingDrift,
	convertSqlImportColumnRows,
	convertSqlImportRelationshipRows,
	convertSqlImportTableRows,
	sqlImportTableKey
} from './sql-import-converter.js';

const TABLE_MAPPING: Record<string, SqlImportTarget> = {
	SCHEMA: 'schema',
	TABLENAME: 'tableSystemName',
	LONGNAME: 'tableSqlName',
	LABEL: 'tableDescription'
};

const COLUMN_MAPPING: Record<string, SqlImportTarget> = {
	SCHEMA: 'schema',
	TABLENAME: 'tableSystemName',
	COLNAME: 'columnSystemName',
	COLTYPE: 'dataType',
	NULLS: 'nullable',
	PK: 'primaryKey',
	POS: 'columnPosition'
};

const RELATIONSHIP_MAPPING: Record<string, SqlImportTarget> = {
	SCHEMA1: 'childSchema',
	NAME1: 'childTableSystemName',
	COLNAME1: 'childColumnSystemName',
	SCHEMA2: 'parentSchema',
	NAME2: 'parentTableSystemName',
	COLNAME2: 'parentColumnSystemName'
};

// Reads one table's contribution out of a per-table map, so a test asserting on a table that produced
// nothing fails on the assertion rather than on a missing map entry.
function forTable<T>(map: Map<string, T[]>, schema: string, table: string): T[] {
	return map.get(sqlImportTableKey(schema, table)) ?? [];
}

function known(...tables: string[]): Set<string> {
	return new Set(tables);
}

function issueCount(issues: {kind: string; count: number}[], kind: string): number {
	return issues.filter(issue => issue.kind === kind).reduce((total, issue) => total + issue.count, 0);
}

describe('convertSqlImportTableRows', () => {
	it('reads a table with every fact mapped', () => {
		let rows: SqlImportRow[] = [{SCHEMA: 'ACME', TABLENAME: 'APPUSER', LONGNAME: 'ACCT_MASTER', LABEL: 'Users'}];
		let result = convertSqlImportTableRows(rows, TABLE_MAPPING);

		expect(result.tables).to.eql([{schema: 'ACME', name: 'APPUSER', sqlName: 'ACCT_MASTER', description: 'Users'}]);
		expect(result.stats.importedCount).to.equal(1);
		expect(result.stats.issues).to.be.empty;
	});

	it('trims the blank padding DB2 CHAR columns come back with', () => {
		let result = convertSqlImportTableRows([{SCHEMA: 'ACME   ', TABLENAME: 'APPUSER  '}], TABLE_MAPPING);

		expect(result.tables[0]).to.include({schema: 'ACME', name: 'APPUSER'});
	});

	it('skips and counts a row missing a required value', () => {
		let result = convertSqlImportTableRows([{SCHEMA: '  ', TABLENAME: 'APPUSER'}, {SCHEMA: 'ACME', TABLENAME: 'APPUSER'}], TABLE_MAPPING);

		expect(result.tables).to.have.lengthOf(1);
		expect(issueCount(result.stats.issues, 'missingRequired')).to.equal(1);
	});

	it('counts one skipped row even when several required values are missing', () => {
		let result = convertSqlImportTableRows([{SCHEMA: null, TABLENAME: null}], TABLE_MAPPING);

		expect(issueCount(result.stats.issues, 'missingRequired')).to.equal(1);
	});

	it('dedupes a repeated table', () => {
		let rows: SqlImportRow[] = [{SCHEMA: 'ACME', TABLENAME: 'APPUSER'}, {SCHEMA: 'acme', TABLENAME: 'appuser'}];
		let result = convertSqlImportTableRows(rows, TABLE_MAPPING);

		expect(result.tables).to.have.lengthOf(1);
		expect(issueCount(result.stats.issues, 'duplicate')).to.equal(1);
	});

	it('reports the returned row count even when nothing is usable', () => {
		let result = convertSqlImportTableRows([{SCHEMA: 'ACME'}], TABLE_MAPPING);

		expect(result.stats.rowCount).to.equal(1);
		expect(result.stats.importedCount).to.equal(0);
	});
});

describe('convertSqlImportColumnRows', () => {
	let tables = known(sqlImportTableKey('ACME', 'APPUSER'));

	it('reads columns, booleans and the primary key', () => {
		let rows: SqlImportRow[] = [
			{SCHEMA: 'ACME', TABLENAME: 'APPUSER', COLNAME: 'EMNO', COLTYPE: 'CHAR(4)', NULLS: 'N', PK: 'Y', POS: 1},
			{SCHEMA: 'ACME', TABLENAME: 'APPUSER', COLNAME: 'UID', COLTYPE: 'DECIMAL(9,0)', NULLS: 'YES', PK: '0', POS: 2}
		];

		let result = convertSqlImportColumnRows(rows, COLUMN_MAPPING, tables);
		let columns = forTable(result.columns, 'ACME', 'APPUSER');

		expect(columns.map(column => column.name)).to.eql(['EMNO', 'UID']);
		expect(columns[0]).to.include({type: 'CHAR(4)', nullable: false, colNo: 1});
		expect(columns[1].nullable).to.be.true;
		expect(result.primaryKeyColumns.get(sqlImportTableKey('ACME', 'APPUSER'))).to.eql(['EMNO']);
	});

	it('orders columns by Column Position when every row has one', () => {
		let rows: SqlImportRow[] = [
			{SCHEMA: 'ACME', TABLENAME: 'APPUSER', COLNAME: 'B', POS: 2},
			{SCHEMA: 'ACME', TABLENAME: 'APPUSER', COLNAME: 'A', POS: 1}
		];

		let result = convertSqlImportColumnRows(rows, COLUMN_MAPPING, tables);

		expect(forTable(result.columns, 'ACME', 'APPUSER').map(column => column.name)).to.eql(['A', 'B']);
	});

	it('keeps result-set order when a position is missing', () => {
		let rows: SqlImportRow[] = [
			{SCHEMA: 'ACME', TABLENAME: 'APPUSER', COLNAME: 'B', POS: 2},
			{SCHEMA: 'ACME', TABLENAME: 'APPUSER', COLNAME: 'A'}
		];

		let result = convertSqlImportColumnRows(rows, COLUMN_MAPPING, tables);

		expect(forTable(result.columns, 'ACME', 'APPUSER').map(column => column.name)).to.eql(['B', 'A']);
	});

	it('drops an unrecognized boolean and counts it, keeping the column', () => {
		let rows: SqlImportRow[] = [{SCHEMA: 'ACME', TABLENAME: 'APPUSER', COLNAME: 'EMNO', NULLS: 'maybe'}];
		let result = convertSqlImportColumnRows(rows, COLUMN_MAPPING, tables);

		expect(forTable(result.columns, 'ACME', 'APPUSER')).to.have.lengthOf(1);
		expect(forTable(result.columns, 'ACME', 'APPUSER')[0].nullable).to.be.true;
		expect(issueCount(result.stats.issues, 'invalidValue')).to.equal(1);
	});

	it('leaves the data type blank rather than claiming one', () => {
		let result = convertSqlImportColumnRows([{SCHEMA: 'ACME', TABLENAME: 'APPUSER', COLNAME: 'EMNO'}], COLUMN_MAPPING, tables);

		expect(forTable(result.columns, 'ACME', 'APPUSER')[0].type).to.equal('');
	});

	it('skips a row naming a table nothing knows about', () => {
		let rows: SqlImportRow[] = [{SCHEMA: 'ACME', TABLENAME: 'NOSUCH', COLNAME: 'EMNO'}];
		let result = convertSqlImportColumnRows(rows, COLUMN_MAPPING, tables);

		expect(result.columns.size).to.equal(0);
		expect(issueCount(result.stats.issues, 'unknownTable')).to.equal(1);
	});

	it('dedupes a repeated column', () => {
		let rows: SqlImportRow[] = [
			{SCHEMA: 'ACME', TABLENAME: 'APPUSER', COLNAME: 'EMNO'},
			{SCHEMA: 'ACME', TABLENAME: 'APPUSER', COLNAME: 'emno'}
		];

		let result = convertSqlImportColumnRows(rows, COLUMN_MAPPING, tables);

		expect(forTable(result.columns, 'ACME', 'APPUSER')).to.have.lengthOf(1);
		expect(issueCount(result.stats.issues, 'duplicate')).to.equal(1);
	});
});

describe('convertSqlImportRelationshipRows', () => {
	let tables = known(
		sqlImportTableKey('ACME', 'APPUSER'),
		sqlImportTableKey('ACME', 'EMPXTND'),
		sqlImportTableKey('ACME', 'APPUSJB')
	);

	it('builds one single-column relationship per row when no key name is mapped', () => {
		let rows: SqlImportRow[] = [
			{SCHEMA1: 'ACME', NAME1: 'APPUSER', COLNAME1: 'EMNO', SCHEMA2: 'ACME', NAME2: 'EMPXTND', COLNAME2: 'EMPTCD'},
			{SCHEMA1: 'ACME', NAME1: 'APPUSER', COLNAME1: 'UID', SCHEMA2: 'ACME', NAME2: 'APPUSJB', COLNAME2: 'UID'}
		];

		let result = convertSqlImportRelationshipRows(rows, RELATIONSHIP_MAPPING, tables);
		let foreignKeys = forTable(result.foreignKeys, 'ACME', 'APPUSER');

		expect(foreignKeys).to.have.lengthOf(2);
		expect(foreignKeys[0]).to.include({referencedSchema: 'ACME', referencedTable: 'EMPXTND'});
		expect(foreignKeys[0].columns).to.eql(['EMNO']);
		expect(foreignKeys[0].referencedColumns).to.eql(['EMPTCD']);
		// Never synthesized - an unnamed relationship has no constraint name to claim.
		expect(foreignKeys[0].name).to.be.undefined;
	});

	it('groups a composite key by Foreign Key Name, ordered by Key Position', () => {
		let mapping: Record<string, SqlImportTarget> = {...RELATIONSHIP_MAPPING, FKNAME: 'foreignKeyName', KEYPOS: 'keyPosition'};
		let rows: SqlImportRow[] = [
			{SCHEMA1: 'ACME', NAME1: 'APPUSER', COLNAME1: 'B', SCHEMA2: 'ACME', NAME2: 'APPUSJB', COLNAME2: 'PB', FKNAME: 'FK1', KEYPOS: 2},
			{SCHEMA1: 'ACME', NAME1: 'APPUSER', COLNAME1: 'A', SCHEMA2: 'ACME', NAME2: 'APPUSJB', COLNAME2: 'PA', FKNAME: 'FK1', KEYPOS: 1}
		];

		let result = convertSqlImportRelationshipRows(rows, mapping, tables);
		let foreignKeys = forTable(result.foreignKeys, 'ACME', 'APPUSER');

		expect(foreignKeys).to.have.lengthOf(1);
		expect(foreignKeys[0].name).to.equal('FK1');
		expect(foreignKeys[0].columns).to.eql(['A', 'B']);
		expect(foreignKeys[0].referencedColumns).to.eql(['PA', 'PB']);
	});

	it('dedupes a repeated key name and position', () => {
		let mapping: Record<string, SqlImportTarget> = {...RELATIONSHIP_MAPPING, FKNAME: 'foreignKeyName', KEYPOS: 'keyPosition'};
		let row: SqlImportRow = {SCHEMA1: 'ACME', NAME1: 'APPUSER', COLNAME1: 'A', SCHEMA2: 'ACME', NAME2: 'APPUSJB', COLNAME2: 'PA', FKNAME: 'FK1', KEYPOS: 1};
		let result = convertSqlImportRelationshipRows([row, {...row}], mapping, tables);

		expect(forTable(result.foreignKeys, 'ACME', 'APPUSER')[0].columns).to.eql(['A']);
		expect(issueCount(result.stats.issues, 'duplicate')).to.equal(1);
	});

	it('dedupes an identical unnamed relationship', () => {
		let row: SqlImportRow = {SCHEMA1: 'ACME', NAME1: 'APPUSER', COLNAME1: 'UID', SCHEMA2: 'ACME', NAME2: 'APPUSJB', COLNAME2: 'UID'};
		let result = convertSqlImportRelationshipRows([row, {...row}], RELATIONSHIP_MAPPING, tables);

		expect(result.foreignKeys.get(sqlImportTableKey('ACME', 'APPUSER'))).to.have.lengthOf(1);
		expect(issueCount(result.stats.issues, 'duplicate')).to.equal(1);
	});

	it('validates referential actions and drops anything else', () => {
		let mapping: Record<string, SqlImportTarget> = {...RELATIONSHIP_MAPPING, UPD: 'updateRule', DEL: 'deleteRule'};
		let rows: SqlImportRow[] = [
			{SCHEMA1: 'ACME', NAME1: 'APPUSER', COLNAME1: 'A', SCHEMA2: 'ACME', NAME2: 'APPUSJB', COLNAME2: 'PA', UPD: 'cascade', DEL: 'explode'}
		];

		let result = convertSqlImportRelationshipRows(rows, mapping, tables);
		let foreignKey = forTable(result.foreignKeys, 'ACME', 'APPUSER')[0];

		expect(foreignKey.updateRule).to.equal('CASCADE');
		expect(foreignKey.deleteRule).to.be.undefined;
		expect(issueCount(result.stats.issues, 'invalidValue')).to.equal(1);
	});

	it('skips a row whose parent table is unknown on both sides', () => {
		let rows: SqlImportRow[] = [
			{SCHEMA1: 'ACME', NAME1: 'APPUSER', COLNAME1: 'A', SCHEMA2: 'ACME', NAME2: 'NOSUCH', COLNAME2: 'PA'}
		];

		let result = convertSqlImportRelationshipRows(rows, RELATIONSHIP_MAPPING, tables);

		expect(result.foreignKeys.size).to.equal(0);
		expect(issueCount(result.stats.issues, 'unknownTable')).to.equal(1);
	});

	it('keeps a parent table that only exists in the database', () => {
		let rows: SqlImportRow[] = [
			{SCHEMA1: 'ACME', NAME1: 'APPUSER', COLNAME1: 'A', SCHEMA2: 'ACME', NAME2: 'DB2ONLY', COLNAME2: 'PA'}
		];

		let result = convertSqlImportRelationshipRows(rows, RELATIONSHIP_MAPPING, new Set([...tables, sqlImportTableKey('ACME', 'DB2ONLY')]));

		expect(result.foreignKeys.get(sqlImportTableKey('ACME', 'APPUSER'))).to.have.lengthOf(1);
	});
});

describe('buildSqlImportedTables', () => {
	it('assembles the fragments the host stamps provenance onto', () => {
		let tables = convertSqlImportTableRows([{SCHEMA: 'ACME', TABLENAME: 'APPUSER', LABEL: 'Users'}], TABLE_MAPPING).tables;
		let columns = convertSqlImportColumnRows(
			[{SCHEMA: 'ACME', TABLENAME: 'APPUSER', COLNAME: 'EMNO', PK: 'Y'}],
			COLUMN_MAPPING,
			known(sqlImportTableKey('ACME', 'APPUSER'))
		);

		let imported = buildSqlImportedTables({tables: tables, columns: columns.columns, primaryKeyColumns: columns.primaryKeyColumns});

		expect(imported).to.have.lengthOf(1);
		expect(imported[0]).to.include({schema: 'ACME', name: 'APPUSER', description: 'Users'});
		expect(imported[0].columns.map(column => column.name)).to.eql(['EMNO']);
		expect(imported[0].primaryKeyColumns).to.eql(['EMNO']);
		expect(imported[0].uniqueKeys).to.be.empty;
		expect(imported[0].indexes).to.be.empty;
	});

	it('leaves a table empty for a section that has not loaded yet', () => {
		let tables = convertSqlImportTableRows([{SCHEMA: 'ACME', TABLENAME: 'APPUSER'}], TABLE_MAPPING).tables;
		let imported = buildSqlImportedTables({tables: tables});

		expect(imported[0].columns).to.be.empty;
		expect(imported[0].foreignKeys).to.be.empty;
	});
});

describe('checkSqlImportMappingDrift', () => {
	it('reports nothing when every mapped column is still there', () => {
		let drift = checkSqlImportMappingDrift('tables', TABLE_MAPPING, ['SCHEMA', 'TABLENAME', 'LONGNAME', 'LABEL']);

		expect(drift.missingRequired).to.be.empty;
		expect(drift.missingOptional).to.be.empty;
	});

	it('reports a vanished required column separately from an optional one', () => {
		let drift = checkSqlImportMappingDrift('tables', TABLE_MAPPING, ['SCHEMA', 'LONGNAME']);

		expect(drift.missingRequired).to.eql(['TABLENAME']);
		expect(drift.missingOptional).to.eql(['LABEL']);
	});

	it('says nothing about a new result column', () => {
		let drift = checkSqlImportMappingDrift('tables', TABLE_MAPPING, ['SCHEMA', 'TABLENAME', 'LONGNAME', 'LABEL', 'NEWCOL']);

		expect(drift.missingRequired).to.be.empty;
		expect(drift.missingOptional).to.be.empty;
	});
});
