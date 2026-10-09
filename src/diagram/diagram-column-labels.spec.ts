import { expect } from 'chai';
import { ResultHeadingLabel } from '../models/result-heading-label.js';
import { DiagramColumn } from '../webview-messages/diagram-messages.js';
import { columnDisplayName, columnTooltipLines, findColumnIdentity, matchesColumnName } from './diagram-column-labels.js';

// A connected column as toDiagramTable produces one: identity is the long name, and all three forms are
// carried alongside it.
function column(options: Partial<DiagramColumn> = {}): DiagramColumn {
	return {
		name: 'EMPLOYEE_ID', shortName: 'EMNO', longName: 'EMPLOYEE_ID', description: 'Employee Code',
		type: 'INTEGER', primaryKey: false, foreignKey: false, identity: false, notNull: false, unique: false, indexed: false, ...options
	};
}

// A diagram saved before aliases were stored: identity and nothing else.
function legacyColumn(name: string): DiagramColumn {
	return {name: name, type: 'CHAR(10)', primaryKey: false, foreignKey: false, identity: false, notNull: false, unique: false, indexed: false};
}

describe('diagram-column-labels', () => {
	describe('columnDisplayName', () => {
		it('shows the first configured option', () => {
			expect(columnDisplayName(column(), [ResultHeadingLabel.SHORT_NAME])).to.equal('EMNO');
			expect(columnDisplayName(column(), [ResultHeadingLabel.LONG_NAME])).to.equal('EMPLOYEE_ID');
			expect(columnDisplayName(column(), [ResultHeadingLabel.DESCRIPTION])).to.equal('Employee Code');
		});

		// A diagram row is one narrow cell - unlike the results grid's stacked header, it can't show two
		// or three names at once, so the rest of the configured options are deliberately ignored.
		it('shows only the first option even when several are configured', () => {
			let labels = [ResultHeadingLabel.SHORT_NAME, ResultHeadingLabel.LONG_NAME, ResultHeadingLabel.DESCRIPTION];

			expect(columnDisplayName(column(), labels)).to.equal('EMNO');
		});

		it('falls through to the next configured option when the first has no value', () => {
			expect(columnDisplayName(column({description: undefined}), [ResultHeadingLabel.DESCRIPTION, ResultHeadingLabel.SHORT_NAME])).to.equal('EMNO');
		});

		it('falls back to the identity when no configured option has a value', () => {
			expect(columnDisplayName(legacyColumn('BADGE'), [ResultHeadingLabel.DESCRIPTION])).to.equal('BADGE');
		});

		it('falls back to the identity when nothing is configured at all', () => {
			expect(columnDisplayName(column(), [])).to.equal('EMPLOYEE_ID');
		});

		it('ignores a configured value it does not recognize', () => {
			expect(columnDisplayName(column(), ['Something Else', ResultHeadingLabel.SHORT_NAME])).to.equal('EMNO');
		});
	});

	describe('matchesColumnName', () => {
		it('matches any of the column\'s name forms', () => {
			expect(matchesColumnName(column(), 'EMNO')).to.be.true;
			expect(matchesColumnName(column(), 'EMPLOYEE_ID')).to.be.true;
		});

		// A heading isn't a name: two columns can share one, and an imported foreign key must never anchor by it.
		it('does not match the description', () => {
			expect(matchesColumnName(column(), 'Employee Code')).to.be.false;
		});

		it('matches case-insensitively', () => {
			expect(matchesColumnName(column(), 'emno')).to.be.true;
		});

		it('does not match an unrelated name', () => {
			expect(matchesColumnName(column(), 'DEPARTMENT_ID')).to.be.false;
		});

		it('still matches a column that only has an identity', () => {
			expect(matchesColumnName(legacyColumn('BADGE'), 'badge')).to.be.true;
		});
	});

	describe('findColumnIdentity', () => {
		// The point of the whole thing: an imported foreign key names its column the short way, and the
		// edge has to anchor to the identity the diagram keys that column by.
		it('resolves a short name to the column identity', () => {
			expect(findColumnIdentity([column()], 'EMNO')).to.equal('EMPLOYEE_ID');
		});

		it('resolves an identity to itself', () => {
			expect(findColumnIdentity([column()], 'EMPLOYEE_ID')).to.equal('EMPLOYEE_ID');
		});

		it('is undefined when no column answers to the name', () => {
			expect(findColumnIdentity([column()], 'NOPE')).to.be.undefined;
		});

		it('picks the first column that answers to the name', () => {
			let columns = [column({name: 'A', shortName: 'X', longName: 'A', description: undefined}), column({name: 'B', shortName: 'X', longName: 'B', description: undefined})];

			expect(findColumnIdentity(columns, 'X')).to.equal('A');
		});
	});

	describe('columnTooltipLines', () => {
		it('reports all three name forms when the column has them', () => {
			expect(columnTooltipLines(column())).to.deep.equal([
				{label: ResultHeadingLabel.SHORT_NAME, value: 'EMNO'},
				{label: ResultHeadingLabel.LONG_NAME, value: 'EMPLOYEE_ID'},
				{label: ResultHeadingLabel.DESCRIPTION, value: 'Employee Code'}
			]);
		});

		it('skips whichever forms the column does not have', () => {
			expect(columnTooltipLines(column({shortName: undefined, description: undefined}))).to.deep.equal([
				{label: ResultHeadingLabel.LONG_NAME, value: 'EMPLOYEE_ID'}
			]);
		});

		it('is empty for a column with only an identity', () => {
			expect(columnTooltipLines(legacyColumn('BADGE'))).to.be.empty;
		});

		it('adds a Primary Key line for a primary key column', () => {
			expect(columnTooltipLines(column({primaryKey: true}))).to.deep.equal([
				{label: ResultHeadingLabel.SHORT_NAME, value: 'EMNO'},
				{label: ResultHeadingLabel.LONG_NAME, value: 'EMPLOYEE_ID'},
				{label: ResultHeadingLabel.DESCRIPTION, value: 'Employee Code'},
				{label: 'Primary Key', value: 'Yes'}
			]);
		});

		it('adds Identity before Primary Key for a column that is both', () => {
			expect(columnTooltipLines({...legacyColumn('RCID'), primaryKey: true, identity: true})).to.deep.equal([
				{label: 'Identity', value: 'Yes'},
				{label: 'Primary Key', value: 'Yes'}
			]);
		});

		it('adds an Identity line for an identity column', () => {
			expect(columnTooltipLines(column({identity: true}))).to.deep.equal([
				{label: ResultHeadingLabel.SHORT_NAME, value: 'EMNO'},
				{label: ResultHeadingLabel.LONG_NAME, value: 'EMPLOYEE_ID'},
				{label: ResultHeadingLabel.DESCRIPTION, value: 'Employee Code'},
				{label: 'Identity', value: 'Yes'}
			]);
		});

		it('adds a Foreign Key line per relationship the column is the source of', () => {
			let lines = columnTooltipLines(legacyColumn('DEPT_ID'), [
				{toTable: 'ACME.DEPARTMENT', toColumn: 'DEPT_ID'},
				{toTable: 'ACME.LOCATION', toColumn: 'LOC_ID'}
			]);

			expect(lines).to.deep.equal([
				{label: 'Foreign Key', value: 'ACME.DEPARTMENT.DEPT_ID'},
				{label: 'Foreign Key', value: 'ACME.LOCATION.LOC_ID'}
			]);
		});

		it('has no Foreign Key line when no targets are given', () => {
			expect(columnTooltipLines(legacyColumn('BADGE'), [])).to.be.empty;
		});
	});
});
