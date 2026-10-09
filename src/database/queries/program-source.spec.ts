import { expect } from 'chai';
import {
	buildMemberCopiesQuery,
	buildMemberExistsQuery,
	buildMemberReadStatements,
	buildSourceFileLibrariesQuery,
	chooseMemberCopy,
	describeMemberCopy,
	describeMissingMember,
	describeSourceLocation,
	findEntrySource,
	hasSourceLocation,
	isChangedSince,
	isSystemName,
	parseExternalName
} from './program-source.js';

const MEMBER = {module: 'TG_MED_M01', library: 'TRIGGERLIB', file: 'QSRCF', member: 'TG_MED_M01'};

describe('isSystemName', () => {
	it('accepts IBM i object names, including the $ # @ characters', () => {
		for(let name of ['TRIGGERLIB', 'QSRCF', 'TG_MED_M01', '$LIB', '#SRC', '@X1']) {
			expect(isSystemName(name), name).to.equal(true);
		}
	});

	it('rejects blanks, lowercase, over ten characters, a leading digit or underscore, and anything that could end a quoted identifier', () => {
		for(let name of [undefined, '', 'qsrcf', 'ABCDEFGHIJK', '1LIB', '_LIB', 'A"B', 'A B', 'A.B']) {
			expect(isSystemName(name), String(name)).to.equal(false);
		}
	});
});

describe('buildMemberReadStatements', () => {
	it('creates a QTEMP alias over the one member, reads it in sequence order, and drops it', () => {
		expect(buildMemberReadStatements(MEMBER, 'WBSRC1')).to.deep.equal({
			create: 'create alias qtemp."WBSRC1" for "TRIGGERLIB"."QSRCF" ("TG_MED_M01")',
			select: 'select srcdta from qtemp."WBSRC1" order by srcseq',
			drop: 'drop alias qtemp."WBSRC1"'
		});
	});

	it('refuses to build DDL around a name that is not a system name', () => {
		expect(() => buildMemberReadStatements({...MEMBER, member: 'X") ; DROP TABLE Y --'}, 'WBSRC1')).to.throw(/member/);
		expect(() => buildMemberReadStatements({...MEMBER, library: undefined}, 'WBSRC1')).to.throw(/library/);
		expect(() => buildMemberReadStatements(MEMBER, 'wbsrc1')).to.throw(/alias/);
	});
});

describe('describeSourceLocation / hasSourceLocation', () => {
	it('reads a member the way IBM i writes one, and a stream file as its path', () => {
		expect(describeSourceLocation(MEMBER)).to.equal('TRIGGERLIB/QSRCF(TG_MED_M01)');
		expect(describeSourceLocation({module: 'M', streamFile: '/home/src/m.rpgle'})).to.equal('/home/src/m.rpgle');
	});

	it('counts a location only when it names a whole member or a stream file', () => {
		expect(hasSourceLocation(MEMBER)).to.equal(true);
		expect(hasSourceLocation({streamFile: '/a'})).to.equal(true);
		expect(hasSourceLocation({module: 'M', library: 'LIB', file: 'QSRCF'})).to.equal(false);
		expect(hasSourceLocation({module: 'M'})).to.equal(false);
	});
});

describe('parseExternalName', () => {
	it('reads a program, and a service program export with its case kept', () => {
		expect(parseExternalName('SALES/ORDPGM')).to.deep.equal({objectType: '*PGM', library: 'SALES', object: 'ORDPGM', entry: undefined});
		expect(parseExternalName('sales/ordsrv(ordHist)')).to.deep.equal({objectType: '*SRVPGM', library: 'SALES', object: 'ORDSRV', entry: 'ordHist'});
	});

	it('leaves the library to the library list for *LIBL or no library, and strips quotes', () => {
		expect(parseExternalName('*LIBL/ORDPGM')).to.deep.equal({objectType: '*PGM', library: undefined, object: 'ORDPGM', entry: undefined});
		expect(parseExternalName('ORDSRV(ORDHIST)')).to.deep.equal({objectType: '*SRVPGM', library: undefined, object: 'ORDSRV', entry: 'ORDHIST'});
		expect(parseExternalName('"SALES"/"ORDSRV"("ORDHIST")')).to.deep.equal({objectType: '*SRVPGM', library: 'SALES', object: 'ORDSRV', entry: 'ORDHIST'});
	});

	it('names no object for a Java routine, a blank, or a name that is not a system name', () => {
		for(let name of [undefined, '', 'com.example.Orders.history', 'jar:orders.Orders.history', 'SALES/NOT A NAME', 'A/B/C']) {
			expect(parseExternalName(name), String(name)).to.equal(undefined);
		}
	});
});

