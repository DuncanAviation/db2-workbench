import { expect } from 'chai';
import { buildMemberCopiesQuery, buildMemberExistsQuery, buildSourceFileLibrariesQuery } from '../../queries/program-source.js';
import { CatalogResponder } from './catalog-responder.js';
import { defineFakeDatabase } from './fake-database.js';
import { SAMPLE_DATABASE } from './fixtures/sample-database.js';

const responder = new CatalogResponder(SAMPLE_DATABASE);

// The predicates below are the ones buildTablePredicate actually emits, embedded in the same
// statements src/database/queries/ runs - so a change to those queries' predicate columns fails here
// rather than silently emptying a tab in an integration test.
const COLUMNS_SQL = 'select dbname, tbname, colno, sys_cname, name from qsys2.syscolumns2 where ((dbname = ? and tbname = ?)) order by dbname, tbname, colno';
const KEYS_SQL = 'select a.system_table_schema from qsys2.syscst a join qsys2.syskeycst c on a.constraint_name = c.constraint_name where ((a.system_table_schema = ? and a.system_table_name = ?)) and a.constraint_type in (\'PRIMARY KEY\', \'UNIQUE\')';
const FOREIGN_KEYS_SQL = 'select a.system_table_schema as owning_schema from qsys2.syscst a join qsys2.sysrefcst b on a.constraint_name = b.constraint_name where ((a.system_table_schema = ? and a.system_table_name = ?)) and a.constraint_type = \'FOREIGN KEY\'';
const INDEXES_SQL = 'select p.table_schema from qsys2.syspartitionindexstat p left join qsys2.sysindexes i on p.index_name = i.index_name where ((p.table_schema = ? and p.table_name = ?))';
const ADVICE_SQL = 'select rrn(sysixadv) as id, table_schema, table_name from qsys2.sysixadv where ((table_schema = ? and table_name = ?))';

describe('CatalogResponder.readTargets', () => {
	it('reads a schema-qualified target from the predicate columns, not a fixed stride', () => {
		let targets = CatalogResponder.readTargets(CatalogResponder.normalize(COLUMNS_SQL), ['SALES', 'ORDERS'], 'dbname', 'tbname');
		expect(targets).to.deep.equal([{ schema: 'SALES', table: 'ORDERS' }]);
	});

	it('reads a schema-less target, which is what autocomplete asks for', () => {
		let sql = CatalogResponder.normalize('select dbname from qsys2.syscolumns2 where (tbname = ?)');
		expect(CatalogResponder.readTargets(sql, ['ORDERS'], 'dbname', 'tbname')).to.deep.equal([{ schema: undefined, table: 'ORDERS' }]);
	});

	it('reads a batch mixing qualified and unqualified targets', () => {
		let sql = CatalogResponder.normalize('select dbname from qsys2.syscolumns2 where ((dbname = ? and tbname = ?) or tbname = ?)');
		expect(CatalogResponder.readTargets(sql, ['SALES', 'ORDERS', 'CUSTOMER'], 'dbname', 'tbname')).to.deep.equal([
			{ schema: 'SALES', table: 'ORDERS' },
			{ schema: undefined, table: 'CUSTOMER' }
		]);
	});

	it('reads every table of a schema\'s IN list, alongside other clauses', () => {
		let sql = CatalogResponder.normalize('select dbname from qsys2.syscolumns2 where ((dbname = ? and tbname in (?, ?)) or (dbname = ? and tbname = ?) or tbname in (?,?))');
		expect(CatalogResponder.readTargets(sql, ['SALES', 'ORDERS', 'CUSTOMER', 'HR', 'EMPLOYEE', 'A', 'B'], 'dbname', 'tbname')).to.deep.equal([
			{ schema: 'SALES', table: 'ORDERS' },
			{ schema: 'SALES', table: 'CUSTOMER' },
			{ schema: 'HR', table: 'EMPLOYEE' },
			{ schema: undefined, table: 'A' },
			{ schema: undefined, table: 'B' }
		]);
	});

	it('ignores the alias a catalog is joined under', () => {
		let targets = CatalogResponder.readTargets(CatalogResponder.normalize(KEYS_SQL), ['SALES', 'ORDERS'], 'system_table_schema', 'system_table_name');
		expect(targets).to.deep.equal([{ schema: 'SALES', table: 'ORDERS' }]);
	});
});

