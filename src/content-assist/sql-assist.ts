import { SystemColumn } from '../models/system-column.js';
import { SystemRoutine } from '../models/system-routine.js';
import { ArrayUtils } from '../utils/array-utils.js';
import { ColumnNameUtils } from '../utils/column-name-utils.js';
import { FieldUtils } from '../utils/field-utils.js';
import { Nullable } from '../utils/nullable.js';
import { RoutineUtils } from '../utils/routine-utils.js';
import { SqlParser } from '../utils/sql-parser.js';
import type { SqlStatementText } from '../utils/sql-statement-text.js';
import { StringUtils } from '../utils/string-utils.js';
import { CteAssist } from './cte-assist.js';
import { DbAssist } from './db-assist.js';

export class SqlAssist extends DbAssist {
	async getItems(key: string, sql: string, caretPosition: SqlStatementText.CaretPosition, parseResults: SqlParser.SqlParseResults): Promise<DbAssist.CompletionItemDescriptor[]> {
		let connectionConfig = await this.getConnectionConfig(key);
		let lastKeyword = this.getLastKeyword(sql);

		if(SqlAssist.isTableContext(sql, lastKeyword)) {
			return this.getTableContextItems({key: key, sql: sql, caretPosition: caretPosition, parseResults: parseResults, connectionConfig: connectionConfig});
		}

		if(SqlAssist.isValueContext(sql, lastKeyword)) {
			return this.getValueContextItems({key: key, sql: sql, caretPosition: caretPosition, parseResults: parseResults, connectionConfig: connectionConfig});
		}

		// Checked ahead of the generic column context below: ORDER BY/GROUP BY only ever take a real
		// column (or alias.column) reference, never "*"/"[All from ...]", so they get their own item
		// set rather than falling into getColumnContextItems' shared wildcard-offering behavior.
		if(SqlAssist.isOrderByContext(sql, lastKeyword)) {
			return this.getOrderByContextItems({key: key, sql: sql, caretPosition: caretPosition, parseResults: parseResults, connectionConfig: connectionConfig});
		}

		if(SqlAssist.isGroupByContext(sql, lastKeyword)) {
			return this.getGroupByContextItems({key: key, sql: sql, caretPosition: caretPosition, parseResults: parseResults, connectionConfig: connectionConfig});
		}

		if(SqlAssist.isColumnContext(sql, lastKeyword)) {
			let options = {key: key, sql: sql, caretPosition: caretPosition, parseResults: parseResults, connectionConfig: connectionConfig};
			let [columnItems, functionItems] = await Promise.all([this.getColumnContextItems(options), this.getFunctionContextItems(options)]);
			return [...columnItems, ...functionItems];
		}

		return this.getKeyWordItems(SqlParser.KEY_WORDS);
	}

	private async getTableContextItems(options: SqlAssist.TableContextItemsOptions): Promise<DbAssist.CompletionItemDescriptor[]> {
		let dotMatch = await this.getDotMatch(options);
		let schemaName = dotMatch?.schema?.name ?? options.connectionConfig?.defaultTableSchema;

		if(dotMatch) {
			if(dotMatch.schema != null) {
				let [schemaTableItems, schemaFunctionItems] = await Promise.all([
					this.getTableItems({...options, schema: schemaName}),
					this.getFunctionItems({...options, schema: schemaName}, true)
				]);

				return [...schemaTableItems, ...schemaFunctionItems];
			}
		}

		// A CTE isn't schema-qualifiable, so it's only ever offered here (never in the dotMatch.schema
		// branch above) - listed ahead of schemas/tables since it's declared right in this same
		// statement, the most immediately relevant thing to reference next.
		let cteItems = this.getCteTableItems(options.parseResults.originalSql);

		// Table functions resolve through the library list (the SQL path) when unqualified, not the
		// default table schema, so they aren't narrowed to it the way the tables are.
		let [schemaItems, tableItems, tableFunctionItems] = await Promise.all([
			this.getSchemaItems(options.key),
			this.getTableItems({...options, schema: schemaName}),
			this.getFunctionItems(options, true)
		]);

		return [...cteItems, ...schemaItems, ...tableItems, ...tableFunctionItems];
	}

	// Scalar and aggregate functions go wherever an expression can, so they're offered after the columns.
	// A schema typed at the cursor narrows them to that schema; with none, it's every function on the
	// library list, which is what an unqualified call resolves through. Not after a table or alias
	// qualifier ("e.", where only that table's columns make sense), and not inside an INSERT column list,
	// which takes names rather than expressions.
	private async getFunctionContextItems(options: SqlAssist.ColumnContextItemsOptions): Promise<DbAssist.CompletionItemDescriptor[]> {
		if(SqlAssist.isInsertColumnListContext(options.sql, this.getLastKeyword(options.sql))) {
			return [];
		}

		let dotMatch = await this.getDotMatch(options);

		if(dotMatch?.tableReference != null) {
			return [];
		}

		return this.getFunctionItems({...options, schema: dotMatch?.schema?.name}, false);
	}

	private async getFunctionItems(options: DbAssist.DbItemsOptions & {schema?: string}, tableFunctions: boolean): Promise<DbAssist.CompletionItemDescriptor[]> {
		let functions = await this.extension.memoryCache.getFunctions({key: options.key, schema: options.schema});
		return SqlAssist.buildFunctionItems(functions.filter(fn => (fn.functionType === 'T') === tableFunctions));
	}

