import { expect } from 'chai';
import { DiagramColumn, DiagramModel, DiagramSchemaGroup, DiagramTable } from '../webview-messages/diagram-messages.js';
import { diagramModelToResolvedTables } from './diagram-schema-export.js';

function column(name: string, options: Partial<DiagramColumn> = {}): DiagramColumn {
	return {name: name, type: 'CHAR(10)', primaryKey: false, foreignKey: false, identity: false, notNull: false, unique: false, indexed: false, ...options};
}

function schemaGroup(id: string): DiagramSchemaGroup {
	return {id: id, name: id, color: '#000', bounds: {x: 0, y: 0, width: 100, height: 100}};
}

function table(id: string, schemaId: string, name: string, options: Partial<DiagramTable> = {}): DiagramTable {
	return {id: id, schemaId: schemaId, name: name, position: {x: 0, y: 0}, columns: [], ...options};
}

describe('diagram-schema-export', () => {
	describe('diagramModelToResolvedTables - column type parsing', () => {
		it('parses a bare type with no length or precision', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {columns: [column('STATUS', {type: 'INTEGER'})]})],
				relationships: []
			};

			let [resolved] = diagramModelToResolvedTables(model);

			expect(resolved.columns[0].dataType).to.equal('INTEGER');
			expect(resolved.columns[0].length).to.be.undefined;
			expect(resolved.columns[0].precision).to.be.undefined;
			expect(resolved.columns[0].scale).to.be.undefined;
		});

		it('parses a length-qualified type', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {columns: [column('NAME', {type: 'VARCHAR(50)'})]})],
				relationships: []
			};

			let [resolved] = diagramModelToResolvedTables(model);

			expect(resolved.columns[0].dataType).to.equal('VARCHAR');
			expect(resolved.columns[0].length).to.equal(50);
			expect(resolved.columns[0].precision).to.be.undefined;
		});

		it('parses a precision/scale-qualified type', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {columns: [column('SALARY', {type: 'DECIMAL(7,2)'})]})],
				relationships: []
			};

			let [resolved] = diagramModelToResolvedTables(model);

			expect(resolved.columns[0].dataType).to.equal('DECIMAL');
			expect(resolved.columns[0].precision).to.equal(7);
			expect(resolved.columns[0].scale).to.equal(2);
			expect(resolved.columns[0].length).to.be.undefined;
		});

		it('falls back to the raw string when it does not match the expected shape', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {columns: [column('WEIRD', {type: '??? not a type'})]})],
				relationships: []
			};

			let [resolved] = diagramModelToResolvedTables(model);

			expect(resolved.columns[0].dataType).to.equal('??? not a type');
			expect(resolved.columns[0].length).to.be.undefined;
		});
	});

	describe('diagramModelToResolvedTables - column mapping', () => {
		it('prefers shortName for systemName, falling back to the column identity', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {
					columns: [
						column('ACCT_EMPLOYEENO', {shortName: 'EMNO', longName: 'ACCT_EMPLOYEENO'}),
						column('NOSHORTNAME')
					]
				})],
				relationships: []
			};

			let [resolved] = diagramModelToResolvedTables(model);

			expect(resolved.columns[0].systemName).to.equal('EMNO');
			expect(resolved.columns[0].sqlName).to.equal('ACCT_EMPLOYEENO');
			expect(resolved.columns[1].systemName).to.equal('NOSHORTNAME');
			expect(resolved.columns[1].sqlName).to.be.undefined;
		});

		it('exports a NOT NULL column\'s nulls as N, and a nullable one\'s as Y', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {columns: [column('ID', {notNull: true}), column('NAME', {notNull: false})]})],
				relationships: []
			};

			let [resolved] = diagramModelToResolvedTables(model);

			expect(resolved.columns[0].nulls).to.equal('N');
			expect(resolved.columns[1].nulls).to.equal('Y');
		});

		it('maps identity and imported flags', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {
					columns: [column('ID', {identity: true, imported: true}), column('NAME')]
				})],
				relationships: []
			};

			let [resolved] = diagramModelToResolvedTables(model);

			expect(resolved.columns[0].identity).to.equal('YES');
			expect(resolved.columns[0].isNew).to.equal(true);
			expect(resolved.columns[1].identity).to.equal('NO');
			expect(resolved.columns[1].isNew).to.equal(false);
		});

		it('carries the column description as text when present', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {columns: [column('ID', {description: 'Employee id'})]})],
				relationships: []
			};

			let [resolved] = diagramModelToResolvedTables(model);

			expect(resolved.columns[0].text).to.equal('Employee id');
		});
	});

	describe('diagramModelToResolvedTables - primary keys', () => {
		it('maps a single primary key column', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {columns: [column('ID', {primaryKey: true}), column('NAME')]})],
				relationships: []
			};

			let [resolved] = diagramModelToResolvedTables(model);

			expect(resolved.keys).to.have.lengthOf(1);
			expect(resolved.keys[0].systemColumnName).to.equal('ID');
			expect(resolved.keys[0].constraintType).to.equal('PRIMARY KEY');
			expect(resolved.keys[0].ordinalPosition).to.equal(1);
		});

		it('groups a composite primary key under one shared synthetic constraint name', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {
					columns: [column('DEPT_ID', {primaryKey: true}), column('EMP_ID', {primaryKey: true}), column('NAME')]
				})],
				relationships: []
			};

			let [resolved] = diagramModelToResolvedTables(model);

			expect(resolved.keys).to.have.lengthOf(2);
			expect(resolved.keys[0].constraintName).to.equal(resolved.keys[1].constraintName);
			expect(resolved.keys[0].ordinalPosition).to.equal(1);
			expect(resolved.keys[1].ordinalPosition).to.equal(2);
		});

		it('produces no keys when no column is flagged as a primary key', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {columns: [column('NAME')]})],
				relationships: []
			};

			let [resolved] = diagramModelToResolvedTables(model);

			expect(resolved.keys).to.have.lengthOf(0);
		});
	});

	describe('diagramModelToResolvedTables - foreign keys', () => {
		it('maps a relationship on this table to a foreign key referencing the other table', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR'), schemaGroup('SALES')],
				tables: [
					table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {columns: [column('DEPT_ID')]}),
					table('SALES.DEPT', 'SALES', 'DEPT', {columns: [column('ID', {primaryKey: true})]})
				],
				relationships: [{id: 'r1', fromTable: 'HR.EMPLOYEE', fromColumn: 'DEPT_ID', toTable: 'SALES.DEPT', toColumn: 'ID'}]
			};

			let [employee, dept] = diagramModelToResolvedTables(model);

			expect(employee.foreignKeys).to.have.lengthOf(1);
			expect(employee.foreignKeys[0].systemColumnName).to.equal('DEPT_ID');
			expect(employee.foreignKeys[0].referencedSchema).to.equal('SALES');
			expect(employee.foreignKeys[0].referencedTable).to.equal('DEPT');
			expect(employee.foreignKeys[0].referencedSystemColumnName).to.equal('ID');
			expect(dept.foreignKeys).to.have.lengthOf(0);
		});

		it('skips a relationship whose endpoint column no longer resolves on either table', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR'), schemaGroup('SALES')],
				tables: [
					table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {columns: [column('DEPT_ID')]}),
					table('SALES.DEPT', 'SALES', 'DEPT', {columns: [column('ID', {primaryKey: true})]})
				],
				relationships: [{id: 'r1', fromTable: 'HR.EMPLOYEE', fromColumn: 'MISSING_COLUMN', toTable: 'SALES.DEPT', toColumn: 'ID'}]
			};

			let [employee] = diagramModelToResolvedTables(model);

			expect(employee.foreignKeys).to.have.lengthOf(0);
		});

		it('skips a relationship whose referenced table is not on the diagram', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {columns: [column('DEPT_ID')]})],
				relationships: [{id: 'r1', fromTable: 'HR.EMPLOYEE', fromColumn: 'DEPT_ID', toTable: 'SALES.DEPT', toColumn: 'ID'}]
			};

			let [employee] = diagramModelToResolvedTables(model);

			expect(employee.foreignKeys).to.have.lengthOf(0);
		});
	});

	describe('diagramModelToResolvedTables - table-level fields', () => {
		it('resolves the schema name via the schema group, falling back to the raw id', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE'), table('ORPHAN.T', 'ORPHAN', 'T')],
				relationships: []
			};

			let [employee, orphanTable] = diagramModelToResolvedTables(model);

			expect(employee.schema).to.equal('HR');
			expect(orphanTable.schema).to.equal('ORPHAN');
		});

		it('carries the table description when present', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {description: 'People who work here'})],
				relationships: []
			};

			let [employee] = diagramModelToResolvedTables(model);

			expect(employee.description).to.equal('People who work here');
		});

		it('marks an imported-only table as not existing in the database', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {importStatus: 'imported'})],
				relationships: []
			};

			let [employee] = diagramModelToResolvedTables(model);

			expect(employee.existsInDatabase).to.equal(false);
		});

		it('treats an enhanced or plain table as existing in the database', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [
					table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {importStatus: 'enhanced'}),
					table('HR.DEPT', 'HR', 'DEPT')
				],
				relationships: []
			};

			let [employee, dept] = diagramModelToResolvedTables(model);

			expect(employee.existsInDatabase).to.equal(true);
			expect(dept.existsInDatabase).to.equal(true);
		});

		it('treats an orphaned table as existing in the database, the safer default', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {importStatus: 'orphaned'})],
				relationships: []
			};

			let [employee] = diagramModelToResolvedTables(model);

			expect(employee.existsInDatabase).to.equal(true);
		});

		it('emits an empty indexes array for a table with none', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE')],
				relationships: []
			};

			let [employee] = diagramModelToResolvedTables(model);

			expect(employee.indexes).to.deep.equal([]);
		});
	});

	describe('diagramModelToResolvedTables - unique keys', () => {
		it('maps a single-column UNIQUE constraint', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {
					columns: [column('BADGE', {unique: true})],
					uniqueKeys: [{name: 'UQ_BADGE', columns: ['BADGE']}]
				})],
				relationships: []
			};

			let [resolved] = diagramModelToResolvedTables(model);

			expect(resolved.keys).to.have.lengthOf(1);
			expect(resolved.keys[0].constraintType).to.equal('UNIQUE');
			expect(resolved.keys[0].constraintName).to.equal('UQ_BADGE');
			expect(resolved.keys[0].systemColumnName).to.equal('BADGE');
		});

		it('emits one row per column for a composite UNIQUE constraint, sharing the group\'s name', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {
					columns: [column('FIRST', {unique: true}), column('LAST', {unique: true})],
					uniqueKeys: [{name: 'UQ_NAME', columns: ['FIRST', 'LAST']}]
				})],
				relationships: []
			};

			let [resolved] = diagramModelToResolvedTables(model);

			expect(resolved.keys).to.have.lengthOf(2);
			expect(resolved.keys[0].constraintName).to.equal('UQ_NAME');
			expect(resolved.keys[1].constraintName).to.equal('UQ_NAME');
			expect(resolved.keys[0].ordinalPosition).to.equal(1);
			expect(resolved.keys[1].ordinalPosition).to.equal(2);
		});

		it('produces no unique key rows for a table with none, alongside a plain primary key', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {columns: [column('ID', {primaryKey: true})]})],
				relationships: []
			};

			let [resolved] = diagramModelToResolvedTables(model);

			expect(resolved.keys).to.have.lengthOf(1);
			expect(resolved.keys[0].constraintType).to.equal('PRIMARY KEY');
		});
	});

	describe('diagramModelToResolvedTables - indexes', () => {
		it('maps a table\'s indexes, joining a composite index\'s columns with a comma', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {
					columns: [column('FIRST', {indexed: true}), column('LAST', {indexed: true})],
					indexes: [{name: 'IDX_NAME', columns: ['FIRST', 'LAST'], unique: false}]
				})],
				relationships: []
			};

			let [resolved] = diagramModelToResolvedTables(model);

			expect(resolved.indexes).to.have.lengthOf(1);
			expect(resolved.indexes[0].indexName).to.equal('IDX_NAME');
			expect(resolved.indexes[0].keyColumns).to.equal('FIRST, LAST');
			expect(resolved.indexes[0].uniqueness).to.equal('Not Unique');
		});

		it('maps a unique index\'s uniqueness', () => {
			let model: DiagramModel = {
				schemas: [schemaGroup('HR')],
				tables: [table('HR.EMPLOYEE', 'HR', 'EMPLOYEE', {
					columns: [column('BADGE', {indexed: true})],
					indexes: [{name: 'UX_BADGE', columns: ['BADGE'], unique: true}]
				})],
				relationships: []
			};

			let [resolved] = diagramModelToResolvedTables(model);

			expect(resolved.indexes[0].uniqueness).to.equal('Unique');
		});
	});
});
