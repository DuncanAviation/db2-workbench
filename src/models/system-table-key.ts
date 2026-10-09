export interface SystemTableKey {
	schema: string;
	tableName: string;
	constraintName: string;
	// Full-text value from QSYS2.SYSCST.CONSTRAINT_TYPE on IBM i - 'PRIMARY KEY' or 'UNIQUE'.
	constraintType: string;
	columnName: string;
	systemColumnName: string;
	ordinalPosition: number;
}