describe('CatalogResponder.respond', () => {
	it('answers the connection-time job lookup, without which no session ever opens', () => {
		let rows = <Record<string, unknown>[]>responder.respond('select qsys2.job_name, a.v_client_ip_address from table (qsys2.get_job_info(\'*\')) a');
		expect(rows).to.have.lengthOf(1);
		expect(rows[0]['JOB_NAME']).to.equal(SAMPLE_DATABASE.job.jobName);
		expect(rows[0]['LANGUAGE_ID']).to.equal('ENU');
	});

	it('lists only library-list schemas for the library list lookup', () => {
		let rows = <Record<string, unknown>[]>responder.respond('select ordinal_position, system_schema_name, type, text_description from qsys2.library_list_info order by ordinal_position');
		expect(rows.map(row => row['SYSTEM_SCHEMA_NAME'])).to.deep.equal(['SALES']);
	});

	it('lists every declared schema for the schema browser, library list or not', () => {
		let rows = <Record<string, unknown>[]>responder.respond('select sys_name, label from qsys2.sysschemas order by name');
		expect(rows.map(row => row['SYS_NAME'])).to.deep.equal(['SALES', 'ARCHIVE']);
	});

	it('returns the tables of every named schema', () => {
		let rows = <Record<string, unknown>[]>responder.respond('select sys_dname, sys_tname from qsys2.systables where sys_dname in (?, ?)', ['SALES', 'ARCHIVE']);
		expect(rows.map(row => row['SYS_TNAME'])).to.deep.equal(['CUSTOMER', 'ORDERS', 'SHIPMENT', 'ORDNOTE', 'CUSTTOT', 'ORDERS2024']);
	});

	it('types a materialized query table M, and answers its definition on its own', () => {
		let rows = <Record<string, unknown>[]>responder.respond('select sys_dname, sys_tname, type from qsys2.systables where sys_dname in (?)', ['SALES']);
		expect(rows.filter(row => row['TYPE'] === 'M').map(row => row['SYS_TNAME'])).to.deep.equal(['CUSTTOT']);

		let definition = <Record<string, unknown>[]>responder.respond('select mqtdef from qsys2.systables where sys_dname = ? and sys_tname = ? and type = \'M\'', ['SALES', 'CUSTTOT']);
		expect(definition).to.deep.equal([{ MQTDEF: 'SELECT CUSTNO, COUNT(*) AS ORDCNT FROM SALES.ORDERS GROUP BY CUSTNO' }]);

		let notAnMqt = <Record<string, unknown>[]>responder.respond('select mqtdef from qsys2.systables where sys_dname = ? and sys_tname = ? and type = \'M\'', ['SALES', 'ORDERS']);
		expect(notAnMqt).to.deep.equal([]);
	});

	it('returns a named schema\'s tables even when it is off the library list', () => {
		let rows = <Record<string, unknown>[]>responder.respond('select sys_dname, sys_tname from qsys2.systables where sys_dname in (?)', ['ARCHIVE']);
		expect(rows.map(row => row['SYS_TNAME'])).to.deep.equal(['ORDERS2024']);
	});

	// The view list joins SYSTABLES for each view's description, so it has to be recognized as a view list
	// before the table check claims it.
	it('answers the view list as views, not as a table list', () => {
		let sql = 'select v.sys_vdname, v.sys_vname, t.label from qsys2.sysviews v left join qsys2.systables t on t.sys_dname = v.sys_vdname and t.sys_tname = v.sys_vname where v.sys_vdname in (?)';
		let rows = <Record<string, unknown>[]>responder.respond(sql, ['SALES']);
		expect(rows.map(row => row['SYS_VNAME'])).to.deep.equal(['CUSTORD']);
		expect(rows[0]['LABEL']).to.equal('Orders with customer names');
	});

	it('returns a named schema\'s views even when it is off the library list', () => {
		let rows = <Record<string, unknown>[]>responder.respond('select v.sys_vdname, v.sys_vname from qsys2.sysviews v where v.sys_vdname in (?)', ['ARCHIVE']);
		expect(rows.map(row => row['SYS_VNAME'])).to.deep.equal(['ORDERS2024V']);
	});

	it('answers one view\'s definition, and nothing for a view that isn\'t there', () => {
		let sql = 'select text from qsys2.sysviews where sys_vdname = ? and sys_vname = ?';
		expect(responder.respond(sql, ['ARCHIVE', 'ORDERS2024V'])).to.deep.equal([{ TEXT: 'SELECT ORDNO FROM ARCHIVE.ORDERS2024' }]);
		expect(responder.respond(sql, ['SALES', 'NOSUCHVIEW'])).to.deep.equal([]);
	});

	it('lists a view\'s columns like a table\'s', () => {
		let rows = <Record<string, unknown>[]>responder.respond(COLUMNS_SQL, ['SALES', 'CUSTORD']);
		expect(rows.map(row => row['SYS_CNAME'])).to.deep.equal(['ORDNO', 'CUSTNM']);
	});

	it('reports both of a column\'s names, which several features turn on', () => {
		let rows = <Record<string, unknown>[]>responder.respond(COLUMNS_SQL, ['SALES', 'ORDERS']);
		expect(rows).to.have.lengthOf(4);
		expect(rows[0]['SYS_CNAME']).to.equal('ORDNO');
		expect(rows[0]['NAME']).to.equal('ORDER_NUMBER');
		expect(rows[0]['COLNO']).to.equal(1);
	});

	it('interleaves a batch\'s rows and tags each with its own table, the way a batched statement does', () => {
		let sql = 'select dbname, tbname, sys_cname from qsys2.syscolumns2 where ((dbname = ? and tbname = ?) or (dbname = ? and tbname = ?))';
		let rows = <Record<string, unknown>[]>responder.respond(sql, ['SALES', 'ORDERS', 'SALES', 'CUSTOMER']);
		expect(new Set(rows.map(row => row['TBNAME']))).to.deep.equal(new Set(['ORDERS', 'CUSTOMER']));
	});

	it('returns one row per key column, in key order', () => {
		let rows = <Record<string, unknown>[]>responder.respond(KEYS_SQL, ['SALES', 'ORDERS']);

		// One row per column of each key: the primary key on ORDNO, then both columns of the unique key
		// SHIPMENT's foreign key references, in key order.
		expect(rows.map(row => [row['CONSTRAINT_NAME'], row['SYSTEM_COLUMN_NAME'], row['ORDINAL_POSITION']])).to.deep.equal([
			['ORDERS_PK', 'ORDNO', 1],
			['ORDERS_CUST_DATE_UK', 'CUSTNO', 1],
			['ORDERS_CUST_DATE_UK', 'ORDDT', 2]
		]);
		expect(rows[0]['CONSTRAINT_TYPE']).to.equal('PRIMARY KEY');
		expect(rows[1]['CONSTRAINT_TYPE']).to.equal('UNIQUE');
		expect(rows[0]['COLUMN_NAME']).to.equal('ORDER_NUMBER');
	});

	it('resolves a foreign key\'s referenced table and column names', () => {
		let rows = <Record<string, unknown>[]>responder.respond(FOREIGN_KEYS_SQL, ['SALES', 'ORDERS']);
		expect(rows).to.have.lengthOf(1);
		expect(rows[0]['REFERENCED_TABLE']).to.equal('CUSTOMER');
		expect(rows[0]['REFERENCED_SYSTEM_COLUMN_NAME']).to.equal('CUSTNO');
		expect(rows[0]['REFERENCED_COLUMN_NAME']).to.equal('CUSTOMER_NUMBER');
	});

	it('pairs a multi-column foreign key\'s columns with the referenced ones by ordinal position', () => {
		let rows = <Record<string, unknown>[]>responder.respond(FOREIGN_KEYS_SQL, ['SALES', 'SHIPMENT']);

		expect(rows.map(row => [row['SYSTEM_COLUMN_NAME'], row['ORDINAL_POSITION'], row['REFERENCED_SYSTEM_COLUMN_NAME']])).to.deep.equal([
			['SHPCUS', 1, 'CUSTNO'],
			['SHPDT', 2, 'ORDDT']
		]);
		expect(rows.map(row => row['REFERENCED_COLUMN_NAME'])).to.deep.equal(['CUSTOMER_NUMBER', 'ORDER_DATE']);
	});

	it('answers the index query, keeping the numeric uniqueness code the mapper decodes', () => {
		let rows = <Record<string, unknown>[]>responder.respond(INDEXES_SQL, ['SALES', 'ORDERS']);
		expect(rows.map(row => row['INDEX_NAME'])).to.deep.equal(['ORDERS_PK', 'ORDERS_BY_CUST']);
		expect(rows[0]['UNIQUE_CODE']).to.equal(0);
	});

	it('answers index advice, and reports an empty list rather than a miss for a table with none', () => {
		expect(<Record<string, unknown>[]>responder.respond(ADVICE_SQL, ['SALES', 'ORDERS'])).to.have.lengthOf(1);
		expect(<Record<string, unknown>[]>responder.respond(ADVICE_SQL, ['SALES', 'CUSTOMER'])).to.deep.equal([]);
	});

	it('treats a delete against the advice catalog as a successful no-row statement', () => {
		expect(responder.respond('delete from qsys2.sysixadv where rrn(sysixadv) = ?', [1])).to.deep.equal([]);
	});

	it('answers procedure parameters, which a CALL needs to report its OUT values', () => {
		let sql = 'select specific_schema, specific_name, ordinal_position, parameter_mode, parameter_name from qsys2.sysparms where specific_schema = ? and specific_name = ? order by ordinal_position';
		let rows = <Record<string, unknown>[]>responder.respond(sql, ['SALES', 'NEXT_ORDER_NUMBER']);
		expect(rows.map(row => row['PARAMETER_MODE'])).to.deep.equal(['IN', 'OUT']);
		expect(rows[1]['PARAMETER_NAME']).to.equal('OUT_ORDER_NUMBER');
	});

	it('lists procedures and functions together, by routine name and specific name', () => {
		let sql = 'select specific_schema, specific_name, routine_name, routine_type from qsys2.sysroutines where specific_schema in (?)';
		let rows = <Record<string, unknown>[]>responder.respond(sql, ['SALES']);
		expect(rows.map(row => `${row['ROUTINE_TYPE']}:${row['ROUTINE_NAME']}:${row['SPECIFIC_NAME']}`)).to.deep.equal([
			'PROCEDURE:NEXT_ORDER_NUMBER:NEXT_ORDER_NUMBER',
			'PROCEDURE:ORDER_TOTAL:ORDER_TOTAL_RECALC',
			'PROCEDURE:ORDER_TOTAL:ORDER_TOTAL_RECALC1',
			'PROCEDURE:ORDER_HISTORY:ORDER_HISTORY',
			'PROCEDURE:ORDER_REPORT:ORDER_REPORT',
			'PROCEDURE:ORDER_PURGE:ORDER_PURGE',
			'PROCEDURE:ORDER_EXPORT:ORDER_EXPORT',
			'FUNCTION:ORDER_TOTAL:ORDER_TOTAL',
			'FUNCTION:ORDER_TOTAL:ORDER_TOTAL_CURRENCY',
			'FUNCTION:OPEN_ORDERS:OPEN_ORDERS'
		]);
	});

	it('answers an external procedure\'s row with its program and result sets, and no function-only columns', () => {
		let sql = 'select specific_name, external_name, is_null_call, max_dynamic_result_sets, length(routine_definition) as definition_length, cast(substring(routine_definition, 1, 10) as varchar(40)) as definition_chunk from qsys2.sysroutines where specific_schema = ? and specific_name = ?';
		let rows = <Record<string, unknown>[]>responder.respond(sql, ['SALES', 'ORDER_HISTORY']);
		expect(rows[0]).to.include({ROUTINE_BODY: 'EXTERNAL', EXTERNAL_NAME: 'SALES/ORDSRV(ORDHIST)', MAX_DYNAMIC_RESULT_SETS: 2, IS_NULL_CALL: null, FUNCTION_TYPE: null, DEFINITION_CHUNK: null});
	});

	it('lists an off-list schema\'s routines only when asked for by name', () => {
		let sql = 'select specific_schema, specific_name from qsys2.sysroutines where specific_schema in (?)';
		let rows = <Record<string, unknown>[]>responder.respond(sql, ['ARCHIVE']);
		expect(rows.map(row => row['SPECIFIC_NAME'])).to.deep.equal(['ARCHIVE_DATE']);
	});

	it('answers one routine\'s row with a chunk of its body, then the chunks after it', () => {
		let sql = 'select specific_name, length(routine_definition) as definition_length, cast(substring(routine_definition, 1, 10) as varchar(40)) as definition_chunk from qsys2.sysroutines where specific_schema = ? and specific_name = ?';
		let rows = <Record<string, unknown>[]>responder.respond(sql, ['SALES', 'ORDER_TOTAL_CURRENCY']);
		expect(rows).to.have.lengthOf(1);
		expect(rows[0]['DEFINITION_LENGTH']).to.equal(45);
		expect(rows[0]['DEFINITION_CHUNK']).to.equal('BEGIN RETU');
		expect(<Record<string, unknown>[]>responder.respond(sql, ['SALES', 'NO_SUCH_FUNCTION'])).to.deep.equal([]);

		let next = 'select cast(substring(routine_definition, ?, 10) as varchar(40)) as definition_chunk from qsys2.sysroutines where specific_schema = ? and specific_name = ?';
		expect(responder.respond(next, [39, 'SALES', 'ORDER_TOTAL_CURRENCY'])).to.deep.equal([{ DEFINITION_CHUNK: 'O); END' }]);
	});

	// On a real system this hangs on the row's LOB columns, so the fake must not quietly answer it.
	it('refuses select * from the routine catalog', () => {
		expect(() => responder.respond('select * from qsys2.sysroutines where specific_schema = ? and specific_name = ?', ['SALES', 'ORDER_TOTAL'])).to.throw(/LOB/);
	});

	it('answers batched routine parameters with each function\'s results after its parameters', () => {
		let sql = 'select specific_schema, specific_name, row_type from qsys2.sysparms where ((specific_schema = ? and specific_name = ?) or (specific_schema = ? and specific_name = ?))';
		let rows = <Record<string, unknown>[]>responder.respond(sql, ['SALES', 'ORDER_TOTAL_CURRENCY', 'SALES', 'OPEN_ORDERS']);
		expect(rows.map(row => `${row['SPECIFIC_NAME']}:${row['ROW_TYPE']}:${row['PARAMETER_NAME']}`)).to.deep.equal([
			'ORDER_TOTAL_CURRENCY:P:IN_ORDNO',
			'ORDER_TOTAL_CURRENCY:P:IN_CURRENCY',
			'ORDER_TOTAL_CURRENCY:C:',
			'OPEN_ORDERS:P:IN_CUSTNO',
			'OPEN_ORDERS:R:ORDNO',
			'OPEN_ORDERS:R:ORDDT'
		]);
	});

	it('does not answer a statement that reads no catalog, so the driver can report a miss', () => {
		expect(responder.respond('select * from sales.orders')).to.equal(undefined);
	});
});

