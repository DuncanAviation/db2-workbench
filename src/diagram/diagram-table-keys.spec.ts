import { expect } from 'chai';
import { DiagramColumn, DiagramModel, DiagramTable } from '../webview-messages/diagram-messages.js';
import { ResolvedForeignKey } from './diagram-add-tables.js';
import { buildTableKeys, ReferencingKeyColumn } from './diagram-table-keys.js';

function column(name: string): DiagramColumn {
	return {name: name, type: 'CHAR(10)', primaryKey: false, foreignKey: false, identity: false, notNull: false, unique: false, indexed: false};
}

function table(schema: string, name: string, columns: string[]): DiagramTable {
	return {id: `${schema}.${name}`, schemaId: schema, name: name, position: {x: 0, y: 0}, columns: columns.map(column)};
}

function model(tables: DiagramTable[]): DiagramModel {
	return {schemas: [], tables: tables, relationships: []};
}

function foreignKey(constraintName: string | undefined, fromColumn: string, toSchema: string, toTable: string, toShortName = 'ID', toLongName?: string): ResolvedForeignKey {
	return {constraintName: constraintName, fromColumn: fromColumn, toSchema: toSchema, toTable: toTable, toColumn: toLongName ?? toShortName, toShortName: toShortName, toLongName: toLongName};
}

function referencing(schema: string, tableName: string, constraintName: string | undefined, keyColumn: string, childShortName: string, childLongName?: string): ReferencingKeyColumn {
	return {schema: schema, table: tableName, constraintName: constraintName, column: keyColumn, childShortName: childShortName, childLongName: childLongName};
}