	// One item per name rather than per overload (see RoutineUtils.groupByName). A table function is
	// inserted inside the TABLE(...) a FROM clause needs around it.
	static buildFunctionItems(functions: SystemRoutine[]): DbAssist.CompletionItemDescriptor[] {
		return RoutineUtils.groupByName(functions).map(overloads => {
			let fn = overloads[0];
			let isTable = fn.functionType === 'T';
			let kind = isTable ? 'table function' : 'function';
			let description = overloads.map(overload => overload.description).find(StringUtils.isNotBlank);

			return {
				label: description ? `${fn.name} (${description})` : fn.name,
				insertText: isTable ? `TABLE(${fn.name}(` : `${fn.name}(`,
				detail: overloads.length > 1
					? `${fn.schema.toLowerCase()} (${kind}, ${overloads.length} overloads)`
					: `${fn.schema.toLowerCase()} (${kind})`,
				kind: 'Function',
				sortText: DbAssist.ItemSortOrder.FUNCTIONS
			};
		});
	}

	private getCteTableItems(fullSql: string): DbAssist.CompletionItemDescriptor[] {
		return CteAssist.getCtes(fullSql).map(cte => ({
			label: `${cte.name} (CTE)`,
			insertText: cte.name,
			detail: 'cte',
			kind: 'Class',
			sortText: DbAssist.ItemSortOrder.CTES
		}));
	}

	private async getColumnContextItems(options: SqlAssist.ColumnContextItemsOptions): Promise<DbAssist.CompletionItemDescriptor[]> {
		// Inside "INSERT INTO table (col1, |" there's no dot being actively typed at the cursor —
		// the table reference (possibly schema-qualified) is resolved independently of cursor depth
		// via getInsertTableReferenceText, since it may be many columns further back than the dot
		// regex used below (which only looks at what's immediately before the cursor) can reach.
		if(SqlAssist.isInsertColumnListContext(options.sql, this.getLastKeyword(options.sql))) {
			return this.getInsertColumnListItems(options);
		}

		let dotMatch = await this.getDotMatch(options);
		let defaultSchemaName = dotMatch?.schema?.name ?? options.connectionConfig?.defaultTableSchema;

		if(dotMatch) {
			if(dotMatch.schema != null) {
				if(dotMatch.tableReference != null) {
					// An explicit "schema.table." typed at the cursor always wins over whatever
					// schema (if any) that table was parsed with elsewhere in the statement.
					let tableReference = SqlAssist.resolveTable(options.parseResults.tables, dotMatch.tableReference);
					let includeAlias = this.includeAlias({smartInclude: () => false});
					return this.getColumnItems({...options, tableReference: tableReference, includeAlias: includeAlias, dotMatch: dotMatch, schema: defaultSchemaName});
				}

				return this.getTableItems({...options, schema: defaultSchemaName});
			}

			if(dotMatch.tableReference != null) {
				// No schema typed at the cursor (e.g. an alias like "e."), so prefer the schema the
				// table was actually declared with in FROM/JOIN (if schema-qualified there).
				let tableReference = SqlAssist.resolveTable(options.parseResults.tables, dotMatch.tableReference);
				let includeAlias = this.includeAlias({smartInclude: () => false});
				return this.getColumnItems({...options, tableReference: tableReference, includeAlias: includeAlias, dotMatch: dotMatch, schema: tableReference.schema ?? defaultSchemaName});
			}
		}

		let items: DbAssist.CompletionItemDescriptor[] = [];

		if(options.parseResults.tables?.length) {
			// SqlParser.parseTables is a flat regex with no concept of CTE-body boundaries, so a
			// real table used only *inside* a CTE's own definition (e.g. "appuser" in "WITH data AS
			// (SELECT fnam FROM appuser) SELECT | FROM data") is indistinguishable from one that's
			// actually reachable at the cursor unless we filter it back out here.
			let inaccessibleTableKeys = CteAssist.getInaccessibleTableNames(options.parseResults.originalSql, options.caretPosition);
			let tableReferences = options.parseResults.tables.filter(tableReference => !inaccessibleTableKeys.has(CteAssist.getTableKey(tableReference.table, tableReference.alias)));
			let includeAlias = this.includeAlias({smartInclude: () => tableReferences.length > 1});
			let allColumnItems = await Promise.all(tableReferences.map(tableReference => this.getColumnItems({...options, tableReference: tableReference, includeAlias: includeAlias, dotMatch: dotMatch, schema: tableReference.schema ?? defaultSchemaName})));
			items.push(...allColumnItems.flat());
		}

		return items;
	}

	// Reuses getColumnContextItems' full schema/table/alias resolution (dot-qualified, aliased,
	// multi-table, CTE, etc.) but with includeWildcards suppressed -- ORDER BY can't reference "*"
	// or a bulk column list the way SELECT can, only individual (optionally alias-qualified) columns.
	private async getOrderByContextItems(options: SqlAssist.ColumnContextItemsOptions): Promise<DbAssist.CompletionItemDescriptor[]> {
		return this.getColumnContextItems({...options, includeWildcards: false});
	}

	// Unlike ORDER BY, GROUP BY can't offer every column in scope -- SQL requires every
	// non-aggregated SELECT item to appear in GROUP BY, so the only columns that ever belong here
	// are the SELECT list's own non-aggregated items, not the full FROM/JOIN column set.
	private async getGroupByContextItems(options: SqlAssist.ColumnContextItemsOptions): Promise<DbAssist.CompletionItemDescriptor[]> {
		let selectItems = SqlAssist.getGroupableSelectItems(options.sql);

		if(!selectItems) {
			return [];
		}

		let items = await Promise.all(selectItems.map(item => this.buildGroupByItem(options, item)));
		return items.flat();
	}