describe('findEntrySource', () => {
	let utility = {module: 'ORDSRV01', text: '**free\ndcl-proc formatDate export;\nend-proc;'};

	it('prefers a module named like the entry', () => {
		expect(findEntrySource([utility, {module: 'ORDHIST', text: ''}], 'ordhist')).to.equal(1);
	});

	it('finds the source that defines the entry in RPG free or fixed form, COBOL or C', () => {
		expect(findEntrySource([utility, {module: 'M2', text: '**free\n  dcl-proc ordHist export;\nend-proc;'}], 'ORDHIST')).to.equal(1);
		expect(findEntrySource([utility, {module: 'M2', text: '     H NOMAIN\n     POrdHist         B                   EXPORT'}], 'ORDHIST')).to.equal(1);
		expect(findEntrySource([utility, {module: 'M2', text: '       PROGRAM-ID. ORDHIST.'}], 'ORDHIST')).to.equal(1);
		expect(findEntrySource([utility, {module: 'M2', text: 'int ordHist(char *custno)\n{\n  return 0;\n}'}], 'ordHist')).to.equal(1);
	});

	// A utility module bound in by copy defines nothing the routine names - the module named like the
	// service program is the better guess, but only once no source has answered.
	it('falls back to the module named like the service program when no source defines the entry', () => {
		let home = {module: 'TRR9001V', text: '**free\ndcl-proc getMakeHist export;\nend-proc;'};
		let bound = {module: 'RPTPGM05', text: '**free\ndcl-proc formatMake export;\nend-proc;'};
		expect(findEntrySource([bound, home], 'GETMAKEHISTORY_UDF', 'TRR9001V')).to.equal(1);
		expect(findEntrySource([bound, home], 'GETMAKEHISTORY_UDF')).to.equal(undefined);

		let defining = {module: 'RPTPGM05', text: '**free\ndcl-proc getMakeHistory_UDF export;\nend-proc;'};
		expect(findEntrySource([defining, home], 'GETMAKEHISTORY_UDF', 'TRR9001V')).to.equal(0);
	});

	it('does not take a call or a prototype for the definition, and is undefined when nothing defines it', () => {
		let caller = {module: 'M2', text: '**free\ndcl-pr ordHist;\nend-pr;\nordHist(custno);\nint x = ordHist(1);'};
		expect(findEntrySource([utility, caller], 'ORDHIST')).to.equal(undefined);
		expect(findEntrySource([{module: 'M1', error: 'unreadable'} as {module: string}], 'ORDHIST')).to.equal(undefined);
	});
});

