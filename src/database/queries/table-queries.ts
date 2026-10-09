import { Extension } from '../../extension.js';
import { SystemColumn } from '../../models/system-column.js';
import { SystemForeignKey } from '../../models/system-foreign-key.js';
import { SystemTableKey } from '../../models/system-table-key.js';
import { SystemTrigger } from '../../models/system-trigger.js';
import { Nullable } from '../../utils/nullable.js';
import { StringUtils } from '../../utils/string-utils.js';
import { DbConnections } from '../db-connections.js';
import { runCatalogLookup } from './catalog-lookup.js';
import { queryByTableTargets, TablePredicate, TableTarget } from './table-predicates.js';

// Everything about already-identified tables' structure - detail behind the Columns/Table Keys/Foreign
// Keys/Triggers tabs today; future home for createTable()/alterTable()/dropTable().
//
// Each list takes `tables: TableTarget[] | TableTarget`, so asking about one table and asking about
// twenty is the same code path and the same single statement - see table-predicates.ts. That is what
// keeps opening a diagram of twenty tables to one query per catalog instead of twenty.
export class TableQueries {
	constructor(private extension: Extension) {}

	async listColumns(options: TableQueries.ListColumnsOptions): Promise<SystemColumn[]> {
		// SYSCOLUMNS2 (not SYSCOLUMNS) - a superset that also carries true NUMERIC_PRECISION (SYSCOLUMNS'
		// LENGTH is dual-purpose: character length for CHAR/VARCHAR, precision for DECIMAL/NUMERIC) plus
		// HAS_DEFAULT/IS_HIDDEN/IS_UPDATABLE, needed by the future column-editing (ALTER TABLE) feature.
		return queryByTableTargets<SystemColumn>({
			tables: options?.tables,
			columns: {schema: 'dbname', table: 'tbname'},
			run: predicate => this.runQuery(options, `select dbname, tbname, colno, sys_cname, name, label, labeltext, coltype, length, scale, precision, ` +
					`nulls, identity, generated, start, increment, minvalue, maxvalue, cycle, cache, ccsid, ` +
					`dftvalue, has_default, hidden, updates ` +
					`from qsys2.syscolumns2 ` +
					`where ${predicate.clause} ` +
					`order by dbname, tbname, colno`, predicate),
			map: row => {
				return {
					schema: TableQueries.readName(row, 'DBNAME'),
					tableName: TableQueries.readName(row, 'TBNAME'),
					colNo: <number>row['COLNO'],
					systemName: <string>StringUtils.trim(<string>row['SYS_CNAME'], {removeDuplicateWhiteSpace: true}),
					sqlName: <string>StringUtils.trim(<string>row['NAME'], {removeDuplicateWhiteSpace: true}),
					heading: <string>StringUtils.trim(<string>row['LABEL'], {removeDuplicateWhiteSpace: true}),
					text: <string>StringUtils.trim(<string>row['LABELTEXT'], {removeDuplicateWhiteSpace: true}),
					dataType: <string>StringUtils.trim(<string>row['COLTYPE'], {removeDuplicateWhiteSpace: true}),
					length: <number>row['LENGTH'],
					scale: <number>row['SCALE'],
					precision: <number>row['PRECISION'],
					nulls: <string>StringUtils.trim(<string>row['NULLS'], {removeDuplicateWhiteSpace: true}),
					identity: <string>StringUtils.trim(<string>row['IDENTITY'], {removeDuplicateWhiteSpace: true}),
					generated: <string>StringUtils.trim(<string>row['GENERATED'], {removeDuplicateWhiteSpace: true}),
					identityStart: <number>row['START'],
					increment: <number>row['INCREMENT'],
					minValue: <number>row['MINVALUE'],
					maxValue: <number>row['MAXVALUE'],
					cycle: <string>StringUtils.trim(<string>row['CYCLE'], {removeDuplicateWhiteSpace: true}),
					cache: <number>row['CACHE'],
					ccsid: <number>row['CCSID'],
					defaultValue: <string>StringUtils.trim(<string>row['DFTVALUE'], {removeDuplicateWhiteSpace: true}),
					hasDefault: <string>StringUtils.trim(<string>row['HAS_DEFAULT'], {removeDuplicateWhiteSpace: true}),
					hidden: <string>StringUtils.trim(<string>row['HIDDEN'], {removeDuplicateWhiteSpace: true}),
					updatable: <string>StringUtils.trim(<string>row['UPDATES'], {removeDuplicateWhiteSpace: true})
				};
			}
		});
	}

