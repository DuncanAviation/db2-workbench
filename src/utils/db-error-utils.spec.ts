import { expect } from 'chai';
import { DbErrorUtils } from './db-error-utils.js';

describe('DbErrorUtils', () => {
	it('toText puts the message first, then one line per part of the driver error chain', () => {
		let text = DbErrorUtils.toText({
			message: '[odbc] Error executing the sql statement',
			driverErrors: [
				{ code: -204, state: '42704', message: 'SQL0204 - MISSING in TESTLIB type *FILE not found.' },
				{ code: -30038, state: 'HY000', message: 'Statement was not prepared.' }
			]
		});

		expect(text).to.equal([
			'[odbc] Error executing the sql statement',
			'Code -204, State 42704: SQL0204 - MISSING in TESTLIB type *FILE not found.',
			'Code -30038, State HY000: Statement was not prepared.'
		].join('\n'));
	});

	it('toText is just the message when there is no driver error chain', () => {
		expect(DbErrorUtils.toText({ message: 'Failed' })).to.equal('Failed');
	});
});
