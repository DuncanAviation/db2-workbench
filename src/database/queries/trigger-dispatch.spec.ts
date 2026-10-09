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
	'DECLARE TRCURSOR CURSOR FOR SELECT TRFILENAME , TRLIBNAME , TRSRVPGM , TRSRVLIB , TRSRVPROC FROM TRGROUT WHERE TRACTIVE = \'Y\' ORDER BY TRFILENAME , TRLIBNAME FOR FETCH ONLY',
	'SELECT COUNT ( * ) INTO : H FROM TRGROUT WHERE TRACTIVE = \'Y\'',
	'OPEN TRCURSOR',
	'FETCH NEXT FROM TRCURSOR INTO : H ,: H ,: H ,: H ,: H',
	'CLOSE TRCURSOR',
	'INSERT INTO ACME . EVLOG ( LGFILE , LGPGM ) VALUES ( : H , : H )',
	'SELECT A . X FROM APPL . TRGROUX A JOIN QSYS2 . SYSTABLES B ON B . TABLE_NAME = A . X'
];

// A TRGROUT routing row for WOHEAD, CHAR columns padded the way the driver returns them.
const ROW = {
	TRFILENAME: 'WOHEAD    ', TRLIBNAME: 'ACME      ', TRACTIVE: 'Y', TRSRVPGM: 'TRGSRV01  ', TRSRVLIB: 'APPL      ',
	TRSRVPROC: 'TRIGGERSERVICE                                    ', TRCRTSTAMP: '2020-01-01 00:00:00.000000', TRCRTUSER: 'TESTUSER  ', TREDTUSER: 'TESTUSER  '
};

describe('extractReadTables', () => {
	it('reads the tables a program selects from, distinct, unqualified ones left unqualified', () => {
		expect(extractReadTables(STATEMENTS)).to.deep.equal([
			{schema: undefined, table: 'TRGROUT'},
			{schema: 'APPL', table: 'TRGROUX'}
		]);
	});

	it('leaves out tables only written to, cursor statements, and the system catalogs', () => {
		let tables = extractReadTables(STATEMENTS).map(table => table.table);

		expect(tables).not.to.include('EVLOG');
		expect(tables).not.to.include('TRCURSOR');
		expect(tables).not.to.include('SYSTABLES');
	});
});

describe('buildRoutingRowQuery', () => {
	it('matches the trigger table in every character column, bounded', () => {
		expect(buildRoutingRowQuery({schema: 'APPOPNSRC', table: 'TRGROUT'}, [{name: 'TRFILENAME', length: 10}, {name: 'TRLIBNAME', length: 10}], 'wohead')).to.deep.equal({
			sql: `select "TRFILENAME", "TRLIBNAME" from "APPOPNSRC"."TRGROUT" where "TRFILENAME" = ? or "TRLIBNAME" = ? fetch first ${MAX_ROUTING_ROWS} rows only`,
			parameters: ['WOHEAD', 'WOHEAD']
		});
	});

	// On a real system, binding the table name against a CHAR(1) column fails the statement with CWB0111.
	it('leaves out a column too short to hold the table name', () => {
		let query = buildRoutingRowQuery({schema: 'APPOPNSRC', table: 'TRGROUT'}, [{name: 'TRFILENAME', length: 10}, {name: 'TRACTIVE', length: 1}, {name: 'TRSHORT', length: 6}], 'WOHEAD');

		expect(query?.sql).not.to.include('TRACTIVE');
		expect(query?.sql).to.include('"TRSHORT" = ?');
		expect(query?.parameters).to.have.length(2);
	});

	it('leaves out a column that is not a system name, and builds nothing around a bad table name or no columns', () => {
		expect(buildRoutingRowQuery({schema: 'LIB', table: 'TAB'}, [{name: 'GOOD'}, {name: 'BAD"COL'}], 'T')?.sql).not.to.include('BAD');
		expect(buildRoutingRowQuery({schema: 'LIB', table: 'TAB"; DROP'}, [{name: 'GOOD'}], 'T')).to.equal(undefined);
		expect(buildRoutingRowQuery({schema: 'LIB', table: 'TAB'}, [{name: 'TRACTIVE', length: 1}], 'WOHEAD')).to.equal(undefined);
	});
});

describe('routing row values', () => {
	it('trims padded values and drops blanks and non-text', () => {
		expect(rowValues({A: 'X  ', B: '   ', C: 12, D: 'X', E: null})).to.deep.equal(['X']);
	});

	it('keeps only rows that really name the table', () => {
		expect(findRoutingRows([ROW, {...ROW, TRFILENAME: 'WOPLWIP   '}], 'WOHEAD')).to.deep.equal([ROW]);
	});

	it('offers system names and *LIBL as libraries, and leaves the table and dispatcher out of the program names', () => {
		let values = rowValues({...ROW, TRSRVLIB: '*LIBL'});

		expect(libraryCandidates(values)).to.deep.equal(['WOHEAD', 'ACME', 'Y', 'TRGSRV01', '*LIBL', 'TESTUSER']);
		expect(programNameCandidates(values, ['WOHEAD', 'TG_MED'])).to.deep.equal(['ACME', 'Y', 'TRGSRV01', 'TESTUSER']);
	});
});

