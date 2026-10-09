
// Groups a flat, one-row-per-column list (ResolvedTableKey/ResolvedForeignKey are both shaped this way)
// by constraint name, ordered by ordinalPosition within each group. constraintName is only actually
// absent for a malformed row - the resolver always populates a real or synthetic one (see
// table-resolver.ts) - but the type stays optional so this doesn't silently assume more than it should.
// Shared by both format converters so "what counts as a single-column unique constraint" can't drift
// between them - see [[feedback_consolidate-duplicated-keyword-data]].
export function groupByConstraint<T extends {constraintName?: string; ordinalPosition: number}>(rows: T[]): T[][] {
	let byConstraint = new Map<string, T[]>();
	let nextFallbackId = 0;

	for(let row of rows) {
		let key = row.constraintName ?? `__ungrouped_${nextFallbackId++}`;
		let group = byConstraint.get(key) ?? [];
		group.push(row);
		byConstraint.set(key, group);
	}

	return Array.from(byConstraint.values()).map(group => group.slice().sort((first, second) => first.ordinalPosition - second.ordinalPosition));
}