	async listTableKeys(options: TableQueries.ListTableKeysOptions): Promise<SystemTableKey[]> {
		return queryByTableTargets<SystemTableKey>({
			tables: options?.tables,
			columns: {schema: 'a.system_table_schema', table: 'a.system_table_name'},
			run: predicate => this.runQuery(options, `select a.system_table_schema, a.system_table_name, ` +
					`a.constraint_name, a.constraint_type, c.column_name, c.system_column_name, c.ordinal_position ` +
					`from qsys2.syscst a ` +
					`join qsys2.syskeycst c ` +
					`on a.constraint_schema = c.constraint_schema ` +
					`and a.constraint_name = c.constraint_name ` +
					`where (${predicate.clause}) ` +
					`and a.constraint_type in ('PRIMARY KEY', 'UNIQUE') ` +
					`order by a.system_table_schema, a.system_table_name, a.constraint_name, c.ordinal_position`, predicate),
			map: row => {
				return <SystemTableKey>{
					schema: TableQueries.readName(row, 'SYSTEM_TABLE_SCHEMA'),
					tableName: TableQueries.readName(row, 'SYSTEM_TABLE_NAME'),
					constraintName: StringUtils.trim(<string>row['CONSTRAINT_NAME'], {removeDuplicateWhiteSpace: true}),
					constraintType: StringUtils.trim(<string>row['CONSTRAINT_TYPE'], {removeDuplicateWhiteSpace: true}),
					columnName: StringUtils.trim(<string>row['COLUMN_NAME'], {removeDuplicateWhiteSpace: true}),
					systemColumnName: StringUtils.trim(<string>row['SYSTEM_COLUMN_NAME'], {removeDuplicateWhiteSpace: true}),
					ordinalPosition: <number>row['ORDINAL_POSITION']
				};
			}
		});
	}

	async listForeignKeys(options: TableQueries.ListForeignKeysOptions): Promise<SystemForeignKey[]> {
		// d/e resolve the referenced table/columns: SYSREFCST only carries the referenced constraint's
		// name (b.unique_constraint_schema/name), so it's joined back into SYSCST (d) to get the
		// referenced table and SYSKEYCST (e) to get the referenced columns, matched to this FK's own
		// key columns (c) by ordinal position. a's own table comes back aliased owning_schema/owning_table
		// rather than selected bare, since referenced_schema/referenced_table already name d's.
		return queryByTableTargets<SystemForeignKey>({
			tables: options?.tables,
			columns: {schema: 'a.system_table_schema', table: 'a.system_table_name'},
			run: predicate => this.runQuery(options, `select a.system_table_schema as owning_schema, a.system_table_name as owning_table, ` +
					`a.constraint_name, c.column_name, c.system_column_name, c.ordinal_position, ` +
					`b.update_rule, b.delete_rule, ` +
					`d.system_table_schema as referenced_schema, d.system_table_name as referenced_table, ` +
					`e.column_name as referenced_column_name, e.system_column_name as referenced_system_column_name ` +
					`from qsys2.syscst a ` +
					`join qsys2.sysrefcst b ` +
					`on a.constraint_schema = b.constraint_schema ` +
					`and a.constraint_name = b.constraint_name ` +
					`join qsys2.syskeycst c ` +
					`on a.constraint_schema = c.constraint_schema ` +
					`and a.constraint_name = c.constraint_name ` +
					`join qsys2.syscst d ` +
					`on b.unique_constraint_schema = d.constraint_schema ` +
					`and b.unique_constraint_name = d.constraint_name ` +
					`join qsys2.syskeycst e ` +
					`on d.constraint_schema = e.constraint_schema ` +
					`and d.constraint_name = e.constraint_name ` +
					`and c.ordinal_position = e.ordinal_position ` +
					`where (${predicate.clause}) ` +
					`and a.constraint_type = 'FOREIGN KEY' ` +
					`order by owning_schema, owning_table, a.constraint_name, c.ordinal_position`, predicate),
			map: row => {
				return <SystemForeignKey>{
					schema: TableQueries.readName(row, 'OWNING_SCHEMA'),
					tableName: TableQueries.readName(row, 'OWNING_TABLE'),
					constraintName: StringUtils.trim(<string>row['CONSTRAINT_NAME'], {removeDuplicateWhiteSpace: true}),
					columnName: StringUtils.trim(<string>row['COLUMN_NAME'], {removeDuplicateWhiteSpace: true}),
					systemColumnName: StringUtils.trim(<string>row['SYSTEM_COLUMN_NAME'], {removeDuplicateWhiteSpace: true}),
					ordinalPosition: <number>row['ORDINAL_POSITION'],
					updateRule: StringUtils.trim(<string>row['UPDATE_RULE'], {removeDuplicateWhiteSpace: true}),
					deleteRule: StringUtils.trim(<string>row['DELETE_RULE'], {removeDuplicateWhiteSpace: true}),
					referencedSchema: StringUtils.trim(<string>row['REFERENCED_SCHEMA'], {removeDuplicateWhiteSpace: true}),
					referencedTable: StringUtils.trim(<string>row['REFERENCED_TABLE'], {removeDuplicateWhiteSpace: true}),
					referencedColumnName: StringUtils.trim(<string>row['REFERENCED_COLUMN_NAME'], {removeDuplicateWhiteSpace: true}),
					referencedSystemColumnName: StringUtils.trim(<string>row['REFERENCED_SYSTEM_COLUMN_NAME'], {removeDuplicateWhiteSpace: true})
				};
			}
		});
	}

