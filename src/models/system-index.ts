import { Nullable } from '../utils/nullable.js';

export interface SystemIndex {
	schema: string;
	tableName: string;
	partition: string;
	indexSchema: string;
	indexName: string;
	// QSYS2.SYSPARTITIONINDEXSTAT.INDEX_TYPE - already readable: INDEX | LOGICAL | PHYSICAL | PRIMARY KEY | UNIQUE | REFERENTIAL
	indexType: string;
	// Mapped from QSYS2.SYSPARTITIONINDEXSTAT.UNIQUE's numeric code (0-4) - see DbConnections.describeIndexUniqueness()
	uniqueness: string;
	keyColumns: string;
	size: number;
	created: Date;
	lastBuild: Date;
	lastQueryUsed: Nullable<Date>;
	queryUseCount: number;
	queryStatisticsUseCount: number;
	lastUsed: Nullable<Date>;
	// From a left join to QSYS2.SYSINDEXES - null for non-SQL indexes (logical files, constraints).
	indexOwner: Nullable<string>;
	comment: Nullable<string>;
}