	// A plain (optionally alias-qualified) column reference is resolved the same way any other
	// column reference is -- through getColumnItems, so CTE/derived-table columns and real
	// SystemColumn metadata (heading, etc.) resolve identically to everywhere else in this file.
	// includeAlias is forced to whatever the SELECT item itself used (qualified in, qualified out)
	// rather than the Smart/Always/Never setting other column items use, since GROUP BY's item has
	// to actually match what SELECT already wrote. A non-column expression (a non-aggregate
	// function call, arithmetic, CASE, etc.) has no metadata to resolve at all, so it's offered
	// back verbatim -- the user already typed it once in SELECT, offering it as-is for GROUP BY
	// saves retyping it exactly, which is what SQL requires there.
	private async buildGroupByItem(options: SqlAssist.ColumnContextItemsOptions, item: SqlAssist.GroupableSelectItem): Promise<DbAssist.CompletionItemDescriptor[]> {
		if(item.type === 'expression') {
			return [{label: <string>item.text, insertText: <string>item.text, kind: 'Field', sortText: DbAssist.ItemSortOrder.COLUMNS}];
		}

		let candidateTables = item.qualifier != null
			? [SqlAssist.resolveTable(options.parseResults.tables, <string>item.qualifier)]
			: SqlAssist.getAccessibleTables(options);
		let includeAlias = item.qualifier != null;

		for(let tableReference of candidateTables) {
			let columnItems = await this.getColumnItems({...options, tableReference: tableReference, includeAlias: includeAlias, schema: tableReference.schema ?? options.connectionConfig?.defaultTableSchema});
			let match = columnItems.find(columnItem => StringUtils.equalsIgnoreCase(columnItem.insertText.replace(/^.*\./, ''), <string>item.columnName));

			if(match != null) {
				return [match];
			}
		}

		return [];
	}

	// Mirrors the CTE-of-a-CTE accessibility filter getColumnContextItems already applies -- a
	// real table used only inside another CTE's own body isn't reachable from here, so an
	// unqualified GROUP BY column reference should never search it.
	private static getAccessibleTables(options: SqlAssist.ColumnContextItemsOptions): SqlParser.TableReference[] {
		let inaccessibleTableKeys = CteAssist.getInaccessibleTableNames(options.parseResults.originalSql, options.caretPosition);
		return (options.parseResults.tables ?? []).filter(tableReference => !inaccessibleTableKeys.has(CteAssist.getTableKey(tableReference.table, tableReference.alias)));
	}

	private async getValueContextItems(options: SqlAssist.ColumnContextItemsOptions): Promise<DbAssist.CompletionItemDescriptor[]> {
		let lastKeyword = this.getLastKeyword(options.sql);

		if(SqlAssist.isInsertValueListContext(options.sql, lastKeyword)) {
			return this.getInsertValueItems(options);
		}

		// A "column = " assignment is only ever additive — the column completions that already
		// apply to this clause (WHERE/SET/etc.) are kept alongside the value suggestion so nothing
		// is lost if the position actually calls for a column reference (e.g. a JOIN's ON clause).
		let [valueItems, columnItems] = await Promise.all([
			this.getAssignmentValueItems(options),
			this.getColumnContextItems(options)
		]);

		return [...valueItems, ...columnItems];
	}

	private async getInsertColumnListItems(options: SqlAssist.ColumnContextItemsOptions): Promise<DbAssist.CompletionItemDescriptor[]> {
		let insertTable = await this.resolveInsertTable(options);

		if(insertTable == null) {
			return [];
		}

		let includeAlias = this.includeAlias({smartInclude: () => false});
		return this.getColumnItems({...options, tableReference: {table: insertTable.table}, includeAlias: includeAlias, schema: insertTable.schema});
	}

	private async getInsertValueItems(options: SqlAssist.ColumnContextItemsOptions): Promise<DbAssist.CompletionItemDescriptor[]> {
		let insertTable = await this.resolveInsertTable(options);

		if(insertTable == null) {
			return [];
		}

		let columns = await this.extension.memoryCache.getColumns({...options, tables: {schema: insertTable.schema, table: insertTable.table}});

		if(columns.length === 0) {
			return [];
		}

		let tableReference: SqlParser.TableReference = {table: insertTable.table};
		let orderedColumns = SqlAssist.getOrderedInsertColumns(options.parseResults, columns);
		let items: DbAssist.CompletionItemDescriptor[] = [];

		if(orderedColumns.length > 0 && !SqlAssist.hasSuppliedValues(options.sql)) {
			items.push(this.buildBulkValueItem(tableReference, orderedColumns));
		}

		let targetColumn = orderedColumns[SqlParser.getArgumentIndex(options.sql)];

		if(targetColumn != null) {
			items.push(this.buildValueItem(targetColumn));
		}

		return items;
	}

	// Resolves the (possibly schema-qualified) target table of an "INSERT INTO ..." statement,
	// independent of how far past it the cursor currently is — it may be sitting right after the
	// opening paren or several columns/values further in. Isolates "SCHEMA.TABLE"/"TABLE" right
	// after "INSERT INTO" and feeds it through getDotMatch so schema resolution matches an ordinary
	// table reference typed at the cursor.
	private async resolveInsertTable(options: SqlAssist.ColumnContextItemsOptions): Promise<Nullable<SqlAssist.InsertTable>> {
		let referenceText = SqlAssist.getInsertTableReferenceText(options.sql);

		if(!referenceText) {
			return undefined;
		}

		let dotMatch = await this.getDotMatch({...options, sql: referenceText});
		let table = dotMatch?.value;

		if(!table) {
			return undefined;
		}

		return {table: table, schema: dotMatch?.schema?.name ?? options.connectionConfig?.defaultTableSchema};
	}