	async listTriggers(options: TableQueries.ListTriggersOptions): Promise<SystemTrigger[]> {
		// Matched on SYS_DNAME/SYS_TNAME (the table's system names, which is what the schema tree keys
		// tables by) rather than TABSCHEMA/TABNAME, which are the SQL names. TEXT (the trigger body) is
		// selected here rather than read on demand the way a view's definition is: this only ever runs
		// for the one table the Triggers tab is showing, and a table rarely has more than a handful.
		return queryByTableTargets<SystemTrigger>({
			tables: options?.tables,
			columns: {schema: 'sys_dname', table: 'sys_tname'},
			run: predicate => this.runQuery(options, `select sys_dname, sys_tname, trigschema, trigname, trigevent, event_i, event_u, event_d, ` +
					`trigtime, granular, trigmode, orderseqno, condition, text, old_row, new_row, old_table, new_table, ` +
					`trigpgmlib, trigpgm, operative, enabled, thdsafe, mltthdacn, alwrepchg, trgupdcnd, secure, definer, ` +
					`create_dts, alteredts, label, remarks ` +
					`from qsys2.systriggers ` +
					`where ${predicate.clause} ` +
					`order by sys_dname, sys_tname, orderseqno, trigname`, predicate),
			map: row => {
				return <SystemTrigger>{
					schema: TableQueries.readName(row, 'SYS_DNAME'),
					tableName: TableQueries.readName(row, 'SYS_TNAME'),
					triggerSchema: StringUtils.trim(<string>row['TRIGSCHEMA'], {removeDuplicateWhiteSpace: true}),
					triggerName: StringUtils.trim(<string>row['TRIGNAME'], {removeDuplicateWhiteSpace: true}),
					event: TableQueries.describeTriggerEvent(row),
					timing: StringUtils.trim(<string>row['TRIGTIME'], {removeDuplicateWhiteSpace: true}),
					orientation: StringUtils.trim(<string>row['GRANULAR'], {removeDuplicateWhiteSpace: true}),
					mode: StringUtils.trim(<string>row['TRIGMODE'], {removeDuplicateWhiteSpace: true}),
					actionOrder: <number>row['ORDERSEQNO'],
					condition: TableQueries.readOptional(row, 'CONDITION'),
					// Only trimmed, never whitespace-collapsed: the body is shown as written.
					actionStatement: StringUtils.trim(<string>row['TEXT'], {toUndefined: true}),
					oldRow: TableQueries.readOptional(row, 'OLD_ROW'),
					newRow: TableQueries.readOptional(row, 'NEW_ROW'),
					oldTable: TableQueries.readOptional(row, 'OLD_TABLE'),
					newTable: TableQueries.readOptional(row, 'NEW_TABLE'),
					programLibrary: StringUtils.trim(<string>row['TRIGPGMLIB'], {removeDuplicateWhiteSpace: true}),
					programName: StringUtils.trim(<string>row['TRIGPGM'], {removeDuplicateWhiteSpace: true}),
					operative: StringUtils.trim(<string>row['OPERATIVE'], {removeDuplicateWhiteSpace: true}),
					enabled: StringUtils.trim(<string>row['ENABLED'], {removeDuplicateWhiteSpace: true}),
					threadSafe: StringUtils.trim(<string>row['THDSAFE'], {removeDuplicateWhiteSpace: true}),
					multithreadedJobAction: StringUtils.trim(<string>row['MLTTHDACN'], {removeDuplicateWhiteSpace: true}),
					allowRepeatedChange: StringUtils.trim(<string>row['ALWREPCHG'], {removeDuplicateWhiteSpace: true}),
					updateCondition: TableQueries.readOptional(row, 'TRGUPDCND'),
					secure: StringUtils.trim(<string>row['SECURE'], {removeDuplicateWhiteSpace: true}),
					definer: StringUtils.trim(<string>row['DEFINER'], {removeDuplicateWhiteSpace: true}),
					created: new Date(<string>row['CREATE_DTS']),
					lastAltered: row['ALTEREDTS'] != null ? new Date(<string>row['ALTEREDTS']) : undefined,
					description: TableQueries.readOptional(row, 'LABEL'),
					remarks: TableQueries.readOptional(row, 'REMARKS')
				};
			}
		});
	}

