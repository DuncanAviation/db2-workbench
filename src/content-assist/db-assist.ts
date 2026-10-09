import { DbConnections } from '../database/db-connections.js';
import type { Extension } from '../extension.js';
import { ConnectionConfig } from '../models/connection-config.js';
import { SystemSchema } from '../models/system-schema.js';
import { Nullable } from '../utils/nullable.js';
import { SpParser } from '../utils/sp-parser.js';
import { SqlParser } from '../utils/sql-parser.js';
import type { SqlStatementText } from '../utils/sql-statement-text.js';

import { StringUtils } from '../utils/string-utils.js';

// Deliberately free of any `vscode` import -- importing `vscode` at module scope breaks loading
// outside a running Extension Host, even for an otherwise-pure method (see CteAssist/
// SqlStatementText for the same pattern and why). Every item-building method here -- and, in turn,
// on SpAssist/SqlAssist, which extend this -- returns a plain CompletionItemDescriptor (below);
// StatementCompletionProvider is the one place left in this whole chain that still imports
// `vscode`, and is solely responsible for turning descriptors into real vscode.CompletionItems.
export class DbAssist {
	constructor(public extension: Extension) {}

	getLastKeyword(text: string): Nullable<string> {
		let regex = new RegExp(DbAssist.KEYWORD_LOOKBACK_PATTERN.source, 'gi');
		let match: RegExpExecArray | null;
		let lastKeyword: Nullable<string>;

		while((match = regex.exec(text)) !== null) {
			lastKeyword = match[1];
		}

		return lastKeyword;
	}

	async getConnectionConfig(key: string): Promise<Nullable<ConnectionConfig>> {
		return this.extension.connections.getConnectionConfig({key: key});
	}

	includeAlias(options: DbAssist.IncludeAliasOptions): boolean {
		// Widened to plain string on assignment -- lets this compare against the literal values
		// without importing Configurations (its "useAlias" getter is typed via Configurations.UseAlias,
		// but configurations.ts imports vscode, so pulling the real enum in here would defeat the point).
		let useAlias: string = this.extension.configurations.useAlias;

		if(useAlias === 'Always') {
			return true;
		}

		if(useAlias === 'Never') {
			return false;
		}

		return options.smartInclude();
	}

	private async findSchema(key: string, schema: string): Promise<Nullable<SystemSchema>> {
		let schemas = await this.extension.memoryCache.getSchemas({
			key: key
		});

		return schemas.find(findSchema => StringUtils.equalsIgnoreCase(findSchema.name, schema));
	}

	// Matches a trailing "name.", "qualifier.name.", or partial "name"/"qualifier.name" reference,
	// e.g. "MYTABLE." (qualifier undefined), "MYSCHEMA.MYTABLE." (qualifier "MYSCHEMA"), or
	// "MYSCHEMA.TAB" (qualifier "MYSCHEMA", value "TAB" not yet resolved to anything) — so callers
	// can tell whether the user typed a schema-qualified reference, and what they've typed so far
	// past the last resolved segment, without a separate regex per call site. "name" may be either
	// a table name or an alias (e.g. the "e" in "e."); callers resolve which via SqlParser.findTable.
	async getDotMatch(options: DbAssist.DbItemsOptions): Promise<Nullable<DbAssist.DotMatch>> {
		// A reference is often immediately followed by an opening paren rather than more text —
		// e.g. "INSERT INTO schema.table (" about to list columns, or "CALL proc(" about to list
		// parameters — so that trailing "(" (and any whitespace around it) is stripped first;
		// otherwise the regex below, which anchors to the end of the string, would never reach
		// back far enough to find the reference.
		let sql = options.sql.replace(/\s*\(\s*$/, '');
		let match = sql.match(/(?:(\w+)\s*\.\s*)?(?:(\w+)\s*\.\s*)?(\w*)$/);

		if(match == null) {
			return undefined;
		}

		// A single completed "name." segment lands in the first capture group (the second is only
		// populated once there are two dots), so normalize it into the "name" slot here.
		let qualifier = match[2] != null ? match[1] : undefined;
		let name = match[2] != null ? match[2] : match[1];
		let value = match[3] ?? '';

		if(qualifier != null) {
			let qualifiedSchema = await this.findSchema(options.key, qualifier);

			return {
				schema: qualifiedSchema,
				tableReference: name,
				value: value
			};
		}

		if(name == null) {
			return {
				value: value
			};
		}

		let schema = await this.findSchema(options.key, name);

		if(schema == null) {
			return {
				tableReference: name,
				value: value
			};
		}

		return {
			schema: schema,
			value: value
		};
	}

	getKeyWordItems(keyWords = DbAssist.ALL_KEYWORDS): DbAssist.CompletionItemDescriptor[] {
		return keyWords.map(keyword => ({
			label: keyword,
			insertText: keyword,
			kind: 'Keyword',
			sortText: DbAssist.ItemSortOrder.KEY_WORDS
		}));
	}

	async getSchemaItems(key: string): Promise<DbAssist.CompletionItemDescriptor[]> {
		let schemas = await this.extension.memoryCache.getSchemas({
			key: key
		});

		if(schemas.length === 0) {
			return [];
		}

		return schemas.map(schema => ({
			label: StringUtils.isNotBlank(schema.description) ? `${schema.name} (${schema.description})` : schema.name,
			insertText: schema.name,
			kind: 'Module',
			sortText: DbAssist.ItemSortOrder.SCHEMAS
		}));
	}
}

export namespace DbAssist {
	export const ALL_KEYWORDS = [...SqlParser.KEY_WORDS, ...SpParser.KEY_WORDS];

