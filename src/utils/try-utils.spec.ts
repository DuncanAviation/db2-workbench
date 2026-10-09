import { expect } from 'chai';
import { lastValueFrom } from 'rxjs';
import { Sync } from './sync.js';
import { TryUtils } from './try-utils.js';

describe('TryUtils', () => {
	it('tryAsync resolves to the result, or hands a failure to onError with its context and cause', async () => {
		expect(await TryUtils.tryAsync({context: 'ok', try: () => Promise.resolve(5)})).to.equal(5);

		let cause = new Error('boom');
		let handled: Error | undefined;
		let result = await TryUtils.tryAsync({context: 'loading x', try: () => Promise.reject(cause), onError: error => {
			handled = error;
		}});

		expect(result).to.equal(undefined);
		expect(handled?.message).to.contain('loading x');
		expect(handled?.cause).to.equal(cause);
	});

	it('tryAsync survives an onError that throws', async () => {
		let original = console.error;
		console.error = () => undefined;

		try {
			let result = await TryUtils.tryAsync({context: 'x', try: () => Promise.reject(new Error('a')), onError: () => {
				throw new Error('b');
			}});
			expect(result).to.equal(undefined);
		} finally {
			console.error = original;
		}
	});
});

describe('Sync', () => {
	it('shares one in-flight run per key, and starts fresh once it settles', async () => {
		let calls = 0;
		let supplier = async () => ++calls;

		let [first, second] = await Promise.all([lastValueFrom(Sync.get('key', supplier)), lastValueFrom(Sync.get('key', supplier))]);
		expect([first, second, calls]).to.deep.equal([1, 1, 1]);

		expect(await lastValueFrom(Sync.get('key', supplier))).to.equal(2);
	});
});
