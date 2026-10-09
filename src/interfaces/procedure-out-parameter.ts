export interface ProcedureOutParameter {
	name: string;
	/** Raw QSYS2.SYSPARMS PARAMETER_MODE value ("OUT"/"INOUT") - never "IN", those are filtered out
	 * before this is built since the caller already sees IN values in the CALL statement itself. */
	mode: string;
	dataType?: string;
	length?: number;
	scale?: number;
	value: string | number | null;
}
