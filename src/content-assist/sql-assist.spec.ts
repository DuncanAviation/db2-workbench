import { expect } from 'chai';
import { ConnectionConfig } from '../models/connection-config.js';
import { SystemColumn } from '../models/system-column.js';
import { SystemRelation } from '../models/system-relation.js';
import { SystemRoutine } from '../models/system-routine.js';
import { SystemSchema } from '../models/system-schema.js';
import { SystemTable } from '../models/system-table.js';
import { SqlParser } from '../utils/sql-parser.js';
import { DbAssist } from './db-assist.js';
import { SqlAssist } from './sql-assist.js';

function column(overrides: Partial<SystemColumn> = {}): SystemColumn {
	return {
		schema: 'MYSCHEMA',
		tableName: 'MYTABLE',
		colNo: 1,
		systemName: 'COL1',
		sqlName: 'COL1',
		heading: '',
		text: '',
		dataType: 'VARCHAR',
		nulls: 'Y',
		identity: 'NO',
		generated: '',
		cycle: 'NO',
		hasDefault: 'N',
		hidden: 'N',
		updatable: 'YES',
		...overrides
	};
}

function schema(name: string, description = ''): SystemSchema {
	return {name: name, type: 'SCHEMA', description: description};
}

function table(overrides: Partial<SystemTable> = {}): SystemTable {
	return <SystemTable>{schema: 'MYSCHEMA', name: 'MYTABLE', description: '', ...overrides};
}

function routine(overrides: Partial<SystemRoutine> = {}): SystemRoutine {
	return {
		schema: 'MYSCHEMA', name: 'MYFUNC', specificName: overrides.name ?? 'MYFUNC', sqlSchema: 'MYSCHEMA', routineType: 'FUNCTION', functionType: 'S',
		functionOrigin: 'Q', body: 'SQL', language: 'SQL', description: '', parameterCount: 0,
		...overrides
	};
}

function connectionConfig(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
	return {id: '1', name: 'conn', host: 'host', userName: 'user', defaultTableSchema: 'MYSCHEMA', ...overrides};
}

function caretAtEndOf(sqlUpToCursor: string) {
	let lines = sqlUpToCursor.split('\n');
	return {lineNumber: lines.length, column: lines[lines.length - 1].length + 1};
}

// Real MemoryCache methods narrow by schema when one is given, and return everything otherwise --
// these fakes replicate just that narrowing (not the caching/DB-loading behind it) so getItems'
// schema-resolution logic (dot-qualified vs. table's own declared schema vs. connection default vs.
// "nothing narrows it down") can be exercised meaningfully end-to-end, the same way a real
// MemoryCache would behave.
function fakeExtension(options: {
	schemas?: SystemSchema[];
	tables?: SystemTable[];
	views?: SystemTable[];
	columnsByTable?: Record<string, SystemColumn[]>;
	functions?: SystemRoutine[];
	connectionConfig?: ConnectionConfig;
} = {}) {
	let inSchema = (listOptions: {schema?: string}) => (candidate: SystemTable) => !listOptions.schema || candidate.schema.toLowerCase() === listOptions.schema.toLowerCase();

	return {
		memoryCache: {
			getSchemas: async () => options.schemas ?? [],
			getTables: async (listOptions: {schema?: string}) => (options.tables ?? []).filter(inSchema(listOptions)),
			getRelations: async (listOptions: {schema?: string}): Promise<SystemRelation[]> => [
				...(options.tables ?? []).filter(inSchema(listOptions)).map(t => ({schema: t.schema, name: t.name, description: t.description, kind: <const>'table'})),
				...(options.views ?? []).filter(inSchema(listOptions)).map(v => ({schema: v.schema, name: v.name, description: v.description, kind: <const>'view'}))
			],
			getFunctions: async (listOptions: {schema?: string}) => (options.functions ?? [])
				.filter(fn => !listOptions.schema || fn.schema.toLowerCase() === listOptions.schema.toLowerCase()),
			// Mirrors MemoryCache's `tables: TableTarget[] | TableTarget` shape, including returning every
			// requested table's columns in one flat list.
			getColumns: async (listOptions: {tables: Array<{schema?: string; table: string}> | {schema?: string; table: string}}) => {
				let targets = Array.isArray(listOptions.tables) ? listOptions.tables : [listOptions.tables];

				return targets.flatMap(target => {
					let columns = (options.columnsByTable ?? {})[target.table.toLowerCase()] ?? [];
					return target.schema ? columns.filter(c => c.schema.toLowerCase() === (<string>target.schema).toLowerCase()) : columns;
				});
			}
		},
		connections: {
			getConnectionConfig: async () => options.connectionConfig
		},
		configurations: {
			useAlias: 'Smart'
		}
	} as unknown as import('../extension.js').Extension;
}

