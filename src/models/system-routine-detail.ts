// The rest of one QSYS2.SYSROUTINES row, read on demand for a single routine (the schema browser's Info
// and Definition tabs) rather than carried in the list every schema loads up front. The body in
// particular can be long, the same reason SystemView leaves out SYSVIEWS.TEXT.
//
// Read with `select *` and mapped field by field, so a column a release doesn't have reads as empty
// instead of failing the lookup.
export interface SystemRoutineDetail {
	schema: string;
	specificName: string;
	externalName: string;
	parameterStyle: string;
	deterministic: string;
	sqlDataAccess: string;
	/** Whether the function is still called when an argument is null. */
	nullCall: string;
	inParms: number;
	outParms: number;
	inoutParms: number;
	resultSets: number;
	created: string;
	lastAltered: string;
	definer: string;
	/** ROUTINE_DEFINITION - the SQL body, empty for an external routine. Only trimmed, never collapsed. */
	definition: string;
}
