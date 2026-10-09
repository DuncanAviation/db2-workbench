import { SpParser } from '../utils/sp-parser.js';

// One row of QSYS2.SYSPARMS. A function's rows include its result as well as its parameters, told
// apart by `rowType`: a scalar function has one result row (two when it casts its result), and a table
// function has one result row per column it returns.
export interface SystemRoutineParam {
	schema: string;
	/** SPECIFIC_NAME - the overload these rows belong to (see SystemRoutine). */
	specificName: string;
	rowType: SystemRoutineParam.RowType;
	position: number;
	parameterMode: SpParser.ParameterMode;
	name: string;
	dataType: string;
	scale: number;
	precision: number;
	length: number;
	description: string;
	default: string;
}

export namespace SystemRoutineParam {
	/**
	 * 'P' a parameter, 'R' a result before casting, 'C' a result after casting. On a live system a scalar
	 * function's return is its 'C' row, with an 'R' row beside it only when it declares CAST FROM, and a
	 * table function's columns are its 'R' rows.
	 */
	export type RowType = 'P' | 'R' | 'C';

	export function parameters(rows: SystemRoutineParam[]): SystemRoutineParam[] {
		return rows.filter(row => row.rowType === 'P');
	}

	// `NAME(INTEGER, CHAR)` - how an overload is told apart from its siblings in the tree.
	export function signature(name: string, rows: SystemRoutineParam[]): string {
		let types = parameters(rows)
			.sort((first, second) => first.position - second.position)
			.map(row => row.dataType);

		return `${name}(${types.join(', ')})`;
	}
}
