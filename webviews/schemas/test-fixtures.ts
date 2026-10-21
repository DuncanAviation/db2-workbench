import type { ImportedTableSchema } from '../../src/schema-conversion/schema-format-converter';
import type { SchemasRoutineParam, SchemasSystemRoutine, SchemasSystemTable, SchemasSystemView } from '../../src/webview-messages/schemas-messages';

// Fixtures shared by the schemas webview's specs (jsdom and browser). Typed rather than cast, so a
// field added to SchemasSystemTable fails `tsc -p webviews` here instead of arriving at runtime as
// undefined - vitest itself doesn't typecheck.

/** A connected table's QSYS2.SYSTABLES row, with every catalog field filled in with a plain value. */
export function systemTable(schema: string, name: string, overrides: Partial<SchemasSystemTable> = {}): SchemasSystemTable {
	return {
		schema, name, description: '', remarks: '', dbName: name, alteredTimestamp: '2026-09-01T00:00:00.000Z', fileType: 'D', location: '',
		tbDbName: schema, tbName: name, tbMember: '', sysTable: 'N', selectOmit: 'N', insertable: 'Y', iaspNumber: 0, enabled: 'Y',
		tableType: 'T', maintain: '', refresh: '', isolation: '', partTable: '', definer: '', mqtRstDfr: '',
		decFltRnd: '', control: '', temporalType: '', dropRule: '',
		...overrides
	};
}

/** A view's QSYS2.SYSVIEWS row, joined description included. */
export function systemView(schema: string, name: string, overrides: Partial<SchemasSystemView> = {}): SchemasSystemView {
	return {
		schema, name, sqlSchema: schema, sqlName: name, description: '', remarks: '', owner: 'QSECOFR', definer: 'QSECOFR', sequenceNumber: 1,
		checkOption: 'N', iaspNumber: 0, insertable: 'NO', updatable: 'N', deletable: 'N', decFltRnd: '',
		...overrides
	};
}

/** A user-defined scalar SQL function's QSYS2.SYSROUTINES row, as the tree carries it. */
export function systemFunction(schema: string, name: string, overrides: Partial<SchemasSystemRoutine> = {}): SchemasSystemRoutine {
	return {
		schema, name, specificName: name, sqlSchema: schema, routineType: 'FUNCTION', functionType: 'S', functionOrigin: 'Q', body: 'SQL',
		language: 'SQL', description: '', parameterCount: 0,
		...overrides
	};
}

/** An SQL procedure's QSYS2.SYSROUTINES row, as the tree carries it - no function type or origin. */
export function systemProcedure(schema: string, name: string, overrides: Partial<SchemasSystemRoutine> = {}): SchemasSystemRoutine {
	return {
		schema, name, specificName: name, sqlSchema: schema, routineType: 'PROCEDURE', body: 'SQL', language: 'SQL', description: '', parameterCount: 0,
		...overrides
	};
}

/** One QSYS2.SYSPARMS row - a parameter unless rowType says otherwise. */
export function routineParam(schema: string, specificName: string, name: string, overrides: Partial<SchemasRoutineParam> = {}): SchemasRoutineParam {
	return {
		schema, specificName, rowType: 'P', position: 1, parameterMode: 'IN' as SchemasRoutineParam['parameterMode'], name, dataType: 'CHAR',
		scale: 0, precision: 0, length: 8, description: '', default: '',
		...overrides
	};
}

/** A table as one import describes it - no columns or keys unless given, from a DBML file. */
export function importedTable(schema: string, name: string, overrides: Partial<ImportedTableSchema> = {}): ImportedTableSchema {
	return {
		schema, name, columns: [], primaryKeyColumns: [], uniqueKeys: [], foreignKeys: [], indexes: [],
		provenance: { importId: 'import-1', sourceFormat: 'dbml', sourceLabel: 'sales.dbml', importedAt: '2026-09-02T00:00:00.000Z' },
		...overrides
	};
}