	private async getAssignmentValueItems(options: SqlAssist.ColumnContextItemsOptions): Promise<DbAssist.CompletionItemDescriptor[]> {
		let referenceText = SqlAssist.getAssignmentReferenceText(options.sql);

		if(!referenceText) {
			return [];
		}

		let dotMatch = await this.getDotMatch({...options, sql: referenceText});
		let columnName = dotMatch?.value;

		if(!columnName) {
			return [];
		}

		let column = await this.resolveAssignmentColumn(options, dotMatch, columnName);
		return column != null ? [this.buildValueItem(column)] : [];
	}

	// A bare column name in "column = " could belong to any table in the FROM/JOIN list (unless
	// alias/table/schema-qualified via dotMatch), so every candidate table's columns are checked
	// in turn for a match.
	private async resolveAssignmentColumn(options: SqlAssist.ColumnContextItemsOptions, dotMatch: Nullable<DbAssist.DotMatch>, columnName: string): Promise<Nullable<SystemColumn>> {
		let tableReference = dotMatch?.tableReference;
		let candidateTables = tableReference != null
			? [SqlAssist.resolveTable(options.parseResults.tables, tableReference)]
			: options.parseResults.tables ?? [];

		// An explicit schema typed as part of the reference itself (e.g. "myschema.mytable.id =")
		// always wins; otherwise prefer the schema each candidate table was declared with in
		// FROM/JOIN over the connection's default.
		let dotSchemaName = dotMatch?.schema?.name;

		for(let candidateTable of candidateTables) {
			let schema = dotSchemaName ?? candidateTable.schema ?? options.connectionConfig?.defaultTableSchema;
			let columns = await this.extension.memoryCache.getColumns({...options, tables: {schema: schema, table: candidateTable.table}});
			let column = ColumnNameUtils.findSystemColumn(columns, columnName);

			if(column != null) {
				return column;
			}
		}

		return undefined;
	}

	private buildValueItem(column: SystemColumn): DbAssist.CompletionItemDescriptor {
		return this.buildItem(SqlAssist.getValueDescriptor(column), 'Value', DbAssist.ItemSortOrder.VALUES);
	}

	private buildBulkValueItem(tableReference: SqlParser.TableReference, columns: SystemColumn[]): DbAssist.CompletionItemDescriptor {
		return this.buildItem(SqlAssist.getBulkValueDescriptor(tableReference, columns), 'Value', DbAssist.ItemSortOrder.CUSTOM);
	}

	private buildItem(descriptor: SqlAssist.ItemDescriptor, kind: DbAssist.ItemKind, sortOrder: DbAssist.ItemSortOrder): DbAssist.CompletionItemDescriptor {
		return {label: descriptor.label, insertText: descriptor.insertText, detail: descriptor.detail, kind: kind, sortText: sortOrder};
	}

	private async getTableItems(options: SqlAssist.TableItemsOptions): Promise<DbAssist.CompletionItemDescriptor[]> {
		// Views as well as tables: both go after FROM/JOIN, and a view's columns resolve the same way.
		let relations = await this.extension.memoryCache.getRelations(options);

		if(relations.length === 0) {
			return [];
		}

		return relations.map(relation => ({
			label: StringUtils.isNotBlank(relation.description) ? `${relation.name} (${relation.description})` : relation.name,
			insertText: relation.name,
			detail: relation.kind === 'table' ? relation.schema.toLowerCase() : `${relation.schema.toLowerCase()} (${relation.kind})`,
			kind: 'Class',
			sortText: DbAssist.ItemSortOrder.TABLES
		}));
	}

	// qualifierOverride anchors the insertText qualifier to an outer CTE's own name/alias when
	// resolving a "*"/"alias.*" wildcard that reaches this table -- e.g. for a CTE-of-a-CTE chain
	// ("data2 AS (SELECT * FROM data)" where "data AS (SELECT * FROM appuser)"), recursing back
	// into this same method (via getCteColumnItems) re-checks whether "data" is itself a CTE
	// (cascading correctly) while every resulting item still reads "data2.col", not "data.col" or
	// "appuser.col".
	private async getColumnItems(options: SqlAssist.ColumnItemsOptions, qualifierOverride?: string): Promise<DbAssist.CompletionItemDescriptor[]> {
		// The CTE's own reference (its "FROM cteName") may textually come after the cursor -- the
		// full statement is needed, not options.sql (truncated at the cursor), or CteAssist has no
		// table entity for the CTE to resolve at all.
		let cteColumns = CteAssist.getVirtualTableColumns(options.parseResults.originalSql).get(options.tableReference.table.toLowerCase());

		if(cteColumns != null) {
			return this.getCteColumnItems(options, cteColumns, qualifierOverride);
		}

		// Only a schema the SQL itself names ("FROM myschema.t", or "myschema.t." at the cursor) pins the
		// lookup, the one typed at the cursor winning as it does in getColumnContextItems. options.schema
		// can be the connection's default, and pinning to that would hide a table that only lives elsewhere
		// on the library list. A bare name resolves through the library list.
		let explicitSchema = options.dotMatch?.schema?.name ?? options.tableReference.schema;
		let columns = await this.extension.memoryCache.getColumns({...options, tables: {schema: explicitSchema, table: options.tableReference.table}});
		let items: DbAssist.CompletionItemDescriptor[] = this.getCustomColumnItems(options, columns);
		let qualifier = qualifierOverride ?? (options.tableReference.alias ?? options.tableReference.table);
		items.push(...this.buildColumnItems(options, columns, qualifier));
		return items;
	}

