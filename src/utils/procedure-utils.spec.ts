import { expect } from 'chai';
import { ProcedureUtils } from './procedure-utils.js';

describe('ProcedureUtils', () => {
	describe('resolveSchema', () => {
		it('picks the only library list schema that holds the procedure', () => {
			let libraryList = [{ name: 'APPL', position: 1 }, { name: 'QGPL', position: 2 }];
			let procedures = [{ schema: 'QSCRATCH', name: 'SPUSER001' }, { schema: 'APPL', name: 'SPUSER001' }];

			expect(ProcedureUtils.resolveSchema(libraryList, procedures, 'SPUSER001')).to.equal('APPL');
		});

		it('picks the first schema in library list order, not alphabetical or catalog order', () => {
			let libraryList = [{ name: 'APPL', position: 2 }, { name: 'QSCRATCH', position: 1 }];
			let procedures = [{ schema: 'APPL', name: 'SPUSER001' }, { schema: 'QSCRATCH', name: 'SPUSER001' }];

			expect(ProcedureUtils.resolveSchema(libraryList, procedures, 'spuser001')).to.equal('QSCRATCH');
		});

		it('returns undefined when no library list schema holds the procedure', () => {
			let libraryList = [{ name: 'APPL', position: 1 }];
			let procedures = [{ schema: 'QSCRATCH', name: 'SPUSER001' }, { schema: 'APPL', name: 'OTHERSP' }];

			expect(ProcedureUtils.resolveSchema(libraryList, procedures, 'SPUSER001')).to.equal(undefined);
		});
	});
});