describe('diagram-table-keys', () => {
	it('lists a table\'s own key with its other table and column pair, whether or not that table is on the diagram', () => {
		let diagram = model([table('HR', 'EMPLOYEE', ['DEPTNO']), table('HR', 'DEPARTMENT', ['ID'])]);
		let keys = new Map([['HR.EMPLOYEE', [foreignKey('EMP_DEPT_FK', 'DEPTNO', 'HR', 'DEPARTMENT', 'ID', 'DEPARTMENT_ID')]]]);

		expect(buildTableKeys(diagram, keys, new Map())).to.deep.equal([{
			tableId: 'HR.EMPLOYEE',
			keys: [{
				direction: 'references',
				constraintName: 'EMP_DEPT_FK',
				isNew: false,
				otherSchema: 'HR',
				otherTable: 'DEPARTMENT',
				otherTableId: 'HR.DEPARTMENT',
				columns: [{column: 'DEPTNO', otherShortName: 'ID', otherLongName: 'DEPARTMENT_ID'}]
			}]
		}]);
	});

	it('groups a composite key\'s rows into one key, in arrival order', () => {
		let diagram = model([table('SALES', 'SHIPMENT', ['ORDNO', 'LINE'])]);
		let keys = new Map([['SALES.SHIPMENT', [
			foreignKey('SHIP_ORDER_FK', 'ORDNO', 'SALES', 'ORDERS', 'ORDNO'),
			foreignKey('SHIP_ORDER_FK', 'LINE', 'SALES', 'ORDERS', 'LINE')
		]]]);

		let [entry] = buildTableKeys(diagram, keys, new Map());

		expect(entry.keys).to.have.length(1);
		expect(entry.keys[0].columns.map(pair => `${pair.column}>${pair.otherShortName}`)).to.deep.equal(['ORDNO>ORDNO', 'LINE>LINE']);
	});

	it('keeps two keys into the same table apart by constraint name', () => {
		let diagram = model([table('SALES', 'ORDERS', ['BILL_TO', 'SHIP_TO'])]);
		let keys = new Map([['SALES.ORDERS', [
			foreignKey('BILL_TO_FK', 'BILL_TO', 'SALES', 'CUSTOMER'),
			foreignKey('SHIP_TO_FK', 'SHIP_TO', 'SALES', 'CUSTOMER')
		]]]);

		expect(buildTableKeys(diagram, keys, new Map())[0].keys.map(key => key.constraintName)).to.deep.equal(['BILL_TO_FK', 'SHIP_TO_FK']);
	});

	it('lists another table\'s key into this one as referencedBy, with the child\'s column as the other column', () => {
		let diagram = model([table('SALES', 'CUSTOMER', ['CUSNO'])]);
		let referencingKeys = new Map([['SALES.CUSTOMER', [referencing('SALES', 'ORDERS', 'ORDERS_CUSTOMER_FK', 'CUSNO', 'CUSNO', 'CUSTOMER_NUMBER')]]]);

		expect(buildTableKeys(diagram, new Map(), referencingKeys)).to.deep.equal([{
			tableId: 'SALES.CUSTOMER',
			keys: [{
				direction: 'referencedBy',
				constraintName: 'ORDERS_CUSTOMER_FK',
				isNew: false,
				otherSchema: 'SALES',
				otherTable: 'ORDERS',
				otherTableId: 'SALES.ORDERS',
				columns: [{column: 'CUSNO', otherShortName: 'CUSNO', otherLongName: 'CUSTOMER_NUMBER'}]
			}]
		}]);
	});

	it('lists a self-reference once, as the table\'s own key', () => {
		let diagram = model([table('HR', 'EMPLOYEE', ['ID', 'MANAGER_ID'])]);
		let keys = new Map([['HR.EMPLOYEE', [foreignKey('EMP_MANAGER_FK', 'MANAGER_ID', 'HR', 'EMPLOYEE')]]]);
		let referencingKeys = new Map([['HR.EMPLOYEE', [referencing('HR', 'EMPLOYEE', 'EMP_MANAGER_FK', 'ID', 'MANAGER_ID')]]]);

		expect(buildTableKeys(diagram, keys, referencingKeys)[0].keys.map(key => key.direction)).to.deep.equal(['references']);
	});

	it('leaves out a table with no keys either way', () => {
		let diagram = model([table('HR', 'EMPLOYEE', ['ID']), table('HR', 'DEPARTMENT', ['ID'])]);
		let keys = new Map([['HR.EMPLOYEE', [foreignKey('EMP_DEPT_FK', 'ID', 'HR', 'DEPARTMENT')]]]);

		expect(buildTableKeys(diagram, keys, new Map()).map(entry => entry.tableId)).to.deep.equal(['HR.EMPLOYEE']);
	});

	it('shares one entry between unnamed keys into the same table and drops a repeated pair', () => {
		let diagram = model([table('SITE', 'WORKORDER', ['CUSNO'])]);
		let keys = new Map([['SITE.WORKORDER', [
			foreignKey(undefined, 'CUSNO', 'SALES', 'CUSTOMER', 'CUSNO'),
			foreignKey(undefined, 'CUSNO', 'SALES', 'CUSTOMER', 'CUSNO')
		]]]);

		let [entry] = buildTableKeys(diagram, keys, new Map());

		expect(entry.keys).to.have.length(1);
		expect(entry.keys[0].constraintName).to.equal('');
		expect(entry.keys[0].columns).to.have.length(1);
	});

	it('shows an imported key flagged New, and drops the placeholder name an unnamed one was given', () => {
		let diagram = model([table('SITE', 'WORKORDER', ['CUSNO', 'REGION'])]);
		let keys = new Map([['SITE.WORKORDER', [
			{...foreignKey('imported-fk-0', 'CUSNO', 'SALES', 'CUSTOMER', 'CUSNO'), isNew: true},
			{...foreignKey('imported-fk-1', 'REGION', 'SALES', 'CUSTOMER', 'REGION'), isNew: true},
			{...foreignKey('WO_REGION_FK', 'REGION', 'SALES', 'REGION', 'REGION'), isNew: true}
		]]]);

		let [entry] = buildTableKeys(diagram, keys, new Map());

		// The two unnamed keys into CUSTOMER stay apart, both shown without a name.
		expect(entry.keys.map(key => [key.otherTable, key.constraintName, key.isNew])).to.deep.equal([
			['CUSTOMER', '', true],
			['CUSTOMER', '', true],
			['REGION', 'WO_REGION_FK', true]
		]);
	});
});
