import { expect } from 'chai';
import { ResolvedColumn, ResolvedForeignKey, ResolvedIndex, ResolvedTable, ResolvedTableKey } from '../schema-conversion/schema-format-converter.js';
import { toDiagramTable } from './diagram-resolved-table.js';

// A connected column: DB2 fills in both name forms and a colNo. An imported-only one has neither a
// colNo nor a long sqlName, which is what the identity/ordering rules below exist for.
function column(options: Partial<ResolvedColumn> = {}): ResolvedColumn {
	return {
		schema: 'HR', tableName: 'EMPLOYEE', colNo: 1, systemName: 'ID', sqlName: 'EMPLOYEE_ID',
		dataType: 'INTEGER', nulls: 'N', identity: 'NO', isNew: false, importedFields: [], ...options
	};
}

function importedColumn(options: Partial<ResolvedColumn> = {}): ResolvedColumn {
	return {systemName: 'NOTE', dataType: 'VARCHAR', nulls: 'Y', isNew: true, importedFields: [], ...options};
}

function tableKey(options: Partial<ResolvedTableKey> = {}): ResolvedTableKey {
	return {constraintType: 'PRIMARY KEY', columnName: 'EMPLOYEE_ID', systemColumnName: 'ID', ordinalPosition: 1, isNew: false, ...options};
}

function foreignKey(options: Partial<ResolvedForeignKey> = {}): ResolvedForeignKey {
	return {
		columnName: 'DEPARTMENT_ID', systemColumnName: 'DPID', ordinalPosition: 1,
		referencedSchema: 'HR', referencedTable: 'DEPARTMENT',
		referencedColumnName: 'DEPARTMENT_ID', referencedSystemColumnName: 'DPID', isNew: false, ...options
	};
}

function index(options: Partial<ResolvedIndex> = {}): ResolvedIndex {
	return {indexName: 'IDX_1', uniqueness: 'Not Unique', keyColumns: 'ID', isNew: false, ...options};
}

function resolvedTable(options: Partial<ResolvedTable> = {}): ResolvedTable {
	return {
		schema: 'HR', name: 'EMPLOYEE', existsInDatabase: true,
		columns: [column()], keys: [], foreignKeys: [], indexes: [], ...options
	};
}

