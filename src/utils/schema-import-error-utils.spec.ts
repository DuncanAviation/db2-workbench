import { expect } from 'chai';
import { dbmlFormat } from '../schema-conversion/formats/dbml-format.js';
import { frictionlessFormat } from '../schema-conversion/formats/frictionless-format.js';
import { SchemaImportErrorUtils } from './schema-import-error-utils.js';

describe('SchemaImportErrorUtils.serialize', () => {
	it('extracts a single @dbml/core diag, including its location', () => {
		let error = {
			diags: [{
				message: 'Expected comment, valid name, or whitespace but "}" found.',
				location: {start: {offset: 69, line: 2, column: 1}, end: {offset: 70, line: 2, column: 2}}
			}]
		};

		let serialized = SchemaImportErrorUtils.serialize(error);

		expect(serialized).to.deep.equal({
			message: 'Expected comment, valid name, or whitespace but "}" found.',
			diags: [{message: 'Expected comment, valid name, or whitespace but "}" found.', startOffset: 69, startLine: 2, startColumn: 1}]
		});
	});

	it('summarizes the message as a count when there is more than one diag', () => {
		let error = {diags: [{message: 'First problem'}, {message: 'Second problem'}]};
		let serialized = SchemaImportErrorUtils.serialize(error);

		expect(serialized.message).to.equal('2 errors were found while parsing.');
		expect(serialized.diags.map(diag => diag.message)).to.deep.equal(['First problem', 'Second problem']);
	});

	it('handles a diag with no location at all', () => {
		let error = {diags: [{message: 'No location on this one'}]};
		let serialized = SchemaImportErrorUtils.serialize(error);

		expect(serialized.diags).to.deep.equal([{message: 'No location on this one', startOffset: undefined, startLine: undefined, startColumn: undefined}]);
	});

	it('falls back to a diag\'s own message when it has no string message property', () => {
		let error = {diags: [42]};
		let serialized = SchemaImportErrorUtils.serialize(error);

		expect(serialized.diags[0].message).to.equal('42');
	});

	it('falls back to a plain Error\'s message when there are no diags', () => {
		let serialized = SchemaImportErrorUtils.serialize(new Error('Unexpected token in JSON'));
		expect(serialized).to.deep.equal({message: 'Unexpected token in JSON', diags: []});
	});

	it('falls back to String(error) for a non-Error, non-diags thrown value', () => {
		expect(SchemaImportErrorUtils.serialize('a plain string thrown').message).to.equal('a plain string thrown');
		expect(SchemaImportErrorUtils.serialize(undefined).message).to.equal('undefined');
		expect(SchemaImportErrorUtils.serialize({}).message).to.equal('[object Object]');
	});

	it('treats an object with a non-array diags property as having no diags', () => {
		let serialized = SchemaImportErrorUtils.serialize({diags: 'not an array'});
		expect(serialized.diags).to.deep.equal([]);
	});

	describe('integration with the real converters (regression guard against @dbml/core changing its throw shape)', () => {
		it('produces a real diag with a location for a malformed DBML file (an empty table block)', async () => {
			let badDbml = `
Table "STARSHIP" [note: 'Registry of starships in active service'] {
}
`;
			try {
				await dbmlFormat.import(badDbml);
				expect.fail('expected dbmlFormat.import to throw for an empty table block');
			} catch(error) {
				let serialized = SchemaImportErrorUtils.serialize(error);
				expect(serialized.diags).to.have.length.greaterThan(0);
				expect(serialized.diags[0].message).to.be.a('string').with.length.greaterThan(0);
				expect(serialized.diags[0].startLine).to.be.a('number');
			}
		});

		it('produces a real diag for a Ref pointing at a column that was never declared', async () => {
			let badDbml = `
Table "A" {
  "ID" "INTEGER" [pk]
}

Table "B" {
  "A_ID" "INTEGER"
}

Ref: "B"."A_ID" > "A"."NOT_A_REAL_COLUMN"
`;
			try {
				await dbmlFormat.import(badDbml);
				expect.fail('expected dbmlFormat.import to throw for a Ref to an undeclared column');
			} catch(error) {
				let serialized = SchemaImportErrorUtils.serialize(error);
				expect(serialized.message).to.be.a('string').with.length.greaterThan(0);
			}
		});

		it('falls back to a plain message (no diags) for malformed Frictionless JSON', async () => {
			try {
				await frictionlessFormat.import('{ not valid json');
				expect.fail('expected frictionlessFormat.import to throw for malformed JSON');
			} catch(error) {
				let serialized = SchemaImportErrorUtils.serialize(error);
				expect(serialized.diags).to.deep.equal([]);
				expect(serialized.message).to.be.a('string').with.length.greaterThan(0);
			}
		});
	});
});
