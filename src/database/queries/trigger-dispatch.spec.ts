import { expect } from 'chai';
import {
	buildRoutingRowQuery,
	extractReadTables,
	extractRowConditions,
	findRoutingRows,
	findUnselectedCondition,
	libraryCandidates,
	MAX_ROUTING_ROWS,
	omitColumns,
	programNameCandidates,
	rankHandlers,
	rowValues,
	scoreHandler
} from './trigger-dispatch.js';

// A dispatcher's statements as SYSPROGRAMSTMTSTAT returns them (modelled on Trigger Mediator's TG_MED), plus a
// write and a qualified read, in the precompiler's normalized form.
const STATEMENTS = [
	'DECLARE TRCURSOR CURSOR FOR SELECT RMFILENAME , RMLIBNAME , RMSRVPGM , RMSRVLIB , RMSRVPROC FROM RTEMAP WHERE RMACTIVE = \'Y\' ORDER BY RMFILENAME , RMLIBNAME FOR FETCH ONLY',
	'SELECT COUNT ( * ) INTO : H FROM RTEMAP WHERE RMACTIVE = \'Y\'',
	'OPEN TRCURSOR',
	'FETCH NEXT FROM TRCURSOR INTO : H ,: H ,: H ,: H ,: H',
	'CLOSE TRCURSOR',
	'INSERT INTO ACME . EVTLOG ( LGFILE , LGPGM ) VALUES ( : H , : H )',
	'SELECT A . X FROM PRODLIB . RTEMAPX A JOIN QSYS2 . SYSTABLES B ON B . TABLE_NAME = A . X'
];

// A RTEMAP routing row for JOBHED, CHAR columns padded the way the driver returns them.
const ROW = {
	RMFILENAME: 'JOBHED    ', RMLIBNAME: 'ACME      ', RMACTIVE: 'Y', RMSRVPGM: 'TRGHDL01  ', RMSRVLIB: 'PRODLIB      ',
	RMSRVPROC: 'TRIGGERHANDLER                                    ', RMCRTSTAMP: '2020-01-01 00:00:00.000000', RMCRTUSER: 'TESTUSER  ', RMEDTUSER: 'TESTUSER  '
};

describe('extractReadTables', () => {
	it('reads the tables a program selects from, distinct, unqualified ones left unqualified', () => {
		expect(extractReadTables(STATEMENTS)).to.deep.equal([
			{schema: undefined, table: 'RTEMAP'},
			{schema: 'PRODLIB', table: 'RTEMAPX'}
		]);
	});

	it('leaves out tables only written to, cursor statements, and the system catalogs', () => {
		let tables = extractReadTables(STATEMENTS).map(table => table.table);

		expect(tables).not.to.include('EVTLOG');
		expect(tables).not.to.include('TRCURSOR');
		expect(tables).not.to.include('SYSTABLES');
	});
});

describe('buildRoutingRowQuery', () => {
	it('matches the trigger table in every character column, bounded', () => {
		expect(buildRoutingRowQuery({schema: 'ACMESRC', table: 'RTEMAP'}, [{name: 'RMFILENAME', length: 10}, {name: 'RMLIBNAME', length: 10}], 'jobhed')).to.deep.equal({
			sql: `select "RMFILENAME", "RMLIBNAME" from "ACMESRC"."RTEMAP" where "RMFILENAME" = ? or "RMLIBNAME" = ? fetch first ${MAX_ROUTING_ROWS} rows only`,
			parameters: ['JOBHED', 'JOBHED']
		});
	});

	// On a real system, binding the table name against a CHAR(1) column fails the statement with CWB0111.
	it('leaves out a column too short to hold the table name', () => {
		let query = buildRoutingRowQuery({schema: 'ACMESRC', table: 'RTEMAP'}, [{name: 'RMFILENAME', length: 10}, {name: 'RMACTIVE', length: 1}, {name: 'RMSHORT', length: 6}], 'JOBHED');

		expect(query?.sql).not.to.include('RMACTIVE');
		expect(query?.sql).to.include('"RMSHORT" = ?');
		expect(query?.parameters).to.have.length(2);
	});

	it('leaves out a column that is not a system name, and builds nothing around a bad table name or no columns', () => {
		expect(buildRoutingRowQuery({schema: 'LIB', table: 'TAB'}, [{name: 'GOOD'}, {name: 'BAD"COL'}], 'T')?.sql).not.to.include('BAD');
		expect(buildRoutingRowQuery({schema: 'LIB', table: 'TAB"; DROP'}, [{name: 'GOOD'}], 'T')).to.equal(undefined);
		expect(buildRoutingRowQuery({schema: 'LIB', table: 'TAB'}, [{name: 'RMACTIVE', length: 1}], 'JOBHED')).to.equal(undefined);
	});
});

