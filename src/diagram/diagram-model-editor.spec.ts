import { expect } from 'chai';
import { DiagramModel } from '../webview-messages/diagram-messages.js';
import { moveSchema, moveTable, moveTables, removeSchema, removeTable, removeTables, resizeSchema } from './diagram-model-editor.js';

function sampleModel(): DiagramModel {
	return {
		schemas: [{id: 'S', name: 'S', color: '#000', bounds: {x: 0, y: 0, width: 100, height: 100}}],
		tables: [{id: 'S.T', schemaId: 'S', name: 'T', position: {x: 10, y: 20}, columns: []}],
		relationships: []
	};
}

// Two tables in the same schema, related to each other, plus a relationship reaching into a different
// schema entirely - covers both "relationship within the removed set" and "relationship crossing out of
// it" in one model.
function sampleModelWithRelationships(): DiagramModel {
	let model = sampleModelWithTwoSchemas();
	model.tables.push({id: 'S.V', schemaId: 'S', name: 'V', position: {x: 15, y: 25}, columns: []});
	model.relationships.push(
		{id: 'R1', fromTable: 'S.T', fromColumn: 'A', toTable: 'S.V', toColumn: 'B'},
		{id: 'R2', fromTable: 'S.T', fromColumn: 'A', toTable: 'OTHER.U', toColumn: 'B'}
	);
	return model;
}

function sampleModelWithTwoSchemas(): DiagramModel {
	let model = sampleModel();
	model.schemas.push({id: 'OTHER', name: 'OTHER', color: '#111', bounds: {x: 500, y: 500, width: 100, height: 100}});
	model.tables.push({id: 'OTHER.U', schemaId: 'OTHER', name: 'U', position: {x: 510, y: 520}, columns: []});
	return model;
}

