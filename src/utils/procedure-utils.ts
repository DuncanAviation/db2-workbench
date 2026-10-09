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
}
