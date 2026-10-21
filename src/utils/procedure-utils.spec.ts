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

	describe('resolveOverload', () => {
		// The shape QSYS2 really has: QCMDEXC(command, length) as specific QCMDEXC, QCMDEXC(command) as QCMDEXC1.
		let qcmdexc = [
			{ schema: 'QSYS2', name: 'QCMDEXC', specificName: 'QCMDEXC', parameterCount: 2 },
			{ schema: 'QSYS2', name: 'QCMDEXC', specificName: 'QCMDEXC1', parameterCount: 1 },
			{ schema: 'QSYS', name: 'QCMDEXC', specificName: 'QCMDEXC', parameterCount: 2 },
			{ schema: 'QSYS2', name: 'OTHER', specificName: 'OTHER', parameterCount: 1 }
		];

		it('picks the overload whose parameter count matches the arguments, whatever its specific name', () => {
			let one = ProcedureUtils.resolveOverload(qcmdexc, 'qsys2', 'qcmdexc', 1);
			expect(one.overloaded).to.equal(true);
			expect(one.candidates.map(candidate => candidate.specificName)).to.deep.equal(['QCMDEXC', 'QCMDEXC1']);
			expect(one.procedure?.specificName).to.equal('QCMDEXC1');

			expect(ProcedureUtils.resolveOverload(qcmdexc, 'QSYS2', 'QCMDEXC', 2).procedure?.specificName).to.equal('QCMDEXC');
		});

		it('counts only procedures in the same schema', () => {
			let resolved = ProcedureUtils.resolveOverload(qcmdexc, 'QSYS', 'QCMDEXC', 2);
			expect(resolved.overloaded).to.equal(false);
			expect(resolved.procedure?.schema).to.equal('QSYS');
		});

		it('falls back to the nearest overload with more parameters, which defaults could fill', () => {
			let procedures = [
				{ schema: 'APPL', name: 'P', parameterCount: 5 },
				{ schema: 'APPL', name: 'P', parameterCount: 3 },
				{ schema: 'APPL', name: 'P', parameterCount: 1 }
			];

			expect(ProcedureUtils.resolveOverload(procedures, 'APPL', 'P', 2).procedure?.parameterCount).to.equal(3);
			expect(ProcedureUtils.resolveOverload(procedures, 'APPL', 'P', 6).procedure).to.equal(undefined);
		});

		it('reports no candidates for a name the schema does not hold', () => {
			let resolved = ProcedureUtils.resolveOverload(qcmdexc, 'QSYS2', 'MISSING', 0);
			expect(resolved).to.deep.equal({ candidates: [], overloaded: false, procedure: undefined });
		});
	});
});