	// A MULTI trigger (one trigger over several events) names its events in the EVENT_I/EVENT_U/EVENT_D
	// flags rather than in TRIGEVENT itself.
	private static describeTriggerEvent(row: Record<string, unknown>): string {
		let event = <string>StringUtils.trim(<string>row['TRIGEVENT'], {removeDuplicateWhiteSpace: true});

		if(!StringUtils.equalsIgnoreCase(event, 'MULTI')) {
			return event;
		}

		let flagged = [['EVENT_I', 'INSERT'], ['EVENT_U', 'UPDATE'], ['EVENT_D', 'DELETE']]
			.filter(([column]) => StringUtils.equalsIgnoreCase(<string>StringUtils.trim(<string>row[column]), 'Y'))
			.map(([, name]) => name);

		return flagged.length > 0 ? flagged.join(', ') : event;
	}

	// A catalog column that is null (or blank) when it doesn't apply, read as absent - e.g. a trigger with no WHEN condition.
	private static readOptional(row: Record<string, unknown>, column: string): Nullable<string> {
		return StringUtils.trim(<string>row[column], {removeDuplicateWhiteSpace: true, toUndefined: true});
	}

	private async runQuery(options: DbConnections.CommonListOptions, sql: string, predicate: TablePredicate): Promise<Record<string, unknown>[]> {
		return await runCatalogLookup(this.extension, {
			key: options.key,
			configId: options.configId,
			sql: sql,
			parameters: predicate.parameters
		});
	}

	// The schema/table a row belongs to, read off the row itself rather than off the request. Always
	// uppercase and trimmed, matching what toTableTargets produces, so a row lines up with the target
	// that asked for it however the caller happened to spell it.
	private static readName(row: Record<string, unknown>, column: string): string {
		return (<string>StringUtils.trim(<string>row[column], {removeDuplicateWhiteSpace: true})).toUpperCase();
	}
}

export namespace TableQueries {
	export interface ListColumnsOptions extends DbConnections.CommonListOptions {
		tables: TableTarget[] | TableTarget;
	}

	export interface ListTableKeysOptions extends DbConnections.CommonListOptions {
		tables: TableTarget[] | TableTarget;
	}

	export interface ListForeignKeysOptions extends DbConnections.CommonListOptions {
		tables: TableTarget[] | TableTarget;
	}

	export interface ListTriggersOptions extends DbConnections.CommonListOptions {
		tables: TableTarget[] | TableTarget;
	}
}
