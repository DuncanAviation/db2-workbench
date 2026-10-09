import { expect } from 'chai';
import { DiagramRelationship } from '../webview-messages/diagram-messages.js';
import { columnKey, columnNamesForTable, columnNameFromKey, relatedColumnKeys } from './diagram-column-selection.js';

function relationship(fromTable: string, fromColumn: string, toTable: string, toColumn: string): DiagramRelationship {
	return {id: `${fromTable}.${fromColumn}->${toTable}.${toColumn}`, fromTable, fromColumn, toTable, toColumn};
}

describe('diagram-column-selection', () => {
	describe('columnKey / columnNameFromKey', () => {
		it('round-trips a column name through a table id that itself contains a dot', () => {
			let key = columnKey('SALES.CUSTOMER', 'ID');
			expect(key).to.equal('SALES.CUSTOMER.ID');
			expect(columnNameFromKey(key, 'SALES.CUSTOMER')).to.equal('ID');
		});

		it('returns null for a key that does not belong to the given table', () => {
			let key = columnKey('SALES.ORDER', 'ID');
			expect(columnNameFromKey(key, 'SALES.CUSTOMER')).to.be.null;
		});
	});

	describe('relatedColumnKeys', () => {
		it('returns null when nothing is selected', () => {
			expect(relatedColumnKeys([], null)).to.be.null;
		});

		it('includes the selection itself even with no relationships at all', () => {
			let result = relatedColumnKeys([], 'SALES.CUSTOMER.ID');
			expect(result).to.deep.equal(new Set(['SALES.CUSTOMER.ID']));
		});

		it('follows a relationship from the FK side to the PK side', () => {
			let relationships = [relationship('SALES.ORDER', 'CUSTOMER_ID', 'SALES.CUSTOMER', 'ID')];
			let result = relatedColumnKeys(relationships, 'SALES.ORDER.CUSTOMER_ID');
			expect(result).to.deep.equal(new Set(['SALES.ORDER.CUSTOMER_ID', 'SALES.CUSTOMER.ID']));
		});

		it('follows a relationship from the PK side back to every FK side referencing it', () => {
			let relationships = [
				relationship('SALES.ORDER', 'CUSTOMER_ID', 'SALES.CUSTOMER', 'ID'),
				relationship('HR.EMPLOYEE', 'SALES_REP_FOR_CUSTOMER_ID', 'SALES.CUSTOMER', 'ID')
			];
			let result = relatedColumnKeys(relationships, 'SALES.CUSTOMER.ID');
			expect(result).to.deep.equal(new Set(['SALES.CUSTOMER.ID', 'SALES.ORDER.CUSTOMER_ID', 'HR.EMPLOYEE.SALES_REP_FOR_CUSTOMER_ID']));
		});

		it('does not include a column from an unrelated relationship', () => {
			let relationships = [relationship('SALES.ORDER', 'CUSTOMER_ID', 'SALES.CUSTOMER', 'ID')];
			let result = relatedColumnKeys(relationships, 'HR.EMPLOYEE.ID');
			expect(result).to.deep.equal(new Set(['HR.EMPLOYEE.ID']));
		});
	});

	describe('columnNamesForTable', () => {
		it('extracts only the names belonging to the given table, dropping the rest', () => {
			let keys = new Set(['SALES.CUSTOMER.ID', 'SALES.ORDER.CUSTOMER_ID', 'SALES.CUSTOMER.NAME']);
			expect(columnNamesForTable(keys, 'SALES.CUSTOMER')).to.deep.equal(new Set(['ID', 'NAME']));
		});

		it('returns an empty set when no keys belong to the table', () => {
			expect(columnNamesForTable(new Set(['SALES.ORDER.ID']), 'SALES.CUSTOMER')).to.deep.equal(new Set());
		});
	});
});