describe('diagram-resolved-table', () => {
	describe('toDiagramTable', () => {
		it('keys a column by its long SQL name', () => {
			let table = toDiagramTable(resolvedTable());

			expect(table.columns[0].name).to.equal('EMPLOYEE_ID');
		});

		it('carries every name form the column has, so a later match can use any of them', () => {
			let table = toDiagramTable(resolvedTable({columns: [column({heading: 'Employee Code'})]}));

			expect(table.columns[0].shortName).to.equal('ID');
			expect(table.columns[0].longName).to.equal('EMPLOYEE_ID');
			expect(table.columns[0].description).to.equal('Employee Code');
		});

		it('omits a name form the column does not have', () => {
			let table = toDiagramTable(resolvedTable({columns: [importedColumn()]}));

			expect(table.columns[0]).to.not.have.property('longName');
			expect(table.columns[0]).to.not.have.property('description');
		});

		// DB2's column heading is what the Columns tab and the results-grid header both label
		// "Description", so it has to win here too - the remark is only a gap-fill.
		it('prefers the column heading over the free-text remark for its description', () => {
			let table = toDiagramTable(resolvedTable({columns: [column({heading: 'Employee Code', text: 'Remark'})]}));

			expect(table.columns[0].description).to.equal('Employee Code');
		});

		it('falls back to the free-text remark when the column has no heading', () => {
			let table = toDiagramTable(resolvedTable({columns: [column({heading: '  ', text: 'Remark'})]}));

			expect(table.columns[0].description).to.equal('Remark');
		});

		// The remark is the only description field an import can supply - table-resolver puts an imported
		// column description in `text` - so without that fallback an imported-only column would have
		// nothing to show when Description is the configured label.
		it('takes an imported column\'s description from the remark', () => {
			let table = toDiagramTable(resolvedTable({columns: [importedColumn({text: 'Free-text note'})]}));

			expect(table.columns[0].description).to.equal('Free-text note');
		});

		it('falls back to the short name as identity for an imported column with no long name', () => {
			let table = toDiagramTable(resolvedTable({columns: [importedColumn()]}));

			expect(table.columns[0].name).to.equal('NOTE');
			expect(table.columns[0].shortName).to.equal('NOTE');
		});

		it('orders columns by their catalog column number', () => {
			let table = toDiagramTable(resolvedTable({
				columns: [column({colNo: 3, sqlName: 'C'}), column({colNo: 1, sqlName: 'A'}), column({colNo: 2, sqlName: 'B'})]
			}));

			expect(table.columns.map(entry => entry.name)).to.deep.equal(['A', 'B', 'C']);
		});

		it('keeps columns with no column number after every real one, in resolver order', () => {
			let table = toDiagramTable(resolvedTable({
				columns: [column({colNo: 2, sqlName: 'B'}), importedColumn({systemName: 'X'}), column({colNo: 1, sqlName: 'A'}), importedColumn({systemName: 'Y'})]
			}));

			expect(table.columns.map(entry => entry.name)).to.deep.equal(['A', 'B', 'X', 'Y']);
		});

		it('flags primary key columns', () => {
			let table = toDiagramTable(resolvedTable({
				columns: [column(), column({colNo: 2, systemName: 'NM', sqlName: 'NAME'})],
				keys: [tableKey()]
			}));

			expect(table.columns[0].primaryKey).to.be.true;
			expect(table.columns[1].primaryKey).to.be.false;
		});

		it('flags a primary key named only in its short form, as an import declares it', () => {
			let table = toDiagramTable(resolvedTable({keys: [tableKey({columnName: undefined, systemColumnName: 'ID', isNew: true})]}));

			expect(table.columns[0].primaryKey).to.be.true;
		});

		it('does not treat a UNIQUE constraint column as a primary key', () => {
			let table = toDiagramTable(resolvedTable({
				columns: [column({systemName: 'BDG', sqlName: 'BADGE'})],
				keys: [tableKey({constraintType: 'UNIQUE', columnName: 'BADGE', systemColumnName: 'BDG'})]
			}));

			expect(table.columns[0].primaryKey).to.be.false;
		});

		it('flags a NOT NULL column and leaves a nullable one unflagged', () => {
			let table = toDiagramTable(resolvedTable({
				columns: [column({nulls: 'N'}), column({colNo: 2, sqlName: 'NAME', nulls: 'Y'})]
			}));

			expect(table.columns[0].notNull).to.be.true;
			expect(table.columns[1].notNull).to.be.false;
		});

		it('flags a single-column UNIQUE constraint and records its group', () => {
			let table = toDiagramTable(resolvedTable({
				columns: [column({systemName: 'BDG', sqlName: 'BADGE'})],
				keys: [tableKey({constraintType: 'UNIQUE', constraintName: 'UQ_BADGE', columnName: 'BADGE', systemColumnName: 'BDG'})]
			}));

			expect(table.columns[0].unique).to.be.true;
			expect(table.uniqueKeys).to.deep.equal([{name: 'UQ_BADGE', columns: ['BADGE']}]);
		});

		it('groups a composite UNIQUE constraint\'s columns under one entry, both columns flagged', () => {
			let table = toDiagramTable(resolvedTable({
				columns: [column({systemName: 'FST', sqlName: 'FIRST'}), column({colNo: 2, systemName: 'LST', sqlName: 'LAST'})],
				keys: [
					tableKey({constraintType: 'UNIQUE', constraintName: 'UQ_NAME', columnName: 'FIRST', systemColumnName: 'FST', ordinalPosition: 1}),
					tableKey({constraintType: 'UNIQUE', constraintName: 'UQ_NAME', columnName: 'LAST', systemColumnName: 'LST', ordinalPosition: 2})
				]
			}));

			expect(table.columns[0].unique).to.be.true;
			expect(table.columns[1].unique).to.be.true;
			expect(table.uniqueKeys).to.deep.equal([{name: 'UQ_NAME', columns: ['FIRST', 'LAST']}]);
		});

		it('omits uniqueKeys entirely when the table has no UNIQUE constraint', () => {
			let table = toDiagramTable(resolvedTable());

			expect(table).to.not.have.property('uniqueKeys');
			expect(table.columns[0].unique).to.be.false;
		});

		it('flags an indexed column and records the index, stripping a descending key\'s ASC/DESC suffix', () => {
			let table = toDiagramTable(resolvedTable({
				columns: [column({systemName: 'FST', sqlName: 'FIRST'}), column({colNo: 2, systemName: 'LST', sqlName: 'LAST'})],
				indexes: [index({indexName: 'IDX_NAME', uniqueness: 'Not Unique', keyColumns: 'FIRST, LAST DESC'})]
			}));

			expect(table.columns[0].indexed).to.be.true;
			expect(table.columns[1].indexed).to.be.true;
			expect(table.indexes).to.deep.equal([{name: 'IDX_NAME', columns: ['FIRST', 'LAST'], unique: false}]);
		});

		it('classifies a "Unique Where Not Null" index as unique, same as a plain "Unique" one', () => {
			let table = toDiagramTable(resolvedTable({indexes: [index({uniqueness: 'Unique Where Not Null', keyColumns: 'ID'})]}));

			expect(table.indexes?.[0]?.unique).to.be.true;
		});

		it('omits indexes entirely when the table has none', () => {
			let table = toDiagramTable(resolvedTable());

			expect(table).to.not.have.property('indexes');
			expect(table.columns[0].indexed).to.be.false;
		});

		it('flags foreign key columns and maps the referenced end', () => {
			let table = toDiagramTable(resolvedTable({
				columns: [column({systemName: 'DPID', sqlName: 'DEPARTMENT_ID'})],
				foreignKeys: [foreignKey()]
			}));

			expect(table.columns[0].foreignKey).to.be.true;
			expect(table.foreignKeys).to.deep.equal([{
				fromColumn: 'DEPARTMENT_ID', toSchema: 'HR', toTable: 'DEPARTMENT', toColumn: 'DEPARTMENT_ID'
			}]);
		});

		// An import names its columns the short way, so its keys arrive in a form the column isn't keyed
		// by - and a relationship that doesn't resolve to a rendered row never gets drawn at all.
		it('resolves an imported foreign key\'s own column to the identity the diagram keys it by', () => {
			let table = toDiagramTable(resolvedTable({
				columns: [column({systemName: 'DPID', sqlName: 'DEPARTMENT_ID'})],
				foreignKeys: [foreignKey({columnName: undefined, systemColumnName: 'DPID', isNew: true})]
			}));

			expect(table.foreignKeys[0].fromColumn).to.equal('DEPARTMENT_ID');
			expect(table.columns[0].foreignKey).to.be.true;
		});

		// The referenced end is resolved by addTables against the target table, not here - only that
		// table knows what its own columns are called.
		it('leaves the referenced column in whatever form it arrived', () => {
			let table = toDiagramTable(resolvedTable({
				foreignKeys: [foreignKey({referencedColumnName: undefined, referencedSystemColumnName: 'DPID', isNew: true})]
			}));

			expect(table.foreignKeys[0].toColumn).to.equal('DPID');
		});

		it('reads an unqualified foreign key target as pointing within the declaring schema', () => {
			let table = toDiagramTable(resolvedTable({foreignKeys: [foreignKey({referencedSchema: undefined})]}));

			expect(table.foreignKeys[0].toSchema).to.equal('HR');
		});

		it('flags identity columns', () => {
			let table = toDiagramTable(resolvedTable({
				columns: [column({identity: 'YES'}), column({colNo: 2, sqlName: 'NAME', identity: 'NO'})]
			}));

			expect(table.columns[0].identity).to.be.true;
			expect(table.columns[1].identity).to.be.false;
		});

		it('omits description entirely when there is none', () => {
			let table = toDiagramTable(resolvedTable({columns: []}));

			expect(table).to.not.have.property('description');
		});

		it('keeps a description when one was supplied', () => {
			let table = toDiagramTable(resolvedTable({description: 'Employee master'}));

			expect(table.description).to.equal('Employee master');
		});

		it('flags a column that does not exist in DB2 at all', () => {
			let table = toDiagramTable(resolvedTable({columns: [importedColumn()]}));

			expect(table.columns[0].imported).to.be.true;
		});

		it('flags a real column an import gap-filled a field on', () => {
			let table = toDiagramTable(resolvedTable({columns: [column({importedFields: ['text']})]}));

			expect(table.columns[0].imported).to.be.true;
		});

		it('omits the imported flag on a column with no import contribution', () => {
			let table = toDiagramTable(resolvedTable());

			expect(table.columns[0]).to.not.have.property('imported');
		});

		// A real, unmodified column can still be "enhanced" this way: an import can add a foreign key that
		// references an existing column without changing anything about the column's own data - the
		// column-level isNew/importedFields flags have nothing to say about that case, only the foreign
		// key's own isNew does.
		it('flags the column a foreign key an import added actually declares, even though the column itself is unchanged', () => {
			let table = toDiagramTable(resolvedTable({
				columns: [column({systemName: 'DPID', sqlName: 'DEPARTMENT_ID'})],
				foreignKeys: [foreignKey({isNew: true})]
			}));

			expect(table.columns[0].imported).to.be.true;
		});

		it('does not flag a foreign key column as imported when the foreign key itself is real', () => {
			let table = toDiagramTable(resolvedTable({
				columns: [column({systemName: 'DPID', sqlName: 'DEPARTMENT_ID'})],
				foreignKeys: [foreignKey()]
			}));

			expect(table.columns[0]).to.not.have.property('imported');
		});

		it('marks a table with no connected data as imported', () => {
			let table = toDiagramTable(resolvedTable({existsInDatabase: false, columns: [importedColumn()]}));

			expect(table.importStatus).to.equal('imported');
		});

		it('marks a connected table with an imported column as enhanced', () => {
			let table = toDiagramTable(resolvedTable({columns: [column(), importedColumn({systemName: 'NOTE'})]}));

			expect(table.importStatus).to.equal('enhanced');
		});

		it('marks a connected table with only an imported key as enhanced', () => {
			let table = toDiagramTable(resolvedTable({keys: [tableKey({isNew: true})]}));

			expect(table.importStatus).to.equal('enhanced');
		});

		it('marks a connected table with only an imported foreign key as enhanced', () => {
			let table = toDiagramTable(resolvedTable({foreignKeys: [foreignKey({isNew: true})]}));

			expect(table.importStatus).to.equal('enhanced');
		});

		it('omits importStatus for a plain connected table with no import contribution', () => {
			let table = toDiagramTable(resolvedTable());

			expect(table).to.not.have.property('importStatus');
		});
	});
});
