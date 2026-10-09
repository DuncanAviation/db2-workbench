import { SystemColumn } from '../models/system-column.js';
import { SystemForeignKey } from '../models/system-foreign-key.js';
import { SystemTableKey } from '../models/system-table-key.js';

export type SchemaFormatId = 'dbml' | 'frictionless';

// Every format an import can have come FROM. Wider than SchemaFormatId on purpose: a SQL import has no
// text to parse and can never be an export target, so adding it to SchemaFormatId (and therefore to the
// SchemaFormatConverter/SCHEMA_FORMATS registry) would mean guarding every export site for a format that
// can never appear there.
export type ImportSourceFormat = SchemaFormatId | 'sql';

// Same shape as T, but only K stays required - everything else becomes optional. Lets each Resolved*
// type below be derived from its matching System* DB2 catalog type instead of re-listing every field by
// hand (and risking the two silently drifting apart) - a row that exists only in an import can never
// honestly populate most of a System* type's fields, but a caller-chosen few stay mandatory regardless
// of provenance. Not used for ResolvedIndex: created/lastBuild/lastQueryUsed/lastUsed are typed as ISO
// strings there (not SystemIndex's Date), since ResolvedIndex travels over postMessage/JSON.
type PartialExcept<T, K extends keyof T> = Partial<T> & Pick<T, K>;

export interface ImportedForeignKey {
	/** Absent when the source format has no way to name a constraint (Frictionless has no such concept
	 * at all; DBML's unnamed `Ref:` form carries none either). */
	name?: string;
	columns: string[];
	referencedSchema?: string;
	referencedTable: string;
	referencedColumns: string[];
	/** One of the five SQL standard referential actions (NO ACTION/CASCADE/RESTRICT/SET NULL/SET DEFAULT),
	 * upper-cased to match DB2's own catalog casing. Frictionless has no concept of these at all. */
	updateRule?: string;
	deleteRule?: string;
}

export interface ImportedIndex {
	name?: string;
	columns: string[];
	unique: boolean;
	comment?: string;
}

export interface ImportedUniqueKey {
	/** Absent when the source format has no way to name a constraint (Frictionless), or the source file
	 * declared uniqueness with no name attached (e.g. DBML's inline `[unique]` field flag). */
	name?: string;
	columns: string[];
}

export interface ImportedColumn {
	name: string;
	type: string;
	nullable: boolean;
	/** DB2's long/SQL name, when the source file carried one (DBML's "Long name: X" note prefix,
	 * Frictionless's `x-sqlName`) - kept separate from description so it lands on ResolvedColumn.sqlName
	 * instead of being smashed into the free-text description shown in the Columns tab. */
	sqlName?: string;
	description?: string;
	/** Facts a site-specific metadata source can supply that DBML/Frictionless have no concept of -
	 * carried so a SQL import's Length/Scale/Default Value/Column Position mappings aren't lossy. Field
	 * names match SystemColumn's, since that's where they land on ResolvedColumn. */
	length?: number;
	scale?: number;
	defaultValue?: string;
	colNo?: number;
}

// What sourceLabel holds for a paste (there being no file name to hold instead). A shared constant
// rather than a bare string in two places: the host writes it (SchemaTrees.importFromText) and the
// webview reads it back to decide how to label that import (see buildImportLabel).
export const PASTED_SOURCE_LABEL = 'Pasted text';

export interface ImportProvenance {
	/** Identifies the one import that produced this table, shared by every table that came in with it.
	 * The host stamps a single provenance object onto a whole batch, but that reference identity is lost
	 * crossing postMessage/JSON, so the View Imports dialog groups by this instead. Two imports of the
	 * same file are separate batches and get separate ids. */
	importId: string;
	sourceFormat: ImportSourceFormat;
	/** The imported file's base name - what a help dialog names as "where this came from". */
	sourceLabel: string;
	/** ISO string - this travels through postMessage/JSON. */
	importedAt: string;
}