describe('SqlAssist', () => {
	describe('isTableContext', () => {
		it('is true right after FROM', () => {
			expect(SqlAssist.isTableContext('SELECT id FROM ', 'FROM')).to.equal(true);
		});

		it('is true right after a compound keyword like LEFT JOIN, matched on its trailing word', () => {
			expect(SqlAssist.isTableContext('SELECT id FROM a LEFT JOIN ', 'LEFT JOIN')).to.equal(true);
		});

		it('is false when there is no keyword at all', () => {
			expect(SqlAssist.isTableContext('employees', undefined)).to.equal(false);
		});

		it('is false for a non-table keyword like WHERE', () => {
			expect(SqlAssist.isTableContext('SELECT id FROM t WHERE ', 'WHERE')).to.equal(false);
		});

		it('is false once inside an INSERT INTO column list, even though INTO is otherwise a table keyword', () => {
			expect(SqlAssist.isTableContext('INSERT INTO mytable (col1, ', 'INTO')).to.equal(false);
		});

		it('is true right after INSERT INTO, before the column list opens', () => {
			expect(SqlAssist.isTableContext('INSERT INTO ', 'INTO')).to.equal(true);
		});
	});

	describe('isColumnContext', () => {
		it('is true right after SELECT', () => {
			expect(SqlAssist.isColumnContext('SELECT ', 'SELECT')).to.equal(true);
		});

		it('is true right after WHERE', () => {
			expect(SqlAssist.isColumnContext('SELECT id FROM t WHERE ', 'WHERE')).to.equal(true);
		});

		it('is false for a table keyword like FROM', () => {
			expect(SqlAssist.isColumnContext('SELECT id FROM ', 'FROM')).to.equal(false);
		});

		it('is false when there is no keyword at all', () => {
			expect(SqlAssist.isColumnContext('employees', undefined)).to.equal(false);
		});

		it('is true once inside an INSERT INTO column list', () => {
			expect(SqlAssist.isColumnContext('INSERT INTO mytable (col1, ', 'INTO')).to.equal(true);
		});
	});

	describe('isOrderByContext', () => {
		it('is true right after ORDER BY', () => {
			expect(SqlAssist.isOrderByContext('SELECT id FROM t ORDER BY ', 'ORDER BY')).to.equal(true);
		});

		it('is case-insensitive', () => {
			expect(SqlAssist.isOrderByContext('select id from t order by ', 'order by')).to.equal(true);
		});

		it('matches even when the keyword wraps across a line break', () => {
			expect(SqlAssist.isOrderByContext('SELECT id FROM t ORDER\nBY ', 'ORDER\nBY')).to.equal(true);
		});

		it('is false for a different column keyword like WHERE', () => {
			expect(SqlAssist.isOrderByContext('SELECT id FROM t WHERE ', 'WHERE')).to.equal(false);
		});

		it('is false when there is no keyword at all', () => {
			expect(SqlAssist.isOrderByContext('employees', undefined)).to.equal(false);
		});
	});

	describe('isGroupByContext', () => {
		it('is true right after GROUP BY', () => {
			expect(SqlAssist.isGroupByContext('SELECT dept_id FROM t GROUP BY ', 'GROUP BY')).to.equal(true);
		});

		it('is case-insensitive', () => {
			expect(SqlAssist.isGroupByContext('select dept_id from t group by ', 'group by')).to.equal(true);
		});

		it('matches even when the keyword wraps across a line break', () => {
			expect(SqlAssist.isGroupByContext('SELECT dept_id FROM t GROUP\nBY ', 'GROUP\nBY')).to.equal(true);
		});

		it('is false for a different column keyword like WHERE', () => {
			expect(SqlAssist.isGroupByContext('SELECT id FROM t WHERE ', 'WHERE')).to.equal(false);
		});

		it('is false when there is no keyword at all', () => {
			expect(SqlAssist.isGroupByContext('employees', undefined)).to.equal(false);
		});
	});

	describe('getGroupableSelectItems', () => {
		it('classifies a bare column and an alias-qualified column', () => {
			let items = SqlAssist.getGroupableSelectItems('SELECT dept_id, e.name FROM employees e GROUP BY ');
			expect(items).to.deep.equal([
				{type: 'column', qualifier: undefined, columnName: 'dept_id'},
				{type: 'column', qualifier: 'e', columnName: 'name'}
			]);
		});

		it('excludes an aggregate call entirely', () => {
			let items = SqlAssist.getGroupableSelectItems('SELECT dept_id, SUM(amount) FROM employees GROUP BY ');
			expect(items).to.deep.equal([{type: 'column', qualifier: undefined, columnName: 'dept_id'}]);
		});

		it('is case-insensitive when detecting an aggregate call', () => {
			let items = SqlAssist.getGroupableSelectItems('select dept_id, sum(amount) from employees group by ');
			expect(items).to.deep.equal([{type: 'column', qualifier: undefined, columnName: 'dept_id'}]);
		});

		it('keeps a non-aggregate function call as a verbatim expression, with its output alias stripped', () => {
			let items = SqlAssist.getGroupableSelectItems('SELECT UPPER(name) AS upper_name FROM employees GROUP BY ');
			expect(items).to.deep.equal([{type: 'expression', text: 'UPPER(name)'}]);
		});

		it('strips an explicit "AS alias" down to the underlying column reference', () => {
			let items = SqlAssist.getGroupableSelectItems('SELECT dept_id AS d FROM employees GROUP BY ');
			expect(items).to.deep.equal([{type: 'column', qualifier: undefined, columnName: 'dept_id'}]);
		});

		it('strips an implicit (no AS) alias down to the underlying column reference', () => {
			let items = SqlAssist.getGroupableSelectItems('SELECT dept_id d FROM employees GROUP BY ');
			expect(items).to.deep.equal([{type: 'column', qualifier: undefined, columnName: 'dept_id'}]);
		});

		it('does not mistake a trailing reserved word (e.g. NULL) for an alias', () => {
			let items = SqlAssist.getGroupableSelectItems('SELECT amount IS NOT NULL FROM employees GROUP BY ');
			expect(items).to.deep.equal([{type: 'expression', text: 'amount IS NOT NULL'}]);
		});

		it('takes only the last qualifier segment of a three-part schema.table.column reference', () => {
			let items = SqlAssist.getGroupableSelectItems('SELECT myschema.employees.dept_id FROM myschema.employees GROUP BY ');
			expect(items).to.deep.equal([{type: 'column', qualifier: 'employees', columnName: 'dept_id'}]);
		});

		it('strips a leading DISTINCT before parsing the select list', () => {
			let items = SqlAssist.getGroupableSelectItems('SELECT DISTINCT dept_id FROM employees GROUP BY ');
			expect(items).to.deep.equal([{type: 'column', qualifier: undefined, columnName: 'dept_id'}]);
		});

		it('only looks at the outer statement\'s own select list, never a CTE\'s', () => {
			let items = SqlAssist.getGroupableSelectItems('WITH data AS (SELECT x, SUM(y) FROM t) SELECT dept_id FROM employees GROUP BY ');
			expect(items).to.deep.equal([{type: 'column', qualifier: undefined, columnName: 'dept_id'}]);
		});

		it('returns undefined when the select list contains a bare wildcard', () => {
			expect(SqlAssist.getGroupableSelectItems('SELECT * FROM employees GROUP BY ')).to.equal(undefined);
		});

		it('returns undefined when the select list contains an alias-qualified wildcard', () => {
			expect(SqlAssist.getGroupableSelectItems('SELECT e.* FROM employees e GROUP BY ')).to.equal(undefined);
		});

		it('returns undefined when there is no top-level SELECT at all', () => {
			expect(SqlAssist.getGroupableSelectItems('FROM employees GROUP BY ')).to.equal(undefined);
		});

		it('returns undefined when FROM has not been typed yet', () => {
			expect(SqlAssist.getGroupableSelectItems('SELECT dept_id ')).to.equal(undefined);
		});
	});

	describe('isInsertColumnListContext', () => {
		it('is false when there is no keyword at all', () => {
			expect(SqlAssist.isInsertColumnListContext('mytable (', undefined)).to.equal(false);
		});

		it('is false when the last keyword is not INTO', () => {
			expect(SqlAssist.isInsertColumnListContext('SELECT (a, ', 'SELECT')).to.equal(false);
		});

		it('is false right after INTO, before the column list opens', () => {
			expect(SqlAssist.isInsertColumnListContext('INSERT INTO mytable ', 'INTO')).to.equal(false);
		});

		it('is true once the column list has been opened', () => {
			expect(SqlAssist.isInsertColumnListContext('INSERT INTO mytable (col1, ', 'INTO')).to.equal(true);
		});

		it('is false once the column list has been closed', () => {
			expect(SqlAssist.isInsertColumnListContext('INSERT INTO mytable (col1, col2) ', 'INTO')).to.equal(false);
		});

		it('is case-insensitive for the INTO keyword', () => {
			expect(SqlAssist.isInsertColumnListContext('insert into mytable (col1, ', 'into')).to.equal(true);
		});
	});

	describe('isValueContext', () => {
		it('is true once inside an INSERT VALUES list', () => {
			expect(SqlAssist.isValueContext('INSERT INTO t VALUES (1, ', 'VALUES')).to.equal(true);
		});

		it('is true right after a column assignment', () => {
			expect(SqlAssist.isValueContext('UPDATE t SET x = ', 'SET')).to.equal(true);
		});

		it('is false in a column context with no assignment present', () => {
			expect(SqlAssist.isValueContext('SELECT ', 'SELECT')).to.equal(false);
		});

		it('is false in a table context', () => {
			expect(SqlAssist.isValueContext('SELECT id FROM ', 'FROM')).to.equal(false);
		});
	});

	describe('isInsertValueListContext', () => {
		it('is false when the last keyword is not VALUES', () => {
			expect(SqlAssist.isInsertValueListContext('INSERT INTO t (a, ', 'INTO')).to.equal(false);
		});

		it('is false right after VALUES, before the list opens', () => {
			expect(SqlAssist.isInsertValueListContext('INSERT INTO t VALUES ', 'VALUES')).to.equal(false);
		});

		it('is true once the values list has been opened', () => {
			expect(SqlAssist.isInsertValueListContext('INSERT INTO t VALUES (1, ', 'VALUES')).to.equal(true);
		});

		it('is false once the values list has been closed', () => {
			expect(SqlAssist.isInsertValueListContext('INSERT INTO t VALUES (1, 2) ', 'VALUES')).to.equal(false);
		});
	});

	describe('hasSuppliedValues', () => {
		it('is false with an empty values list', () => {
			expect(SqlAssist.hasSuppliedValues('INSERT INTO t VALUES (')).to.equal(false);
		});

		it('is false with only whitespace in the values list', () => {
			expect(SqlAssist.hasSuppliedValues('INSERT INTO t VALUES (   ')).to.equal(false);
		});

		it('is true once anything is typed inside the values list', () => {
			expect(SqlAssist.hasSuppliedValues('INSERT INTO t VALUES (1')).to.equal(true);
		});

		it('is true partway through a multi-value list', () => {
			expect(SqlAssist.hasSuppliedValues('INSERT INTO t VALUES (1, 2, ')).to.equal(true);
		});

		it('is false when there is no open parenthesis at all', () => {
			expect(SqlAssist.hasSuppliedValues('INSERT INTO t')).to.equal(false);
		});
	});

	describe('getAssignmentReferenceText', () => {
		it('captures a bare column reference before "="', () => {
			expect(SqlAssist.getAssignmentReferenceText('WHERE id = ')).to.equal('id');
		});

		it('captures an alias-qualified column reference', () => {
			expect(SqlAssist.getAssignmentReferenceText('SET e.name = ')).to.equal('e.name');
		});

		it('captures a schema.table.column-qualified reference', () => {
			expect(SqlAssist.getAssignmentReferenceText('WHERE myschema.mytable.id = ')).to.equal('myschema.mytable.id');
		});

		it('does not mistake "<=" for a plain assignment', () => {
			expect(SqlAssist.getAssignmentReferenceText('WHERE id <= ')).to.equal(undefined);
		});

		it('does not mistake ">=" for a plain assignment', () => {
			expect(SqlAssist.getAssignmentReferenceText('WHERE id >= ')).to.equal(undefined);
		});

		it('does not mistake "!=" for a plain assignment', () => {
			expect(SqlAssist.getAssignmentReferenceText('WHERE id != ')).to.equal(undefined);
		});

		it('does not mistake "<>" for a plain assignment', () => {
			expect(SqlAssist.getAssignmentReferenceText('WHERE id <> ')).to.equal(undefined);
		});

		it('returns undefined when there is no assignment at all', () => {
			expect(SqlAssist.getAssignmentReferenceText('SELECT id FROM t')).to.equal(undefined);
		});
	});

	describe('getInsertTableReferenceText', () => {
		it('captures a plain table name', () => {
			expect(SqlAssist.getInsertTableReferenceText('INSERT INTO mytable (col1)')).to.equal('mytable');
		});

		it('captures a schema-qualified table name', () => {
			expect(SqlAssist.getInsertTableReferenceText('INSERT INTO myschema.mytable (col1)')).to.equal('myschema.mytable');
		});

		it('captures the table name even with nothing typed after it yet', () => {
			expect(SqlAssist.getInsertTableReferenceText('INSERT INTO mytable')).to.equal('mytable');
		});

		it('returns undefined when there is no INSERT INTO at all', () => {
			expect(SqlAssist.getInsertTableReferenceText('SELECT id FROM t')).to.equal(undefined);
		});
	});

	describe('resolveTable', () => {
		let tables: SqlParser.TableReference[] = [
			{table: 'employees', alias: 'e'},
			{table: 'departments', alias: 'd', schema: 'myschema'}
		];

		it('resolves by table name', () => {
			expect(SqlAssist.resolveTable(tables, 'employees')).to.deep.equal({table: 'employees', alias: 'e'});
		});

		it('resolves by alias', () => {
			expect(SqlAssist.resolveTable(tables, 'd')).to.deep.equal({table: 'departments', alias: 'd', schema: 'myschema'});
		});

		it('is case-insensitive', () => {
			expect(SqlAssist.resolveTable(tables, 'EMPLOYEES')).to.deep.equal({table: 'employees', alias: 'e'});
		});

		it('falls back to a bare table reference when nothing matches', () => {
			expect(SqlAssist.resolveTable(tables, 'unknown')).to.deep.equal({table: 'unknown'});
		});

		it('falls back to a bare table reference when tables is undefined', () => {
			expect(SqlAssist.resolveTable(undefined, 'unknown')).to.deep.equal({table: 'unknown'});
		});
	});

	describe('getOrderedInsertColumns', () => {
		let columns = [column({systemName: 'ID'}), column({systemName: 'NAME'}), column({systemName: 'DEPT_ID'})];

		it('returns the columns as-is when there is no explicit column list', () => {
			let parseResults = SqlParser.parse('INSERT INTO mytable VALUES (1, 2, 3)');
			expect(SqlAssist.getOrderedInsertColumns(parseResults, columns)).to.deep.equal(columns);
		});

		it('reorders columns to match an explicit column list', () => {
			let parseResults = SqlParser.parse('INSERT INTO mytable (NAME, ID) VALUES (1, 2)');
			let ordered = SqlAssist.getOrderedInsertColumns(parseResults, columns);
			expect(ordered.map(c => c.systemName)).to.deep.equal(['NAME', 'ID']);
		});

		it('filters out any explicitly-listed column that has no matching SystemColumn', () => {
			let parseResults = SqlParser.parse('INSERT INTO mytable (NAME, BOGUS, ID) VALUES (1, 2, 3)');
			let ordered = SqlAssist.getOrderedInsertColumns(parseResults, columns);
			expect(ordered.map(c => c.systemName)).to.deep.equal(['NAME', 'ID']);
		});

		it('matches column names case-insensitively', () => {
			let parseResults = SqlParser.parse('INSERT INTO mytable (name) VALUES (1)');
			let ordered = SqlAssist.getOrderedInsertColumns(parseResults, columns);
			expect(ordered.map(c => c.systemName)).to.deep.equal(['NAME']);
		});
	});

	describe('getValueDescriptor', () => {
		it('formats a character column\'s default as an empty string literal', () => {
			let descriptor = SqlAssist.getValueDescriptor(column({schema: 'MYSCHEMA', tableName: 'MYTABLE', systemName: 'NAME', dataType: 'VARCHAR'}));
			expect(descriptor).to.deep.equal({
				label: '\'\' (default for NAME)',
				insertText: '\'\'',
				detail: 'myschema.mytable.name (varchar)'
			});
		});

		it('formats a numeric column\'s default as 0', () => {
			let descriptor = SqlAssist.getValueDescriptor(column({systemName: 'AMOUNT', dataType: 'DECIMAL'}));
			expect(descriptor.insertText).to.equal('0');
			expect(descriptor.label).to.equal('0 (default for AMOUNT)');
		});

		it('formats a date column\'s default as the low-value date literal', () => {
			let descriptor = SqlAssist.getValueDescriptor(column({systemName: 'CREATED_ON', dataType: 'DATE'}));
			expect(descriptor.insertText).to.equal('\'0001-01-01\'');
		});

		it('lowercases the schema/table/name/dataType in the detail regardless of input casing', () => {
			let descriptor = SqlAssist.getValueDescriptor(column({schema: 'MYSCHEMA', tableName: 'MYTABLE', systemName: 'COL1', dataType: 'VARCHAR'}));
			expect(descriptor.detail).to.equal('myschema.mytable.col1 (varchar)');
		});
	});

	describe('getBulkValueDescriptor', () => {
		it('joins every column\'s default value in order', () => {
			let columns = [
				column({systemName: 'C1', dataType: 'VARCHAR'}),
				column({systemName: 'C2', dataType: 'DECIMAL'}),
				column({systemName: 'C3', dataType: 'DATE'})
			];
			let descriptor = SqlAssist.getBulkValueDescriptor({table: 'mytable'}, columns);
			expect(descriptor.insertText).to.equal('\'\', 0, \'0001-01-01\'');
			expect(descriptor.label).to.equal('[Default values for mytable]');
		});

		it('handles a single-column table', () => {
			let descriptor = SqlAssist.getBulkValueDescriptor({table: 'mytable'}, [column({dataType: 'DECIMAL'})]);
			expect(descriptor.insertText).to.equal('0');
		});
	});

	describe('getItems', () => {
		function items(sql: string, fullSql: string, extension: ReturnType<typeof fakeExtension>) {
			let parseResults = SqlParser.parse(fullSql);
			return new SqlAssist(extension).getItems('k', sql, caretAtEndOf(sql), parseResults);
		}

		it('falls back to keyword completions when no context is recognized at all', async () => {
			let results = await items('', '', fakeExtension());
			expect(results.map(i => i.label)).to.deep.equal(SqlParser.KEY_WORDS);
			expect(results.every(i => i.kind === 'Keyword')).to.equal(true);
		});

		describe('table context', () => {
			it('offers schema items plus table items when nothing is typed after FROM', async () => {
				let extension = fakeExtension({
					schemas: [schema('MYSCHEMA')],
					tables: [table({schema: 'MYSCHEMA', name: 'EMPLOYEES'})]
				});
				let sql = 'SELECT id FROM ';
				expect(await items(sql, sql, extension)).to.deep.equal([
					{label: 'MYSCHEMA', insertText: 'MYSCHEMA', kind: 'Module', sortText: DbAssist.ItemSortOrder.SCHEMAS},
					{label: 'EMPLOYEES', insertText: 'EMPLOYEES', detail: 'myschema', kind: 'Class', sortText: DbAssist.ItemSortOrder.TABLES}
				]);
			});

			it('offers only that schema\'s tables once a schema has been typed, with no schema items', async () => {
				let extension = fakeExtension({
					schemas: [schema('MYSCHEMA')],
					tables: [table({schema: 'MYSCHEMA', name: 'EMPLOYEES'}), table({schema: 'OTHER', name: 'OTHERTABLE'})]
				});
				let sql = 'SELECT id FROM myschema.';
				expect(await items(sql, sql, extension)).to.deep.equal([
					{label: 'EMPLOYEES', insertText: 'EMPLOYEES', detail: 'myschema', kind: 'Class', sortText: DbAssist.ItemSortOrder.TABLES}
				]);
			});

			it('offers a schema\'s views after its tables, marked as views in the detail', async () => {
				// Regression: only SYSTABLES types T/P were offered, so "from qsys2." never listed SYSTABLES
				// itself, which is a view.
				let extension = fakeExtension({
					schemas: [schema('QSYS2')],
					tables: [table({schema: 'QSYS2', name: 'SYSPARMS'})],
					views: [table({schema: 'QSYS2', name: 'SYSTABLES', description: 'Catalog tables'})]
				});
				let sql = 'SELECT * FROM qsys2.';
				expect(await items(sql, sql, extension)).to.deep.equal([
					{label: 'SYSPARMS', insertText: 'SYSPARMS', detail: 'qsys2', kind: 'Class', sortText: DbAssist.ItemSortOrder.TABLES},
					{label: 'SYSTABLES (Catalog tables)', insertText: 'SYSTABLES', detail: 'qsys2 (view)', kind: 'Class', sortText: DbAssist.ItemSortOrder.TABLES}
				]);
			});

			it('offers table functions after the tables, wrapped in the TABLE(...) a FROM clause needs', async () => {
				let extension = fakeExtension({
					schemas: [schema('MYSCHEMA')],
					tables: [table({schema: 'MYSCHEMA', name: 'EMPLOYEES'})],
					functions: [routine({name: 'OPEN_ORDERS', functionType: 'T'}), routine({name: 'ORDER_TOTAL'})]
				});
				let sql = 'SELECT * FROM myschema.';
				expect(await items(sql, sql, extension)).to.deep.equal([
					{label: 'EMPLOYEES', insertText: 'EMPLOYEES', detail: 'myschema', kind: 'Class', sortText: DbAssist.ItemSortOrder.TABLES},
					{label: 'OPEN_ORDERS', insertText: 'TABLE(OPEN_ORDERS(', detail: 'myschema (table function)', kind: 'Function', sortText: DbAssist.ItemSortOrder.FUNCTIONS}
				]);
			});

			it('lists the CTE\'s name first, ahead of schema and table items, when the statement has a WITH clause', async () => {
				let extension = fakeExtension({
					schemas: [schema('MYSCHEMA')],
					tables: [table({schema: 'MYSCHEMA', name: 'EMPLOYEES'})]
				});
				let sql = 'WITH data AS (SELECT id FROM employees) SELECT id FROM ';
				expect(await items(sql, sql, extension)).to.deep.equal([
					{label: 'data (CTE)', insertText: 'data', detail: 'cte', kind: 'Class', sortText: DbAssist.ItemSortOrder.CTES},
					{label: 'MYSCHEMA', insertText: 'MYSCHEMA', kind: 'Module', sortText: DbAssist.ItemSortOrder.SCHEMAS},
					{label: 'EMPLOYEES', insertText: 'EMPLOYEES', detail: 'myschema', kind: 'Class', sortText: DbAssist.ItemSortOrder.TABLES}
				]);
			});

			it('lists every CTE in a multi-CTE WITH clause, in declaration order', async () => {
				let extension = fakeExtension();
				let sql = 'with a as (select id from t1), b as (select id from t2) select id from ';
				expect(await items(sql, sql, extension)).to.deep.equal([
					{label: 'a (CTE)', insertText: 'a', detail: 'cte', kind: 'Class', sortText: DbAssist.ItemSortOrder.CTES},
					{label: 'b (CTE)', insertText: 'b', detail: 'cte', kind: 'Class', sortText: DbAssist.ItemSortOrder.CTES}
				]);
			});

			it('offers no CTE item once a schema has been typed - a CTE is never schema-qualified', async () => {
				let extension = fakeExtension({
					schemas: [schema('MYSCHEMA')],
					tables: [table({schema: 'MYSCHEMA', name: 'EMPLOYEES'})]
				});
				let sql = 'WITH data AS (SELECT id FROM employees) SELECT id FROM myschema.';
				expect(await items(sql, sql, extension)).to.deep.equal([
					{label: 'EMPLOYEES', insertText: 'EMPLOYEES', detail: 'myschema', kind: 'Class', sortText: DbAssist.ItemSortOrder.TABLES}
				]);
			});
		});

		describe('column context', () => {
			it('offers custom bulk+wildcard items and plain column items for a single unaliased table after SELECT', async () => {
				let extension = fakeExtension({
					columnsByTable: {employees: [column({systemName: 'ID', tableName: 'EMPLOYEES'}), column({systemName: 'NAME', tableName: 'EMPLOYEES'})]}
				});
				let sql = 'SELECT ';
				let fullSql = sql + 'FROM employees';
				expect(await items(sql, fullSql, extension)).to.deep.equal([
					{label: '[All from employees]', insertText: 'ID, NAME', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.CUSTOM},
					{label: 'employees.*', insertText: '*', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.CUSTOM},
					{label: 'ID', insertText: 'ID', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS},
					{label: 'NAME', insertText: 'NAME', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS}
				]);
			});

			it('offers scalar and aggregate functions after the columns, leaving table functions to FROM', async () => {
				let extension = fakeExtension({
					columnsByTable: {employees: [column({systemName: 'ID', tableName: 'EMPLOYEES'})]},
					functions: [
						routine({schema: 'MYSCHEMA', name: 'ORDER_TOTAL', description: 'Order value'}),
						routine({schema: 'OTHER', name: 'MEDIAN', functionType: 'C'}),
						routine({schema: 'MYSCHEMA', name: 'OPEN_ORDERS', functionType: 'T'})
					]
				});
				let sql = 'SELECT ';
				let fullSql = sql + 'FROM employees';
				let results = await items(sql, fullSql, extension);
				expect(results.filter(item => item.kind === 'Function')).to.deep.equal([
					{label: 'ORDER_TOTAL (Order value)', insertText: 'ORDER_TOTAL(', detail: 'myschema (function)', kind: 'Function', sortText: DbAssist.ItemSortOrder.FUNCTIONS},
					{label: 'MEDIAN', insertText: 'MEDIAN(', detail: 'other (function)', kind: 'Function', sortText: DbAssist.ItemSortOrder.FUNCTIONS}
				]);
				expect(results.findIndex(item => item.kind === 'Function')).to.be.greaterThan(results.findIndex(item => item.label === 'ID'));
			});

			// The call is the same whichever overload DB2 picks, so one item stands for all of them.
			it('collapses a function\'s overloads into one item that says how many there are', async () => {
				let extension = fakeExtension({
					functions: [
						routine({name: 'ORDER_TOTAL', specificName: 'ORDER_TOTAL'}),
						routine({name: 'ORDER_TOTAL', specificName: 'ORDER_TOTAL_CURRENCY', description: 'In a currency'})
					]
				});
				let sql = 'SELECT ';
				expect((await items(sql, sql, extension)).filter(item => item.kind === 'Function')).to.deep.equal([
					{label: 'ORDER_TOTAL (In a currency)', insertText: 'ORDER_TOTAL(', detail: 'myschema (function, 2 overloads)', kind: 'Function', sortText: DbAssist.ItemSortOrder.FUNCTIONS}
				]);
			});

			it('narrows functions to a schema typed at the cursor, and offers none after a table qualifier', async () => {
				let extension = fakeExtension({
					schemas: [schema('MYSCHEMA'), schema('OTHER')],
					columnsByTable: {employees: [column({systemName: 'ID', tableName: 'EMPLOYEES'})]},
					functions: [routine({schema: 'MYSCHEMA', name: 'ORDER_TOTAL'}), routine({schema: 'OTHER', name: 'MEDIAN'})]
				});

				let qualified = 'SELECT other.';
				expect((await items(qualified, qualified + ' FROM employees', extension)).filter(item => item.kind === 'Function').map(item => item.label)).to.deep.equal(['MEDIAN']);

				let aliased = 'SELECT e.';
				expect((await items(aliased, aliased + ' FROM employees e', extension)).filter(item => item.kind === 'Function')).to.deep.equal([]);
			});

			it('qualifies every item with its own table alias once more than one table is in scope', async () => {
				let extension = fakeExtension({
					columnsByTable: {
						employees: [column({systemName: 'ID', tableName: 'EMPLOYEES'})],
						departments: [column({systemName: 'NAME', tableName: 'DEPARTMENTS'})]
					}
				});
				let sql = 'SELECT ';
				let fullSql = sql + 'FROM employees e JOIN departments d ON e.dept_id = d.id';
				expect(await items(sql, fullSql, extension)).to.deep.equal([
					{label: '[All from e]', insertText: 'e.ID', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.CUSTOM},
					{label: 'e.*', insertText: 'e.*', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.CUSTOM},
					{label: 'ID', insertText: 'e.ID', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS},
					{label: '[All from d]', insertText: 'd.NAME', detail: 'myschema.departments', kind: 'Field', sortText: DbAssist.ItemSortOrder.CUSTOM},
					{label: 'd.*', insertText: 'd.*', detail: 'myschema.departments', kind: 'Field', sortText: DbAssist.ItemSortOrder.CUSTOM},
					{label: 'NAME', insertText: 'd.NAME', detail: 'myschema.departments', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS}
				]);
			});

			it('disambiguates two aliased references to the same table with distinct labels, keyed by alias', async () => {
				// The exact motivating scenario: "appuser a JOIN appuser b" -- before this fix, both
				// references produced identical, indistinguishable "[All from APPUSER]"/"APPUSER.*"
				// labels since they were keyed by the real table name, not by alias.
				let extension = fakeExtension({
					columnsByTable: {appuser: [column({systemName: 'FNAME', schema: 'MYSCHEMA', tableName: 'APPUSER'})]}
				});
				let sql = 'SELECT ';
				let fullSql = sql + 'FROM appuser a JOIN appuser b ON a.id = b.id';
				expect(await items(sql, fullSql, extension)).to.deep.equal([
					{label: '[All from a]', insertText: 'a.FNAME', detail: 'myschema.appuser', kind: 'Field', sortText: DbAssist.ItemSortOrder.CUSTOM},
					{label: 'a.*', insertText: 'a.*', detail: 'myschema.appuser', kind: 'Field', sortText: DbAssist.ItemSortOrder.CUSTOM},
					{label: 'FNAME', insertText: 'a.FNAME', detail: 'myschema.appuser', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS},
					{label: '[All from b]', insertText: 'b.FNAME', detail: 'myschema.appuser', kind: 'Field', sortText: DbAssist.ItemSortOrder.CUSTOM},
					{label: 'b.*', insertText: 'b.*', detail: 'myschema.appuser', kind: 'Field', sortText: DbAssist.ItemSortOrder.CUSTOM},
					{label: 'FNAME', insertText: 'b.FNAME', detail: 'myschema.appuser', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS}
				]);
			});

			it('resolves a dot-qualified alias reference to just that table\'s own columns, unqualified', async () => {
				let extension = fakeExtension({
					columnsByTable: {employees: [column({systemName: 'DEPT_ID', tableName: 'EMPLOYEES'})]}
				});
				let sqlUpToCursor = 'SELECT e.';
				let fullSql = sqlUpToCursor + ' FROM employees e JOIN departments d ON e.dept_id = d.id';
				expect(await items(sqlUpToCursor, fullSql, extension)).to.deep.equal([
					{label: 'e.*', insertText: '*', detail: 'e.*', kind: 'Field', sortText: DbAssist.ItemSortOrder.CUSTOM},
					{label: 'DEPT_ID', insertText: 'DEPT_ID', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS}
				]);
			});

			it('does not re-qualify with the alias again once a partial column name has been typed after it', async () => {
				// Regression: this override used to trigger on ANY non-empty text typed after the
				// dot, regardless of what it was -- which, since StatementCompletionProvider's
				// replacement range only covers the fragment after the dot, would have produced
				// "e.e.dept_id" in the document instead of "e.dept_id".
				let extension = fakeExtension({
					columnsByTable: {employees: [column({systemName: 'DEPT_ID', tableName: 'EMPLOYEES'})]}
				});
				let sqlUpToCursor = 'SELECT e.de';
				let fullSql = sqlUpToCursor + ' FROM employees e';
				expect(await items(sqlUpToCursor, fullSql, extension)).to.deep.equal([
					{label: 'e.*', insertText: '*', detail: 'e.*', kind: 'Field', sortText: DbAssist.ItemSortOrder.CUSTOM},
					{label: 'DEPT_ID', insertText: 'DEPT_ID', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS}
				]);
			});

			it('qualifies a column item once what\'s typed so far could actually be the start of the table\'s own name', async () => {
				// "emp" doesn't match the plain column label "ID" at all -- qualifying it as
				// "employees.ID" keeps the item visible/filter-matchable against what's been typed.
				let extension = fakeExtension({columnsByTable: {employees: [column({systemName: 'ID', tableName: 'EMPLOYEES'})]}});
				let sql = 'SELECT emp';
				let fullSql = sql + ' FROM employees';
				expect(await items(sql, fullSql, extension)).to.deep.equal([
					{label: '[All from employees]', insertText: 'ID', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.CUSTOM},
					{label: 'employees.*', insertText: '*', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.CUSTOM},
					{label: 'ID', insertText: 'employees.ID', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS}
				]);
			});

			it('prefers a table\'s own declared schema over the connection default when resolving its columns', async () => {
				let extension = fakeExtension({
					columnsByTable: {employees: [column({schema: 'DECLAREDSCHEMA', tableName: 'EMPLOYEES', systemName: 'ID'})]},
					connectionConfig: connectionConfig({defaultTableSchema: 'WRONGSCHEMA'})
				});
				let sqlUpToCursor = 'SELECT e.';
				let fullSql = sqlUpToCursor + ' FROM declaredschema.employees e';
				let results = await items(sqlUpToCursor, fullSql, extension);
				// If the wrong schema were used instead, the fake's schema-filtered getColumns would
				// return nothing and this column would never show up at all.
				expect(results.some(i => i.label === 'ID')).to.equal(true);
			});

			it('offers only the declared schema\'s columns when the same table name exists in another schema', async () => {
				// Regression: the declared schema used to be dropped before the column lookup, so a bare
				// name was resolved instead and could land on another schema's table of the same name.
				let extension = fakeExtension({
					columnsByTable: {employees: [
						column({schema: 'FIRSTSCHEMA', tableName: 'EMPLOYEES', systemName: 'WRONG'}),
						column({schema: 'DECLAREDSCHEMA', tableName: 'EMPLOYEES', systemName: 'RIGHT'})
					]}
				});
				let sqlUpToCursor = 'SELECT e.';
				let fullSql = sqlUpToCursor + ' FROM declaredschema.employees e';
				let labels = (await items(sqlUpToCursor, fullSql, extension)).map(i => i.label);
				expect(labels).to.include('RIGHT');
				expect(labels).to.not.include('WRONG');
			});

			it('does not pin an unqualified table to the connection default schema', async () => {
				// A bare name resolves through the library list, not defaultTableSchema - a table that only
				// lives in another library-list schema must still get its columns.
				let extension = fakeExtension({
					columnsByTable: {employees: [column({schema: 'LIBLISTSCHEMA', tableName: 'EMPLOYEES', systemName: 'ID'})]},
					connectionConfig: connectionConfig({defaultTableSchema: 'DEFAULTSCHEMA'})
				});
				let sqlUpToCursor = 'SELECT e.';
				let fullSql = sqlUpToCursor + ' FROM employees e';
				expect((await items(sqlUpToCursor, fullSql, extension)).map(i => i.label)).to.include('ID');
			});

			it('resolves a CTE\'s own exposed columns instead of hitting real table metadata', async () => {
				let extension = fakeExtension();
				let sqlUpToCursor = 'with data as (select id, name from employees) select ';
				let fullSql = sqlUpToCursor + 'from data';
				expect(await items(sqlUpToCursor, fullSql, extension)).to.deep.equal([
					{label: 'id', insertText: 'id', detail: 'data (cte)', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS},
					{label: 'name', insertText: 'name', detail: 'data (cte)', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS}
				]);
			});

			it('shows an explicitly-named CTE column\'s heading, traced back to the real column it came from, the same as a wildcard passthrough would', async () => {
				// Regression: an explicitly-named column ("select hstdns from apphost", not "select *")
				// used to expose no heading at all, even though the wildcard case already resolved one by
				// recursing into the real table's own metadata.
				let extension = fakeExtension({
					columnsByTable: {apphost: [column({systemName: 'HSTDNS', tableName: 'APPHOST', heading: 'Host DNS Name'})]}
				});
				let sqlUpToCursor = 'with data as (select hstdns from apphost) select ';
				let fullSql = sqlUpToCursor + 'from data';
				expect(await items(sqlUpToCursor, fullSql, extension)).to.deep.equal([
					{label: 'hstdns (Host DNS Name)', insertText: 'hstdns', detail: 'data (cte)', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS}
				]);
			});

			it('resolves a derived table\'s own exposed columns instead of hitting real table metadata', async () => {
				let extension = fakeExtension();
				let sqlUpToCursor = 'select ';
				let fullSql = sqlUpToCursor + 'from (select a from t1) x';
				expect(await items(sqlUpToCursor, fullSql, extension)).to.deep.equal([
					{label: 'a', insertText: 'a', detail: 'x (cte)', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS}
				]);
			});

			it('does not leak an unrelated, unused CTE\'s own table into the results just because an outer JOIN aliases the same table name', async () => {
				// Regression: "data2"'s own "apphost" (never referenced outside its own
				// body) used to show up unaliased alongside "data" and "b" purely because the OUTER
				// "join apphost b" gave that table name an accessible occurrence elsewhere.
				let extension = fakeExtension({
					columnsByTable: {apphost: [column({systemName: 'HOST_NAME', schema: 'MYSCHEMA', tableName: 'APPHOST'})]}
				});
				let sqlUpToCursor = 'with data as (\nselect fnam\nfrom appuser\nlimit 1000\n),\n\ndata2 as (\n\tselect *\n\tfrom apphost\n)\n\nselect ';
				let fullSql = sqlUpToCursor + 'from data\njoin apphost b';
				expect(await items(sqlUpToCursor, fullSql, extension)).to.deep.equal([
					// No heading resolves here (the fake's columnsByTable has no "appuser" entry, so
					// the "fnam" -> appuser lookup comes back empty) -- label falls back to the bare
					// unqualified name, same fallback shape buildColumnItems uses for a real column
					// with no heading, even though insertText stays qualified.
					{label: 'fnam', insertText: 'data.fnam', detail: 'data (cte)', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS},
					{label: '[All from b]', insertText: 'b.HOST_NAME', detail: 'myschema.apphost', kind: 'Field', sortText: DbAssist.ItemSortOrder.CUSTOM},
					{label: 'b.*', insertText: 'b.*', detail: 'myschema.apphost', kind: 'Field', sortText: DbAssist.ItemSortOrder.CUSTOM},
					{label: 'HOST_NAME', insertText: 'b.HOST_NAME', detail: 'myschema.apphost', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS}
				]);
			});
		});

		describe('order by context', () => {
			it('offers only real columns after ORDER BY, never "*" or "[All from ...]", for a single unaliased table', async () => {
				let extension = fakeExtension({
					columnsByTable: {employees: [column({systemName: 'ID', tableName: 'EMPLOYEES'}), column({systemName: 'NAME', tableName: 'EMPLOYEES'})]}
				});
				let sql = 'SELECT id, name FROM employees ORDER BY ';
				expect(await items(sql, sql, extension)).to.deep.equal([
					{label: 'ID', insertText: 'ID', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS},
					{label: 'NAME', insertText: 'NAME', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS}
				]);
			});

			it('qualifies columns by alias once more than one table is in scope, still with no wildcard items', async () => {
				let extension = fakeExtension({
					columnsByTable: {
						employees: [column({systemName: 'ID', tableName: 'EMPLOYEES'})],
						departments: [column({systemName: 'NAME', tableName: 'DEPARTMENTS'})]
					}
				});
				let sql = 'SELECT * FROM employees e JOIN departments d ON e.dept_id = d.id ORDER BY ';
				expect(await items(sql, sql, extension)).to.deep.equal([
					{label: 'ID', insertText: 'e.ID', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS},
					{label: 'NAME', insertText: 'd.NAME', detail: 'myschema.departments', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS}
				]);
			});

			it('does not offer the alias wildcard once a dot has been typed after ORDER BY, unlike the same reference in a SELECT/WHERE clause', async () => {
				let extension = fakeExtension({
					columnsByTable: {employees: [column({systemName: 'DEPT_ID', tableName: 'EMPLOYEES'})]}
				});
				let sql = 'SELECT id FROM employees e ORDER BY e.';
				expect(await items(sql, sql, extension)).to.deep.equal([
					{label: 'DEPT_ID', insertText: 'DEPT_ID', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS}
				]);
			});
		});

		describe('group by context', () => {
			it('offers the select list\'s own non-aggregated columns, excluding an aggregate call, for a single unaliased table', async () => {
				let extension = fakeExtension({
					columnsByTable: {employees: [column({systemName: 'DEPT_ID', tableName: 'EMPLOYEES'}), column({systemName: 'AMOUNT', tableName: 'EMPLOYEES'})]}
				});
				let sql = 'SELECT dept_id, SUM(amount) FROM employees GROUP BY ';
				expect(await items(sql, sql, extension)).to.deep.equal([
					{label: 'DEPT_ID', insertText: 'DEPT_ID', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS}
				]);
			});

			it('qualifies a column by alias when the select list referenced it that way', async () => {
				let extension = fakeExtension({
					columnsByTable: {
						employees: [column({systemName: 'DEPT_ID', tableName: 'EMPLOYEES'})],
						departments: [column({systemName: 'NAME', tableName: 'DEPARTMENTS'})]
					}
				});
				let sql = 'SELECT e.dept_id, d.name, COUNT(*) FROM employees e JOIN departments d ON e.dept_id = d.id GROUP BY ';
				expect(await items(sql, sql, extension)).to.deep.equal([
					{label: 'DEPT_ID', insertText: 'e.DEPT_ID', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS},
					{label: 'NAME', insertText: 'd.NAME', detail: 'myschema.departments', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS}
				]);
			});

			it('offers nothing once the select list is a bare wildcard -- there is then no way to know the full non-aggregated column set', async () => {
				let extension = fakeExtension({
					columnsByTable: {employees: [column({systemName: 'DEPT_ID', tableName: 'EMPLOYEES'})]}
				});
				let sql = 'SELECT * FROM employees GROUP BY ';
				expect(await items(sql, sql, extension)).to.deep.equal([]);
			});

			it('offers a non-aggregate expression back verbatim, with its output alias stripped', async () => {
				let extension = fakeExtension({
					columnsByTable: {employees: [column({systemName: 'DEPT_ID', tableName: 'EMPLOYEES'})]}
				});
				let sql = 'SELECT dept_id, UPPER(name) AS upper_name FROM employees GROUP BY ';
				expect(await items(sql, sql, extension)).to.deep.equal([
					{label: 'DEPT_ID', insertText: 'DEPT_ID', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS},
					{label: 'UPPER(name)', insertText: 'UPPER(name)', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS}
				]);
			});

			it('uses the underlying column, not the output alias, for an aliased plain column', async () => {
				let extension = fakeExtension({
					columnsByTable: {employees: [column({systemName: 'DEPT_ID', tableName: 'EMPLOYEES'})]}
				});
				let sql = 'SELECT dept_id AS d FROM employees GROUP BY ';
				expect(await items(sql, sql, extension)).to.deep.equal([
					{label: 'DEPT_ID', insertText: 'DEPT_ID', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS}
				]);
			});
		});

		describe('value context', () => {
			it('adds a value item for a column assignment, additive to the column completions already offered there', async () => {
				let extension = fakeExtension({
					columnsByTable: {employees: [column({systemName: 'DEPT_ID', tableName: 'EMPLOYEES', dataType: 'DECIMAL'})]}
				});
				let sql = 'SELECT id FROM employees e WHERE e.dept_id = ';
				let results = await items(sql, sql, extension);
				// Additive: both the assignment's own default-value suggestion AND the ordinary
				// column completions that already apply to a WHERE clause should be present.
				expect(results).to.deep.include({label: '0 (default for DEPT_ID)', insertText: '0', detail: 'myschema.employees.dept_id (decimal)', kind: 'Value', sortText: DbAssist.ItemSortOrder.VALUES});
				expect(results.some(i => i.label === 'DEPT_ID')).to.equal(true);
			});

			it('offers a bulk-defaults item plus the first column\'s value item for an empty INSERT VALUES list', async () => {
				let extension = fakeExtension({
					columnsByTable: {employees: [column({systemName: 'ID', tableName: 'EMPLOYEES', dataType: 'DECIMAL'}), column({systemName: 'NAME', tableName: 'EMPLOYEES', dataType: 'VARCHAR'})]}
				});
				let sql = 'INSERT INTO employees VALUES (';
				expect(await items(sql, sql, extension)).to.deep.equal([
					{label: '[Default values for employees]', insertText: '0, \'\'', detail: '0, \'\'', kind: 'Value', sortText: DbAssist.ItemSortOrder.CUSTOM},
					{label: '0 (default for ID)', insertText: '0', detail: 'myschema.employees.id (decimal)', kind: 'Value', sortText: DbAssist.ItemSortOrder.VALUES}
				]);
			});

			it('lines up the targeted value item with an explicit column list and the cursor\'s argument position, suppressing the bulk item once something has been typed', async () => {
				let extension = fakeExtension({
					columnsByTable: {employees: [column({systemName: 'ID', tableName: 'EMPLOYEES', dataType: 'DECIMAL'}), column({systemName: 'NAME', tableName: 'EMPLOYEES', dataType: 'VARCHAR'})]}
				});
				let sql = 'INSERT INTO employees (name, id) VALUES (\'a\', ';
				let results = await items(sql, sql, extension);
				expect(results).to.deep.equal([
					{label: '0 (default for ID)', insertText: '0', detail: 'myschema.employees.id (decimal)', kind: 'Value', sortText: DbAssist.ItemSortOrder.VALUES}
				]);
			});
		});

		describe('INSERT column list context', () => {
			it('offers only the bulk "[All from ...]" custom item, never the "*" wildcard, with unqualified names', async () => {
				let extension = fakeExtension({
					columnsByTable: {employees: [column({systemName: 'ID', tableName: 'EMPLOYEES'}), column({systemName: 'NAME', tableName: 'EMPLOYEES'})]}
				});
				let sql = 'INSERT INTO employees (';
				expect(await items(sql, sql, extension)).to.deep.equal([
					{label: '[All from employees]', insertText: 'ID, NAME', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.CUSTOM},
					{label: 'ID', insertText: 'ID', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS},
					{label: 'NAME', insertText: 'NAME', detail: 'myschema.employees', kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS}
				]);
			});
		});

		it('does not throw on malformed SQL, and resolves whatever it still can', async () => {
			let sql = 'SELECT id FROM data, FROM garbage(((';
			let results = await items(sql, sql, fakeExtension());
			expect(results).to.be.an('array');
		});
	});
});
