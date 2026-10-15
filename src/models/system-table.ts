export interface SystemTable {
	schema: string;
	name: string;
	/** SYSTABLES.TYPE: 'T' a table, 'P' a physical file, 'M' a materialized query table - see isMqt. */
	tableType: string;
	description: string;
	remarks: string;
	dbName: string;
	alteredTimestamp: Date;
	fileType: string;
	location: string;
	tbDbName: string;
	tbName: string;
	tbMember: string;
	sysTable: string;
	selectOmit: string;
	insertable: string;
	iaspNumber: number;
	enabled: string;
	maintain: string;
	refresh: string;
	/** Null in SYSTABLES unless this is a materialized query table that has been refreshed. */
	refreshTimestamp?: Date;
	isolation: string;
	partTable: string;
	definer: string;
	mqtRstDfr: string;
	decFltRnd: string;
	control: string;
	temporalType: string;
	dropRule: string;
}

export namespace SystemTable {
	/** SYSTABLES.TYPE of a materialized query table. */
	export const MQT_TYPE = 'M';

	// Takes the one field it reads, so the webview's SchemasSystemTable answers as well as SystemTable.
	export function isMqt(table: {tableType?: string}): boolean {
		return table.tableType === MQT_TYPE;
	}
}