	// Formats real SystemColumn metadata into completion items, qualified by "qualifier" -- kept
	// separate from options.tableReference.table (used for schema/detail lookup) so a CTE that's a
	// plain "SELECT * FROM realTable" passthrough can show realTable's real columns while still
	// qualifying them with the CTE's own name/alias (getCteColumnItems' wildcard-table case).
	private buildColumnItems(options: SqlAssist.ColumnItemsOptions, columns: SystemColumn[], qualifier: string): DbAssist.CompletionItemDescriptor[] {
		let includeAlias = options.includeAlias;

		if(!includeAlias && options.dotMatch?.value) {
			// The text typed so far (dotMatch.value) might not be a column at all -- it could be the
			// start of THIS table's own name/alias, e.g. "SELECT emp" on the way to "employees.id".
			// Plain "id" wouldn't even match what's been typed; qualifying it keeps the item visible
			// and filter-matchable despite includeAlias otherwise saying not to.
			let typed = <string>options.dotMatch?.value;
			includeAlias = StringUtils.beginsWithIgnoreCase(options.tableReference.table, typed)
				|| (!!options.tableReference.alias && StringUtils.beginsWithIgnoreCase(<string>options.tableReference.alias, typed));
		}

		return columns.map(column => {
			let columnName = includeAlias ? `${qualifier}.${column.systemName}` : column.systemName;

			return {
				label: column.heading ? `${columnName} (${column.heading})` : column.systemName,
				insertText: columnName,
				detail: `${column.schema}.${options.tableReference.table}`.toLowerCase(),
				kind: 'Field',
				sortText: DbAssist.ItemSortOrder.COLUMNS
			};
		});
	}

	// A CTE isn't a real DB2 table, so an explicitly-named column has no schema/heading/dataType of
	// its own to show -- but when CteAssist could trace it back to a real (or virtual) sibling
	// table unambiguously (its sourceTable/sourceColumn), that table's own metadata is looked up so
	// the heading still shows, exactly as if the column had been referenced directly instead of
	// through the CTE. A "*"/"alias.*" in the CTE's own SELECT list, similarly, just proxies another
	// table's columns wholesale -- resolved by recursing back into getColumnItems (not a direct
	// MemoryCache call) so a wildcard reaching *another* CTE (a CTE-of-a-CTE chain) cascades
	// correctly instead of silently resolving to nothing, while qualifierOverride keeps every
	// resulting item qualified by this (outermost) CTE's own name/alias throughout the chain.
	private async getCteColumnItems(options: SqlAssist.ColumnItemsOptions, cteColumns: CteAssist.CteColumns, qualifierOverride?: string): Promise<DbAssist.CompletionItemDescriptor[]> {
		let qualifier = qualifierOverride ?? (options.tableReference.alias ?? options.tableReference.table);
		let literalItems = await Promise.all(cteColumns.literalColumns.map(literalColumn => this.buildCteLiteralColumnItem(options, literalColumn, qualifier)));

		if(cteColumns.wildcardTables.length === 0) {
			return literalItems;
		}

		let wildcardItems = await Promise.all(cteColumns.wildcardTables.map(table =>
			this.getColumnItems({...options, tableReference: {table: table}}, qualifier)
		));

		return [...literalItems, ...wildcardItems.flat()];
	}

	private async buildCteLiteralColumnItem(options: SqlAssist.ColumnItemsOptions, literalColumn: CteAssist.CteLiteralColumn, qualifier: string): Promise<DbAssist.CompletionItemDescriptor> {
		let insertText = options.includeAlias ? `${qualifier}.${literalColumn.name}` : literalColumn.name;
		let heading = await this.resolveCteLiteralColumnHeading(options, literalColumn);

		return {
			label: heading ? `${insertText} (${heading})` : literalColumn.name,
			insertText: insertText,
			detail: `${options.tableReference.table} (CTE)`.toLowerCase(),
			kind: 'Field',
			sortText: DbAssist.ItemSortOrder.COLUMNS
		};
	}

	// sourceTable may itself be another CTE/derived table rather than a real one -- MemoryCache
	// simply has no columns for a name that isn't a real DB2 table, so this degrades to no heading
	// (the same graceful-failure shape used everywhere else here) rather than needing to special-case
	// which kind of table it is.
	private async resolveCteLiteralColumnHeading(options: SqlAssist.ColumnItemsOptions, literalColumn: CteAssist.CteLiteralColumn): Promise<Nullable<string>> {
		if(!literalColumn.sourceTable || !literalColumn.sourceColumn) {
			return undefined;
		}

		let columns = await this.extension.memoryCache.getColumns({...options, tables: {table: <string>literalColumn.sourceTable}});
		return ColumnNameUtils.findSystemColumn(columns, <string>literalColumn.sourceColumn)?.heading;
	}

