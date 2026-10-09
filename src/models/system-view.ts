// One row of QSYS2.SYSVIEWS, joined to its QSYS2.SYSTABLES entry for the description. `schema`/`name`
// are the short system names, the same form SystemTable uses, so a view lands in the same tree bucket
// (and answers the same schema/table lookups) as the tables beside it; the long SQL names are kept
// alongside rather than replacing them.
export interface SystemView {
	schema: string;
	name: string;
	/** Long SQL schema name (SYSVIEWS.TABLE_SCHEMA / DBNAME). */
	sqlSchema: string;
	/** Long SQL view name (SYSVIEWS.TABLE_NAME / NAME). */
	sqlName: string;
	description: string;
	remarks: string;
	owner: string;
	definer: string;
	sequenceNumber: number;
	checkOption: string;
	iaspNumber: number;
	insertable: string;
	updatable: string;
	deletable: string;
	decFltRnd: string;
}
