import { expect } from 'chai';
import { ResultHeadingLabel } from '../models/result-heading-label.js';
import { ColumnNames, ColumnNameUtils } from './column-name-utils.js';

const EMPLOYEE_CODE = {systemName: 'EMNO', sqlName: 'EMPLOYEE_CODE', heading: 'Employee Code'};

function names(overrides: Partial<ColumnNames> = {}): ColumnNames {
	return {...ColumnNameUtils.fromSystemColumn(EMPLOYEE_CODE), ...overrides};
}

describe('ColumnNameUtils', () => {
	describe('labels', () => {
		it('follows the configured order', () => {
			expect(ColumnNameUtils.labels(names(), [ResultHeadingLabel.SHORT_NAME, ResultHeadingLabel.DESCRIPTION])).to.deep.equal(['EMNO', 'Employee Code']);
			expect(ColumnNameUtils.labels(names(), [ResultHeadingLabel.LONG_NAME, ResultHeadingLabel.SHORT_NAME])).to.deep.equal(['EMPLOYEE_CODE', 'EMNO']);
		});

		it('drops repeats, such as a column whose short and long names are the same', () => {
			let sameBoth = ColumnNameUtils.fromSystemColumn({systemName: 'ID', sqlName: 'ID'});
			expect(ColumnNameUtils.labels(sameBoth, [ResultHeadingLabel.SHORT_NAME, ResultHeadingLabel.LONG_NAME])).to.deep.equal(['ID']);
		});

		it('skips an option the column has no value for, and falls back to the identity when none apply', () => {
			expect(ColumnNameUtils.labels(names({description: ''}), [ResultHeadingLabel.DESCRIPTION, ResultHeadingLabel.SHORT_NAME])).to.deep.equal(['EMNO']);
			expect(ColumnNameUtils.labels({identity: 'COMPUTED'}, [ResultHeadingLabel.SHORT_NAME])).to.deep.equal(['COMPUTED']);
			expect(ColumnNameUtils.labels(names(), [])).to.deep.equal(['EMNO']);
		});

		it('ignores a configured value it does not recognize', () => {
			expect(ColumnNameUtils.labels(names(), ['Something Else', ResultHeadingLabel.LONG_NAME])).to.deep.equal(['EMPLOYEE_CODE']);
		});
	});

	describe('displayName', () => {
		it('is the first applicable label', () => {
			expect(ColumnNameUtils.displayName(names(), [ResultHeadingLabel.DESCRIPTION, ResultHeadingLabel.SHORT_NAME])).to.equal('Employee Code');
			expect(ColumnNameUtils.displayName(names({description: undefined}), [ResultHeadingLabel.DESCRIPTION, ResultHeadingLabel.SHORT_NAME])).to.equal('EMNO');
		});
	});

	describe('buildLabelMap', () => {
		// The results grid: raw keys are long names, and the lookup is keyed by them.
		let lookup = new Map([['EMPLOYEE_CODE', EMPLOYEE_CODE]]);

		it('labels a raw long-name key by the configured short name', () => {
			expect(ColumnNameUtils.buildLabelMap(lookup, ['EMPLOYEE_CODE'], [ResultHeadingLabel.SHORT_NAME])).to.deep.equal({EMPLOYEE_CODE: ['EMNO']});
		});

		it('matches the lookup case-insensitively but keeps the key as given', () => {
			expect(ColumnNameUtils.buildLabelMap(lookup, ['employee_code'], [ResultHeadingLabel.SHORT_NAME])).to.deep.equal({employee_code: ['EMNO']});
		});

		it('treats a key with no catalog match as its own long name', () => {
			let labelMap = ColumnNameUtils.buildLabelMap(lookup, ['TOTAL'], [ResultHeadingLabel.SHORT_NAME, ResultHeadingLabel.LONG_NAME]);
			expect(labelMap).to.deep.equal({TOTAL: ['TOTAL']});
		});
	});

	describe('labelForKey / labelsForKey', () => {
		let labelMap = {EMPLOYEE_CODE: ['EMNO', 'Employee Code'], EMPTY: []};

		it('reads the map', () => {
			expect(ColumnNameUtils.labelForKey(labelMap, 'EMPLOYEE_CODE')).to.equal('EMNO');
			expect(ColumnNameUtils.labelsForKey(labelMap, 'EMPLOYEE_CODE')).to.deep.equal(['EMNO', 'Employee Code']);
		});

		it('falls back to the key itself when the map has nothing for it', () => {
			expect(ColumnNameUtils.labelForKey(labelMap, 'MISSING')).to.equal('MISSING');
			expect(ColumnNameUtils.labelsForKey(labelMap, 'EMPTY')).to.deep.equal(['EMPTY']);
		});
	});

	describe('aliases / matches', () => {
		it('matches every name form, case-insensitively', () => {
			expect(ColumnNameUtils.matches(names(), 'EMNO')).to.be.true;
			expect(ColumnNameUtils.matches(names(), 'employee_code')).to.be.true;
		});

		it('never matches the description', () => {
			expect(ColumnNameUtils.aliases(names())).to.deep.equal(['EMNO', 'EMPLOYEE_CODE']);
			expect(ColumnNameUtils.matches(names(), 'Employee Code')).to.be.false;
		});

		it('matches an identity that is neither the short nor the long name', () => {
			expect(ColumnNameUtils.matches({identity: 'BADGE'}, 'badge')).to.be.true;
		});
	});

	describe('find / findSystemColumn', () => {
		let columns = [{systemName: 'DPCD', sqlName: 'DEPARTMENT_CODE'}, EMPLOYEE_CODE];

		it('finds a catalog column by either name', () => {
			expect(ColumnNameUtils.findSystemColumn(columns, 'EMPLOYEE_CODE')).to.equal(EMPLOYEE_CODE);
			expect(ColumnNameUtils.findSystemColumn(columns, 'emno')).to.equal(EMPLOYEE_CODE);
			expect(ColumnNameUtils.findSystemColumn(columns, 'Employee Code')).to.be.undefined;
		});

		it('finds an imported column declared by its long name from a short name it also carries', () => {
			let imported = [{name: 'EMPLOYEE_CODE', sqlName: undefined}, {name: 'X', sqlName: 'EMNO'}];
			expect(ColumnNameUtils.find(imported, 'EMNO', ColumnNameUtils.fromImportedColumn)).to.equal(imported[1]);
		});
	});

	describe('buildResolver', () => {
		it('resolves any name form to its column', () => {
			let resolve = ColumnNameUtils.buildResolver([EMPLOYEE_CODE], ColumnNameUtils.fromSystemColumn);
			expect(resolve('employee_code')).to.equal(EMPLOYEE_CODE);
			expect(resolve('EMNO')).to.equal(EMPLOYEE_CODE);
			expect(resolve('NOPE')).to.be.undefined;
		});

		it('gives a name two columns answer to to the earlier one, as find does', () => {
			let first = {systemName: 'A', sqlName: 'SHARED'};
			let second = {systemName: 'SHARED', sqlName: 'B'};
			let resolve = ColumnNameUtils.buildResolver([first, second], ColumnNameUtils.fromSystemColumn);
			expect(resolve('SHARED')).to.equal(first);
			expect(ColumnNameUtils.findSystemColumn([first, second], 'SHARED')).to.equal(first);
		});
	});
});
