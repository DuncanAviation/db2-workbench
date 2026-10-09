import { expect } from 'chai';
import { findSchemasToFetch } from './schema-fetch-targets.js';

function options(overrides: Partial<Parameters<typeof findSchemasToFetch>[0]> = {}) {
	return {
		libraryListSchemaNames: [],
		addedSchemaNames: [],
		importedSchemaNames: [],
		hiddenSchemaNames: [],
		...overrides
	};
}

describe('findSchemasToFetch', () => {
	it('is empty when nothing is added or imported', () => {
		expect(findSchemasToFetch(options({libraryListSchemaNames: ['HR', 'SALES']}))).to.deep.equal([]);
	});

	it('fetches a schema the user added by name', () => {
		expect(findSchemasToFetch(options({addedSchemaNames: ['LEGACY']}))).to.deep.equal(['LEGACY']);
	});

	it('fetches a schema that only an import names', () => {
		expect(findSchemasToFetch(options({importedSchemaNames: ['LEGACY']}))).to.deep.equal(['LEGACY']);
	});

	it('skips a schema the library list already covers, whatever its case', () => {
		let result = findSchemasToFetch(options({
			libraryListSchemaNames: ['HR'],
			importedSchemaNames: ['hr', 'PAYROLL']
		}));

		expect(result).to.deep.equal(['PAYROLL']);
	});

	it('skips a hidden schema', () => {
		let result = findSchemasToFetch(options({
			addedSchemaNames: ['LEGACY'],
			importedSchemaNames: ['ARCHIVE'],
			hiddenSchemaNames: ['legacy']
		}));

		expect(result).to.deep.equal(['ARCHIVE']);
	});

	it('asks for a name once when it is both added and imported', () => {
		let result = findSchemasToFetch(options({
			addedSchemaNames: ['LEGACY'],
			importedSchemaNames: ['legacy']
		}));

		expect(result).to.deep.equal(['LEGACY']);
	});

	it('uppercases every name it asks for', () => {
		expect(findSchemasToFetch(options({importedSchemaNames: ['legacy']}))).to.deep.equal(['LEGACY']);
	});

	it('drops blank names', () => {
		expect(findSchemasToFetch(options({importedSchemaNames: ['', '   ']}))).to.deep.equal([]);
	});
});
