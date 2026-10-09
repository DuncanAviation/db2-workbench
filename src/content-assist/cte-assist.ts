import type { CaretPosition, CommonEntityContext, EntityContext } from 'dt-sql-parser';
import { DtSqlParser } from '../dt-sql-parser.js';
import { DanglingJoinRepair, Db2SyntaxShim } from '../utils/dt-sql-parser-shim.js';

import { Nullable } from '../utils/nullable.js';
import { StringUtils } from '../utils/string-utils.js';

// Experimental: resolves the columns a CTE exposes so content-assist can offer them the same way
// it offers a real table's columns. MemoryCache only knows about real DB2 tables (from
// QSYS2.SYSCOLUMNS), so today "SELECT | FROM emp_cte" (emp_cte being a WITH-defined CTE, not a
// real table) returns nothing -- the flat regex SqlParser.parseTables happily records "emp_cte"
// as a table reference, but nothing resolves what columns it actually has.
//
// Every method here takes the FULL statement text (e.g. parseResults.originalSql), never the
// cursor-truncated "SQL up to cursor" -- a CTE's own reference (its "FROM emp_cte") very often
// comes textually *after* the cursor (you write the WITH clause, then go back up to fill in the
// SELECT list), and without it dt-sql-parser has no table entity for the CTE to resolve at all.
//
// Uses dt-sql-parser's PostgreSQL grammar (closest available AST parser with real CTE/subquery
// scope support -- there is no DB2 dialect yet, see tmp/dt-sql-parser-spike and
// tmp/db2-grammar-spike) purely to walk the statement's entity graph. This is deliberately scoped
// to top-level, non-nested CTEs only, and only feeds SqlAssist.getColumnItems -- assignment-value
// lookups (WHERE col = |) still go straight to MemoryCache and won't resolve a CTE's columns yet.
export class CteAssist {
	private static readonly parser = new DtSqlParser.PostgreSQL();