	private getCustomColumnItems(options: SqlAssist.ColumnItemsOptions, columns: SystemColumn[]): DbAssist.CompletionItemDescriptor[] {
		if(options.includeWildcards === false) {
			return [];
		}

		let items: DbAssist.CompletionItemDescriptor[] = [];
		let qualifier = options.tableReference.alias ?? options.tableReference.table;

		if(options.dotMatch?.tableReference) {
			items.push({
				label: `${qualifier}.*`,
				insertText: `*`,
				detail: `${qualifier}.*`.toLowerCase(),
				kind: 'Field',
				sortText: DbAssist.ItemSortOrder.CUSTOM
			});
		} else {
			let lastKeyword = this.getLastKeyword(options.sql);

			if(SqlAssist.isInsertColumnListContext(options.sql, lastKeyword)
			|| StringUtils.equalsIgnoreCase(<string>lastKeyword, 'SELECT')) {
				let columnMap = ArrayUtils.toMapOfArrays(columns, column => `${column.schema}.${column.tableName}`, column => column);

				for(let key of Array.from(columnMap.keys())) {
					let selectColumns = <SystemColumn[]>columnMap.get(key);
					let insertTexts = selectColumns.map(column => options.includeAlias ? `${qualifier}.${column.systemName}` : column.systemName);

					items.push({
						// Labeled by qualifier (the alias, when there is one), not the raw table
						// name -- two references to the same table under different aliases (e.g.
						// "appuser a JOIN appuser b") would otherwise show two identical,
						// indistinguishable "[All from APPUSER]" entries.
						label: `[All from ${qualifier}]`,
						insertText: insertTexts.join(', '),
						detail: `${key}`.toLowerCase(),
						kind: 'Field',
						sortText: DbAssist.ItemSortOrder.CUSTOM
					});

					if(StringUtils.equalsIgnoreCase(<string>lastKeyword, 'SELECT')) {
						items.push({
							label: `${qualifier}.*`,
							insertText: options.includeAlias ? `${qualifier}.*` : '*',
							detail: `${key}`.toLowerCase(),
							kind: 'Field',
							sortText: DbAssist.ItemSortOrder.CUSTOM
						});
					}
				}
			}
		}

		return items;
	}

	// True when the nearest keyword before the cursor (searching backward across the whole
	// statement, not just the current line) is one that introduces a table reference, e.g.
	// "FROM\n  |" or "left join\n\t|" should offer table items even though the keyword is on a
	// preceding line. lastKeyword is always the caller's own DbAssist.getLastKeyword(sql) result,
	// threaded in explicitly rather than recomputed here.
	static isTableContext(sql: string, lastKeyword: Nullable<string>): boolean {
		if(SqlAssist.isInsertColumnListContext(sql, lastKeyword)) {
			return false;
		}

		if(!lastKeyword) {
			return false;
		}

		// Compound keywords like "LEFT JOIN" match on their trailing word so "LEFT JOIN"/"JOIN"
		// are treated the same.
		let lastWord = lastKeyword.trim().split(/\s+/).pop() ?? lastKeyword;
		return SqlParser.TABLE_KEY_WORDS.some(tableKeyword => StringUtils.equalsIgnoreCase(tableKeyword, lastWord));
	}

	// True when the nearest keyword before the cursor is ORDER BY. Checked separately from
	// isColumnContext (rather than folding "ORDER BY" into COLUMN_KEY_WORDS) because
	// isColumnContext's lastWord reduction (splitting a compound keyword down to its trailing word,
	// e.g. "LEFT JOIN" -> "JOIN") only works for TABLE_KEY_WORDS, where that trailing word ("JOIN")
	// is itself also a standalone entry -- COLUMN_KEY_WORDS has no standalone "BY", so comparing the
	// full keyword here (not just its last word) is what actually matches "ORDER BY".
	static isOrderByContext(sql: string, lastKeyword: Nullable<string>): boolean {
		if(!lastKeyword) {
			return false;
		}

		return StringUtils.equalsIgnoreCase(lastKeyword.trim().replace(/\s+/g, ' '), 'ORDER BY');
	}

	// True when the nearest keyword before the cursor is GROUP BY. Same rationale as
	// isOrderByContext -- compares the full keyword rather than isColumnContext's lastWord
	// reduction, since COLUMN_KEY_WORDS has no standalone "BY" entry for that reduction to match.
	static isGroupByContext(sql: string, lastKeyword: Nullable<string>): boolean {
		if(!lastKeyword) {
			return false;
		}

		return StringUtils.equalsIgnoreCase(lastKeyword.trim().replace(/\s+/g, ' '), 'GROUP BY');
	}

	// True when it makes sense to offer column completions at the cursor, i.e. we're not in a
	// table context (isTableContext) and the last keyword before the cursor isn't one that's
	// followed by something other than a column (alias, number, etc.).
	static isColumnContext(sql: string, lastKeyword: Nullable<string>): boolean {
		if(SqlAssist.isInsertColumnListContext(sql, lastKeyword)) {
			return true;
		}

		if(!lastKeyword) {
			return false;
		}

		let lastWord = lastKeyword.trim().split(/\s+/).pop() ?? lastKeyword;
		return SqlParser.COLUMN_KEY_WORDS.some(keyword => StringUtils.equalsIgnoreCase(keyword, lastWord));
	}

	// True once the user is inside the unclosed "(col1, col2, |" list that immediately follows
	// "INSERT INTO table" — otherwise isTableContext would still see "INTO" as the nearest
	// keyword and offer table names instead of the columns being inserted.
	static isInsertColumnListContext(sql: string, lastKeyword?: Nullable<string>): boolean {
		if(!lastKeyword || !StringUtils.equalsIgnoreCase(lastKeyword.trim(), 'INTO')) {
			return false;
		}

		let openParenCount = (sql.match(/\(/g) ?? []).length;
		let closeParenCount = (sql.match(/\)/g) ?? []).length;
		return openParenCount > closeParenCount;
	}

