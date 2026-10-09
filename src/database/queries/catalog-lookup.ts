import { Extension } from '../../extension.js';
import { DbConnections } from '../db-connections.js';

// Runs one of the query classes' hardcoded catalog statements over the worker connection, and - unlike
// a bare internalQuery() - throws when it fails instead of handing back nothing.
//
// internalQuery() reports a failing statement by firing an ERROR event (which is what the user sees, in
// the History tab) and returning undefined, and it returns undefined without even running anything
// when the connection couldn't be opened. Coalescing that to [] made a failed lookup indistinguishable
// from "this table genuinely has no rows", and MemoryCache cached it as exactly that for the life of
// the connection. Throwing keeps the two apart: MemoryCache is the only caller of these lookups, and it
// turns a CatalogLookupError back into [] for its own callers - after the point where it would have
// written a cache slot, so nothing is remembered and the next request queries again.
export async function runCatalogLookup(extension: Extension, options: DbConnections.QueryOptions): Promise<Record<string, unknown>[]> {
	let capturedError: unknown;

	let result = await extension.connections.internalQuery({
		...options,
		onError: error => {
			capturedError = error;
			options.onError?.(error);
		}
	});

	// No catalog SELECT legitimately returns a nullish result - an empty answer is an empty array.
	if(!result) {
		throw new CatalogLookupError(capturedError);
	}

	return <Record<string, unknown>[]>result;
}

/** A catalog lookup that failed (or never ran, because the connection couldn't be opened), as opposed to
 * one that succeeded with no rows. Already reported to the user through internalQuery's ERROR event, so
 * whoever catches it should not surface it a second time. */
export class CatalogLookupError extends Error {
	constructor(readonly driverError: unknown) {
		super(driverError instanceof Error ? driverError.message : 'Catalog lookup failed');
		this.name = 'CatalogLookupError';
	}
}