// A service program compiled from a test library's member that has since been removed, with copies of
// the member left in five libraries, the current one in the service program's own library.
describe('finding a copy of a member that is gone', () => {
	let recorded = {module: 'TRGSRV01', library: 'DEVTEST', file: 'DBSOURCE', member: 'TRGSRV01', compiled: '2024-11-01 10:00:00.000000'};
	let copy = (library: string, lastChanged: string) => ({library: library, file: 'DBSOURCE', member: 'TRGSRV01', lastChanged: lastChanged});
	let copies = [copy('APPLT', '2022-04-25 12:12:49.000000'), copy('GITAPPL', '2022-05-04 09:58:03.000000'), copy('APPL', '2024-10-22 19:45:31.000000')];

	it('checks every recorded member in one statement', () => {
		expect(buildMemberExistsQuery([{library: 'DEVTEST', file: 'DBSOURCE', member: 'TRGSRV01'}, {library: 'APPL', file: 'QRPGLESRC', member: 'X'}])).to.deep.equal({
			sql: 'select system_table_schema, system_table_name, system_table_member, last_change_timestamp from qsys2.syspartitionstat '
				+ 'where (system_table_schema = ? and system_table_name = ? and system_table_member = ?) or (system_table_schema = ? and system_table_name = ? and system_table_member = ?)',
			parameters: ['DEVTEST', 'DBSOURCE', 'TRGSRV01', 'APPL', 'QRPGLESRC', 'X']
		});
	});

	it('finds the libraries holding every source file in one statement, then the members only in those', () => {
		expect(buildSourceFileLibrariesQuery(['DBSOURCE', 'QRPGLESRC'])).to.deep.equal({
			sql: 'select objlib, objname from table(qsys2.object_statistics(\'*ALLUSR\', ?, ?)) x union all select objlib, objname from table(qsys2.object_statistics(\'*ALLUSR\', ?, ?)) x',
			parameters: ['*FILE', 'DBSOURCE', '*FILE', 'QRPGLESRC']
		});

		let query = buildMemberCopiesQuery([{file: 'DBSOURCE', member: 'TRGSRV01', libraries: ['APPL', 'APPLT']}, {file: 'QRPGLESRC', member: 'X', libraries: ['A']}]);
		expect(query.sql).to.match(/where \(system_table_name = \? and system_table_member = \? and system_table_schema in \(\?, \?\)\) or \(system_table_name = \? and system_table_member = \? and system_table_schema in \(\?\)\)$/);
		expect(query.parameters).to.deep.equal(['DBSOURCE', 'TRGSRV01', 'APPL', 'APPLT', 'QRPGLESRC', 'X', 'A']);
	});

	it('prefers the program\'s own library, then the library list, then the most recently changed', () => {
		expect(chooseMemberCopy(copies, {programLibrary: 'appl', libraryList: ['GITAPPL']})).to.deep.include({copy: copies[2], reason: 'own library'});
		expect(chooseMemberCopy(copies, {programLibrary: 'OTHER', libraryList: ['QGPL', 'GITAPPL', 'APPLT']})).to.deep.include({copy: copies[1], reason: 'library list'});
		expect(chooseMemberCopy(copies, {libraryList: []})).to.deep.include({copy: copies[2], reason: 'most recently changed'});
		expect(chooseMemberCopy(copies, {programLibrary: 'APPL', libraryList: []})?.others).to.deep.equal([copies[0], copies[1]]);
		expect(chooseMemberCopy([], {libraryList: []})).to.equal(undefined);
	});

	it('says briefly which copy is shown, and names the others', () => {
		let choice = chooseMemberCopy(copies, {programLibrary: 'APPL', libraryList: []});
		expect(describeMemberCopy(recorded, <NonNullable<typeof choice>>choice, false)).to.equal('Compiled from DEVTEST/DBSOURCE(TRGSRV01), which no longer exists. Showing APPL/DBSOURCE(TRGSRV01). '
			+ 'Also found: APPLT/DBSOURCE(TRGSRV01), GITAPPL/DBSOURCE(TRGSRV01).');
		expect(describeMemberCopy(recorded, {copy: copies[2], others: []}, false)).to.equal('Compiled from DEVTEST/DBSOURCE(TRGSRV01), which no longer exists. Showing APPL/DBSOURCE(TRGSRV01).');
		expect(describeMemberCopy(recorded, {copy: copies[2], others: [copies[0]]}, true)).to.equal('Compiled from DEVTEST/DBSOURCE(TRGSRV01), which no longer exists. Showing APPL/DBSOURCE(TRGSRV01). '
			+ 'Changed since compile. Also found: APPLT/DBSOURCE(TRGSRV01).');
		expect(describeMissingMember(recorded)).to.equal('Compiled from DEVTEST/DBSOURCE(TRGSRV01), which no longer exists, and no copy of that member was found in another library.');
	});

	it('counts a copy as changed only when it is later than the compile', () => {
		expect(isChangedSince('2024-10-22 19:45:31.000000', '2024-11-01 10:00:00.000000')).to.equal(false);
		expect(isChangedSince('2024-11-02 08:00:00.000000', '2024-11-01T10:00:00.000Z')).to.equal(true);
		expect(isChangedSince(undefined, '2024-11-01 10:00:00.000000')).to.equal(false);
		expect(isChangedSince('2024-11-02 08:00:00.000000', undefined)).to.equal(false);
	});
});