	// True when it makes sense to offer a literal value suggestion at the cursor: either inside
	// the unclosed "VALUES (1, |" list of an INSERT, or right after a "column = |" assignment in
	// a WHERE/SET/HAVING/etc. clause (isColumnContext is already true there, so this only adds to
	// — never replaces — the column completions offered in that case).
	static isValueContext(sql: string, lastKeyword: Nullable<string>): boolean {
		if(SqlAssist.isInsertValueListContext(sql, lastKeyword)) {
			return true;
		}

		return SqlAssist.isColumnContext(sql, lastKeyword) && !!SqlAssist.getAssignmentReferenceText(sql);
	}

	// True once the user is inside the unclosed "VALUES (1, |" list of an INSERT statement —
	// mirrors isInsertColumnListContext but keyed off the VALUES keyword instead of INTO.
	static isInsertValueListContext(sql: string, lastKeyword?: Nullable<string>): boolean {
		if(!lastKeyword || !StringUtils.equalsIgnoreCase(lastKeyword.trim(), 'VALUES')) {
			return false;
		}

		let openParenCount = (sql.match(/\(/g) ?? []).length;
		let closeParenCount = (sql.match(/\)/g) ?? []).length;
		return openParenCount > closeParenCount;
	}

	// True once the user has typed anything (besides whitespace) inside an INSERT statement's
	// VALUES list, e.g. "INSERT INTO t VALUES (1" or "INSERT INTO t VALUES (1, " -- mirrors
	// SpAssist.hasSuppliedParameters. The bulk "all defaults" item only makes sense while the list
	// is still completely empty, since otherwise it would duplicate/clobber what's already typed.
	static hasSuppliedValues(sql: string): boolean {
		let parenStart = SqlParser.getCurrentParenStart(sql);
		return parenStart !== -1 && StringUtils.isNotBlank(sql.substring(parenStart + 1));
	}

	// Isolates the "[[schema.]table.]column" reference right before a trailing "= " (e.g. "WHERE
	// id = ", "SET e.name = ", "WHERE myschema.mytable.id = "), so it can be fed straight into
	// getDotMatch and reuse its schema/alias resolution instead of a bespoke qualifier regex. The
	// identifier must be followed by only whitespace before the "=" so comparison operators like
	// "<=", ">=", "<>", "!=" are never mistaken for a plain assignment.
	static getAssignmentReferenceText(sql: string): Nullable<string> {
		let match = sql.match(/([a-zA-Z0-9_]+(?:\s*\.\s*[a-zA-Z0-9_]+){0,2})\s*=\s*[^=]*$/);
		return match?.[1];
	}

	// Isolates the (possibly schema-qualified) target table text immediately following "INSERT
	// INTO", independent of how far past it the cursor currently is -- resolveInsertTable feeds
	// this into getDotMatch so schema resolution matches an ordinary table reference typed at the
	// cursor.
	static getInsertTableReferenceText(sql: string): Nullable<string> {
		let match = sql.match(/\bINSERT\s+INTO\s+([a-zA-Z0-9_]+(?:\s*\.\s*[a-zA-Z0-9_]+)?)/i);
		return match?.[1];
	}

	// "tableReference" (from a dot match like "e.") may be either a real table name or an alias
	// assigned in the FROM/JOIN clause — resolve it against the parsed tables to get both back.
	static resolveTable(tables: SqlParser.TableReference[] | undefined, tableReference: string): SqlParser.TableReference {
		return SqlParser.findTable(tables, tableReference) ?? {table: tableReference};
	}

	// The DB2 for i aggregate/column functions checked against here -- deliberately a plain array
	// rather than a one-off regex literal so it reads as "the current list of known aggregates" and
	// stays easy to extend if another one (e.g. LISTAGG) turns out to matter for this.
	static readonly AGGREGATE_FUNCTIONS = ['COUNT', 'COUNT_BIG', 'SUM', 'AVG', 'MIN', 'MAX', 'VARIANCE', 'STDDEV'];

	private static readonly AGGREGATE_FUNCTION_PATTERN = new RegExp(`^(?:${SqlAssist.AGGREGATE_FUNCTIONS.join('|')})\\s*\\(`, 'i');

	// Classifies every item in the SELECT list belonging to the statement currently being typed
	// (per SqlParser.getCurrentSelectListText) into what GROUP BY is actually allowed to reference:
	// a plain (optionally alias-qualified) column, or some other non-aggregated expression offered
	// back verbatim. An aggregate call is dropped entirely -- SQL never requires (or permits) it in
	// GROUP BY. Returns undefined -- meaning "offer nothing" -- once there's no SELECT/FROM pair to
	// anchor on yet, or the select list contains a "*"/"alias.*" wildcard, since there's then no
	// way to know the full set of non-aggregated columns the query would actually need.
	static getGroupableSelectItems(sql: string): Nullable<SqlAssist.GroupableSelectItem[]> {
		let selectListText = SqlParser.getCurrentSelectListText(sql);

		if(!selectListText) {
			return undefined;
		}

		let rawItems = SqlParser.splitTopLevelCommas(selectListText).map(item => item.trim()).filter(item => item.length > 0);

		if(rawItems.some(item => item === '*' || item.endsWith('.*'))) {
			return undefined;
		}

		let items: SqlAssist.GroupableSelectItem[] = [];

		for(let rawItem of rawItems) {
			let coreExpression = SqlAssist.stripSelectItemAlias(rawItem);

			if(SqlAssist.AGGREGATE_FUNCTION_PATTERN.test(coreExpression)) {
				continue;
			}

			// Split on every dot rather than a single "(schema.)?(qualifier.)?column" regex -- a
			// regex like that needs an optional leading discard group for the schema segment,
			// which (being greedy and optional) ends up swallowing the ONLY dot in a plain
			// "qualifier.column" reference, losing the qualifier. Taking the last two segments
			// directly sidesteps that regardless of whether a schema segment is present at all.
			let parts = coreExpression.split('.').map(part => part.trim());
			let isPlainColumnReference = parts.length <= 3 && parts.every(part => /^[a-zA-Z_]\w*$/.test(part));

			items.push(isPlainColumnReference
				? {type: 'column', qualifier: parts.length >= 2 ? parts[parts.length - 2] : undefined, columnName: parts[parts.length - 1]}
				: {type: 'expression', text: coreExpression});
		}

		return items;
	}