describe('routing row values', () => {
	it('trims padded values and drops blanks and non-text', () => {
		expect(rowValues({A: 'X  ', B: '   ', C: 12, D: 'X', E: null})).to.deep.equal(['X']);
	});

	it('keeps only rows that really name the table', () => {
		expect(findRoutingRows([ROW, {...ROW, RMFILENAME: 'JOBWIP   '}], 'JOBHED')).to.deep.equal([ROW]);
	});

	it('offers system names and *LIBL as libraries, and leaves the table and dispatcher out of the program names', () => {
		let values = rowValues({...ROW, RMSRVLIB: '*LIBL'});

		expect(libraryCandidates(values)).to.deep.equal(['JOBHED', 'ACME', 'Y', 'TRGHDL01', '*LIBL', 'TESTUSER']);
		expect(programNameCandidates(values, ['JOBHED', 'TG_MED'])).to.deep.equal(['ACME', 'Y', 'TRGHDL01', 'TESTUSER']);
	});
});

describe('scoreHandler / rankHandlers', () => {
	let values = rowValues(ROW);
	let handler = {library: 'PRODLIB', object: 'TRGHDL01', objectType: <const>'*SRVPGM'};

	it('takes the export the row names as the entry, case ignored, and counts the trigger schema', () => {
		expect(scoreHandler(handler, values, ['FORMATDATE', 'TRIGGERHANDLER'], 'ACME')).to.deep.equal({...handler, entry: 'TRIGGERHANDLER', score: 3});
	});

	it('drops a program with neither a named export nor the trigger schema in its row', () => {
		expect(scoreHandler(handler, values, ['OTHER'], 'ELSEWHERE')).to.equal(undefined);
		expect(scoreHandler({...handler, objectType: '*PGM'}, values, undefined, 'ACME')).to.deep.equal({...handler, objectType: '*PGM', entry: undefined, score: 1});
	});

	it('keeps each program once at its best score, most certain first', () => {
		let weak = {library: 'ACME', object: 'OTHERPGM', objectType: <const>'*PGM', score: 1};
		let strong = {...handler, entry: 'TRIGGERHANDLER', score: 3};

		expect(rankHandlers([weak, {...handler, score: 1}, strong])).to.deep.equal([strong, weak]);
	});

	it('prefers, on a tie, a row the dispatcher selects over one it passes over', () => {
		let selected = {...handler, entry: 'TRIGGERHANDLER', score: 3};
		let passedOver = {...selected, unselected: {column: 'RMACTIVE', value: 'Y', actual: 'N'}};

		expect(rankHandlers([passedOver, selected])).to.deep.equal([selected]);
		expect(rankHandlers([selected, passedOver])).to.deep.equal([selected]);
	});
});

describe('extractRowConditions / findUnselectedCondition', () => {
	let conditions = extractRowConditions(STATEMENTS, {table: 'RTEMAP'});

	it('reads the literal conditions each statement reading the table puts on its rows, from the WHERE only', () => {
		expect(conditions).to.deep.equal([[{column: 'RMACTIVE', value: 'Y'}], [{column: 'RMACTIVE', value: 'Y'}]]);
		expect(extractRowConditions(['SELECT A FROM T X JOIN U Y ON Y . K = \'Z\' WHERE X . FLAG = \'it\'\'s\''], {table: 'T'}))
			.to.deep.equal([[{column: 'FLAG', value: 'it\'s'}]]);
		expect(extractRowConditions(STATEMENTS, {schema: 'OTHER', table: 'RTEMAPX'})).to.deep.equal([]);
	});

	it('enters a statement with an OR, a NOT or no WHERE as one that reads every row', () => {
		let statements = ['SELECT A FROM T WHERE F = \'Y\' OR G = \'Y\'', 'SELECT A FROM T WHERE NOT F = \'N\'', 'SELECT A FROM T'];
		expect(extractRowConditions(statements, {table: 'T'})).to.deep.equal([[], [], []]);
	});

	it('judges a row passed over only when every statement has a condition it fails', () => {
		let inactive = {...ROW, RMACTIVE: 'N'};

		expect(findUnselectedCondition(ROW, conditions)).to.equal(undefined);
		expect(findUnselectedCondition(inactive, conditions)).to.deep.equal({column: 'RMACTIVE', value: 'Y', actual: 'N'});
		expect(findUnselectedCondition(inactive, [...conditions, []])).to.equal(undefined);
		expect(findUnselectedCondition(inactive, [])).to.equal(undefined);
	});

	it('compares blank padded, and leaves a condition on a column the row lacks unjudged', () => {
		expect(findUnselectedCondition({...ROW, RMACTIVE: 'Y   '}, conditions)).to.equal(undefined);
		expect(findUnselectedCondition({RMFILENAME: 'JOBHED'}, conditions)).to.equal(undefined);
	});

	it('leaves a condition\'s flag column out of the values searched for program names', () => {
		expect(omitColumns(ROW, ['rmactive'])).to.not.have.property('RMACTIVE');
	});

	it('selects a flag column too short to compare, without binding a marker to it', () => {
		let query = buildRoutingRowQuery({schema: 'ACMESRC', table: 'RTEMAP'}, [{name: 'RMFILENAME', length: 10}, {name: 'RMACTIVE', length: 1}], 'JOBHED', ['RMACTIVE']);

		expect(query?.sql).to.equal(`select "RMFILENAME", "RMACTIVE" from "ACMESRC"."RTEMAP" where "RMFILENAME" = ? fetch first ${MAX_ROUTING_ROWS} rows only`);
		expect(query?.parameters).to.deep.equal(['JOBHED']);
	});
});
