import { expect } from 'chai';
import { DbDriverConnection } from '../db-driver.js';
import { defineFakeDatabase } from './fake-database.js';
import { FakeDriver } from './fake-driver.js';

const LIBRARY_LIST_SQL = 'select ordinal_position, system_schema_name, type, text_description from qsys2.library_list_info order by ordinal_position';
const DATABASE = defineFakeDatabase({
	schemas: [
		{ name: 'QSYS', type: 'System' },
		{ name: 'SALES' },
		{ name: 'APPL' },
		{ name: 'ARCHIVE', onLibraryList: false }
	]
});

async function libraryList(connection: DbDriverConnection): Promise<string[]> {
	let rows = <Record<string, unknown>[]>await connection.query({ sql: LIBRARY_LIST_SQL });
	return rows.map(row => `${row['SYSTEM_SCHEMA_NAME']}:${row['TYPE']}`);
}

describe('FakeLibraryList', () => {
	it('starts from the fixture\'s library list', async () => {
		let connection = await new FakeDriver({ database: DATABASE }).connect();
		expect(await libraryList(connection)).to.deep.equal(['QSYS:SYSTEM', 'SALES:USER', 'APPL:USER']);
	});

	// The point of keeping the list per connection: a session's main and worker jobs are separate jobs.
	it('keeps one list per connection, so a command on one job leaves the other alone', async () => {
		let driver = new FakeDriver({ database: DATABASE });
		let main = await driver.connect();
		let worker = await driver.connect();

		await main.query({ sql: 'CALL QSYS2.QCMDEXC(?)', parameters: ['CHGLIBL LIBL(APPL ARCHIVE)'] });

		expect(await libraryList(main)).to.deep.equal(['QSYS:SYSTEM', 'APPL:USER', 'ARCHIVE:USER']);
		expect(await libraryList(worker)).to.deep.equal(['QSYS:SYSTEM', 'SALES:USER', 'APPL:USER']);
	});

	it('applies CHGLIBL, ADDLIBLE and RMVLIBLE, from a literal or a bound command', async () => {
		let connection = await new FakeDriver({ database: DATABASE }).connect();

		await connection.query({ sql: 'CALL QSYS2.QCMDEXC(\'ADDLIBLE LIB(ARCHIVE) POSITION(*LAST)\')' });
		expect(await libraryList(connection)).to.deep.equal(['QSYS:SYSTEM', 'SALES:USER', 'APPL:USER', 'ARCHIVE:USER']);

		await connection.query({ sql: 'CALL QSYS2.QCMDEXC(?)', parameters: ['rmvlible lib(sales)'] });
		await connection.query({ sql: 'CALL QSYS2.QCMDEXC(?)', parameters: ['ADDLIBLE LIB(QTEMP)'] });
		expect(await libraryList(connection)).to.deep.equal(['QSYS:SYSTEM', 'QTEMP:USER', 'APPL:USER', 'ARCHIVE:USER']);

		await connection.query({ sql: 'CALL QSYS2.QCMDEXC(?)', parameters: ['CHGLIBL LIBL(*NONE)'] });
		expect(await libraryList(connection)).to.deep.equal(['QSYS:SYSTEM']);
	});

	it('fails a CALL for a missing library with CPF2110, and leaves the list alone', async () => {
		let connection = await new FakeDriver({ database: DATABASE }).connect();

		try {
			await connection.query({ sql: 'CALL QSYS2.QCMDEXC(?)', parameters: ['CHGLIBL LIBL(SALES NOSUCH)'] });
			expect.fail('expected the command to fail');
		} catch(error: any) {
			expect(error.message).to.contain('CPF2110');
			expect(error.driverErrors?.[0]?.state).to.equal('38501');
		}

		expect(await libraryList(connection)).to.deep.equal(['QSYS:SYSTEM', 'SALES:USER', 'APPL:USER']);
	});

	it('returns 1 or -1 from the scalar function form, as it does live', async () => {
		let connection = await new FakeDriver({ database: DATABASE }).connect();

		let failed = <Record<string, unknown>[]>await connection.query({ sql: 'values qsys2.qcmdexc(\'ADDLIBLE LIB(NOSUCH)\')' });
		expect(Object.values(failed[0])).to.deep.equal([-1]);

		let succeeded = <Record<string, unknown>[]>await connection.query({ sql: 'values qsys2.qcmdexc(\'ADDLIBLE LIB(ARCHIVE)\')' });
		expect(Object.values(succeeded[0])).to.deep.equal([1]);
		expect(await libraryList(connection)).to.deep.equal(['QSYS:SYSTEM', 'ARCHIVE:USER', 'SALES:USER', 'APPL:USER']);
	});

	it('throws on a CL command it doesn\'t understand rather than accepting it', async () => {
		let connection = await new FakeDriver({ database: DATABASE }).connect();

		try {
			await connection.query({ sql: 'CALL QSYS2.QCMDEXC(\'DSPLIBL\')' });
			expect.fail('expected an unknown command to fail');
		} catch(error: any) {
			expect(error.message).to.contain('no fixture response for the CL command DSPLIBL');
		}
	});

	it('lets a declared response override the job\'s own list', async () => {
		let connection = await new FakeDriver({
			database: DATABASE,
			responses: [{ match: /library_list_info/i, rows: [{ ORDINAL_POSITION: 1, SYSTEM_SCHEMA_NAME: 'X', TYPE: 'USER', TEXT_DESCRIPTION: '' }] }]
		}).connect();

		expect(await libraryList(connection)).to.deep.equal(['X:USER']);
	});
});
