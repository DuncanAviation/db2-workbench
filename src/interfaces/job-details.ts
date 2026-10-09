export interface JobDetails {
	jobName: string;
	ip: string;
	createdDate: Date;
	/** QSYS2.JOB_INFO.SORT_SEQUENCE_NAME - the sort sequence in effect for this job. */
	sortSequence: string;
	/** QSYS2.JOB_INFO.SORT_SEQUENCE_LIBRARY - the library containing sortSequence's table, when
	 * sortSequence names a custom sort sequence table rather than a symbolic value like *HEX. */
	sortSequenceLibrary: string;
	/** QSYS2.JOB_INFO.LANGUAGE_ID - needed to rebuild a *LANGIDSHR/*LANGIDUNQ sort sequence on a
	 * new connection, since neither symbolic value alone identifies which language table to use. */
	languageId: string;
}