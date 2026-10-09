import * as assert from 'assert';
import type { Extension } from '../extension.js';
import type { SystemColumn } from '../models/system-column.js';
import type { SystemProcedureParam } from '../models/system-procedure-param.js';
import * as vscode from 'vscode';
import { ParameterParser } from '../utils/parameter-parser.js';
import { StatementParser } from '../utils/statement-parser.js';

// resolveTypesForStatement/resolveDocumentParameters take `extension` as an explicit parameter
// rather than reaching for global state, so a plain mock - cast to Extension, since it has private
// fields that make it otherwise unassignable - is enough to test them without a real VS Code host.
//
// The fake rows are typed off the real SystemColumn/SystemProcedureParam interfaces rather than as
// free-form shapes. That matters here: this file spent its whole life unrun (it compiled to
// out/utils/parameter-parser.test.js, which matched neither suite's glob - see
// src/test-layout.spec.ts), and in the meantime SystemColumn's column-name fields were renamed to
// systemName/sqlName. An untyped mock followed neither rename, so every lookup in
// resolveColumnSize() missed and every resolved dataType came back undefined. Typing the mock off
// the interface makes the next rename a compile error instead of a silent miss.
type FakeColumn = Pick<SystemColumn, 'systemName' | 'sqlName' | 'dataType'> & Partial<Pick<SystemColumn, 'length' | 'scale'>>;
type FakeProcedureParam = Pick<SystemProcedureParam, 'position' | 'dataType'> & Partial<Pick<SystemProcedureParam, 'length' | 'precision' | 'scale'>>;

function fakeExtension(options: FakeOptions): Extension {
	return <Extension><unknown>{
		connections: {
			getConnectionConfig: async () => ({defaultTableSchema: options.defaultTableSchema})
		},
		memoryCache: {
			getColumns: async (request: {tables: {schema?: string; table: string} | {schema?: string; table: string}[]}) => {
				let target = Array.isArray(request.tables) ? request.tables[0] : request.tables;
				options.columnRequests?.push(`${target?.schema ?? ''}.${target?.table ?? ''}`.toUpperCase());

				return options.columnsByTable?.[target?.table?.toUpperCase() ?? ''] ?? options.columns ?? [];
			},
			getProcedureParams: async (request: {schema?: string; procedure: string}) => {
				options.procedureRequests?.push(`${request.schema ?? ''}.${request.procedure}`.toUpperCase());
				return options.procedureParams ?? [];
			}
		}
	};
}

interface FakeOptions {
	defaultTableSchema?: string;
	/** Answered for every table, for a statement where which table was asked for doesn't matter. */
	columns?: FakeColumn[];
	/** Answered per table (keyed by upper-case table name) - what an alias or a join has to get right. */
	columnsByTable?: Record<string, FakeColumn[]>;
	procedureParams?: FakeProcedureParam[];
	/** Each "SCHEMA.TABLE" a lookup asked for, in order - so a resolution can be checked against the
	 * table it actually consulted rather than only against the type it happened to return. */
	columnRequests?: string[];
	procedureRequests?: string[];
}

// The fixture the association tests resolve against: one table whose columns cover the three type
// shapes that behave differently (character, integer, decimal with a scale, date).
const CUSTOMER_COLUMNS: FakeColumn[] = [
	{systemName: 'CUSTNO', sqlName: 'CUSTOMER_NUMBER', dataType: 'INTEGER', length: 4},
	{systemName: 'CUSTNM', sqlName: 'CUSTOMER_NAME', dataType: 'VARCHAR', length: 40},
	{systemName: 'ORDDT', sqlName: 'ORDER_DATE', dataType: 'DATE', length: 10},
	{systemName: 'ORDAMT', sqlName: 'ORDER_AMOUNT', dataType: 'DECIMAL', length: 9, scale: 2}
];

