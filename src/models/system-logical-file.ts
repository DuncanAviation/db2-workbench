// One logical file's QSYS2.SYSFILES row - what DSPFD would say about it, read on demand when its Info or
// Source tab opens. SystemView carries the little the tree needs; this carries the rest. Timestamps stay
// strings, since this crosses to the webview as JSON.
export interface SystemLogicalFile {
	schema: string;
	name: string;
	text?: string;
	owner?: string;
	/** SYSFILES.ALTEREDTS - when the file was created or last changed. */
	alteredTimestamp?: string;
	/** The physical files it is built over, in order - more than one for a join or multi-format file. */
	basedOn: SystemLogicalFile.BasedOnFile[];
	/** SYSFILES.AP_TYPE as the system words it - "KEYED UNIQUE", "ARRIVAL" and so on. */
	accessPathType?: string;
	keyFieldCount?: number;
	/** The key fields in order, as SYSPARTITIONINDEXSTAT.COLUMN_NAMES lists them ("CUSNO, WONO DESC"). Absent for
	 * an arrival-sequence file, or when the lookup found no index row for it. */
	keyFields?: string;
	/** SYSFILES.MAINT - *IMMED, *DLY or *REBLD. */
	maintenance?: string;
	selectOmit: boolean;
	joinLogical: boolean;
	dynamicSelection: boolean;
	/** The record format name - the first one, for a multi-format file. */
	formatName?: string;
}

export namespace SystemLogicalFile {
	export interface BasedOnFile {
		library: string;
		file: string;
		member?: string;
		/** The logical file's record format over this physical file. */
		format?: string;
	}

	/** Where a file's DDS was compiled from - see CatalogQueries.getFileSource. */
	export interface SourceMember {
		library: string;
		file: string;
		member: string;
	}
}
