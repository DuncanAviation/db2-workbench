export interface SystemColumn {
	schema: string;
	tableName: string;
	colNo: number;
	// Short "system" name (SYS_CNAME, e.g. "EMNO") - what most hand-written SQL against these files
	// actually uses, and what autocomplete inserts.
	systemName: string;
	// Long SQL name (NAME, e.g. "ACCT_EMPLOYEENO").
	sqlName: string;
	heading: string;
	text: string;
	dataType: string;
	length?: number;
	scale?: number;
	precision?: number;
	nulls: string;
	identity: string;
	generated: string;
	identityStart?: number;
	increment?: number;
	minValue?: number;
	maxValue?: number;
	cycle: string;
	cache?: number;
	ccsid?: number;
	// Not surfaced in the Columns tab yet - carried on the interface now so the future column-editing
	// feature (generating ALTER TABLE statements) doesn't need a second SYSCOLUMNS2 query/migration.
	defaultValue?: string;
	hasDefault: string;
	hidden: string;
	updatable: string;
}
