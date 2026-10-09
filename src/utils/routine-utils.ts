import { SystemRoutineParam } from '../models/system-routine-param.js';
import { ArrayUtils } from './array-utils.js';
import { StringUtils } from './string-utils.js';

export class RoutineUtils {
	/**
	 * The routines that share their schema and name with another - the overloads, which only their
	 * parameters tell apart. Everything else is unique by name and needs no signature to be recognized.
	 */
	static overloaded<T extends RoutineUtils.NamedRoutine>(routines: T[]): T[] {
		return routines.filter(routine => routines.some(other => other !== routine
			&& StringUtils.equalsIgnoreCase(other.schema, routine.schema)
			&& StringUtils.equalsIgnoreCase(other.name, routine.name)));
	}

	/**
	 * Each routine's `NAME(INTEGER, CHAR)` signature, keyed by RoutineUtils.key, built from the SYSPARMS
	 * rows given (which may cover other routines too - each is matched by schema and specific name).
	 */
	static signatures(routines: RoutineUtils.NamedRoutine[], params: SystemRoutineParam[]): Map<string, string> {
		let signatures = new Map<string, string>();

		for(let routine of routines) {
			let owned = params.filter(param => StringUtils.equalsIgnoreCase(param.schema, routine.schema)
				&& StringUtils.equalsIgnoreCase(param.specificName, routine.specificName));

			signatures.set(RoutineUtils.key(routine.schema, routine.specificName), SystemRoutineParam.signature(routine.name, owned));
		}

		return signatures;
	}

	/**
	 * The routines grouped by schema and name, one group per name a statement can call, in first-seen
	 * order. Completion offers one item per group: what gets inserted is the same either way, and DB2 picks
	 * the overload from the arguments.
	 */
	static groupByName<T extends RoutineUtils.NamedRoutine>(routines: T[]): T[][] {
		return Array.from(ArrayUtils.toMapOfArrays(routines, routine => `${routine.schema}.${routine.name}`.toUpperCase(), routine => routine).values());
	}

	static key(schema: string, specificName: string): string {
		return `${schema}.${specificName}`.toUpperCase();
	}
}

export namespace RoutineUtils {
	export interface NamedRoutine {
		schema: string;
		name: string;
		specificName: string;
	}
}
