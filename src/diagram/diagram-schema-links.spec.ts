import { expect } from 'chai';
import { DiagramModel } from '../webview-messages/diagram-messages.js';
import { schemaLinks } from './diagram-schema-links.js';

function model(overrides: Partial<DiagramModel>): DiagramModel {
	return {
		schemas: [],
		tables: [],
		relationships: [],
		...overrides
	};
}

describe('diagram-schema-links', () => {
	describe('schemaLinks', () => {
		it('links two schemas whose tables have a relationship between them', () => {
			let links = schemaLinks(model({
				tables: [
					{id: 'A.T1', schemaId: 'A', name: 'T1', position: {x: 0, y: 0}, columns: []},
					{id: 'B.T1', schemaId: 'B', name: 'T1', position: {x: 0, y: 0}, columns: []}
				],
				relationships: [
					{id: 'fk-0', fromTable: 'A.T1', fromColumn: 'X', toTable: 'B.T1', toColumn: 'Y'}
				]
			}));

			expect(links).to.deep.equal([{id: 'A--B', schemaA: 'A', schemaB: 'B'}]);
		});

		it('excludes a relationship whose two tables belong to the same schema', () => {
			let links = schemaLinks(model({
				tables: [
					{id: 'A.T1', schemaId: 'A', name: 'T1', position: {x: 0, y: 0}, columns: []},
					{id: 'A.T2', schemaId: 'A', name: 'T2', position: {x: 0, y: 0}, columns: []}
				],
				relationships: [
					{id: 'fk-0', fromTable: 'A.T1', fromColumn: 'X', toTable: 'A.T2', toColumn: 'Y'}
				]
			}));

			expect(links).to.deep.equal([]);
		});

		it('collapses multiple relationships between the same two schemas into one link', () => {
			let links = schemaLinks(model({
				tables: [
					{id: 'A.T1', schemaId: 'A', name: 'T1', position: {x: 0, y: 0}, columns: []},
					{id: 'A.T2', schemaId: 'A', name: 'T2', position: {x: 0, y: 0}, columns: []},
					{id: 'B.T1', schemaId: 'B', name: 'T1', position: {x: 0, y: 0}, columns: []}
				],
				relationships: [
					{id: 'fk-0', fromTable: 'A.T1', fromColumn: 'X', toTable: 'B.T1', toColumn: 'Y'},
					{id: 'fk-1', fromTable: 'A.T2', fromColumn: 'X', toTable: 'B.T1', toColumn: 'Y'}
				]
			}));

			expect(links).to.deep.equal([{id: 'A--B', schemaA: 'A', schemaB: 'B'}]);
		});

		it('produces the same link id regardless of which side is "from" vs "to"', () => {
			let forward = schemaLinks(model({
				tables: [
					{id: 'A.T1', schemaId: 'A', name: 'T1', position: {x: 0, y: 0}, columns: []},
					{id: 'B.T1', schemaId: 'B', name: 'T1', position: {x: 0, y: 0}, columns: []}
				],
				relationships: [{id: 'fk-0', fromTable: 'A.T1', fromColumn: 'X', toTable: 'B.T1', toColumn: 'Y'}]
			}));
			let reversed = schemaLinks(model({
				tables: [
					{id: 'A.T1', schemaId: 'A', name: 'T1', position: {x: 0, y: 0}, columns: []},
					{id: 'B.T1', schemaId: 'B', name: 'T1', position: {x: 0, y: 0}, columns: []}
				],
				relationships: [{id: 'fk-0', fromTable: 'B.T1', fromColumn: 'Y', toTable: 'A.T1', toColumn: 'X'}]
			}));

			expect(forward[0]?.id).to.equal(reversed[0]?.id);
		});

		it('returns one link per distinct schema pair when three schemas are all connected', () => {
			let links = schemaLinks(model({
				tables: [
					{id: 'A.T1', schemaId: 'A', name: 'T1', position: {x: 0, y: 0}, columns: []},
					{id: 'B.T1', schemaId: 'B', name: 'T1', position: {x: 0, y: 0}, columns: []},
					{id: 'C.T1', schemaId: 'C', name: 'T1', position: {x: 0, y: 0}, columns: []}
				],
				relationships: [
					{id: 'fk-0', fromTable: 'A.T1', fromColumn: 'X', toTable: 'B.T1', toColumn: 'Y'},
					{id: 'fk-1', fromTable: 'B.T1', fromColumn: 'X', toTable: 'C.T1', toColumn: 'Y'}
				]
			}));

			expect(links).to.have.deep.members([
				{id: 'A--B', schemaA: 'A', schemaB: 'B'},
				{id: 'B--C', schemaA: 'B', schemaB: 'C'}
			]);
		});

		it('returns an empty array when there are no relationships at all', () => {
			expect(schemaLinks(model({}))).to.deep.equal([]);
		});
	});
});
