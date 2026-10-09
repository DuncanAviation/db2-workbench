import { from, Observable, share } from 'rxjs';

// De-duplicates concurrent async work by key: every caller asking for the same key while its work
// is in flight shares that one run instead of starting another.
export class Sync {
	private static readonly inFlight = new Map<unknown, Observable<unknown>>();

	// The shared run for "key" -- "supplier" is only called when nothing for that key is in flight.
	// The key is forgotten once the run settles, so the next call starts fresh.
	static get<V>(key: unknown, supplier: () => Promise<V>): Observable<V> {
		let existing = Sync.inFlight.get(key);

		if(existing) {
			return <Observable<V>>existing;
		}

		let promise = supplier().finally(() => Sync.inFlight.delete(key));
		let observable = from(promise).pipe(share());
		Sync.inFlight.set(key, observable);
		return observable;
	}
}
