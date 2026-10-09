export interface ConnectionConfig {
	id: string;
	name: string;
	host: string;
	userName: string;
	defaultTableSchema: string;
	connectionString?: string;
	/** Which DbDriver opens this connection - see DbDrivers. Absent means ODBC, which is what every
	 * connection configured before drivers existed means. */
	driver?: string;
	resultBorderColor?: string;
	/** Ids of the `db2-workbench.sqlImports` entries that run against this connection - see
	 * SqlSchemaImports. The link lives here, on the one owner, rather than as a list of connections on
	 * each import: "which connections use this import" is then derived and can never drift. An id with
	 * no matching entry is ignored. */
	sqlImportIds?: string[];
}
