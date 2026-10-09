import { SystemRoutine } from '../models/system-routine.js';
import { SystemProcedureParam } from '../models/system-procedure-param.js';
import { FieldUtils } from '../utils/field-utils.js';
import { RoutineUtils } from '../utils/routine-utils.js';
import { SpParser } from '../utils/sp-parser.js';
import { SqlParser } from '../utils/sql-parser.js';
import type { SqlStatementText } from '../utils/sql-statement-text.js';
import { StringUtils } from '../utils/string-utils.js';
import { DbAssist } from './db-assist.js';

export class SpAssist extends DbAssist {
	async getItems(key: string, sql: string, caretPosition: SqlStatementText.CaretPosition, parseResults: SpParser.SpParseResults): Promise<DbAssist.CompletionItemDescriptor[]> {
		if(SpAssist.isParameterContext(sql)) {
			return this.getParameterContextItems({key: key, sql: sql, caretPosition: caretPosition, parseResults: parseResults});
		}

		return this.getProcedureContextItems({key: key, sql: sql, caretPosition: caretPosition});
	}

	// With a schema typed, that schema's procedures; with none, every procedure on the library list - the
	// same list an unqualified CALL is resolved against when it runs.
	private async getProcedureContextItems(options: SpAssist.ProcedureContextItemsOptions): Promise<DbAssist.CompletionItemDescriptor[]> {
		let dotMatch = await this.getDotMatch(options);

		if(dotMatch?.schema != null) {
			return this.getProcedureItems({...options, schema: dotMatch.schema.name});
		}

		let [schemaItems, procedureItems] = await Promise.all([
			this.getSchemaItems(options.key),
			this.getProcedureItems(options)
		]);

		return [...schemaItems, ...procedureItems];
	}

	private async getProcedureItems(options: SpAssist.ProcedureItemsOptions): Promise<DbAssist.CompletionItemDescriptor[]> {
		let procedures = await this.extension.memoryCache.getProcedures({key: options.key, schema: options.schema});
		return RoutineUtils.groupByName(procedures).map(overloads => this.buildItem(SpAssist.getProcedureDescriptor(overloads), 'Method', DbAssist.ItemSortOrder.TABLES));
	}

	private async getParameterContextItems(options: SpAssist.ParameterContextItemsOptions): Promise<DbAssist.CompletionItemDescriptor[]> {
		let procedureName = options.parseResults.name;

		if(!procedureName) {
			return [];
		}

		// An unqualified name is resolved against the library list by getProcedureParams, as the CALL is when it runs.
		let params = await this.extension.memoryCache.getProcedureParams({...options, schema: options.parseResults.schema, procedure: procedureName});

		if(params.length === 0) {
			return [];
		}

		let items: DbAssist.CompletionItemDescriptor[] = [];

		if(!SpAssist.hasSuppliedParameters(options.sql)) {
			items.push(this.buildItem(SpAssist.getBulkParamValueDescriptor(procedureName, params), 'Value', DbAssist.ItemSortOrder.CUSTOM));
		}

		let targetParam = params[SqlParser.getArgumentIndex(options.sql)];

		if(targetParam != null) {
			items.push(this.buildItem(SpAssist.getParamValueDescriptor(targetParam), 'Value', DbAssist.ItemSortOrder.VALUES));
		}

		return items;
	}

	private buildItem(descriptor: SpAssist.ItemDescriptor, kind: DbAssist.ItemKind, sortOrder: DbAssist.ItemSortOrder): DbAssist.CompletionItemDescriptor {
		return {label: descriptor.label, insertText: descriptor.insertText, detail: descriptor.detail, kind: kind, sortText: sortOrder};
	}

	// True once the user has typed the opening "(" of the call's parameter list, e.g. "CALL proc(|".
	static isParameterContext(sql: string): boolean {
		return sql.includes('(');
	}

	// True once the user has typed anything (besides whitespace) inside the call's parameter list,
	// e.g. "CALL proc(1" or "CALL proc(1, " -- the bulk "all defaults" item only makes sense while
	// the list is still completely empty, since otherwise it would duplicate/clobber what's already
	// been typed.
	static hasSuppliedParameters(sql: string): boolean {
		let parenStart = SqlParser.getCurrentParenStart(sql);
		return parenStart !== -1 && StringUtils.isNotBlank(sql.substring(parenStart + 1));
	}

	// One item for every overload of a name - see RoutineUtils.groupByName.
	static getProcedureDescriptor(overloads: SystemRoutine[]): SpAssist.ItemDescriptor {
		let procedure = overloads[0];
		let description = overloads.map(overload => overload.description).find(StringUtils.isNotBlank);
		let label = description ? `${procedure.name} (${description})` : procedure.name;
		let schema = procedure.schema.toLowerCase();

		return {label: label, insertText: procedure.name, detail: overloads.length > 1 ? `${schema} (${overloads.length} overloads)` : schema};
	}

	static getParamValueDescriptor(param: SystemProcedureParam): SpAssist.ItemDescriptor {
		let value = FieldUtils.getDefaultValueLiteral(param);
		return {
			label: `${value} (default for ${param.name})`,
			insertText: value,
			detail: `${param.schema}.${param.procedureName}.${param.name} (${param.dataType})`.toLowerCase()
		};
	}

	static getBulkParamValueDescriptor(procedureName: string, params: SystemProcedureParam[]): SpAssist.ItemDescriptor {
		let values = params.map(param => FieldUtils.getDefaultValueLiteral(param)).join(', ');
		return {
			label: `[Default values for ${procedureName}]`,
			insertText: values,
			detail: values.toLowerCase()
		};
	}
}

export namespace SpAssist {
	export interface ProcedureContextItemsOptions extends DbAssist.DbItemsOptions {}

	export interface ProcedureItemsOptions extends ProcedureContextItemsOptions {
		schema?: string;
	}

	export interface ParameterContextItemsOptions extends DbAssist.DbItemsOptions {
		parseResults: SpParser.SpParseResults;
	}

	export interface ItemDescriptor {
		label: string;
		insertText: string;
		detail: string;
	}
}
