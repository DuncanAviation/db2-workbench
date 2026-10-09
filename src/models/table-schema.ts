import { SystemColumn } from './system-column.js';
import { SystemForeignKey } from './system-foreign-key.js';
import { SystemIndex } from './system-index.js';
import { SystemTable } from './system-table.js';
import { SystemTableKey } from './system-table-key.js';

// The canonical, DB2-sourced representation of one table's full structure - assembled by
// TableSchemaAssembler from data that's always come from a live connection, so every field here is
// real DB2 catalog metadata. This is the hub type schema-format converters export *from* (see
// src/schema-conversion) - it is not what import() produces, since an external DBML/Frictionless file
// can't honestly supply most of these DB2-only fields. See ImportedTableSchema for that direction.
export interface TableSchema {
	table: SystemTable;
	columns: SystemColumn[];
	keys: SystemTableKey[];
	foreignKeys: SystemForeignKey[];
	indexes: SystemIndex[];
}
