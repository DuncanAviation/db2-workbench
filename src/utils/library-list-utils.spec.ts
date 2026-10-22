import { expect } from 'chai';
import { LibraryListUtils } from './library-list-utils.js';

describe('LibraryListUtils', () => {
	describe('isValidSystemName', () => {
		it('accepts system names of up to ten characters, in any case', () => {
			expect(['QGPL', 'lltesta', '$LIB', '#LIB', '@LIB', 'A1_B2', 'ABCDEFGHIJ'].map(name => LibraryListUtils.isValidSystemName(name))).to.deep.equal([true, true, true, true, true, true, true]);
		});

		it('refuses anything that could break out of the CL command or its string literal', () => {
			let refused = ['', 'ABCDEFGHIJK', '1LIB', '_LIB', 'A B', 'A\'B', 'A)', 'A(B)', 'A;B', 'A.B', 'A"B', 'A) CALL X'];
			expect(refused.filter(name => LibraryListUtils.isValidSystemName(name))).to.deep.equal([]);
			expect(LibraryListUtils.isValidSystemName(undefined)).to.equal(false);
			expect(LibraryListUtils.isValidSystemName(null)).to.equal(false);
		});
	});

	describe('buildChangeLibraryListCommand', () => {
		it('lists the libraries in order, upper-cased', () => {
			expect(LibraryListUtils.buildChangeLibraryListCommand(['qtemp', 'LLTESTB', 'lltesta'])).to.equal('CHGLIBL LIBL(QTEMP LLTESTB LLTESTA)');
		});

		it('sets an empty list with *NONE', () => {
			expect(LibraryListUtils.buildChangeLibraryListCommand([])).to.equal('CHGLIBL LIBL(*NONE)');
		});

		it('refuses an invalid name rather than embedding it', () => {
			expect(() => LibraryListUtils.buildChangeLibraryListCommand(['QGPL', 'X\') CALL Y'])).to.throw('"X\') CALL Y" is not a valid library name');
		});
	});

	describe('keepQtemp', () => {
		it('puts QTEMP back at its current position', () => {
			expect(LibraryListUtils.keepQtemp(['QTEMP', 'A', 'B'], ['B', 'A'])).to.deep.equal(['QTEMP', 'B', 'A']);
			expect(LibraryListUtils.keepQtemp(['A', 'QTEMP', 'B'], ['B', 'C', 'A'])).to.deep.equal(['B', 'QTEMP', 'C', 'A']);
		});

		it('keeps QTEMP where a request that carries it put it', () => {
			expect(LibraryListUtils.keepQtemp(['A', 'QTEMP', 'B'], ['qtemp', 'B'])).to.deep.equal(['QTEMP', 'B']);
		});

		it('never adds QTEMP to a job that doesn\'t have it', () => {
			expect(LibraryListUtils.keepQtemp(['A'], ['QTEMP', 'A'])).to.deep.equal(['A']);
		});

		it('keeps QTEMP when the request shrinks the list past its position', () => {
			expect(LibraryListUtils.keepQtemp(['A', 'B', 'QTEMP'], ['B'])).to.deep.equal(['B', 'QTEMP']);
			expect(LibraryListUtils.keepQtemp(['A', 'QTEMP'], [])).to.deep.equal(['QTEMP']);
		});
	});

	describe('userLibraries', () => {
		it('keeps only the USER entries, in list order', () => {
			let schemas = [
				{ name: 'QSYS', type: 'SYSTEM' },
				{ name: 'QSYS2', type: 'SYSTEM' },
				{ name: 'MYCUR', type: 'CURRENT' },
				{ name: 'QTEMP', type: 'USER' },
				{ name: 'B', type: 'USER' },
				{ name: 'A', type: 'USER' }
			];

			expect(LibraryListUtils.userLibraries(schemas)).to.deep.equal(['QTEMP', 'B', 'A']);
		});
	});

	describe('isSameList', () => {
		it('compares names, types and order', () => {
			let list = [{ name: 'QSYS', type: 'SYSTEM' }, { name: 'A', type: 'USER' }, { name: 'B', type: 'USER' }];

			expect(LibraryListUtils.isSameList(list, [{ name: 'qsys', type: 'SYSTEM' }, { name: 'A ', type: 'USER' }, { name: 'B', type: 'USER' }])).to.equal(true);
			expect(LibraryListUtils.isSameList(list, [list[0], list[2], list[1]])).to.equal(false);
			expect(LibraryListUtils.isSameList(list, [list[0], { name: 'A', type: 'CURRENT' }, list[2]])).to.equal(false);
			expect(LibraryListUtils.isSameList(list, list.slice(0, 2))).to.equal(false);
		});
	});

	describe('isLibraryListCommand', () => {
		it('recognizes each library list command run through a QCMDEXC CALL', () => {
			for(let command of LibraryListUtils.LIBRARY_LIST_COMMANDS) {
				expect(LibraryListUtils.isLibraryListCommand(`CALL QSYS2.QCMDEXC('${command} LIB(X)')`), command).to.equal(true);
			}
		});

		it('recognizes the scalar function form, unqualified calls, lowercase and leading whitespace', () => {
			expect(LibraryListUtils.isLibraryListCommand('values qsys2.qcmdexc(\'  addlible lib(x)\')')).to.equal(true);
			expect(LibraryListUtils.isLibraryListCommand('select qsys2.qcmdexc(\'RMVLIBLE LIB(X)\') from sysibm.sysdummy1')).to.equal(true);
			expect(LibraryListUtils.isLibraryListCommand('{CALL QCMDEXC (\'CHGLIBL LIBL(A B)\')}')).to.equal(true);
			expect(LibraryListUtils.isLibraryListCommand('call qsys2.qcmdexc(\'chgcurlib curlib(x)\', 0000000020.00000)')).to.equal(true);
		});

		it('reads a command bound as a parameter value', () => {
			expect(LibraryListUtils.isLibraryListCommand('CALL QSYS2.QCMDEXC(:command)', ['ADDLIBLE LIB(X)'])).to.equal(true);
			expect(LibraryListUtils.isLibraryListCommand('values qsys2.qcmdexc(?)', ['CHGLIBL LIBL(A)'])).to.equal(true);
			expect(LibraryListUtils.isLibraryListCommand('values qsys2.qcmdexc(?)', ['DSPLIBL'])).to.equal(false);
		});

		it('ignores other commands, other procedures and statements with no QCMDEXC at all', () => {
			expect(LibraryListUtils.isLibraryListCommand('CALL QSYS2.QCMDEXC(\'DSPLIBL\')')).to.equal(false);
			expect(LibraryListUtils.isLibraryListCommand('CALL QSYS2.QCMDEXC(\'ADDLIBLEX LIB(X)\')')).to.equal(false);
			expect(LibraryListUtils.isLibraryListCommand('CALL MYLIB.MYQCMDEXC(\'ADDLIBLE LIB(X)\')')).to.equal(false);
			expect(LibraryListUtils.isLibraryListCommand('select \'ADDLIBLE LIB(X)\' from sysibm.sysdummy1')).to.equal(false);
			expect(LibraryListUtils.isLibraryListCommand('CALL QSYS2.QCMDEXC(\'SNDMSG MSG(\'\'ADDLIBLE\'\') TOUSR(X)\')')).to.equal(false);
		});
	});
});
