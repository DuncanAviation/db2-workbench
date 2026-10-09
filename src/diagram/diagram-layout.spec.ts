import { expect } from 'chai';
import { LayoutEdge, LayoutNode, layoutTables } from './diagram-layout.js';

function node(id: string, groupId: string, options: Partial<LayoutNode> = {}): LayoutNode {
	return {id: id, groupId: groupId, width: 390, height: 108, ...options};
}

function requireDefined<T>(value: T | undefined, message: string): T {
	if(value === undefined) {
		throw new Error(message);
	}

	return value;
}

describe('diagram-layout', () => {
	it('returns nothing for an empty input', async () => {
		let result = await layoutTables([], []);

		expect(result.positions.size).to.equal(0);
		expect(result.groupBounds.size).to.equal(0);
	});

	it('positions every node and produces bounds for every group', async () => {
		let result = await layoutTables([node('HR.EMPLOYEE', 'HR'), node('SALES.ORDER', 'SALES')], []);

		expect([...result.positions.keys()]).to.have.members(['HR.EMPLOYEE', 'SALES.ORDER']);
		expect([...result.groupBounds.keys()]).to.have.members(['HR', 'SALES']);
	});

	it('places every table fully inside its own group\'s bounds', async () => {
		let inputs = [
			node('HR.EMPLOYEE', 'HR'), node('HR.DEPARTMENT', 'HR', {height: 60}),
			node('SALES.ORDER', 'SALES')
		];
		let heightById = new Map(inputs.map(input => [input.id, input.height]));
		let result = await layoutTables(inputs, []);

		for(let [tableId, position] of result.positions) {
			let groupId = tableId.split('.')[0];
			let bounds = requireDefined(result.groupBounds.get(groupId), `missing bounds for ${groupId}`);
			let height = requireDefined(heightById.get(tableId), `missing height for ${tableId}`);

			expect(position.x).to.be.greaterThanOrEqual(bounds.x);
			expect(position.y).to.be.greaterThanOrEqual(bounds.y);
			expect(position.x + 390).to.be.lessThanOrEqual(bounds.x + bounds.width);
			expect(position.y + height).to.be.lessThanOrEqual(bounds.y + bounds.height);
		}
	});

	it('does not overlap two groups\' bounds', async () => {
		let result = await layoutTables([node('HR.EMPLOYEE', 'HR'), node('SALES.ORDER', 'SALES')], []);

		let hr = requireDefined(result.groupBounds.get('HR'), 'missing bounds for HR');
		let sales = requireDefined(result.groupBounds.get('SALES'), 'missing bounds for SALES');
		let overlapsX = hr.x < sales.x + sales.width && sales.x < hr.x + hr.width;
		let overlapsY = hr.y < sales.y + sales.height && sales.y < hr.y + hr.height;

		expect(overlapsX && overlapsY).to.be.false;
	});

	it('handles a relationship that crosses group boundaries without dropping either table', async () => {
		let edges: LayoutEdge[] = [{fromId: 'SALES.ORDER', toId: 'HR.EMPLOYEE'}];
		let result = await layoutTables([node('HR.EMPLOYEE', 'HR'), node('SALES.ORDER', 'SALES')], edges);

		expect(result.positions.has('HR.EMPLOYEE')).to.be.true;
		expect(result.positions.has('SALES.ORDER')).to.be.true;
	});

	it('groups nodes into the same box regardless of input order', async () => {
		let result = await layoutTables([
			node('HR.EMPLOYEE', 'HR'), node('SALES.ORDER', 'SALES'), node('HR.DEPARTMENT', 'HR')
		], []);

		expect(result.groupBounds.size).to.equal(2);
	});
});
