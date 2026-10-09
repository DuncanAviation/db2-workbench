export interface SystemIndexAdvice {
	/** RRN(SYSIXADV) - a unique-per-row id for this query's result set, used as the React key for
	 * the Indexes tab's table rows since SYSIXADV has no natural primary key of its own. */
	id: number;
	schema: string;
	table: string;
	keyColumnsAdvised: string;
	indexType: string;
	reasonAdvised: string;
	timesAdvised: number;
	lastAdvised: Date;
	/** QSYS2.SYSIXADV.NLSSNAME - the sort sequence the advised index would use. */
	sortSequence: string;
	/** QSYS2.SYSIXADV.NLSSDBNAME - the library containing the sortSequence table, when sortSequence
	 * names a custom sort sequence table rather than a symbolic value like *HEX. */
	sortSequenceLibrary: string;
}