describe('diagram-model-editor', () => {
	describe('moveTable', () => {
		it('moves the table immediately and returns an undo/redo edit', () => {
			let model = sampleModel();
			let edit = moveTable(model, 'S.T', {x: 100, y: 200});

			expect(model.tables[0].position).to.deep.equal({x: 100, y: 200});
			expect(edit?.label).to.equal('Move Table');
		});

		it('undo reverts to the previous position, redo reapplies the new one', () => {
			let model = sampleModel();
			let edit = moveTable(model, 'S.T', {x: 100, y: 200});

			edit?.undo();
			expect(model.tables[0].position).to.deep.equal({x: 10, y: 20});

			edit?.redo();
			expect(model.tables[0].position).to.deep.equal({x: 100, y: 200});
		});

		it('returns undefined and leaves the model untouched for an unknown table id', () => {
			let model = sampleModel();
			let edit = moveTable(model, 'does-not-exist', {x: 100, y: 200});

			expect(edit).to.be.undefined;
			expect(model.tables[0].position).to.deep.equal({x: 10, y: 20});
		});

		it('does not affect other tables', () => {
			let model = sampleModel();
			model.tables.push({id: 'S.OTHER', schemaId: 'S', name: 'OTHER', position: {x: 5, y: 5}, columns: []});

			moveTable(model, 'S.T', {x: 100, y: 200});

			expect(model.tables[1].position).to.deep.equal({x: 5, y: 5});
		});

		it('returns undefined for a position identical to the table\'s current one', () => {
			let model = sampleModel();
			let edit = moveTable(model, 'S.T', {x: 10, y: 20});

			expect(edit).to.be.undefined;
			expect(model.tables[0].position).to.deep.equal({x: 10, y: 20});
		});
	});

	describe('moveTables', () => {
		it('moves every table in the batch and returns one undo/redo edit', () => {
			let model = sampleModelWithTwoSchemas();
			let edit = moveTables(model, [
				{tableId: 'S.T', position: {x: 100, y: 200}},
				{tableId: 'OTHER.U', position: {x: 600, y: 700}}
			]);

			expect(model.tables.find(table => table.id === 'S.T')?.position).to.deep.equal({x: 100, y: 200});
			expect(model.tables.find(table => table.id === 'OTHER.U')?.position).to.deep.equal({x: 600, y: 700});
			expect(edit?.label).to.equal('Move Tables');
		});

		it('labels a batch of one the same as a plain moveTable', () => {
			let model = sampleModel();
			let edit = moveTables(model, [{tableId: 'S.T', position: {x: 100, y: 200}}]);

			expect(edit?.label).to.equal('Move Table');
		});

		it('moves the tables it knows and silently skips the ones it does not', () => {
			let model = sampleModel();
			let edit = moveTables(model, [
				{tableId: 'S.T', position: {x: 100, y: 200}},
				{tableId: 'does-not-exist', position: {x: 1, y: 1}}
			]);

			expect(model.tables[0].position).to.deep.equal({x: 100, y: 200});
			expect(edit?.label).to.equal('Move Table');
		});

		it('returns undefined and leaves the model untouched when none of the ids match', () => {
			let model = sampleModel();
			let edit = moveTables(model, [{tableId: 'does-not-exist', position: {x: 100, y: 200}}]);

			expect(edit).to.be.undefined;
			expect(model.tables[0].position).to.deep.equal({x: 10, y: 20});
		});

		it('returns undefined when every move in the batch is a no-op position', () => {
			let model = sampleModelWithTwoSchemas();
			let edit = moveTables(model, [
				{tableId: 'S.T', position: {x: 10, y: 20}},
				{tableId: 'OTHER.U', position: {x: 510, y: 520}}
			]);

			expect(edit).to.be.undefined;
		});

		it('applies only the tables that actually moved, skipping no-op positions in the same batch', () => {
			let model = sampleModelWithTwoSchemas();
			let edit = moveTables(model, [
				{tableId: 'S.T', position: {x: 10, y: 20}},
				{tableId: 'OTHER.U', position: {x: 600, y: 700}}
			]);

			expect(model.tables.find(table => table.id === 'OTHER.U')?.position).to.deep.equal({x: 600, y: 700});
			expect(edit?.label).to.equal('Move Table');
		});

		it('undo reverts every table to its own previous position, redo reapplies all of them', () => {
			let model = sampleModelWithTwoSchemas();
			let edit = moveTables(model, [
				{tableId: 'S.T', position: {x: 100, y: 200}},
				{tableId: 'OTHER.U', position: {x: 600, y: 700}}
			]);

			edit?.undo();
			expect(model.tables.find(table => table.id === 'S.T')?.position).to.deep.equal({x: 10, y: 20});
			expect(model.tables.find(table => table.id === 'OTHER.U')?.position).to.deep.equal({x: 510, y: 520});

			edit?.redo();
			expect(model.tables.find(table => table.id === 'S.T')?.position).to.deep.equal({x: 100, y: 200});
			expect(model.tables.find(table => table.id === 'OTHER.U')?.position).to.deep.equal({x: 600, y: 700});
		});
	});

	describe('resizeSchema', () => {
		it('resizes the schema immediately and returns an undo/redo edit', () => {
			let model = sampleModel();
			let edit = resizeSchema(model, 'S', {x: -20, y: -20, width: 300, height: 300});

			expect(model.schemas[0].bounds).to.deep.equal({x: -20, y: -20, width: 300, height: 300});
			expect(edit?.label).to.equal('Resize Schema');
		});

		it('undo reverts to the previous bounds, redo reapplies the new ones', () => {
			let model = sampleModel();
			let edit = resizeSchema(model, 'S', {x: -20, y: -20, width: 300, height: 300});

			edit?.undo();
			expect(model.schemas[0].bounds).to.deep.equal({x: 0, y: 0, width: 100, height: 100});

			edit?.redo();
			expect(model.schemas[0].bounds).to.deep.equal({x: -20, y: -20, width: 300, height: 300});
		});

		it('returns undefined and leaves the model untouched for an unknown schema id', () => {
			let model = sampleModel();
			let edit = resizeSchema(model, 'does-not-exist', {x: -20, y: -20, width: 300, height: 300});

			expect(edit).to.be.undefined;
			expect(model.schemas[0].bounds).to.deep.equal({x: 0, y: 0, width: 100, height: 100});
		});

		it('leaves table positions untouched - a resize keeps contents fixed in absolute space', () => {
			let model = sampleModel();
			resizeSchema(model, 'S', {x: -20, y: -20, width: 300, height: 300});

			expect(model.tables[0].position).to.deep.equal({x: 10, y: 20});
		});
	});

	describe('removeTable', () => {
		it('removes the table immediately and returns an undo/redo edit', () => {
			let model = sampleModel();
			let edit = removeTable(model, 'S.T');

			expect(model.tables).to.be.empty;
			expect(edit?.label).to.equal('Remove Table');
		});

		it('also removes every relationship touching the table, regardless of which end it\'s on', () => {
			let model = sampleModelWithRelationships();
			removeTable(model, 'S.T');

			expect(model.relationships).to.be.empty;
			expect(model.tables.map(table => table.id)).to.deep.equal(['OTHER.U', 'S.V']);
		});

		it('leaves relationships not touching the table untouched', () => {
			let model = sampleModelWithRelationships();
			removeTable(model, 'S.V');

			expect(model.relationships.map(relationship => relationship.id)).to.deep.equal(['R2']);
		});

		it('does not remove the table\'s schema, even if it was the schema\'s only table', () => {
			let model = sampleModel();
			removeTable(model, 'S.T');

			expect(model.schemas.map(schema => schema.id)).to.deep.equal(['S']);
		});

		it('returns undefined and leaves the model untouched for an unknown table id', () => {
			let model = sampleModel();
			let edit = removeTable(model, 'does-not-exist');

			expect(edit).to.be.undefined;
			expect(model.tables).to.have.length(1);
		});

		it('undo restores the table and its relationships, redo removes them again', () => {
			let model = sampleModelWithRelationships();
			let edit = removeTable(model, 'S.T');

			edit?.undo();
			expect(model.tables.map(table => table.id).sort()).to.deep.equal(['OTHER.U', 'S.T', 'S.V']);
			expect(model.relationships.map(relationship => relationship.id).sort()).to.deep.equal(['R1', 'R2']);

			edit?.redo();
			expect(model.tables.map(table => table.id)).to.not.include('S.T');
			expect(model.relationships).to.be.empty;
		});
	});

	describe('removeTables', () => {
		it('removes every table in the batch and returns one undo/redo edit', () => {
			let model = sampleModelWithTwoSchemas();
			let edit = removeTables(model, ['S.T', 'OTHER.U']);

			expect(model.tables).to.be.empty;
			expect(edit?.label).to.equal('Remove Tables');
		});

		it('labels a batch of one the same as a plain removeTable', () => {
			let model = sampleModel();
			let edit = removeTables(model, ['S.T']);

			expect(edit?.label).to.equal('Remove Table');
		});

		it('also removes every relationship touching any of the removed tables', () => {
			let model = sampleModelWithRelationships();
			removeTables(model, ['S.T', 'S.V']);

			expect(model.relationships).to.be.empty;
			expect(model.tables.map(table => table.id)).to.deep.equal(['OTHER.U']);
		});

		it('removes the tables it knows and silently skips the ones it does not', () => {
			let model = sampleModel();
			let edit = removeTables(model, ['S.T', 'does-not-exist']);

			expect(model.tables).to.be.empty;
			expect(edit?.label).to.equal('Remove Table');
		});

		it('returns undefined and leaves the model untouched when none of the ids match', () => {
			let model = sampleModel();
			let edit = removeTables(model, ['does-not-exist']);

			expect(edit).to.be.undefined;
			expect(model.tables).to.have.length(1);
		});

		it('undo restores every table to its original position in the array and every relationship, redo removes them again', () => {
			let model = sampleModelWithRelationships();
			let edit = removeTables(model, ['S.T', 'OTHER.U']);

			edit?.undo();
			expect(model.tables.map(table => table.id)).to.deep.equal(['S.T', 'OTHER.U', 'S.V']);
			expect(model.relationships.map(relationship => relationship.id).sort()).to.deep.equal(['R1', 'R2']);

			edit?.redo();
			expect(model.tables.map(table => table.id)).to.deep.equal(['S.V']);
			expect(model.relationships).to.be.empty;
		});
	});

	describe('removeSchema', () => {
		it('removes the schema and every one of its tables', () => {
			let model = sampleModelWithTwoSchemas();
			let edit = removeSchema(model, 'S');

			expect(model.schemas.map(schema => schema.id)).to.deep.equal(['OTHER']);
			expect(model.tables.map(table => table.id)).to.deep.equal(['OTHER.U']);
			expect(edit?.label).to.equal('Remove Schema');
		});

		it('removes relationships touching a removed table even when the other end is in a schema that stays', () => {
			let model = sampleModelWithRelationships();
			removeSchema(model, 'S');

			expect(model.relationships).to.be.empty;
			expect(model.tables.map(table => table.id)).to.deep.equal(['OTHER.U']);
		});

		it('returns undefined and leaves the model untouched for an unknown schema id', () => {
			let model = sampleModelWithTwoSchemas();
			let edit = removeSchema(model, 'does-not-exist');

			expect(edit).to.be.undefined;
			expect(model.schemas).to.have.length(2);
		});

		it('undo restores the schema, its tables and their relationships, redo removes them again', () => {
			let model = sampleModelWithRelationships();
			let edit = removeSchema(model, 'S');

			edit?.undo();
			expect(model.schemas.map(schema => schema.id).sort()).to.deep.equal(['OTHER', 'S']);
			expect(model.tables.map(table => table.id).sort()).to.deep.equal(['OTHER.U', 'S.T', 'S.V']);
			expect(model.relationships.map(relationship => relationship.id).sort()).to.deep.equal(['R1', 'R2']);

			edit?.redo();
			expect(model.schemas.map(schema => schema.id)).to.deep.equal(['OTHER']);
			expect(model.relationships).to.be.empty;
		});
	});

	describe('moveSchema', () => {
		it('moves the schema and shifts every one of its tables by the same delta', () => {
			let model = sampleModel();
			let edit = moveSchema(model, 'S', {x: 100, y: 200});

			// Schema moved by (+100, +200) - the table (originally at 10,20, an offset of (10,20) from the
			// schema's own 0,0 origin) should have shifted by that same delta, preserving its offset.
			expect(model.schemas[0].bounds).to.deep.equal({x: 100, y: 200, width: 100, height: 100});
			expect(model.tables[0].position).to.deep.equal({x: 110, y: 220});
			expect(edit?.label).to.equal('Move Schema');
		});

		it('does not affect a table belonging to a different schema', () => {
			let model = sampleModelWithTwoSchemas();
			moveSchema(model, 'S', {x: 100, y: 200});

			let otherTable = model.tables.find(table => table.id === 'OTHER.U');
			expect(otherTable?.position).to.deep.equal({x: 510, y: 520});
		});

		it('undo restores both the schema bounds and every shifted table, redo reapplies both', () => {
			let model = sampleModel();
			let edit = moveSchema(model, 'S', {x: 100, y: 200});

			edit?.undo();
			expect(model.schemas[0].bounds).to.deep.equal({x: 0, y: 0, width: 100, height: 100});
			expect(model.tables[0].position).to.deep.equal({x: 10, y: 20});

			edit?.redo();
			expect(model.schemas[0].bounds).to.deep.equal({x: 100, y: 200, width: 100, height: 100});
			expect(model.tables[0].position).to.deep.equal({x: 110, y: 220});
		});

		it('returns undefined and leaves the model untouched for an unknown schema id', () => {
			let model = sampleModel();
			let edit = moveSchema(model, 'does-not-exist', {x: 100, y: 200});

			expect(edit).to.be.undefined;
			expect(model.schemas[0].bounds).to.deep.equal({x: 0, y: 0, width: 100, height: 100});
			expect(model.tables[0].position).to.deep.equal({x: 10, y: 20});
		});
	});
});
