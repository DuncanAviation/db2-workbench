import { expect } from 'chai';
import { DiagramColumn, DiagramModel, DiagramTable } from '../webview-messages/diagram-messages.js';
import { ResolvedForeignKey } from './diagram-add-tables.js';
import { findMissingTargets, missingTargetKey } from './diagram-missing-targets.js';

function column(name: string, options: Partial<DiagramColumn> = {}): DiagramColumn {
	return {name: name, type: 'CHAR(10)', primaryKey: false, foreignKey: false, identity: false, notNull: false, unique: false, indexed: false, ...options};
}

function table(schema: string, name: string, columns: DiagramColumn[]): DiagramTable {
	return {id: `${schema}.${name}`, schemaId: schema, name: name, position: {x: 0, y: 0}, columns: columns};
}

function model(tables: DiagramTable[]): DiagramModel {
	return {schemas: [], tables: tables, relationships: []};
}

function foreignKey(fromColumn: string, toSchema: string, toTable: string, toColumn = 'ID'): ResolvedForeignKey {
	return {fromColumn: fromColumn, toSchema: toSchema, toTable: toTable, toColumn: toColumn};
}

describe('diagram-missing-targets', () => {
	it('reports a foreign key whose referenced table is not on the diagram', () => {
		let diagram = model([table('HR', 'EMPLOYEE', [column('DEPARTMENT_ID', {foreignKey: true})])]);
		let keys = new Map([['HR.EMPLOYEE', [foreignKey('DEPARTMENT_ID', 'HR', 'DEPARTMENT', 'DEPARTMENT_ID')]]]);

		expect(findMissingTargets(diagram, keys)).to.deep.equal([{
			tableId: 'HR.EMPLOYEE',
			columnName: 'DEPARTMENT_ID',
			targets: [{targetSchema: 'HR', targetTable: 'DEPARTMENT', targetColumn: 'DEPARTMENT_ID'}]
		}]);
	});

	it('ignores a foreign key whose referenced table is already on the diagram', () => {
		let diagram = model([
			table('HR', 'EMPLOYEE', [column('DEPARTMENT_ID', {foreignKey: true})]),
			table('HR', 'DEPARTMENT', [column('ID', {primaryKey: true})])
		]);
		let keys = new Map([['HR.EMPLOYEE', [foreignKey('DEPARTMENT_ID', 'HR', 'DEPARTMENT')]]]);

		expect(findMissingTargets(diagram, keys)).to.be.empty;
	});

	it('ignores a self-referencing foreign key', () => {
		let diagram = model([table('HR', 'EMPLOYEE', [column('ID', {primaryKey: true}), column('MANAGER_ID', {foreignKey: true})])]);
		let keys = new Map([['HR.EMPLOYEE', [foreignKey('MANAGER_ID', 'HR', 'EMPLOYEE')]]]);

		expect(findMissingTargets(diagram, keys)).to.be.empty;
	});

	it('reports a target in another schema', () => {
		let diagram = model([table('SALES', 'ORDER', [column('EMPLOYEE_ID', {foreignKey: true})])]);
		let keys = new Map([['SALES.ORDER', [foreignKey('EMPLOYEE_ID', 'HR', 'EMPLOYEE')]]]);

		expect(findMissingTargets(diagram, keys).map(target => `${target.targets[0].targetSchema}.${target.targets[0].targetTable}`)).to.deep.equal(['HR.EMPLOYEE']);
	});

	it('skips a foreign key naming a column the table does not render', () => {
		let diagram = model([table('HR', 'EMPLOYEE', [column('ID', {primaryKey: true})])]);
		let keys = new Map([['HR.EMPLOYEE', [foreignKey('DEPARTMENT_ID', 'HR', 'DEPARTMENT')]]]);

		expect(findMissingTargets(diagram, keys)).to.be.empty;
	});

	it('reports one target per column of a composite foreign key', () => {
		let diagram = model([table('HR', 'EMPLOYEE', [column('CO', {foreignKey: true}), column('DEPT', {foreignKey: true})])]);
		let keys = new Map([['HR.EMPLOYEE', [
			foreignKey('CO', 'HR', 'DEPARTMENT', 'CO'),
			foreignKey('DEPT', 'HR', 'DEPARTMENT', 'DEPT')
		]]]);

		expect(findMissingTargets(diagram, keys).map(target => target.columnName)).to.deep.equal(['CO', 'DEPT']);
	});

	it('draws one marker carrying both tables when two foreign keys leave the same column', () => {
		let diagram = model([table('HR', 'EMPLOYEE', [column('CODE', {foreignKey: true})])]);
		let keys = new Map([['HR.EMPLOYEE', [
			foreignKey('CODE', 'HR', 'DEPARTMENT'),
			foreignKey('CODE', 'HR', 'JOB')
		]]]);

		let missing = findMissingTargets(diagram, keys);

		expect(missing).to.have.lengthOf(1);
		expect(missing[0].targets.map(target => target.targetTable)).to.deep.equal(['DEPARTMENT', 'JOB']);
	});

	it('lists a target table once when a composite key reports it per column pair', () => {
		let diagram = model([table('HR', 'EMPLOYEE', [column('CODE', {foreignKey: true})])]);
		let keys = new Map([['HR.EMPLOYEE', [
			foreignKey('CODE', 'HR', 'DEPARTMENT', 'CO'),
			foreignKey('CODE', 'HR', 'DEPARTMENT', 'DEPT')
		]]]);

		let missing = findMissingTargets(diagram, keys);

		expect(missing).to.have.lengthOf(1);
		expect(missing[0].targets).to.deep.equal([{targetSchema: 'HR', targetTable: 'DEPARTMENT', targetColumn: 'CO'}]);
	});

	it('reports targets for every table on the diagram', () => {
		let diagram = model([
			table('HR', 'EMPLOYEE', [column('DEPARTMENT_ID', {foreignKey: true})]),
			table('SALES', 'ORDER', [column('CUSTOMER_ID', {foreignKey: true})])
		]);
		let keys = new Map([
			['HR.EMPLOYEE', [foreignKey('DEPARTMENT_ID', 'HR', 'DEPARTMENT')]],
			['SALES.ORDER', [foreignKey('CUSTOMER_ID', 'SALES', 'CUSTOMER')]]
		]);

		expect(findMissingTargets(diagram, keys).map(target => target.tableId)).to.deep.equal(['HR.EMPLOYEE', 'SALES.ORDER']);
	});

	it('is empty when no foreign keys were supplied at all', () => {
		let diagram = model([table('HR', 'EMPLOYEE', [column('DEPARTMENT_ID', {foreignKey: true})])]);

		expect(findMissingTargets(diagram, new Map())).to.be.empty;
	});

	it('keys a target by table and column', () => {
		expect(missingTargetKey('HR.EMPLOYEE', 'DEPARTMENT_ID')).to.equal('HR.EMPLOYEE.DEPARTMENT_ID');
	});
});
