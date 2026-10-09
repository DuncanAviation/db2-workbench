import { SystemRoutineParam } from './system-routine-param.js';

// A procedure's parameters are SYSPARMS rows like any routine's, plus the name a CALL uses for the
// procedure they belong to (ROUTINE_NAME, which an overload shares with its siblings - `specificName`
// is the one that tells them apart).
export interface SystemProcedureParam extends SystemRoutineParam {
	procedureName: string;
}