	// Multi-word keywords (e.g. "LEFT JOIN") need `\s+` in place of the literal space so the
	// lookback still matches when they wrap across lines.
	export const KEYWORD_LOOKBACK_PATTERN = new RegExp(
		`\\b(${SqlParser.KEY_WORDS.map(keyword => keyword.replace(/\s+/g, '\\s+')).join('|')})\\b`,
		'gi'
	);

	export enum ItemSortOrder {
		CUSTOM = '0',
		CTES = '1',
		SCHEMAS = '2',
		TABLES = '3',
		VALUES = '4',
		COLUMNS = '5',
		FUNCTIONS = '6',
		KEY_WORDS = '7'
	}

	export interface IncludeAliasOptions {
		smartInclude: () => boolean;
	}

	export interface DbItemsOptions extends DbConnections.CommonListOptions {
		sql: string;
		caretPosition: SqlStatementText.CaretPosition;
		connectionConfig?: ConnectionConfig;
	}

	export interface DotMatch {
		schema?: SystemSchema;
		tableReference?: string;
		value: string;
	}

	// Names match vscode.CompletionItemKind's own member names 1:1 (StatementCompletionProvider maps
	// via `vscode.CompletionItemKind[descriptor.kind]`) -- kept as a plain string union rather than a
	// mirrored enum so this stays free of any real dependency on `vscode`.
	export type ItemKind = 'Keyword' | 'Module' | 'Class' | 'Field' | 'Value' | 'Method' | 'Function';

	// The final, vscode-free shape every Db/Sp/SqlAssist item-building method returns.
	// StatementCompletionProvider (the only place that still imports `vscode` in this whole chain)
	// is solely responsible for turning these into real vscode.CompletionItems.
	export interface CompletionItemDescriptor {
		label: string;
		insertText: string;
		detail?: string;
		kind: ItemKind;
		sortText: ItemSortOrder;
	}

	export function getDominantCasing(sql?: string): 'upper' | 'lower' {
		if(!sql) {
			return 'lower';
		}

		let upperCount = 0;
		let lowerCount = 0;

		let words = <string[]>sql.match(/\b\w+\b/g);

		if(words.length > 0) {
			for(let word of words) {
				if(DbAssist.ALL_KEYWORDS.some(keyWord => StringUtils.equalsIgnoreCase(keyWord, word))) {
					if(word === word.toUpperCase()) {
						upperCount++;
					} else if(word === word.toLowerCase()) {
						lowerCount++;
					}
				}
			}
		}

		return upperCount > lowerCount ? 'upper' : 'lower';
	}
}