describe('scoreHandler / rankHandlers', () => {
	let values = rowValues(ROW);
	let handler = {library: 'APPL', object: 'TRGSRV01', objectType: <const>'*SRVPGM'};

	it('takes the export the row names as the entry, case ignored, and counts the trigger schema', () => {
		expect(scoreHandler(handler, values, ['FORMATDATE', 'TriggerService'], 'ACME')).to.deep.equal({...handler, entry: 'TriggerService', score: 3});
	});

	it('drops a program with neither a named export nor the trigger schema in its row', () => {
		expect(scoreHandler(handler, values, ['OTHER'], 'ELSEWHERE')).to.equal(undefined);
		expect(scoreHandler({...handler, objectType: '*PGM'}, values, undefined, 'ACME')).to.deep.equal({...handler, objectType: '*PGM', entry: undefined, score: 1});
	});

	it('keeps each program once at its best score, most certain first', () => {
		let weak = {library: 'ACME', object: 'OTHERPGM', objectType: <const>'*PGM', score: 1};
		let strong = {...handler, entry: 'TRIGGERSERVICE', score: 3};

		expect(rankHandlers([weak, {...handler, score: 1}, strong])).to.deep.equal([strong, weak]);
	});

	it('prefers, on a tie, a row the dispatcher selects over one it passes over', () => {
		let selected = {...handler, entry: 'TRIGGERSERVICE', score: 3};
		let passedOver = {...selected, unselected: {column: 'TRACTIVE', value: 'Y', actual: 'N'}};

		expect(rankHandlers([passedOver, selected])).to.deep.equal([selected]);
		expect(rankHandlers([selected, passedOver])).to.deep.equal([selected]);
	});
});

describe('extractRowConditions / findUnselectedCondition', () => {
	let conditions = extractRowConditions(STATEMENTS, {table: 'TRGROUT'});

	it('reads the literal conditions each statement reading the table puts on its rows, from the WHERE only', () => {
		expect(conditions).to.deep.equal([[{column: 'TRACTIVE', value: 'Y'}], [{column: 'TRACTIVE', value: 'Y'}]]);
		expect(extractRowConditions(['SELECT A FROM T X JOIN U Y ON Y . K = \'Z\' WHERE X . FLAG = \'it\'\'s\''], {table: 'T'}))
			.to.deep.equal([[{column: 'FLAG', value: 'it\'s'}]]);
		expect(extractRowConditions(STATEMENTS, {schema: 'OTHER', table: 'TRGROUX'})).to.deep.equal([]);
	});

	it('enters a statement with an OR, a NOT or no WHERE as one that reads every row', () => {
		let statements = ['SELECT A FROM T WHERE F = \'Y\' OR G = \'Y\'', 'SELECT A FROM T WHERE NOT F = \'N\'', 'SELECT A FROM T'];
		expect(extractRowConditions(statements, {table: 'T'})).to.deep.equal([[], [], []]);
	});

	it('judges a row passed over only when every statement has a condition it fails', () => {
		let inactive = {...ROW, TRACTIVE: 'N'};

		expect(findUnselectedCondition(ROW, conditions)).to.equal(undefined);
		expect(findUnselectedCondition(inactive, conditions)).to.deep.equal({column: 'TRACTIVE', value: 'Y', actual: 'N'});
		expect(findUnselectedCondition(inactive, [...conditions, []])).to.equal(undefined);
		expect(findUnselectedCondition(inactive, [])).to.equal(undefined);
	});

	it('compares blank padded, and leaves a condition on a column the row lacks unjudged', () => {
		expect(findUnselectedCondition({...ROW, TRACTIVE: 'Y   '}, conditions)).to.equal(undefined);
		expect(findUnselectedCondition({TRFILENAME: 'WOHEAD'}, conditions)).to.equal(undefined);
	});

	it('leaves a condition\'s flag column out of the values searched for program names', () => {
		expect(omitColumns(ROW, ['tractive'])).to.not.have.property('TRACTIVE');
	});

	it('selects a flag column too short to compare, without binding a marker to it', () => {
		let query = buildRoutingRowQuery({schema: 'APPOPNSRC', table: 'TRGROUT'}, [{name: 'TRFILENAME', length: 10}, {name: 'TRACTIVE', length: 1}], 'WOHEAD', ['TRACTIVE']);

		expect(query?.sql).to.equal(`select "TRFILENAME", "TRACTIVE" from "APPOPNSRC"."TRGROUT" where "TRFILENAME" = ? fetch first ${MAX_ROUTING_ROWS} rows only`);
		expect(query?.parameters).to.deep.equal(['WOHEAD']);
	});
});
