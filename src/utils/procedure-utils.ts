import { Nullable } from './nullable.js';
import { StringUtils } from './string-utils.js';

export class ProcedureUtils {
	/**
	 * The schema an unqualified CALL resolves to: the first schema on the connection's library list,
	 * in list order, that holds a procedure with this name. A schema that isn't on the list never wins,
	 * however many procedures it holds. Undefined when no schema on the list has one.
	 */
	static resolveSchema(libraryList: ProcedureUtils.LibraryListSchema[], procedures: ProcedureUtils.NamedProcedure[], procedureName: string): Nullable<string> {
		let ordered = [...libraryList].sort((first, second) => first.position - second.position);

		return ordered.find(schema => procedures.some(procedure =>
			StringUtils.equalsIgnoreCase(procedure.schema, schema.name) && StringUtils.equalsIgnoreCase(procedure.name, procedureName)))?.name;
	}

	/**
	 * The procedures one schema holds under this name, and the one a CALL with this many arguments runs.
	 * DB2 for i tells procedures of one name apart by their parameter count alone (two with the same
	 * count can't exist), so an exact count is the overload. With no exact match, the overload with the
	 * fewest parameters beyond the argument count is taken, since only trailing parameters with defaults
	 * can be left out. Whether they do have defaults isn't checked: a call that can't run still reaches
	 * the server, which reports its own error.
	 */
	static resolveOverload<T extends ProcedureUtils.CountedProcedure>(procedures: T[], schema: string, procedureName: string, argumentCount: number): ProcedureUtils.Overload<T> {
		let candidates = procedures.filter(candidate =>
			StringUtils.equalsIgnoreCase(candidate.schema, schema) && StringUtils.equalsIgnoreCase(candidate.name, procedureName));

		let chosen = candidates.find(candidate => candidate.parameterCount === argumentCount)
			?? candidates
				.filter(candidate => candidate.parameterCount > argumentCount)
				.sort((first, second) => first.parameterCount - second.parameterCount)[0];

		return {candidates: candidates, overloaded: candidates.length > 1, procedure: chosen};
	}
}

export namespace ProcedureUtils {
	export interface LibraryListSchema {
		name: string;
		position: number;
	}

	export interface NamedProcedure {
		schema: string;
		name: string;
	}

	export interface CountedProcedure extends NamedProcedure {
		/** IN + OUT + INOUT parameters. */
		parameterCount: number;
	}

	export interface Overload<T extends CountedProcedure> {
		/** Every procedure in the schema with this name. */
		candidates: T[];
		/** More than one candidate - the case node-odbc's callProcedure() can't run (see DbConnections.execute). */
		overloaded: boolean;
		/** The candidate the CALL runs, if any fits its argument count. */
		procedure?: T;
	}
}