// The program and source catalogs ProgramQueries and TriggerDispatchQueries read. The member statements
// come from program-source.ts's own builders; the rest are copied from the query classes, as above.
describe('CatalogResponder.respond for programs and their source', () => {
	const STATEMENTS_SQL = 'select cast(substring(statement_text, 1, 8000) as varchar(32000)) as statement_text from qsys2.sysprogramstmtstat where program_schema = ? and program_name = ?';
	const EXPORTS_SQL = 'select symbol_name from qsys2.program_export_import_info where program_library = ? and program_name = ? and object_type = ? and symbol_usage = \'*PROCEXP\'';
	const LIBRARIES_SQL = (count: number) => `select sys_name from qsys2.sysschemas where sys_name in (${Array(count).fill('?').join(', ')})`;
	const LIBL_SQL = 'select objlib, objname, objtype from table(qsys2.object_statistics(\'*LIBL\', ?, ?)) x';
	const LIBRARY_PROGRAMS_SQL = (count: number) => `select objlib, objname, objtype from table(qsys2.object_statistics(?, '*PGM *SRVPGM')) x where objname in (${Array(count).fill('?').join(', ')})`;
	const ALLUSR_SQL = 'select objlib from table(qsys2.object_statistics(\'*ALLUSR\', ?, ?)) x order by objlib';

	const programs = new CatalogResponder(defineFakeDatabase({
		schemas: [
			{
				name: 'APP',
				programs: [
					{ name: 'TRGMED', statements: ['SELECT RTPGM FROM RTCTL WHERE RTACT = \'Y\'', 'OPEN C1'] },
					{ name: 'PARTSRV', objectType: '*SRVPGM', exports: ['FORMATPART', 'PARTSERVICE'], statements: ['SELECT 1 FROM SYSIBM . SYSDUMMY1'] },
					{ name: 'BINPGM', objectType: '*SRVPGM' }
				],
				sourceMembers: [{ file: 'QSRC', member: 'PARTSRV01', lines: ['**free'], lastChanged: '2026-03-01 08:00:00.000000' }]
			},
			{
				name: 'CTL',
				tables: [{ name: 'RTCTL' }],
				programs: [{ name: 'BINPGM' }]
			},
			{
				name: 'OFFLIST',
				onLibraryList: false,
				programs: [{ name: 'BINPGM' }],
				sourceMembers: [
					{ file: 'QSRC', member: 'PARTSRV01', lines: ['**free'], lastChanged: '2026-04-01 08:00:00.000000' },
					{ file: 'QSRC2', member: 'OTHER', lines: ['**free'], lastChanged: '2026-04-01 08:00:00.000000' }
				]
			}
		]
	}));

	const rows = (sql: string, parameters: string[]) => <Record<string, unknown>[]>programs.respond(sql, parameters);

	it('lists a program\'s static SQL by library and name, a *PGM\'s or a *SRVPGM\'s alike', () => {
		expect(rows(STATEMENTS_SQL, ['APP', 'TRGMED']).map(row => row['STATEMENT_TEXT'])).to.deep.equal(['SELECT RTPGM FROM RTCTL WHERE RTACT = \'Y\'', 'OPEN C1']);
		expect(rows(STATEMENTS_SQL, ['app', 'partsrv']).map(row => row['STATEMENT_TEXT'])).to.deep.equal(['SELECT 1 FROM SYSIBM . SYSDUMMY1']);
		expect(rows(STATEMENTS_SQL, ['CTL', 'BINPGM'])).to.deep.equal([]);
		expect(rows(STATEMENTS_SQL, ['APP', 'NOPGM'])).to.deep.equal([]);
	});

	it('lists a service program\'s procedure exports, matched by object type too', () => {
		expect(rows(EXPORTS_SQL, ['APP', 'PARTSRV', '*SRVPGM']).map(row => row['SYMBOL_NAME'])).to.deep.equal(['FORMATPART', 'PARTSERVICE']);
		expect(rows(EXPORTS_SQL, ['APP', 'PARTSRV', '*PGM'])).to.deep.equal([]);
	});

	it('says which of a list of names are libraries, case ignored, and nothing for one that isn\'t', () => {
		expect(rows(LIBRARIES_SQL(3), ['ctl', 'NOPE', 'OFFLIST']).map(row => row['SYS_NAME'])).to.deep.equal(['CTL', 'OFFLIST']);
	});

	it('resolves a *LIBL name through the library list only, in list order, for each type asked', () => {
		expect(rows(LIBL_SQL, ['*PGM *SRVPGM', 'BINPGM'])).to.deep.equal([
			{ OBJLIB: 'APP', OBJNAME: 'BINPGM', OBJTYPE: '*SRVPGM' },
			{ OBJLIB: 'CTL', OBJNAME: 'BINPGM', OBJTYPE: '*PGM' }
		]);
		expect(rows(LIBL_SQL, ['*PGM', 'BINPGM']).map(row => row['OBJLIB'])).to.deep.equal(['CTL']);
		expect(rows(LIBL_SQL, ['*FILE', 'RTCTL'])).to.deep.equal([{ OBJLIB: 'CTL', OBJNAME: 'RTCTL', OBJTYPE: '*FILE' }]);
	});

	it('lists a named library\'s programs among the names asked, on the library list or not', () => {
		expect(rows(LIBRARY_PROGRAMS_SQL(2), ['OFFLIST', 'BINPGM', 'NOPGM'])).to.deep.equal([{ OBJLIB: 'OFFLIST', OBJNAME: 'BINPGM', OBJTYPE: '*PGM' }]);
		expect(rows(LIBRARY_PROGRAMS_SQL(1), ['NOLIB', 'BINPGM'])).to.deep.equal([]);
	});

	it('finds every user library holding an object, typed: a program by its type, a source file by its members', () => {
		expect(rows(ALLUSR_SQL, ['*PGM', 'BINPGM']).map(row => row['OBJLIB'])).to.deep.equal(['CTL', 'OFFLIST']);

		// ProgramQueries asks for several source files in one union, its bound values in pairs.
		let libraries = buildSourceFileLibrariesQuery(['QSRC', 'QSRC2', 'NOFILE']);
		expect(rows(libraries.sql, libraries.parameters)).to.deep.equal([
			{ OBJLIB: 'APP', OBJNAME: 'QSRC' },
			{ OBJLIB: 'OFFLIST', OBJNAME: 'QSRC' },
			{ OBJLIB: 'OFFLIST', OBJNAME: 'QSRC2' }
		]);
	});

	it('says which recorded members exist, with the change timestamp the source cache compares', () => {
		let exists = buildMemberExistsQuery([
			{ library: 'APP', file: 'QSRC', member: 'PARTSRV01' },
			{ library: 'APP', file: 'QSRC', member: 'GONE' }
		]);

		expect(rows(exists.sql, exists.parameters)).to.deep.equal([
			{ SYSTEM_TABLE_SCHEMA: 'APP', SYSTEM_TABLE_NAME: 'QSRC', SYSTEM_TABLE_MEMBER: 'PARTSRV01', LAST_CHANGE_TIMESTAMP: '2026-03-01 08:00:00.000000' }
		]);
	});

	it('finds a missing member\'s copies among only the libraries named for it, however long each IN list', () => {
		let copies = buildMemberCopiesQuery([
			{ file: 'QSRC', member: 'PARTSRV01', libraries: ['OFFLIST', 'CTL'] },
			{ file: 'QSRC2', member: 'OTHER', libraries: ['OFFLIST'] }
		]);

		expect(rows(copies.sql, copies.parameters).map(row => `${row['SYSTEM_TABLE_SCHEMA']}/${row['SYSTEM_TABLE_NAME']}(${row['SYSTEM_TABLE_MEMBER']}) ${row['LAST_CHANGE_TIMESTAMP']}`)).to.deep.equal([
			'OFFLIST/QSRC(PARTSRV01) 2026-04-01 08:00:00.000000',
			'OFFLIST/QSRC2(OTHER) 2026-04-01 08:00:00.000000'
		]);
	});
});
