import { expect } from 'chai';
import { FakeDatabase, defineFakeDatabase } from './fake-database.js';
import { FakeDml } from './fake-dml.js';

/**
 * FakeDml is fixture code, so these tests are here to keep it honest rather than to cover a product
 * behaviour: a row-editing test is only worth anything if the fake it writes to targets the same rows
 * a database would. The cases below are the ones where a sloppy parser would silently hit the wrong
 * row - a comma inside a value, a two-column key, an RRN that must not shift when a row is deleted.
 */
describe('FakeDml', () => {
	function database(): FakeDatabase {
		return defineFakeDatabase({
			schemas: [{
				name: 'SALES',
				tables: [{
					name: 'CUSTOMER',
					columns: [{ systemName: 'CUSTNO' }, { systemName: 'CUSTNM' }, { systemName: 'ACTIVE' }],
					rows: [
						{ CUSTNO: 1, CUSTNM: 'Prairie Air', ACTIVE: 'Y' },
						{ CUSTNO: 2, CUSTNM: 'Example Air', ACTIVE: 'Y' },
						{ CUSTNO: 3, CUSTNM: 'Retired Charter', ACTIVE: 'N' }
					]
				}]
			}]
		});
	}

	function rows(fixture: FakeDatabase): Record<string, unknown>[] {
		return fixture.schemas[0].tables[0].rows;
	}

	it('inserts a row with its values typed as the literals say', () => {
		let fixture = database();
		let affected = new FakeDml(fixture).apply('INSERT INTO "SALES"."CUSTOMER" ("CUSTNO", "CUSTNM", "ACTIVE") VALUES (4, \'New Charter\', NULL)');

		expect(affected).to.equal(1);
		expect(rows(fixture)).to.have.lengthOf(4);
		expect(rows(fixture)[3]).to.deep.equal({ CUSTNO: 4, CUSTNM: 'New Charter', ACTIVE: null });
	});

	// A value is user-typed text: it can contain the separators the statement is built from.
	it('keeps a comma and an escaped quote inside a value', () => {
		let fixture = database();
		new FakeDml(fixture).apply('INSERT INTO "SALES"."CUSTOMER" ("CUSTNO", "CUSTNM") VALUES (4, \'Smith, O\'\'Brien and Co\')');

		expect(rows(fixture)[3]['CUSTNM']).to.equal('Smith, O\'Brien and Co');
	});

	it('updates only the rows its key matches, and leaves the rest alone', () => {
		let fixture = database();
		let affected = new FakeDml(fixture).apply('UPDATE "SALES"."CUSTOMER" SET "CUSTNM" = \'Renamed\' WHERE "CUSTNO" = 2');

		expect(affected).to.equal(1);
		expect(rows(fixture).map(row => row['CUSTNM'])).to.deep.equal(['Prairie Air', 'Renamed', 'Retired Charter']);
	});

	// Both halves of a composite key have to match, or an edit aimed at one row hits several.
	it('requires every column of a multi-column key to match', () => {
		let fixture = database();
		let dml = new FakeDml(fixture);

		expect(dml.apply('UPDATE "SALES"."CUSTOMER" SET "CUSTNM" = \'Both\' WHERE "CUSTNO" = 1 AND "ACTIVE" = \'Y\'')).to.equal(1);
		expect(dml.apply('UPDATE "SALES"."CUSTOMER" SET "CUSTNM" = \'Neither\' WHERE "CUSTNO" = 1 AND "ACTIVE" = \'N\'')).to.equal(0);
		expect(rows(fixture)[0]['CUSTNM']).to.equal('Both');
	});

	it('deletes the keyed row only', () => {
		let fixture = database();
		let affected = new FakeDml(fixture).apply('DELETE FROM "SALES"."CUSTOMER" WHERE "CUSTNO" = 1');

		expect(affected).to.equal(1);
		expect(rows(fixture).map(row => row['CUSTNO'])).to.deep.equal([2, 3]);
	});

	// RRN is a physical position on a real system, so it must not renumber when a row in front of it
	// goes away - otherwise a fake would hide exactly the bug that makes an RRN-keyed delete remove
	// somebody else's row.
	it('keeps a row\'s RRN stable when an earlier row is deleted', () => {
		let fixture = database();
		let dml = new FakeDml(fixture);
		let third = rows(fixture)[2];

		expect(dml.rowNumber(fixture.schemas[0].tables[0], third)).to.equal(3);

		dml.apply('DELETE FROM "SALES"."CUSTOMER" WHERE RRN("CUSTOMER") = 1');

		expect(rows(fixture).map(row => row['CUSTNO'])).to.deep.equal([2, 3]);
		expect(dml.rowNumber(fixture.schemas[0].tables[0], third)).to.equal(3);
	});

	it('targets a row by RRN for an update, and gives an inserted row a number of its own', () => {
		let fixture = database();
		let dml = new FakeDml(fixture);

		expect(dml.apply('UPDATE "SALES"."CUSTOMER" SET "ACTIVE" = \'N\' WHERE RRN("CUSTOMER") = 2')).to.equal(1);
		expect(rows(fixture).map(row => row['ACTIVE'])).to.deep.equal(['Y', 'N', 'N']);

		dml.apply('INSERT INTO "SALES"."CUSTOMER" ("CUSTNO") VALUES (4)');
		expect(dml.rowNumber(fixture.schemas[0].tables[0], rows(fixture)[3])).to.equal(4);
	});

	// The same rule the rest of the fake driver follows: what it wasn't taught fails loudly rather
	// than quietly doing nothing, which would leave a test asserting against an unchanged fixture.
	it('throws on a statement it cannot apply, rather than ignoring it', () => {
		let fixture = database();

		expect(() => new FakeDml(fixture).apply('MERGE INTO "SALES"."CUSTOMER" USING x ON y')).to.throw(/cannot apply statement/);
		expect(() => new FakeDml(fixture).apply('DELETE FROM "SALES"."NOSUCHTABLE" WHERE "X" = 1')).to.throw(/no table/);
		expect(() => new FakeDml(fixture).apply('DELETE FROM "SALES"."CUSTOMER"')).to.throw(/WHERE/);
	});
});