	// Matches each CTE's own declaration at the top level of a WITH clause: "WITH name AS (",
	// optionally preceded by "RECURSIVE" (applies once, to the whole WITH clause) and/or followed
	// by an explicit column-rename list ("name (col1, col2) AS ("); "," instead of "WITH" for every
	// CTE after the first. Deliberately simple (no depth tracking): a subquery containing its own
	// nested "WITH ... AS (" would also match here, which is a known, accepted gap for this pass.
	private static readonly CTE_DECLARATION_PATTERN =
		/\bWITH\s+(?:RECURSIVE\s+)?(?<name1>\w+)\s*(?:\((?<columns1>[^)]*)\)\s*)?AS\s*\(|,\s*(?<name2>\w+)\s*(?:\((?<columns2>[^)]*)\)\s*)?AS\s*\(/gi;

	// Every top-level CTE declared in the statement's WITH clause, in declaration order, alongside
	// the columns it exposes (empty if they couldn't be resolved) -- the one pass over the
	// declaration regex and the entity graph that both "what CTEs exist" (e.g. offering their
	// names for table-context completion) and "what columns does this CTE have" (getCteColumns/
	// getVirtualTableColumns) read from, rather than each doing that work separately.
	static getCtes(sql: string): CteAssist.Cte[] {
		let declarations = CteAssist.getCteDeclarations(sql);

		if(declarations.length === 0) {
			return [];
		}

		let entities = CteAssist.parseEntities(sql);

		// dt-sql-parser's entity graph doesn't link a CTE's table entity back to its own SELECT
		// list explicitly. The Nth queryResult entity in the array is always the Nth *declared*
		// CTE's own body, though -- CTE bodies are fully parsed, in declaration order, before the
		// statement that follows the WITH clause even begins. This holds regardless of how the
		// CTEs get referenced afterward -- notably, looking for "the entity right before this CTE's
		// own outer table reference" does NOT hold in general: "FROM a, b" (or any multi-table
		// FROM/JOIN referencing more than one CTE, or a CTE alongside a real table) puts those table
		// entities adjacent to each other, with no queryResult between them at all.
		let queryResults = entities.filter(entity => entity.entityContextType === DtSqlParser.EntityContextType.QUERY_RESULT);
		let noColumns: CteAssist.CteColumns = {literalColumns: [], wildcardTables: []};

		return declarations.map((declaration, index) => ({
			name: declaration.name,
			columns: index < queryResults.length
				? CteAssist.resolveQueryResultColumns(entities, queryResults[index], declaration.explicitColumns)
				: noColumns
		}));
	}

	// Map of CTE name (lowercased) -> its own SELECT list split into columns it names explicitly
	// vs. tables it wildcards ("*"/"alias.*") -- a CTE that's a plain passthrough ("SELECT * FROM
	// appuser") exposes appuser's real columns wholesale, not the literal string "*". Only CTEs
	// getCtes actually resolved columns for are included - one with neither is useless as a virtual
	// table's column source.
	static getCteColumns(sql: string): Map<string, CteAssist.CteColumns> {
		let columnsByName = new Map<string, CteAssist.CteColumns>();

		for(let cte of CteAssist.getCtes(sql)) {
			if(cte.columns.literalColumns.length > 0 || cte.columns.wildcardTables.length > 0) {
				columnsByName.set(cte.name.toLowerCase(), cte.columns);
			}
		}

		return columnsByName;
	}

	// Map of CTE/derived-table name (lowercased) -> exposed columns, combining getCteColumns and
	// getDerivedTableColumns into the one lookup SqlAssist actually needs -- a derived table
	// ("FROM (SELECT ...) alias") is structurally the same "virtual table with its own SELECT list"
	// concept as a CTE, just declared inline instead of named via WITH. CTEs win on a name collision
	// (a user-caused ambiguity either way, not something to guess between).
	static getVirtualTableColumns(sql: string): Map<string, CteAssist.CteColumns> {
		let columns = CteAssist.getCteColumns(sql);

		for(let [alias, aliasColumns] of CteAssist.getDerivedTableColumns(sql)) {
			if(!columns.has(alias)) {
				columns.set(alias, aliasColumns);
			}
		}

		return columns;
	}

	// Map of derived-table alias (lowercased) -> its own SELECT list, same shape as getCteColumns.
	// Resolved independently per derived table (re-parsing its own self-contained "(...)" text as a
	// standalone statement) rather than by position in the outer entities array -- exactly like
	// CTEs, multiple derived tables referenced together in one FROM/JOIN ("(sub1) x JOIN (sub2) y")
	// put their outer table entities adjacent to each other with no queryResult between them,
	// breaking any "nearby entity" heuristic. Unlike CTEs, though, a derived table has no declared
	// name to anchor a positional Nth-queryResult pairing against either -- its own self-contained
	// text (dt-sql-parser hands back the exact "(SELECT ...)" it matched) is the only reliable
	// anchor, so this re-parses that text on its own instead.
	private static getDerivedTableColumns(sql: string): Map<string, CteAssist.CteColumns> {
		let columnsByAlias = new Map<string, CteAssist.CteColumns>();
		let entities = CteAssist.parseEntities(sql);

		for(let entity of entities) {
			if(entity.entityContextType !== DtSqlParser.EntityContextType.TABLE) {
				continue;
			}

			let alias = entity._alias?.text;

			// A derived table's own entity text is the raw "(SELECT ...)" it was matched from --
			// unlike a plain (possibly schema-qualified) identifier, that always contains whitespace,
			// which is what distinguishes the two here.
			if(!alias || !/\s/.test(entity.text)) {
				continue;
			}

			let innerSql = CteAssist.stripOuterParens(entity.text);

			if(!innerSql) {
				continue;
			}

			let innerEntities = CteAssist.parseEntities(innerSql);
			let ownQueryResult = innerEntities[innerEntities.length - 1];

			if(ownQueryResult == null) {
				continue;
			}

			let columns = CteAssist.resolveQueryResultColumns(innerEntities, ownQueryResult);

			if(columns.literalColumns.length > 0 || columns.wildcardTables.length > 0) {
				columnsByAlias.set((<string>alias).toLowerCase(), columns);
			}
		}

		return columnsByAlias;
	}

	private static stripOuterParens(text: string): Nullable<string> {
		let trimmed = text.trim();

		if(!trimmed.startsWith('(') || !trimmed.endsWith(')')) {
			return undefined;
		}

		return trimmed.slice(1, -1);
	}

	// Splits one query result's columns into explicitly-named columns vs. wildcarded tables. A
	// bare "*" pulls in every table in the same FROM clause -- i.e. every table entity sharing this
	// queryResult's own belongStmt (confirmed empirically: entities from the same FROM clause share
	// the same belongStmt object, and it differs from an outer/sibling statement's) -- while
	// "alias.*" pulls in just the one table matching that alias or table name.
	//
	// explicitColumns, when the CTE was declared with its own column-rename list ("data (a, b) AS
	// (...)"), is used as-is for literalColumns (positionally, per the standard SQL meaning of that
	// syntax) instead of whatever the inner SELECT list's own column names/aliases are -- the two
	// are deliberately not cross-checked for a matching count, trusting the SQL is well-formed. Its
	// entries carry no sourceTable/sourceColumn (unlike the loop below) -- pinning a renamed
	// column back to its positional source in the inner SELECT list isn't attempted, so callers
	// simply get no heading/metadata for these, same as before this had a source to resolve at all.
	private static resolveQueryResultColumns(entities: EntityContext[], queryResultEntity: EntityContext, explicitColumns?: string[]): CteAssist.CteColumns {
		let empty: CteAssist.CteColumns = {literalColumns: [], wildcardTables: []};

		if(queryResultEntity.entityContextType !== DtSqlParser.EntityContextType.QUERY_RESULT) {
			return empty;
		}

		let columns = (<CommonEntityContext>queryResultEntity).columns ?? [];

		if(columns.length === 0) {
			return empty;
		}

		if(explicitColumns?.length) {
			return {literalColumns: explicitColumns.map(name => ({name: name})), wildcardTables: []};
		}

		let siblingTables = entities.filter(entity => entity.entityContextType === DtSqlParser.EntityContextType.TABLE && entity.belongStmt === queryResultEntity.belongStmt);
		let literalColumns: CteAssist.CteLiteralColumn[] = [];
		let wildcardTables: string[] = [];

		// The one real (or virtual) table this column's value actually comes from, so a literal
		// column can still be traced back to its underlying metadata (e.g. heading) even though
		// it's exposed under the CTE's own possibly-renamed name -- a qualified reference ("t.a")
		// resolves against the matching sibling by alias/table name; an unqualified one ("a") is
		// only attributable when exactly one table is in the CTE's own FROM/JOIN, since more than
		// one makes the source genuinely ambiguous. Only meaningful for a plain column reference,
		// never a function call/expression (even an aliased one, e.g. "UPPER(name) AS x") -- there's
		// no real source column behind that to look metadata up for, "name" being the whole
		// expression text in that case, not an actual column name.
		let resolveSource = (isPlainReference: boolean, qualifier: string | undefined, sourceColumn: string): Pick<CteAssist.CteLiteralColumn, 'sourceTable' | 'sourceColumn'> => {
			if(!isPlainReference) {
				return {};
			}

			let sourceTable = qualifier
				? siblingTables.find(table => StringUtils.equalsIgnoreCase(table.text, qualifier) || StringUtils.equalsIgnoreCase(table._alias?.text ?? '', qualifier))?.text
				: (siblingTables.length === 1 ? siblingTables[0].text : undefined);

			return sourceTable ? {sourceTable: sourceTable, sourceColumn: sourceColumn} : {};
		};

		for(let column of columns) {
			let lastDotIndex = column.text.lastIndexOf('.');
			let qualifier = lastDotIndex === -1 ? undefined : column.text.substring(0, lastDotIndex);
			let name = lastDotIndex === -1 ? column.text : column.text.substring(lastDotIndex + 1);
			let isPlainReference = !column.text.includes('(');

			if(name === '*') {
				let matchingTables = !qualifier
					? siblingTables
					: siblingTables.filter(table => StringUtils.equalsIgnoreCase(table.text, <string>qualifier) || StringUtils.equalsIgnoreCase(table._alias?.text ?? '', <string>qualifier));

				wildcardTables.push(...matchingTables.map(table => table.text));
				continue;
			}

			// An explicit "AS alias" always wins -- e.g. "t.a AS x" is exposed as "x", not "a",
			// since that's the name the outer query actually has to reference it by. The *source*
			// column to resolve metadata for is still the original "a", though, not the alias "x".
			if(column._alias?.text) {
				literalColumns.push({name: <string>column._alias?.text, ...resolveSource(isPlainReference, qualifier, name)});
				continue;
			}

			// A plain column/qualified-column reference (e.g. "id" or "t.id") has a clean name to
			// expose even without an alias. An expression or function call without one (e.g.
			// "UPPER(name)") does not -- standard SQL wouldn't let the outer query reference it by
			// that text either, so it's skipped rather than offering the raw expression text as if
			// it were a real column name.
			if(isPlainReference) {
				literalColumns.push({name: name, ...resolveSource(true, qualifier, name)});
			}
		}

		return {literalColumns: literalColumns, wildcardTables: Array.from(new Set(wildcardTables.map(table => table.toLowerCase())))};
	}

	// Composite key identifying one specific table *occurrence* -- its name plus whatever alias (if
	// any) that particular occurrence was given -- rather than just the bare table name. An aliased
	// outer JOIN ("JOIN apphost b") and an unrelated, unaliased reference to the same underlying
	// table name buried inside some other CTE's own body ("data2 AS (SELECT * FROM apphost)") are
	// two entirely different occurrences and must never be conflated: see getInaccessibleTableNames.
	static getTableKey(name: string, alias?: Nullable<string>): string {
		return `${name.toLowerCase()}::${(alias ?? '').toLowerCase()}`;
	}

	// Occurrence keys (getTableKey) of table references dt-sql-parser can positively confirm are OUT
	// of scope at the cursor, per its own scope-depth accessibility tracking -- e.g. in "WITH data AS
	// (SELECT fnam FROM appuser) SELECT | FROM data", SqlParser.parseTables (flat regex, no concept
	// of CTE-body boundaries) records both "data" and "appuser" as plain table references, but
	// "appuser" is only reachable from inside data's own definition, not from the outer SELECT.
	//
	// Deliberately a blocklist (isAccessible === false), not an allowlist -- if dt-sql-parser fails
	// to make sense of something elsewhere in the statement and returns nothing, this returns an
	// empty set and callers filter out nothing, falling back to today's behavior, rather than an
	// allowlist's failure mode of hiding every real, legitimately-accessible table.
	//
	// An occurrence is only ever blocked if EVERY occurrence sharing its exact (name, alias) pair is
	// inaccessible -- the same table can appear more than once under the SAME alias (e.g. once inside
	// a CTE's own body, and again directly in the outer FROM), and if even one of those is genuinely
	// in scope at the cursor, it must still be offered; a single inaccessible occurrence elsewhere
	// must not veto that. Keying by (name, alias) rather than by bare name matters here: an outer
	// "JOIN apphost b" being accessible must never rescue a completely unrelated, genuinely
	// inaccessible bare "apphost" sitting inside some other CTE's body -- those are different
	// occurrences (regression: this used to be keyed by bare name alone, which let exactly that kind
	// of unrelated, unused CTE leak its own tables into the outer scope's results).
	//
	// caretPosition must be in fullSql's own coordinate space (statement-relative, not
	// document-relative) -- EditorUtils.getCaretPosition computes exactly that. In practice, though,
	// the two are sourced independently and can disagree by exactly the trailing whitespace between
	// the last real token and the cursor: fullSql is parseResults.originalSql, trimmed on both ends
	// by StatementParser.parse, while caretPosition is computed against the raw, untrimmed document
	// text. Typing "ORDER BY " (nothing after the trailing space) is the common case this bites --
	// caretPosition ends up one column past the end of fullSql's own last line, and dt-sql-parser
	// responds to that out-of-range position by treating every table as inaccessible. Clamping here
	// keeps every table's accessibility current with whatever the user has actually typed, rather
	// than with whichever untyped trailing whitespace happens to sit under the cursor.
	static getInaccessibleTableNames(fullSql: string, caretPosition: CaretPosition): Set<string> {
		let clampedCaretPosition = CteAssist.clampCaretPosition(fullSql, caretPosition);
		let tableEntities = CteAssist.parseEntities(fullSql, clampedCaretPosition)
			.filter(entity => entity.entityContextType === DtSqlParser.EntityContextType.TABLE);

		let accessibleKeys = new Set(
			tableEntities
				.filter(entity => entity.isAccessible !== false)
				.map(entity => CteAssist.getTableKey(entity.text, entity._alias?.text))
		);

		return new Set(
			tableEntities
				.filter(entity => entity.isAccessible === false && !accessibleKeys.has(CteAssist.getTableKey(entity.text, entity._alias?.text)))
				.map(entity => CteAssist.getTableKey(entity.text, entity._alias?.text))
		);
	}

	// Caps caretPosition at fullSql's own last line/column so it can never point past text that
	// isn't actually there -- see getInaccessibleTableNames for why the two can disagree.
	private static clampCaretPosition(fullSql: string, caretPosition: CaretPosition): CaretPosition {
		let lines = fullSql.split('\n');
		let maxLineNumber = lines.length;
		let maxColumnOnLastLine = lines[lines.length - 1].length + 1;

		if(caretPosition.lineNumber > maxLineNumber) {
			return {lineNumber: maxLineNumber, column: maxColumnOnLastLine};
		}

		if(caretPosition.lineNumber === maxLineNumber && caretPosition.column > maxColumnOnLastLine) {
			return {lineNumber: maxLineNumber, column: maxColumnOnLastLine};
		}

		return caretPosition;
	}

	// Locates "name"'s own top-level WITH-clause declaration ("WITH name AS (" or ", name AS (") for
	// Go to Definition navigation - undefined if no CTE by that name is declared in "sql". Doubles as
	// the "is this word a CTE name" check itself (callers just test the result for emptiness) rather
	// than needing a separate lookup, since finding the declaration necessarily proves it exists.
	static findCteDeclarationOffset(sql: string, name: string): Nullable<number> {
		let regex = new RegExp(CteAssist.CTE_DECLARATION_PATTERN.source, 'gi');
		let match: RegExpExecArray | null;

		while((match = regex.exec(sql)) !== null) {
			let matchedName = match.groups?.name1 ?? match.groups?.name2;

			// The declared name is always the first occurrence of that exact word within this match
			// (an explicit column-rename list or the "AS (" that follows can only repeat it later,
			// never earlier) - same indexOf-from-match.index approach as SqlParser.findAliasDeclarationOffset.
			if(matchedName && StringUtils.equalsIgnoreCase(matchedName, name)) {
				return match.index + match[0].indexOf(matchedName);
			}
		}

		return undefined;
	}

	private static getCteDeclarations(sql: string): CteAssist.CteDeclaration[] {
		let declarations: CteAssist.CteDeclaration[] = [];
		let regex = new RegExp(CteAssist.CTE_DECLARATION_PATTERN.source, 'gi');
		let match: RegExpExecArray | null;

		while((match = regex.exec(sql)) !== null) {
			let name = match.groups?.name1 ?? match.groups?.name2;

			if(!name) {
				continue;
			}

			let columnListRaw = match.groups?.columns1 ?? match.groups?.columns2;
			let explicitColumns = columnListRaw
				? columnListRaw.split(',').map(column => column.trim()).filter(column => !!column)
				: undefined;

			declarations.push({name: name, explicitColumns: explicitColumns});
		}

		return declarations;
	}

	private static parseEntities(sql: string, caretPosition?: CaretPosition): EntityContext[] {
		try {
			let prepared = Db2SyntaxShim.strip(DanglingJoinRepair.repair(sql));
			return CteAssist.parser.getAllEntities(prepared, caretPosition) ?? [];
		} catch {
			return [];
		}
	}
}

export namespace CteAssist {
	export interface Cte {
		name: string;
		columns: CteColumns;
	}

	export interface CteColumns {
		// Columns the CTE's own SELECT list names explicitly.
		literalColumns: CteLiteralColumn[];
		// Real tables (lowercased names) a "*"/"alias.*" in the CTE's SELECT list wildcards --
		// callers resolve these through the normal real-table column path.
		wildcardTables: string[];
	}

	export interface CteLiteralColumn {
		// The name exposed to callers of the CTE -- the alias if one was given, otherwise the
		// column's own name.
		name: string;
		// The table (real or itself another CTE/derived table) this column's value traces back to,
		// and the name to look it up by there -- present only when resolvable unambiguously (see
		// resolveQueryResultColumns). Lets a caller still look up the real column's own
		// metadata (e.g. heading) even though it's exposed here under the CTE's own name.
		sourceTable?: string;
		sourceColumn?: string;
	}

	export interface CteDeclaration {
		name: string;
		// Present only for "name (col1, col2) AS (...)" -- the CTE's own explicit column-rename
		// list, taken as-is over the inner SELECT list's own names/aliases.
		explicitColumns?: Nullable<string[]>;
	}
}
