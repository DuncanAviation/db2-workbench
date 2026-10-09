import { expect } from 'chai';
import { DiagramColumn, DiagramModel, DiagramRelationship, DiagramTable } from '../webview-messages/diagram-messages.js';
import { cardinalitiesByRelationshipId, relationshipCardinality } from './diagram-cardinality.js';

function column(name: string, overrides: Partial<DiagramColumn> = {}): DiagramColumn {
	return {name: name, type: 'INTEGER', primaryKey: false, foreignKey: false, identity: false, notNull: false, unique: false, indexed: false, ...overrides};
}

function table(overrides: Partial<DiagramTable> = {}): DiagramTable {
	return {
		id: 'SALES.ORDER',
		schemaId: 'SALES',
		name: 'ORDER',
		position: {x: 0, y: 0},
		columns: [column('ID', {primaryKey: true}), column('CUSTOMER_ID', {foreignKey: true})],
		...overrides
	};
}

function relationship(overrides: Partial<DiagramRelationship> = {}): DiagramRelationship {
	return {id: 'fk-0', fromTable: 'SALES.ORDER', fromColumn: 'CUSTOMER_ID', toTable: 'SALES.CUSTOMER', toColumn: 'ID', ...overrides};
}

describe('diagram-cardinality', () => {
	describe('relationshipCardinality', () => {
		it('puts many on the foreign-key end and one on the referenced end', () => {
			expect(relationshipCardinality(relationship(), table())).to.deep.equal({from: 'many', to: 'one'});
		});

		it('reports one-to-one when the foreign-key column is by itself the whole primary key', () => {
			let extension = table({
				id: 'SALES.CUSTOMER_DETAIL',
				columns: [column('CUSTOMER_ID', {primaryKey: true, foreignKey: true})]
			});

			let oneToOne = relationship({fromTable: 'SALES.CUSTOMER_DETAIL', fromColumn: 'CUSTOMER_ID'});
			expect(relationshipCardinality(oneToOne, extension)).to.deep.equal({from: 'one', to: 'one'});
		});

		it('still reports many when the foreign-key column is only part of a composite primary key', () => {
			let lineItem = table({
				id: 'SALES.ORDER_LINE',
				columns: [column('ORDER_ID', {primaryKey: true, foreignKey: true}), column('LINE_NO', {primaryKey: true})]
			});

			let composite = relationship({fromTable: 'SALES.ORDER_LINE', fromColumn: 'ORDER_ID'});
			expect(relationshipCardinality(composite, lineItem)).to.deep.equal({from: 'many', to: 'one'});
		});

		it('falls back to many when the foreign-key column is not a key at all', () => {
			expect(relationshipCardinality(relationship({fromColumn: 'CUSTOMER_ID'}), table())).to.deep.equal({from: 'many', to: 'one'});
		});

		it('falls back to many when the from table is missing entirely', () => {
			expect(relationshipCardinality(relationship(), undefined)).to.deep.equal({from: 'many', to: 'one'});
		});
	});

	describe('cardinalitiesByRelationshipId', () => {
		it('resolves each relationship against its own from table', () => {
			let model: DiagramModel = {
				schemas: [],
				tables: [
					table(),
					table({id: 'SALES.CUSTOMER_DETAIL', columns: [column('CUSTOMER_ID', {primaryKey: true, foreignKey: true})]})
				],
				relationships: [
					relationship(),
					relationship({id: 'fk-1', fromTable: 'SALES.CUSTOMER_DETAIL', fromColumn: 'CUSTOMER_ID'})
				]
			};

			let cardinalities = cardinalitiesByRelationshipId(model);
			expect(cardinalities.get('fk-0')).to.deep.equal({from: 'many', to: 'one'});
			expect(cardinalities.get('fk-1')).to.deep.equal({from: 'one', to: 'one'});
		});

		it('returns an empty map for a model with no relationships', () => {
			let model: DiagramModel = {schemas: [], tables: [table()], relationships: []};
			expect(cardinalitiesByRelationshipId(model).size).to.equal(0);
		});
	});
});