suite('ParameterParser Test Suite', () => {
	test('findOccurrences finds named parameters in order', () => {
		let occurrences = ParameterParser.findOccurrences(`select * from appuser where fnam = :firstName and lnam = :lastName`);

		assert.strictEqual(occurrences.length, 2);
		assert.strictEqual(occurrences[0].name, 'firstName');
		assert.strictEqual(occurrences[1].name, 'lastName');
	});

	test('findOccurrences ignores ":" tokens inside quoted string literals', () => {
		let occurrences = ParameterParser.findOccurrences(`select * from t where tm = '12:30:00' and nm = :name`);

		assert.strictEqual(occurrences.length, 1);
		assert.strictEqual(occurrences[0].name, 'name');
	});

	test('findOccurrences ignores a double-colon', () => {
		let occurrences = ParameterParser.findOccurrences(`select a::b from t`);

		assert.strictEqual(occurrences.length, 0);
	});

	test('findOccurrences keeps duplicate parameter names in occurrence order', () => {
		let occurrences = ParameterParser.findOccurrences(`select * from t where a = :p or b = :p`);

		assert.strictEqual(occurrences.length, 2);
		assert.deepStrictEqual(occurrences.map(occurrence => occurrence.name), ['p', 'p']);
	});

	test('substituteMarkers replaces every occurrence with "?"', () => {
		let sql = `select * from appuser where fnam = :firstName and lnam = :lastName`;
		let occurrences = ParameterParser.findOccurrences(sql);
		let result = ParameterParser.substituteMarkers(sql, occurrences);

		assert.strictEqual(result, `select * from appuser where fnam = ? and lnam = ?`);
	});

	test('substituteMarkers handles a repeated parameter and preserves surrounding text', () => {
		let sql = `select * from t where a = :p or b = :p`;
		let occurrences = ParameterParser.findOccurrences(sql);
		let result = ParameterParser.substituteMarkers(sql, occurrences);

		assert.strictEqual(result, `select * from t where a = ? or b = ?`);
	});

	test('dedupeParameters collapses the same name+dataType but keeps different dataTypes separate', () => {
		let deduped = ParameterParser.dedupeParameters([
			{key: 'id|numeric', name: 'id', label: ':id', dataType: 'NUMERIC'},
			{key: 'id|numeric', name: 'id', label: ':id', dataType: 'NUMERIC'},
			{key: 'id|character', name: 'id', label: ':id', dataType: 'CHARACTER'}
		]);

		assert.strictEqual(deduped.length, 2);
		assert.deepStrictEqual(deduped.map(param => param.dataType), ['NUMERIC', 'CHARACTER']);
	});

	test('dedupeParameters preserves first-seen order', () => {
		let deduped = ParameterParser.dedupeParameters([
			{key: 'b|', name: 'b', label: ':b'},
			{key: 'a|', name: 'a', label: ':a'},
			{key: 'b|', name: 'b', label: ':b'}
		]);

		assert.deepStrictEqual(deduped.map(param => param.name), ['b', 'a']);
	});

	test('dedupeParameters ORs allowMultiple across duplicate keys', () => {
		let deduped = ParameterParser.dedupeParameters([
			{key: 'field|CHAR', name: 'field', label: ':field', dataType: 'CHAR'},
			{key: 'field|CHAR', name: 'field', label: ':field', dataType: 'CHAR', allowMultiple: true}
		]);

		assert.strictEqual(deduped.length, 1);
		assert.strictEqual(deduped[0].allowMultiple, true);
	});

	test('substituteMarkers expands a multi-value region into N comma-joined "?" markers', () => {
		let sql = `select * from t where field in (:field, :field, :field)`;
		let start = sql.indexOf('(') + 1;
		let end = sql.indexOf(')');
		let result = ParameterParser.substituteMarkers(sql, [{start, end, count: 3}]);

		assert.strictEqual(result, `select * from t where field in (?, ?, ?)`);
	});

	test('substituteMarkers defaults an omitted count to a single "?"', () => {
		let sql = `select * from t where a = :p`;
		let start = sql.indexOf(':p');
		let end = start + ':p'.length;
		let result = ParameterParser.substituteMarkers(sql, [{start, end}]);

		assert.strictEqual(result, `select * from t where a = ?`);
	});

	test('resolveTypesForStatement collapses a single-name IN list into one allowMultiple parameter', async () => {
		let extension = fakeExtension({
			defaultTableSchema: 'ACME',
			columns: [{systemName: 'FIELD', sqlName: 'FIELD_COL', dataType: 'CHAR', length: 10}]
		});

		let resolved = await ParameterParser.resolveTypesForStatement(extension, 'key', `select * from appuser where field in (:field)`);

		assert.strictEqual(resolved.length, 1);
		assert.strictEqual(resolved[0].allowMultiple, true);
		assert.strictEqual(resolved[0].dataType, 'CHAR');
		assert.strictEqual(resolved[0].length, 10);
	});

	test('resolveTypesForStatement collapses repeated same-name markers in one IN list, ignoring the extras', async () => {
		let extension = fakeExtension({
			defaultTableSchema: 'ACME',
			columns: [{systemName: 'FIELD', sqlName: 'FIELD_COL', dataType: 'CHAR', length: 10}]
		});

		let sql = `select * from appuser where field in (:field, :field, :field)`;
		let resolved = await ParameterParser.resolveTypesForStatement(extension, 'key', sql);

		assert.strictEqual(resolved.length, 1);
		assert.strictEqual(resolved[0].allowMultiple, true);

		// The collapsed region spans the whole list, so 3 entered chip values produce exactly 3
		// markers - not 3x the raw duplicate-token count.
		let substituted = ParameterParser.substituteMarkers(sql, [
			{start: <number>resolved[0].substitutionStart, end: <number>resolved[0].substitutionEnd, count: 3}
		]);

		assert.strictEqual(substituted, `select * from appuser where field in (?, ?, ?)`);
	});

	test('resolveTypesForStatement keeps a multi-name IN list as separate, non-multiple scalar parameters', async () => {
		let extension = fakeExtension({
			defaultTableSchema: 'ACME',
			columns: [{systemName: 'FIELD', sqlName: 'FIELD_COL', dataType: 'CHAR', length: 10}]
		});

		let resolved = await ParameterParser.resolveTypesForStatement(extension, 'key', `select * from appuser where field in (:field1, :field2)`);

		assert.strictEqual(resolved.length, 2);
		assert.deepStrictEqual(resolved.map(param => param.name), ['field1', 'field2']);
		assert.ok(!resolved[0].allowMultiple);
		assert.ok(!resolved[1].allowMultiple);
		assert.strictEqual(resolved[0].dataType, 'CHAR');
		assert.strictEqual(resolved[1].dataType, 'CHAR');
	});

	test('resolveTypesForStatement resolves numeric length/scale for a multi-value IN parameter', async () => {
		let extension = fakeExtension({
			defaultTableSchema: 'ACME',
			columns: [{systemName: 'AMT', sqlName: 'AMOUNT_COL', dataType: 'DECIMAL', length: 9, scale: 2}]
		});

		let resolved = await ParameterParser.resolveTypesForStatement(extension, 'key', `select * from appuser where amt in (:amt)`);

		assert.strictEqual(resolved.length, 1);
		assert.strictEqual(resolved[0].allowMultiple, true);
		assert.strictEqual(resolved[0].dataType, 'DECIMAL');
		assert.strictEqual(resolved[0].length, 9);
		assert.strictEqual(resolved[0].scale, 2);
	});

	test('buildCallParameters splices the resolved value into the correct position, leaving other literals untouched', () => {
		let sql = `call SPUSER004 ('RX','',:employeeCode,'0001-01-01-00.00.00.000000',27355,'','E','Workorder.Open.Assign','')`;
		let resolvedParams: ParameterParser.SqlParameter[] = [
			{key: 'employeecode|CHAR', name: 'employeeCode', label: ':employeeCode', dataType: 'CHAR'}
		];

		let result = ParameterParser.buildCallParameters(sql, resolvedParams, {'employeecode|CHAR': 'EMP123'});

		assert.deepStrictEqual(result, ['RX', '', 'EMP123', '0001-01-01-00.00.00.000000', 27355, '', 'E', 'Workorder.Open.Assign', '']);
	});

	test('buildCallParameters uses the first entry when a marker resolves to a list of values', () => {
		let resolvedParams: ParameterParser.SqlParameter[] = [{key: 'x|', name: 'x', label: ':x'}];
		let result = ParameterParser.buildCallParameters(`call proc(:x, 1)`, resolvedParams, {'x|': ['first', 'second']});

		assert.deepStrictEqual(result, ['first', 1]);
	});

	test('buildCallParameters returns an empty array for a non-CALL statement', () => {
		let result = ParameterParser.buildCallParameters(`select * from t where a = :p`, [], {});

		assert.deepStrictEqual(result, []);
	});

	// A delimited identifier is quoted text as far as the scanner is concerned, same as a literal -
	// so a colon inside one is part of the name, not a marker.
	test('findOccurrences ignores a ":" inside a delimited identifier', () => {
		let occurrences = ParameterParser.findOccurrences(`select "odd:name" from t where a = :p`);

		assert.deepStrictEqual(occurrences.map(occurrence => occurrence.name), ['p']);
	});

	// ":1" is a positional marker in some dialects but never a named one here, and DB2's own
	// qualified-name syntax puts a colon nowhere else - so a colon not followed by an identifier is
	// left alone rather than guessed at.
	test('findOccurrences ignores a colon that does not begin an identifier', () => {
		assert.deepStrictEqual(ParameterParser.findOccurrences(`select * from t where a = :1`), []);
		assert.deepStrictEqual(ParameterParser.findOccurrences(`select * from t where a = : b`), []);
	});

	// resolveTypesForStatement strips comments before it scans, which is the only reason a commented-out
	// marker doesn't reach the Parameters tab. The offsets it reports are into that stripped text, so
	// this asserts both halves at once: the comment's marker is gone, and the surviving span still lands
	// on the right token when it is substituted.
	test('resolveTypesForStatement ignores a commented-out marker and reports offsets into the stripped text', async () => {
		let extension = fakeExtension({defaultTableSchema: 'SALES', columns: CUSTOMER_COLUMNS});
		let sql = `select * from sales.customer\n-- where custnm = :oldName\nwhere custno = :custno`;

		let resolved = await ParameterParser.resolveTypesForStatement(extension, 'key', sql);

		assert.deepStrictEqual(resolved.map(param => param.name), ['custno']);

		let stripped = StatementParser.stripComments(sql);
		let substituted = ParameterParser.substituteMarkers(stripped, [{start: <number>resolved[0].substitutionStart, end: <number>resolved[0].substitutionEnd}]);

		assert.match(substituted, /where custno = \?$/);
		assert.ok(!substituted.includes(':'), 'the reported span must land on the marker itself');
	});

	// INSERT is the one case with no operator next to the marker: the only thing tying a value to a
	// column is its position in the VALUES list against the column list.
	test('resolveTypesForStatement types INSERT values by their position in the column list', async () => {
		let extension = fakeExtension({defaultTableSchema: 'SALES', columns: CUSTOMER_COLUMNS});

		let resolved = await ParameterParser.resolveTypesForStatement(
			extension,
			'key',
			`insert into sales.customer (custnm, custno) values (:name, :number)`
		);

		// Column order, not declaration order: CUSTNM is named first, so the first value is the VARCHAR.
		assert.deepStrictEqual(resolved.map(param => param.name), ['name', 'number']);
		assert.deepStrictEqual(resolved.map(param => param.dataType), ['VARCHAR', 'INTEGER']);
	});

	test('resolveTypesForStatement counts INSERT positions past literals and function calls', async () => {
		let extension = fakeExtension({defaultTableSchema: 'SALES', columns: CUSTOMER_COLUMNS});

		let resolved = await ParameterParser.resolveTypesForStatement(
			extension,
			'key',
			`insert into sales.customer (custno, orddt, custnm, ordamt) values (1, current date, upper(:name), :amount)`
		);

		// A comma inside upper(...) is not a position of its own - the third and fourth columns are what
		// these two markers must land on.
		assert.deepStrictEqual(resolved.map(param => param.dataType), ['VARCHAR', 'DECIMAL']);
		assert.strictEqual(resolved[1].scale, 2);
	});

	test('resolveTypesForStatement types both ends of a BETWEEN from its column', async () => {
		let extension = fakeExtension({defaultTableSchema: 'SALES', columns: CUSTOMER_COLUMNS});

		let resolved = await ParameterParser.resolveTypesForStatement(extension, 'key', `select * from sales.customer where orddt between :from and :to`);

		assert.deepStrictEqual(resolved.map(param => param.name), ['from', 'to']);
		assert.deepStrictEqual(resolved.map(param => param.dataType), ['DATE', 'DATE']);
	});

	// The generic case, from both sides. A marker written before its column ("where :p = custno") is
	// unusual but valid, and reads the same way to the database.
	test('resolveTypesForStatement resolves a marker on either side of a comparison, including LIKE and <>', async () => {
		let extension = fakeExtension({defaultTableSchema: 'SALES', columns: CUSTOMER_COLUMNS});

		let after = await ParameterParser.resolveTypesForStatement(extension, 'key', `select * from sales.customer where :wanted = custno`);
		assert.strictEqual(after[0]?.dataType, 'INTEGER');

		let like = await ParameterParser.resolveTypesForStatement(extension, 'key', `select * from sales.customer where custnm like :pattern`);
		assert.strictEqual(like[0]?.dataType, 'VARCHAR');

		let notEqual = await ParameterParser.resolveTypesForStatement(extension, 'key', `select * from sales.customer where ordamt <> :amount`);
		assert.strictEqual(notEqual[0]?.dataType, 'DECIMAL');
	});

	// Wrapping either side in a scalar function is how this statement would really be written for a
	// case-insensitive match, and it hides the column from a plain adjacency check.
	test('resolveTypesForStatement looks through a scalar function on either side of the operator', async () => {
		let extension = fakeExtension({defaultTableSchema: 'SALES', columns: CUSTOMER_COLUMNS});

		let resolved = await ParameterParser.resolveTypesForStatement(extension, 'key', `select * from sales.customer where upper(:name) = upper(custnm)`);

		assert.strictEqual(resolved.length, 1);
		assert.strictEqual(resolved[0].dataType, 'VARCHAR');
		assert.strictEqual(resolved[0].length, 40);
	});

	// An alias has to resolve to the table it was given in the FROM clause, not to whichever table the
	// statement happened to mention first - with two tables in play, guessing wrong still produces a
	// type, just the wrong one.
	test('resolveTypesForStatement resolves an aliased column against that alias\'s own table', async () => {
		let columnRequests: string[] = [];
		let extension = fakeExtension({
			defaultTableSchema: 'SALES',
			columnRequests: columnRequests,
			columnsByTable: {
				ORDERS: [{systemName: 'ORDNO', sqlName: 'ORDER_NUMBER', dataType: 'INTEGER', length: 4}],
				CUSTOMER: CUSTOMER_COLUMNS
			}
		});

		let resolved = await ParameterParser.resolveTypesForStatement(
			extension,
			'key',
			`select * from sales.orders o join sales.customer c on c.custno = o.custno where c.custnm = :name`
		);

		assert.strictEqual(resolved.length, 1);
		assert.strictEqual(resolved[0].dataType, 'VARCHAR');
		assert.ok(columnRequests.includes('SALES.CUSTOMER'), `expected the aliased table to be looked up, asked for: ${columnRequests.join(', ')}`);
	});

	// DB2 for i gives a column two names and hand-written SQL uses either. Matching only the short one
	// is the exact failure this file's own mock had for as long as it went unrun.
	test('resolveTypesForStatement matches a column written under its long SQL name', async () => {
		let extension = fakeExtension({defaultTableSchema: 'SALES', columns: CUSTOMER_COLUMNS});

		let resolved = await ParameterParser.resolveTypesForStatement(extension, 'key', `select * from sales.customer where customer_name = :name`);

		assert.strictEqual(resolved[0]?.dataType, 'VARCHAR');
		assert.strictEqual(resolved[0]?.length, 40);
	});

	// An unresolvable marker is still a parameter: the user has to be able to type a value for it, the
	// Parameters tab just can't offer a typed input. Its key carries the empty type, which is what keeps
	// it separate from the same name resolved elsewhere (see dedupeParameters).
	test('resolveTypesForStatement still reports a marker whose column it cannot resolve', async () => {
		let extension = fakeExtension({defaultTableSchema: 'SALES', columns: CUSTOMER_COLUMNS});

		let resolved = await ParameterParser.resolveTypesForStatement(extension, 'key', `select * from sales.customer where nosuchcolumn = :mystery`);

		assert.strictEqual(resolved.length, 1);
		assert.strictEqual(resolved[0].dataType, undefined);
		assert.strictEqual(resolved[0].key, 'mystery|');
		assert.strictEqual(resolved[0].label, ':mystery');
	});

	// A CALL binds positionally, so the marker's type comes from the procedure's declared parameter at
	// that position - and SYSPARMS reports character length and numeric precision in different columns,
	// so a numeric parameter's size only appears if precision is read as a fallback.
	test('resolveTypesForStatement types a CALL marker from the procedure parameter in that position', async () => {
		let extension = fakeExtension({
			procedureParams: [
				{position: 1, dataType: 'CHAR', length: 3},
				{position: 2, dataType: 'DECIMAL', precision: 11, scale: 2}
			]
		});

		let resolved = await ParameterParser.resolveTypesForStatement(extension, 'key', `call sales.next_order_number('ORD', :amount)`);

		assert.strictEqual(resolved.length, 1);
		assert.strictEqual(resolved[0].dataType, 'DECIMAL');
		assert.strictEqual(resolved[0].length, 11, 'a numeric parameter reports its precision as the size');
		assert.strictEqual(resolved[0].scale, 2);
	});

	// No schema is filled in, so getProcedureParams resolves the name against the library list - the
	// same procedure the CALL runs when executed.
	test('resolveTypesForStatement leaves an unqualified CALL\'s schema for the library list to resolve', async () => {
		let procedureRequests: string[] = [];
		let extension = fakeExtension({
			procedureRequests: procedureRequests,
			procedureParams: [{position: 1, dataType: 'CHAR', length: 3}]
		});

		let resolved = await ParameterParser.resolveTypesForStatement(extension, 'key', `call next_order_number(:prefix)`);

		assert.strictEqual(resolved[0]?.dataType, 'CHAR');
		assert.deepStrictEqual(procedureRequests, ['.NEXT_ORDER_NUMBER']);
	});

	// The document-wide list behind the Parameters tab: every statement in the file, flattened and
	// deduped. Run against a real editor document, since that is where the statements are split.
	test('resolveDocumentParameters flattens every statement in a document and dedupes across them', async () => {
		let extension = fakeExtension({defaultTableSchema: 'SALES', columns: CUSTOMER_COLUMNS});
		let document = await vscode.workspace.openTextDocument({
			language: 'sql',
			content: [
				'select * from sales.customer where custnm = :name;',
				'select * from sales.customer where custno = :number;',
				'select * from sales.customer where custnm in (:name);'
			].join('\n')
		});

		let resolved = await ParameterParser.resolveDocumentParameters(extension, 'key', document);

		// :name appears twice with the same resolved type, so it collapses - and the IN-list use is what
		// makes the single remaining entry multi-valued.
		assert.deepStrictEqual(resolved.map(param => param.name), ['name', 'number']);
		assert.deepStrictEqual(resolved.map(param => param.dataType), ['VARCHAR', 'INTEGER']);
		assert.strictEqual(resolved[0].allowMultiple, true);
		assert.ok(!resolved[1].allowMultiple);
	});
});
