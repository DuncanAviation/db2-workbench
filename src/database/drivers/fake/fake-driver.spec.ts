import { expect } from 'chai';
import { DbDriverConnection } from '../db-driver.js';
import { FakeDriver } from './fake-driver.js';
import { SAMPLE_DATABASE } from './fixtures/sample-database.js';

async function connect(options: FakeDriver.Options = { database: SAMPLE_DATABASE }): Promise<DbDriverConnection> {
	return new FakeDriver(options).connect();
}

describe('FakeDriver', () => {
	it('serves a table\'s declared rows for a plain select', async () => {
		let connection = await connect();
		let result = await connection.query({ sql: 'select * from sales.customer' });

		expect(result).to.have.lengthOf(3);
		expect(result?.count).to.equal(3);
		expect(result?.columns.map(column => column.name)).to.deep.equal(['CUSTNO', 'CUSTNM', 'ACTIVE']);
	});

	it('answers a catalog query out of the declared database', async () => {
		let connection = await connect();
		let result = await connection.query({ sql: 'select sys_name, label from qsys2.sysschemas order by name' });
		expect(result?.map(row => (<Record<string, unknown>>row)['SYS_NAME'])).to.deep.equal(['SALES', 'ARCHIVE', 'QSYS2']);
	});

	// The single most important behavior here: a statement nobody taught the fake must fail loudly.
	// A fake that returned no rows instead would let a test pass while proving nothing.
	it('throws on a statement no fixture covers, rather than returning no rows', async () => {
		let connection = await connect();

		try {
			await connection.query({ sql: 'select * from nowhere.missing' });
			expect.fail('expected the fake driver to reject an uncovered statement');
		} catch(error: any) {
			expect(error.message).to.contain('no fixture response for SQL');
			expect(error.driverErrors?.[0]?.state).to.equal('HY000');
		}
	});

	it('prefers a declared response over the database', async () => {
		let connection = await connect({
			database: SAMPLE_DATABASE,
			responses: [{ sql: 'select * from sales.customer', rows: [{ CUSTNO: 99 }] }]
		});

		let result = await connection.query({ sql: 'SELECT  *  FROM   Sales.Customer' });
		expect(result).to.have.lengthOf(1);
		expect((<Record<string, unknown>>(<unknown[]>result)[0])['CUSTNO']).to.equal(99);
	});

	it('matches a response by pattern and by predicate', async () => {
		let connection = await connect({
			responses: [
				{ match: /from\s+sales\.orders/i, rows: [{ ORDNO: 1 }] },
				{ match: (sql, parameters) => sql.includes('WHERE') && parameters?.[0] === 7, rows: [{ ORDNO: 7 }] }
			]
		});

		expect(await connection.query({ sql: 'select * from sales.orders' })).to.have.lengthOf(1);

		let byPredicate = await connection.query({ sql: 'select * from anything WHERE x = ?', parameters: [7] });
		expect((<Record<string, unknown>>(<unknown[]>byPredicate)[0])['ORDNO']).to.equal(7);
	});

	it('throws a declared error, carrying the driverErrors every driver owes its callers', async () => {
		let connection = await connect({
			responses: [{
				sql: 'select * from sales.orders',
				error: { message: 'Table ORDERS in SALES type *FILE not found.', driverErrors: [{ code: -204, state: '42704', message: 'Not found.' }] }
			}]
		});

		try {
			await connection.query({ sql: 'select * from sales.orders' });
			expect.fail('expected the declared error to be thrown');
		} catch(error: any) {
			expect(error.message).to.contain('not found');
			expect(error.driverErrors).to.deep.equal([{ code: -204, state: '42704', message: 'Not found.' }]);
		}
	});

	it('pages a cursor and reports noData only once the rows run out', async () => {
		let connection = await connect();
		let cursor = await connection.openCursor({ sql: 'select * from sales.orders', fetchSize: 10 });

		expect(await cursor.fetch()).to.have.lengthOf(10);
		expect(cursor.noData).to.equal(false);

		expect(await cursor.fetch()).to.have.lengthOf(10);
		expect(cursor.noData).to.equal(false);

		let last = await cursor.fetch();
		expect(last).to.have.lengthOf(5);
		expect(cursor.noData).to.equal(true);
		expect(last?.columns.map(column => column.name)).to.deep.equal(['ORDNO', 'CUSTNO', 'ORDDT', 'ORDAMT']);
	});

	it('describes columns on a final empty batch the same as on the first', async () => {
		let connection = await connect();
		let cursor = await connection.openCursor({ sql: 'select * from archive.orders2024', fetchSize: 10 });
		let result = await cursor.fetch();

		expect(result).to.have.lengthOf(0);
		expect(cursor.noData).to.equal(true);
	});

	it('echoes a call\'s parameters back, which is how OUT values are reported', async () => {
		let connection = await connect({
			database: SAMPLE_DATABASE,
			responses: [{ match: /call sales\.next_order_number/i, rows: [] }]
		});

		let result = await connection.callProcedure({ schema: 'SALES', name: 'NEXT_ORDER_NUMBER', parameters: ['ORD', 1001] });
		expect(result?.parameters).to.deep.equal(['ORD', 1001]);
	});

	it('reports a call\'s declared parameters instead of the echo, so an OUT parameter can return a value', async () => {
		let connection = await connect({
			database: SAMPLE_DATABASE,
			responses: [{ match: /call sales\.next_order_number/i, rows: [], parameters: ['ORD', 2002] }]
		});

		let result = await connection.callProcedure({ schema: 'SALES', name: 'NEXT_ORDER_NUMBER', parameters: ['ORD', null] });
		expect(result?.parameters).to.deep.equal(['ORD', 2002]);
	});

	it('applies a declared delay, so slow-statement behavior can be exercised', async () => {
		let connection = await connect({ responses: [{ sql: 'select 1 from sysibm.sysdummy1', rows: [], delayMs: 25 }] });
		let start = Date.now();

		await connection.query({ sql: 'select 1 from sysibm.sysdummy1' });
		expect(Date.now() - start).to.be.greaterThanOrEqual(20);
	});

	it('holds an untilCancelled statement until cancel(), then fails it with HY008 the way node-odbc does', async () => {
		let reached!: () => void;
		let arrived = new Promise<void>(resolve => reached = resolve);
		let connection = await connect({
			responses: [{ sql: 'select * from sales.orders', untilCancelled: true }],
			onStatement: () => reached()
		});

		let running = connection.openCursor({ sql: 'select * from sales.orders' });
		await arrived;
		await connection.cancel?.();

		try {
			await running;
			expect.fail('expected the cancelled statement to reject');
		} catch(error: any) {
			expect(error.driverErrors?.[0]?.state).to.equal('HY008');
		}
	});

	it('treats cancel() with nothing running as a no-op', async () => {
		let connection = await connect();

		await connection.cancel?.();
		expect(await connection.query({ sql: 'select * from sales.customer' })).to.have.lengthOf(3);
	});
});