// What converter.import() produces - deliberately smaller than TableSchema. An external DBML or
// Frictionless file was never guaranteed to carry DB2-only catalog metadata (CCSID, identity/generated
// column state, constraint names, index usage stats, ...), so fabricating placeholder values for
// TableSchema's DB2-shaped fields would just be lying about provenance. This is the shape import()
// produces, and it's honest about what an arbitrary external file can actually supply. `provenance` is
// stamped on by the host after import() returns (converters don't know the source file name) - see
// SchemaFormatConverter.import()'s return type below.
export interface ImportedTableSchema {
	schema?: string;
	name: string;
	/** The table-level comment/label, when the source carried one. Gap-fills ResolvedTable.description
	 * when the connected table has none - see resolveTable. */
	description?: string;
	columns: ImportedColumn[];
	primaryKeyColumns: string[];
	/** Absent for the same reasons as ImportedUniqueKey.name - Frictionless has no name concept at all,
	 * and DBML's inline `[pk]` field flag (as opposed to a named indexes-block entry) carries none either. */
	primaryKeyName?: string;
	uniqueKeys: ImportedUniqueKey[];
	foreignKeys: ImportedForeignKey[];
	indexes: ImportedIndex[];
	provenance: ImportProvenance;
}

// The reconciled, "what should actually be shown/exported" shape - produced by the resolver
// (src/schema-conversion/table-resolver.ts) from a connected table's real data plus zero or more
// imported contributions. Every consumer (tab rendering, export, future DDL generation) works from
// this, never from raw connected/imported data directly - see table-resolver.ts's file comment for why.
//
// Field shape mirrors the matching System* type, but every DB2-only administrative field becomes
// optional - a row that exists only in an import can never honestly populate them. `isNew` flags a
// row that doesn't exist in DB2 at all; ResolvedColumn's `importedFields` additionally flags which
// individual fields on an otherwise-real row came from an import rather than DB2 (empty in phase 1 -
// the connected+imported merge case is a deliberate no-op until later phases).
// isNew/importedFields are ResolvedColumn's own additions, not present on SystemColumn at all.
export type ResolvedColumn = PartialExcept<SystemColumn, 'systemName' | 'dataType' | 'nulls'> & {
	isNew: boolean;
	importedFields: string[];
};

export type ResolvedTableKey = PartialExcept<SystemTableKey, 'constraintType' | 'systemColumnName' | 'ordinalPosition'> & {
	isNew: boolean;
};

export type ResolvedForeignKey = PartialExcept<SystemForeignKey, 'systemColumnName' | 'ordinalPosition' | 'referencedTable' | 'referencedSystemColumnName'> & {
	isNew: boolean;
};

// Not derived via PartialExcept<SystemIndex, ...> like the three Resolved* types above - SystemIndex's
// created/lastBuild/lastQueryUsed/lastUsed are Date, but these travel over postMessage/JSON as ISO
// strings instead, so the field types genuinely diverge from SystemIndex here, not just the optionality.
export interface ResolvedIndex {
	schema?: string;
	tableName?: string;
	partition?: string;
	indexSchema?: string;
	indexName?: string;
	indexType?: string;
	uniqueness: string;
	keyColumns: string;
	size?: number;
	created?: string;
	lastBuild?: string;
	lastQueryUsed?: string | null;
	queryUseCount?: number;
	queryStatisticsUseCount?: number;
	lastUsed?: string | null;
	indexOwner?: string | null;
	comment?: string | null;
	isNew: boolean;
}

export interface ResolvedTable {
	schema: string;
	name: string;
	description?: string;
	/** Whether a real, connected DB2 table backs this - false means every field here came from an
	 * import. See TreeTableEntry (src/webview-messages/schemas-messages.ts) for the tree-level version
	 * of this same idea. */
	existsInDatabase: boolean;
	columns: ResolvedColumn[];
	keys: ResolvedTableKey[];
	foreignKeys: ResolvedForeignKey[];
	indexes: ResolvedIndex[];
}

export interface SchemaFormatConverter {
	id: SchemaFormatId;
	label: string;
	fileExtension: string;
	export(tables: ResolvedTable[]): string;
	import(content: string): Promise<Omit<ImportedTableSchema, 'provenance'>[]>;
}
