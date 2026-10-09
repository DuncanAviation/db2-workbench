import { expect } from 'chai';
import { SystemRoutine } from '../models/system-routine.js';
import { SystemProcedureParam } from '../models/system-procedure-param.js';
import { SystemSchema } from '../models/system-schema.js';
import { SpParser } from '../utils/sp-parser.js';
import { DbAssist } from './db-assist.js';
import { SpAssist } from './sp-assist.js';

function param(overrides: Partial<SystemProcedureParam> = {}): SystemProcedureParam {
	return {
		schema: 'MYSCHEMA',
		specificName: 'MYPROC',
		rowType: 'P',
		procedureName: 'MYPROC',
		position: 1,
		parameterMode: 'IN' as SystemProcedureParam['parameterMode'],
		name: 'PARAM1',
		dataType: 'VARCHAR',
		scale: 0,
		precision: 0,
		length: 50,
		description: '',
		default: '',
		...overrides
	};
}

function schema(name: string): SystemSchema {
	return {name: name, type: 'SCHEMA', description: ''};
}

function procedure(overrides: Partial<SystemRoutine> = {}): SystemRoutine {
	return {schema: 'MYSCHEMA', name: 'MYPROC', specificName: 'MYPROC', sqlSchema: 'MYSCHEMA', routineType: 'PROCEDURE', body: 'SQL', language: 'SQL', description: '', ...overrides};
}

// Real MemoryCache methods narrow by schema when one is given, and return everything otherwise --
// these fakes replicate just that narrowing (not the caching/DB-loading behind it) so getItems'
// schema-resolution logic (dot-qualified vs. "nothing narrows it down") can be exercised
// meaningfully end-to-end, the same way a real MemoryCache would behave.
function fakeExtension(options: {
	schemas?: SystemSchema[];
	procedures?: SystemRoutine[];
	procedureParams?: SystemProcedureParam[];
	procedureRequests?: {schema?: string; procedure?: string}[];
} = {}) {
	return {
		memoryCache: {
			getSchemas: async () => options.schemas ?? [],
			getProcedures: async (listOptions: {schema?: string}) => (options.procedures ?? [])
				.filter(p => !listOptions.schema || p.schema.toLowerCase() === listOptions.schema.toLowerCase()),
			getProcedureParams: async (request: {schema?: string; procedure?: string}) => {
				options.procedureRequests?.push({schema: request.schema, procedure: request.procedure});
				return options.procedureParams ?? [];
			}
		},
		configurations: {
			useAlias: 'Smart'
		}
	} as unknown as import('../extension.js').Extension;
}

