export interface SystemForeignKey {
	schema: string;
	tableName: string;
	constraintName: string;
	columnName: string;
	systemColumnName: string;
	ordinalPosition: number;
	updateRule: string;
	deleteRule: string;
	referencedSchema: string;
	referencedTable: string;
	referencedColumnName: string;
	referencedSystemColumnName: string;
}
