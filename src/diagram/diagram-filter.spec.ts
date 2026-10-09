import { expect } from 'chai';
import { DiagramModel, DiagramRelationship, DiagramSchemaGroup, DiagramTable } from '../webview-messages/diagram-messages.js';
import { filterDiagramModel, tableMatchesFilter } from './diagram-filter.js';

function table(overrides: Partial<DiagramTable> = {}): DiagramTable {
	return {
		id: 'SALES.CUSTOMER',
		schemaId: 'SALES',
		name: 'CUSTOMER',
		position: {x: 0, y: 0},
		columns: [
			{name: 'ID', type: 'INTEGER', primaryKey: true, foreignKey: false, identity: true, notNull: true, unique: false, indexed: false},
			{name: 'EMAIL', type: 'VARCHAR(150)', primaryKey: false, foreignKey: false, identity: false, notNull: false, unique: false, indexed: false}
		],
		...overrides
	};
}

describe('diagram-filter', () => {
	describe('tableMatchesFilter', () => {
		it('matches everything when the filter text is empty', () => {
			expect(tableMatchesFilter(table(), 'SALES', '')).to.be.true;
		});

		it('matches everything when the filter text is only whitespace', () => {
			expect(tableMatchesFilter(table(), 'SALES', '   ')).to.be.true;
		});

		it('matches by table name, case-insensitively', () => {
			expect(tableMatchesFilter(table({name: 'CUSTOMER'}), 'SALES', 'custom')).to.be.true;
			expect(tableMatchesFilter(table({name: 'CUSTOMER'}), 'SALES', 'CUSTOM')).to.be.true;
		});

		it('matches by a substring, not just a full-name match', () => {
			expect(tableMatchesFilter(table({name: 'CUSTOMER'}), 'SALES', 'stom')).to.be.true;
		});

		it('matches by the owning schema name', () => {
			expect(tableMatchesFilter(table({name: 'CUSTOMER'}), 'SALES', 'sales')).to.be.true;
		});

		it('matches by description', () => {
			expect(tableMatchesFilter(table({description: 'Customer master record'}), 'SALES', 'master')).to.be.true;
		});

		it('does not throw and does not match on description text when there is no description', () => {
			expect(tableMatchesFilter(table({description: undefined}), 'SALES', 'master')).to.be.false;
		});

		it('matches by a column name', () => {
			expect(tableMatchesFilter(table(), 'SALES', 'email')).to.be.true;
		});

		it('does not match unrelated text', () => {
			expect(tableMatchesFilter(table(), 'SALES', 'nonexistent')).to.be.false;
		});
	});

	describe('filterDiagramModel', () => {
		function schema(overrides: Partial<DiagramSchemaGroup> = {}): DiagramSchemaGroup {
			return {id: 'SALES', name: 'SALES', color: '#888888', bounds: {x: 0, y: 0, width: 100, height: 100}, ...overrides};
		}

		function relationship(overrides: Partial<DiagramRelationship> = {}): DiagramRelationship {
			return {id: 'rel1', fromTable: 'SALES.ORDERS', fromColumn: 'CUSTOMER_ID', toTable: 'SALES.CUSTOMER', toColumn: 'ID', ...overrides};
		}

		function model(overrides: Partial<DiagramModel> = {}): DiagramModel {
			return {
				schemas: [schema()],
				tables: [table({id: 'SALES.CUSTOMER', name: 'CUSTOMER'}), table({id: 'SALES.ORDERS', name: 'ORDERS'})],
				relationships: [relationship()],
				...overrides
			};
		}

		it('returns the exact same model instance when the filter text is blank', () => {
			let source = model();
			expect(filterDiagramModel(source, '')).to.equal(source);
			expect(filterDiagramModel(source, '   ')).to.equal(source);
		});

		it('keeps only tables matching the filter', () => {
			let result = filterDiagramModel(model(), 'customer');
			expect(result.tables.map(resultTable => resultTable.id)).to.deep.equal(['SALES.CUSTOMER']);
		});

		it('drops a relationship when only one endpoint matches', () => {
			let result = filterDiagramModel(model(), 'customer');
			expect(result.relationships).to.be.empty;
		});

		it('keeps a relationship when both endpoints match', () => {
			let result = filterDiagramModel(model(), 'sales');
			expect(result.relationships.map(resultRelationship => resultRelationship.id)).to.deep.equal(['rel1']);
		});

		it('drops a schema with no matching tables', () => {
			let result = filterDiagramModel(model({schemas: [schema(), schema({id: 'HR', name: 'HR'})]}), 'customer');
			expect(result.schemas.map(resultSchema => resultSchema.id)).to.deep.equal(['SALES']);
		});

		it('keeps a schema that has at least one matching table', () => {
			let result = filterDiagramModel(model(), 'customer');
			expect(result.schemas.map(resultSchema => resultSchema.id)).to.deep.equal(['SALES']);
		});
	});
});
