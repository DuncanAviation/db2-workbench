import { expect } from 'chai';
import { chooseEdgeHandles, TABLE_MIDDLE_HANDLE_ID } from './diagram-edge-routing.js';

describe('diagram-edge-routing', () => {
	describe('chooseEdgeHandles', () => {
		it('exits the source table\'s right side and enters the target\'s left side when source is to the left', () => {
			expect(chooseEdgeHandles('CUSTOMER_ID', 'ID', 0, 300, true)).to.deep.equal({
				sourceHandle: 'CUSTOMER_ID-source-right',
				targetHandle: 'ID-target-left'
			});
		});

		it('exits the source table\'s left side and enters the target\'s right side when source is to the right', () => {
			expect(chooseEdgeHandles('CUSTOMER_ID', 'ID', 300, 0, true)).to.deep.equal({
				sourceHandle: 'CUSTOMER_ID-source-left',
				targetHandle: 'ID-target-right'
			});
		});

		it('defaults to the traditional right/left pairing on a tie (same x)', () => {
			expect(chooseEdgeHandles('CUSTOMER_ID', 'ID', 150, 150, true)).to.deep.equal({
				sourceHandle: 'CUSTOMER_ID-source-right',
				targetHandle: 'ID-target-left'
			});
		});

		it('anchors to the table-middle handle instead of the column when not expanded', () => {
			expect(chooseEdgeHandles('CUSTOMER_ID', 'ID', 0, 300, false)).to.deep.equal({
				sourceHandle: `${TABLE_MIDDLE_HANDLE_ID}-source-right`,
				targetHandle: `${TABLE_MIDDLE_HANDLE_ID}-target-left`
			});
		});

		it('still picks the correct left/right side by table position when not expanded', () => {
			expect(chooseEdgeHandles('CUSTOMER_ID', 'ID', 300, 0, false)).to.deep.equal({
				sourceHandle: `${TABLE_MIDDLE_HANDLE_ID}-source-left`,
				targetHandle: `${TABLE_MIDDLE_HANDLE_ID}-target-right`
			});
		});
	});
});
