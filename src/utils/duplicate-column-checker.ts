import { DbColumnDefinition } from '../database/drivers/db-driver.js';

import { Nullable } from './nullable.js';

// DbResult.columns comes straight from the driver's own column metadata and keeps
// one entry per physical output column, even when two share a name - unlike the row objects
// themselves, which collapse duplicate keys and silently keep only the last one's value. Checking
// here (instead of parsing the SELECT list) catches every source of a name collision - aliasing,
// unqualified join columns, SELECT * across joined tables - without needing a real SQL AST.
export class DuplicateColumnChecker {
	static check(columns: Nullable<DbColumnDefinition[]>): Nullable<DuplicateColumnChecker.Result> {
		if(!columns?.length || !columns) {
			return undefined;
		}

		let seen = new Set<string>();
		let duplicateNames = new Set<string>();

		for(let column of columns) {
			if(seen.has(column.name)) {
				duplicateNames.add(column.name);
			}

			seen.add(column.name);
		}

		if(duplicateNames.size === 0) {
			return undefined;
		}

		return {duplicateNames: Array.from(duplicateNames)};
	}
}

export namespace DuplicateColumnChecker {
	export interface Result {
		duplicateNames: string[];
	}
}