	// Strips a trailing explicit ("AS alias") or implicit ("expr alias") alias off a single SELECT
	// list item, e.g. "SUM(amount) AS total" / "dept_id d" both reduce to their expression alone.
	// The explicit-AS pattern is tried first and separately from the implicit one (rather than
	// folding "AS" into a single optional group) -- a single optional "(?:AS\s+)?" lets the greedy
	// engine prefer the split where "AS" itself stays part of the core expression and only the
	// word after it is treated as the alias, which is backwards from what's intended. The trailing
	// identifier is rejected as an alias when it's actually a reserved word (e.g. the "NULL" in
	// "amount IS NOT NULL") via the same RESERVED_WORDS exclusion parseTables' own alias detection
	// uses, so a boolean/null-check expression's own keyword is never swallowed as if it were a
	// made-up alias.
	private static stripSelectItemAlias(item: string): string {
		let reservedWordPattern = SqlParser.RESERVED_WORDS.join('|');
		let aliasPattern = `(?!(?:${reservedWordPattern})\\b)[a-zA-Z_]\\w*`;
		let explicitAsMatch = item.match(new RegExp(`^(.*\\S)\\s+AS\\s+(${aliasPattern})$`, 'i'));

		if(explicitAsMatch) {
			return explicitAsMatch[1];
		}

		let implicitAliasMatch = item.match(new RegExp(`^(.*\\S)\\s+(${aliasPattern})$`, 'i'));
		return implicitAliasMatch ? implicitAliasMatch[1] : item;
	}

	// Lines up the explicit "INSERT INTO table (colA, colB)" column list (if any) with the loaded
	// SystemColumn metadata, preserving the order the user typed them in. With no explicit list,
	// falls back to the table's full column order (the query is ordered by ORDINAL_POSITION),
	// matching "INSERT INTO table VALUES (...)" supplying every column positionally.
	static getOrderedInsertColumns(parseResults: SqlParser.SqlParseResults, columns: SystemColumn[]): SystemColumn[] {
		let insertColumns = parseResults.insertColumns;

		if(!insertColumns?.length) {
			return columns;
		}

		return insertColumns
			.map(name => ColumnNameUtils.findSystemColumn(columns, name))
			.filter((column): column is SystemColumn => column != null);
	}

	static getValueDescriptor(column: SystemColumn): SqlAssist.ItemDescriptor {
		let value = FieldUtils.getDefaultValueLiteral(column);
		return {
			label: `${value} (default for ${column.systemName})`,
			insertText: value,
			detail: `${column.schema}.${column.tableName}.${column.systemName} (${column.dataType})`.toLowerCase()
		};
	}

	static getBulkValueDescriptor(tableReference: SqlParser.TableReference, columns: SystemColumn[]): SqlAssist.ItemDescriptor {
		let values = columns.map(column => FieldUtils.getDefaultValueLiteral(column)).join(', ');
		return {
			label: `[Default values for ${tableReference.table}]`,
			insertText: values,
			detail: values.toLowerCase()
		};
	}
}

export namespace SqlAssist {
	export interface TableContextItemsOptions extends DbAssist.DbItemsOptions {
		parseResults: SqlParser.SqlParseResults;
	}

	export interface TableItemsOptions extends TableContextItemsOptions {
		schema?: string;
	}

	export interface ColumnContextItemsOptions extends DbAssist.DbItemsOptions {
		parseResults: SqlParser.SqlParseResults;
		// Defaults to true (via getCustomColumnItems' `=== false` check) so every existing call site
		// keeps offering "*"/"[All from ...]" unchanged; only getOrderByContextItems sets this false.
		includeWildcards?: boolean;
	}

	export interface ColumnItemsOptions extends ColumnContextItemsOptions {
		schema?: string;
		tableReference: SqlParser.TableReference;
		includeAlias: boolean;
		dotMatch?: DbAssist.DotMatch;
	}

	export interface InsertTable {
		table: string;
		schema?: string;
	}

	export interface ItemDescriptor {
		label: string;
		insertText: string;
		detail: string;
	}

	// A single SELECT list item that's eligible to appear in GROUP BY (an aggregate call is
	// filtered out well before this type is ever produced -- see getGroupableSelectItems). A plain
	// (optionally alias-qualified) column carries qualifier/columnName so it can be resolved through
	// the normal column-metadata path; anything else (a non-aggregate function call, arithmetic,
	// CASE, etc.) carries its own already-alias-stripped text verbatim instead, since there's no
	// metadata to look up for it.
	export interface GroupableSelectItem {
		type: 'column' | 'expression';
		qualifier?: string;
		columnName?: string;
		text?: string;
	}
}
