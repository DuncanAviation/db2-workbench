// One QSYS2.SYSTRIGGERS row - a trigger defined over a table, read by the schema browser's Triggers tab.
export interface SystemTrigger {
	// The table the trigger is defined over, by system name (SYS_DNAME/SYS_TNAME) - the same name form
	// the schema tree keys its tables by.
	schema: string;
	tableName: string;
	triggerSchema: string;
	triggerName: string;
	// SYSTRIGGERS.TRIGEVENT is INSERT | UPDATE | DELETE | READ, or MULTI for a trigger over more than
	// one event - a MULTI trigger's events are spelled out from EVENT_I/EVENT_U/EVENT_D instead, so
	// this is always display-ready (e.g. "INSERT, UPDATE").
	event: string;
	// BEFORE | AFTER | INSTEAD OF
	timing: string;
	// ROW | STATEMENT
	orientation: string;
	// DB2ROW | DB2SQL
	mode: string;
	actionOrder: number;
	// The WHEN condition, for an SQL trigger that has one.
	condition?: string;
	// The trigger body - absent for an external (native program) trigger, whose logic lives in program.
	actionStatement?: string;
	// The REFERENCING correlation names, where declared.
	oldRow?: string;
	newRow?: string;
	oldTable?: string;
	newTable?: string;
	programLibrary: string;
	programName: string;
	// 'Y' | 'N'
	operative: string;
	enabled: string;
	threadSafe: string;
	multithreadedJobAction: string;
	allowRepeatedChange: string;
	// ALWAYS | ONCHANGE - absent for a trigger that isn't over UPDATE.
	updateCondition?: string;
	secure: string;
	definer: string;
	created: Date;
	lastAltered?: Date;
	description?: string;
	remarks?: string;
}
