import { Nullable } from './nullable.js';
import { SpParser } from './sp-parser.js';
import { SqlParser } from './sql-parser.js';

export class StatementParser {
	static stripComments(sql?: string): string {
		if(!sql) {
			return '';
		}

		return sql
			.replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
			.replace(/--.*$/gm, '')           // Remove single-line comments
			.trim();
	}

	// Classifies any raw SQL/CALL text by its statement kind, independent of a full SqlParser/SpParser
	// parse - used both by those parsers (to stamp ParseResults.statementKind) and directly by
	// DbConnections' internal-query fire sites, which never build a full parse result. CALL is
	// checked separately (via SpParser.isSp) before the keyword table - everything else is a
	// first-keyword match against the already comment-stripped statement text.
	static classifyKind(statement: string): StatementParser.StatementKind {
		let stripped = StatementParser.stripComments(statement);

		if(SpParser.isSp(stripped)) {
			return StatementParser.StatementKind.CALL;
		}

		let keyWords: [string, StatementParser.StatementKind][] = [
			['SELECT', StatementParser.StatementKind.SELECT],
			['INSERT', StatementParser.StatementKind.INSERT],
			['UPDATE', StatementParser.StatementKind.UPDATE],
			['DELETE', StatementParser.StatementKind.DELETE],
			['MERGE', StatementParser.StatementKind.MERGE],
			['CREATE', StatementParser.StatementKind.CREATE],
			['ALTER', StatementParser.StatementKind.ALTER],
			['DROP', StatementParser.StatementKind.DROP],
			['TRUNCATE', StatementParser.StatementKind.TRUNCATE]
		];

		let match = keyWords.find(([keyword]) => new RegExp(`^\\s*${keyword}\\b`, 'i').test(stripped));
		return match ? match[1] : StatementParser.StatementKind.OTHER;
	}

	// Lightweight counterpart to parse() for callers that only need DbConnectionEvent.parseResults
	// populated (e.g. internal DDL/metadata queries) without the table/parameter extraction a full
	// SqlParser/SpParser parse does.
	static classify(statement: string): StatementParser.ParseResults {
		return {statementType: StatementParser.StatementType.SQL, statementKind: StatementParser.classifyKind(statement), originalSql: statement, isValid: true};
	}

	static parse(statement?: string): Nullable<SqlParser.SqlParseResults | SpParser.SpParseResults> {
		statement = StatementParser.stripComments(statement);

		if(!statement) {
			return;
		}

		return SpParser.isSp(statement)
			? SpParser.parse(statement)
			: SqlParser.parse(statement);
	}
}

export namespace StatementParser {
	export enum StatementType {
		SQL = 'sql',
		SP = 'sp'
	}

	// Coarse statement classification, independent of StatementType (SQL vs SP) - a CALL is
	// StatementType.SP and StatementKind.CALL at the same time. Exposed on DbConnectionEvent for
	// consumers (including other extensions via the public API) that care what kind of statement ran.
	export enum StatementKind {
		SELECT = 'SELECT',
		INSERT = 'INSERT',
		UPDATE = 'UPDATE',
		DELETE = 'DELETE',
		MERGE = 'MERGE',
		CREATE = 'CREATE',
		ALTER = 'ALTER',
		DROP = 'DROP',
		TRUNCATE = 'TRUNCATE',
		CALL = 'CALL',
		OTHER = 'OTHER'
	}

	export interface ParseResults {
		statementType: StatementType;
		statementKind: StatementKind;
		originalSql: string;
		isValid: boolean;
	}
}