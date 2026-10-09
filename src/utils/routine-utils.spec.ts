import { expect } from 'chai';
import { SystemRoutineParam } from '../models/system-routine-param.js';
import { RoutineUtils } from './routine-utils.js';

function routine(schema: string, name: string, specificName = name): RoutineUtils.NamedRoutine {
	return {schema: schema, name: name, specificName: specificName};
}

function param(schema: string, specificName: string, rowType: SystemRoutineParam.RowType, position: number, dataType: string): SystemRoutineParam {
	return {
		schema: schema,
		specificName: specificName,
		rowType: rowType,
		position: position,
		parameterMode: 'IN' as SystemRoutineParam['parameterMode'],
		name: `P${position}`,
		dataType: dataType,
		scale: 0,
		precision: 0,
		length: 0,
		description: '',
		default: ''
	};
}

describe('RoutineUtils', () => {
	describe('overloaded', () => {
		it('finds the routines sharing a schema and name, case-insensitively', () => {
			let first = routine('SALES', 'ORDER_TOTAL');
			let second = routine('sales', 'order_total', 'ORDER_TOTAL_CURRENCY');
			let unique = routine('SALES', 'OPEN_ORDERS');
			expect(RoutineUtils.overloaded([first, second, unique])).to.deep.equal([first, second]);
		});

		// Two schemas each holding one function by the same name aren't overloads of each other - each is
		// still the only one by that name in its own schema node.
		it('does not count a same-named routine in another schema', () => {
			expect(RoutineUtils.overloaded([routine('SALES', 'ORDER_TOTAL'), routine('ARCHIVE', 'ORDER_TOTAL')])).to.deep.equal([]);
		});
	});

	describe('signatures', () => {
		it('lists parameter types in position order, leaving out result rows', () => {
			let params = [
				param('SALES', 'ORDER_TOTAL_CURRENCY', 'P', 2, 'CHAR'),
				param('SALES', 'ORDER_TOTAL_CURRENCY', 'C', 1, 'DECIMAL'),
				param('SALES', 'ORDER_TOTAL_CURRENCY', 'P', 1, 'INTEGER'),
				param('SALES', 'ORDER_TOTAL', 'P', 1, 'INTEGER')
			];

			let signatures = RoutineUtils.signatures([routine('SALES', 'ORDER_TOTAL', 'ORDER_TOTAL_CURRENCY'), routine('SALES', 'ORDER_TOTAL')], params);

			expect(signatures.get(RoutineUtils.key('SALES', 'ORDER_TOTAL_CURRENCY'))).to.equal('ORDER_TOTAL(INTEGER, CHAR)');
			expect(signatures.get(RoutineUtils.key('SALES', 'ORDER_TOTAL'))).to.equal('ORDER_TOTAL(INTEGER)');
		});

		it('gives a routine with no parameters empty parentheses', () => {
			let signatures = RoutineUtils.signatures([routine('SALES', 'NOW_PLUS')], []);
			expect(signatures.get(RoutineUtils.key('SALES', 'NOW_PLUS'))).to.equal('NOW_PLUS()');
		});
	});
});