describe('SpAssist', () => {
	describe('isParameterContext', () => {
		it('is false before the opening parenthesis', () => {
			expect(SpAssist.isParameterContext('CALL myproc')).to.equal(false);
		});

		it('is true once the opening parenthesis is typed', () => {
			expect(SpAssist.isParameterContext('CALL myproc(')).to.equal(true);
		});

		it('is true with parameters already typed', () => {
			expect(SpAssist.isParameterContext('CALL myproc(1, 2')).to.equal(true);
		});
	});

	describe('hasSuppliedParameters', () => {
		it('is false with an empty parameter list', () => {
			expect(SpAssist.hasSuppliedParameters('CALL myproc(')).to.equal(false);
		});

		it('is false with only whitespace in the parameter list', () => {
			expect(SpAssist.hasSuppliedParameters('CALL myproc(   ')).to.equal(false);
		});

		it('is true once anything is typed inside the parameter list', () => {
			expect(SpAssist.hasSuppliedParameters('CALL myproc(1')).to.equal(true);
		});

		it('is true partway through a multi-parameter call', () => {
			expect(SpAssist.hasSuppliedParameters('CALL myproc(1, 2, ')).to.equal(true);
		});

		it('is false when there is no open parenthesis at all', () => {
			expect(SpAssist.hasSuppliedParameters('CALL myproc')).to.equal(false);
		});
	});

	describe('getProcedureDescriptor', () => {
		it('includes the description in the label when present', () => {
			let descriptor = SpAssist.getProcedureDescriptor([procedure({description: 'Does a thing'})]);
			expect(descriptor).to.deep.equal({label: 'MYPROC (Does a thing)', insertText: 'MYPROC', detail: 'myschema'});
		});

		it('falls back to just the name when there is no description', () => {
			let descriptor = SpAssist.getProcedureDescriptor([procedure()]);
			expect(descriptor).to.deep.equal({label: 'MYPROC', insertText: 'MYPROC', detail: 'myschema'});
		});

		it('describes every overload of a name in one item, with the first description any of them has', () => {
			let descriptor = SpAssist.getProcedureDescriptor([
				procedure({specificName: 'MYPROC_1'}),
				procedure({specificName: 'MYPROC_2', description: 'Two-argument form'})
			]);
			expect(descriptor).to.deep.equal({label: 'MYPROC (Two-argument form)', insertText: 'MYPROC', detail: 'myschema (2 overloads)'});
		});
	});

	describe('getParamValueDescriptor', () => {
		it('formats a character parameter\'s default as an empty string literal', () => {
			let descriptor = SpAssist.getParamValueDescriptor(param({dataType: 'VARCHAR', name: 'NAME'}));
			expect(descriptor).to.deep.equal({
				label: '\'\' (default for NAME)',
				insertText: '\'\'',
				detail: 'myschema.myproc.name (varchar)'
			});
		});

		it('formats a numeric parameter\'s default as 0', () => {
			let descriptor = SpAssist.getParamValueDescriptor(param({dataType: 'DECIMAL', name: 'AMOUNT'}));
			expect(descriptor.insertText).to.equal('0');
			expect(descriptor.label).to.equal('0 (default for AMOUNT)');
		});

		it('lowercases the schema/procedure/name/dataType in the detail regardless of input casing', () => {
			let descriptor = SpAssist.getParamValueDescriptor(param({schema: 'MYSCHEMA', procedureName: 'MYPROC', name: 'PARAM1', dataType: 'VARCHAR'}));
			expect(descriptor.detail).to.equal('myschema.myproc.param1 (varchar)');
		});
	});

	describe('getBulkParamValueDescriptor', () => {
		it('joins every parameter\'s default value in order', () => {
			let params = [
				param({name: 'P1', dataType: 'VARCHAR'}),
				param({name: 'P2', dataType: 'DECIMAL'}),
				param({name: 'P3', dataType: 'DATE'})
			];
			let descriptor = SpAssist.getBulkParamValueDescriptor('MYPROC', params);
			expect(descriptor.insertText).to.equal('\'\', 0, \'0001-01-01\'');
			expect(descriptor.label).to.equal('[Default values for MYPROC]');
		});

		it('handles a single-parameter procedure', () => {
			let descriptor = SpAssist.getBulkParamValueDescriptor('MYPROC', [param({dataType: 'DECIMAL'})]);
			expect(descriptor.insertText).to.equal('0');
		});
	});

	describe('getItems', () => {
		function items(sql: string, extension: ReturnType<typeof fakeExtension>) {
			let parseResults = <SpParser.SpParseResults>SpParser.parse(sql);
			return new SpAssist(extension).getItems('k', sql, {lineNumber: 1, column: 1}, parseResults);
		}

		describe('procedure context (no "(" typed yet)', () => {
			it('offers schema items plus one item per procedure name when nothing is typed', async () => {
				let extension = fakeExtension({
					schemas: [schema('MYSCHEMA')],
					procedures: [
						procedure({schema: 'MYSCHEMA', name: 'MYPROC', specificName: 'MYPROC_1'}),
						procedure({schema: 'MYSCHEMA', name: 'MYPROC', specificName: 'MYPROC_2'})
					]
				});
				expect(await items('CALL ', extension)).to.deep.equal([
					{label: 'MYSCHEMA', insertText: 'MYSCHEMA', kind: 'Module', sortText: DbAssist.ItemSortOrder.SCHEMAS},
					{label: 'MYPROC', insertText: 'MYPROC', detail: 'myschema (2 overloads)', kind: 'Method', sortText: DbAssist.ItemSortOrder.TABLES}
				]);
			});

			it('offers every procedure across every schema when nothing narrows it down', async () => {
				let extension = fakeExtension({
					procedures: [procedure({schema: 'A', name: 'P1'}), procedure({schema: 'B', name: 'P2'})]
				});
				let results = await items('CALL ', extension);
				expect(results.map(i => i.label)).to.deep.equal(['P1', 'P2']);
			});

			it('offers only that schema\'s procedures once a schema has been typed, with no schema items', async () => {
				let extension = fakeExtension({
					schemas: [schema('MYSCHEMA')],
					procedures: [procedure({schema: 'MYSCHEMA', name: 'MYPROC'}), procedure({schema: 'OTHER', name: 'OTHERPROC'})]
				});
				expect(await items('CALL myschema.', extension)).to.deep.equal([
					{label: 'MYPROC', insertText: 'MYPROC', detail: 'myschema', kind: 'Method', sortText: DbAssist.ItemSortOrder.TABLES}
				]);
			});
		});

		describe('parameter context (after "(")', () => {
			it('offers a bulk-defaults item plus the first parameter\'s value item when the list is empty', async () => {
				let extension = fakeExtension({
					procedureParams: [param({name: 'P1', dataType: 'VARCHAR'}), param({name: 'P2', dataType: 'DECIMAL'})]
				});
				expect(await items('CALL myschema.MYPROC(', extension)).to.deep.equal([
					{label: '[Default values for MYPROC]', insertText: '\'\', 0', detail: '\'\', 0', kind: 'Value', sortText: DbAssist.ItemSortOrder.CUSTOM},
					{label: '\'\' (default for P1)', insertText: '\'\'', detail: 'myschema.myproc.p1 (varchar)', kind: 'Value', sortText: DbAssist.ItemSortOrder.VALUES}
				]);
			});

			it('offers only the targeted parameter\'s value item once something has been typed, no bulk item', async () => {
				let extension = fakeExtension({
					procedureParams: [param({name: 'P1', dataType: 'VARCHAR'}), param({name: 'P2', dataType: 'DECIMAL'})]
				});
				expect(await items('CALL myschema.MYPROC(1, ', extension)).to.deep.equal([
					{label: '0 (default for P2)', insertText: '0', detail: 'myschema.myproc.p2 (decimal)', kind: 'Value', sortText: DbAssist.ItemSortOrder.VALUES}
				]);
			});

			// No schema is filled in for an unqualified name, so getProcedureParams resolves it against the
			// library list - the same procedure the CALL runs when executed.
			it('leaves an unqualified procedure\'s schema for the library list to resolve', async () => {
				let procedureRequests: {schema?: string; procedure?: string}[] = [];
				let extension = fakeExtension({procedureParams: [param()], procedureRequests: procedureRequests});
				await items('CALL MYPROC(', extension);
				expect(procedureRequests).to.deep.equal([{schema: undefined, procedure: 'MYPROC'}]);
			});

			it('offers nothing when the procedure name could not be parsed at all', async () => {
				let extension = fakeExtension({procedureParams: [param()]});
				expect(await items('CALL (', extension)).to.deep.equal([]);
			});

			it('offers nothing when the procedure has no parameters', async () => {
				let extension = fakeExtension({procedureParams: []});
				expect(await items('CALL myschema.MYPROC(', extension)).to.deep.equal([]);
			});
		});
	});
});
