// One row of QSYS2.SYSVIEWS, joined to its QSYS2.SYSTABLES entry for the description - or one logical file,
// from its own SYSTABLES row (type 'L'; see viewType). `schema`/`name` are the short system names, the same
// form SystemTable uses, so a view lands in the same tree bucket (and answers the same schema/table lookups)
// as the tables beside it; the long SQL names are kept alongside rather than replacing them.
//
// A logical file is listed with the views because it behaves like one everywhere the extension looks: a
// query can select from it, it has columns but no keys or constraints of its own, and its rows belong to
// the physical file(s) it is built over. The schema tree lists the two under separate nodes.
export interface SystemView {
	schema: string;
	name: string;
	/** SYSTABLES.TYPE: 'V' a view, 'L' a logical file - see isLogicalFile. */
	viewType: string;
	/** Long SQL schema name (SYSVIEWS.TABLE_SCHEMA / DBNAME). */
	sqlSchema: string;
	/** Long SQL view name (SYSVIEWS.TABLE_NAME / NAME). */
	sqlName: string;
	description: string;
	remarks: string;
	owner: string;
	iaspNumber: number;
	insertable: string;
	/** From SYSVIEWS, so absent for a logical file. */
	definer?: string;
	sequenceNumber?: number;
	checkOption?: string;
	updatable?: string;
	deletable?: string;
	decFltRnd?: string;
	/** Logical files only: SYSTABLES.SELECTOMIT, 'Y' when the file has select/omit criteria. */
	selectOmit?: string;
}

export namespace SystemView {
	/** SYSTABLES.TYPE of a view. */
	export const VIEW_TYPE = 'V';
	/** SYSTABLES.TYPE of a logical file. */
	export const LOGICAL_FILE_TYPE = 'L';

	// Takes the one field it reads, so the webview's SchemasSystemView answers as well as SystemView.
	export function isLogicalFile(view: {viewType?: string}): boolean {
		return view.viewType === LOGICAL_FILE_TYPE;
	}
}
