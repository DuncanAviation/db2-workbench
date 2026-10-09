import * as vscode from 'vscode';
import { Extension } from './extension.js';
import type { SqlDocumentFormatter } from './formatting/sql-document-formatter.js';
import { ConnectionConfig } from './models/connection-config.js';
import { DataEditDefaults, DataEditSettings } from './utils/data-edit-defaults.js';
import { ResultHeadingLabel } from './models/result-heading-label.js';
import { SqlImportConfig } from './models/sql-import-config.js';

export class Configurations {
	private get<V>(key: string, defaultValue: V): V {
		return vscode.workspace.getConfiguration(Extension.ID).get(key, defaultValue);
	}

	private set(key: string, value: unknown): Thenable<void> {
		return vscode.workspace.getConfiguration(Extension.ID).update(key, value, vscode.ConfigurationTarget.Global);
	}

	get connections(): ConnectionConfig[] {
		return this.get(Configurations.Keys.CONNECTIONS, <ConnectionConfig[]>[]);
	}

	set connections(connections: ConnectionConfig[]) {
		this.set(Configurations.Keys.CONNECTIONS, connections);
	}

	/** The awaitable form of the `connections` setter - for a caller that writes two settings in a row and
	 * must not read either back before both have landed. */
	setConnections(connections: ConnectionConfig[]): Thenable<void> {
		return this.set(Configurations.Keys.CONNECTIONS, connections);
	}

	// Read from USER scope only, deliberately - unlike every other setting here. A saved SQL import
	// auto-runs against the user's own credentials as soon as a connection opens, so a workspace- or
	// folder-scoped entry would let a cloned repository run SQL nobody looked at. Only what the user put
	// in their own settings.json counts; anything else is ignored outright rather than merged.
	get sqlImports(): SqlImportConfig[] {
		let inspected = vscode.workspace.getConfiguration(Extension.ID).inspect<SqlImportConfig[]>(Configurations.Keys.SQL_IMPORTS);
		return inspected?.globalValue ?? [];
	}

	set sqlImports(imports: SqlImportConfig[]) {
		this.set(Configurations.Keys.SQL_IMPORTS, imports);
	}

	/** The awaitable form of the `sqlImports` setter - see setConnections. */
	setSqlImports(imports: SqlImportConfig[]): Thenable<void> {
		return this.set(Configurations.Keys.SQL_IMPORTS, imports);
	}

	get useAlias(): Configurations.UseAlias {
		return this.get(Configurations.Keys.USE_ALIAS, Configurations.UseAlias.SMART);
	}

	get cursorFetchSize(): number {
		return this.get(Configurations.Keys.CURSOR_FETCH_SIZE, 100);
	}

	get historyCount(): number {
		return this.get(Configurations.Keys.HISTORY_COUNT, 20);
	}

	// Applied per statement (per batch) a SQL schema import runs - see SqlSchemaImports. A site metadata
	// table is normally small, so this is a runaway guard rather than a paging mechanism.
	get sqlImportRowLimit(): number {
		return this.get(Configurations.Keys.SQL_IMPORT_ROW_LIMIT, 50000);
	}

	get autoFocusResults(): boolean {
		return this.get(Configurations.Keys.AUTO_FOCUS_RESULTS, true);
	}

	get resultHeadingLabels(): string[] {
		const value = this.get(Configurations.Keys.RESULT_HEADING_LABELS, [Configurations.ResultHeadingLabels.SHORT_NAME]);
		return Array.isArray(value) ? value : [value];
	}

	// The schema browser Data tab's edit settings. Shaped once here, so a hand-edited settings.json
	// value of the wrong type falls back to the default rather than reaching the webview.
	get dataEditSettings(): DataEditSettings {
		let defaults = DataEditDefaults.DEFAULT_SETTINGS;
		let defaultValues = this.get<unknown>(Configurations.Keys.DATA_EDIT_DEFAULT_VALUES, {});
		let columnsWithTableDefault = this.get<string>(Configurations.Keys.DATA_EDIT_COLUMNS_WITH_TABLE_DEFAULT, defaults.columnsWithTableDefault);
		let nullableColumns = this.get<string>(Configurations.Keys.DATA_EDIT_NULLABLE_COLUMNS, defaults.nullableColumns);

		return {
			defaultValues: defaultValues != null && typeof defaultValues === 'object' && !Array.isArray(defaultValues)
				? Object.fromEntries(Object.entries(defaultValues).filter(([, value]) => value === null || typeof value === 'string'))
				: {},
			columnsWithTableDefault: columnsWithTableDefault === 'appDefault' ? 'appDefault' : 'tableDefault',
			nullableColumns: nullableColumns === 'appDefault' ? 'appDefault' : 'null'
		};
	}

	// A value equal to its setting's default is cleared rather than written, so settings.json only
	// holds what the user actually changed.
	async setDataEditSettings(settings: DataEditSettings): Promise<void> {
		let defaults = DataEditDefaults.DEFAULT_SETTINGS;
		let defaultValues = DataEditDefaults.withoutAppDefaults(settings.defaultValues);

		await Promise.all([
			this.set(Configurations.Keys.DATA_EDIT_DEFAULT_VALUES, Object.keys(defaultValues).length > 0 ? defaultValues : undefined),
			this.set(Configurations.Keys.DATA_EDIT_COLUMNS_WITH_TABLE_DEFAULT, settings.columnsWithTableDefault === defaults.columnsWithTableDefault ? undefined : settings.columnsWithTableDefault),
			this.set(Configurations.Keys.DATA_EDIT_NULLABLE_COLUMNS, settings.nullableColumns === defaults.nullableColumns ? undefined : settings.nullableColumns)
		]);
	}

	get formattingTabWidth(): number {
		return this.get(Configurations.Keys.FORMATTING_TAB_WIDTH, 4);
	}

	get formattingUseTabs(): boolean {
		return this.get(Configurations.Keys.FORMATTING_USE_TABS, true);
	}

	get formattingKeywordCase(): Configurations.KeywordCase {
		return this.get(Configurations.Keys.FORMATTING_KEYWORD_CASE, Configurations.KeywordCase.PRESERVE);
	}

	get formattingDenseOperators(): boolean {
		return this.get(Configurations.Keys.FORMATTING_DENSE_OPERATORS, false);
	}

	get formattingRemoveComments(): boolean {
		return this.get(Configurations.Keys.FORMATTING_REMOVE_COMMENTS, false);
	}

	get formattingLinesBetweenQueries(): number {
		return this.get(Configurations.Keys.FORMATTING_LINES_BETWEEN_QUERIES, 1);
	}

	get formattingExpressionMaxWidth(): number {
		return this.get(Configurations.Keys.FORMATTING_EXPRESSION_MAX_WIDTH, 120);
	}

	get formattingSelectFieldWrapping(): Configurations.SelectFieldWrapping {
		return this.get(Configurations.Keys.FORMATTING_SELECT_FIELD_WRAPPING, Configurations.SelectFieldWrapping.WRAP_TO_WIDTH);
	}

	get formattingClauseLayout(): Configurations.ClauseLayout {
		return this.get(Configurations.Keys.FORMATTING_CLAUSE_LAYOUT, Configurations.ClauseLayout.COMPACT);
	}

	get formattingIndentJoins(): boolean {
		return this.get(Configurations.Keys.FORMATTING_INDENT_JOINS, false);
	}

	get formattingIndentWhere(): boolean {
		return this.get(Configurations.Keys.FORMATTING_INDENT_WHERE, false);
	}

	// Composes the formatting settings above into the shape SqlPrettyPrinter/SqlDocumentFormatter
	// actually take, so SqlFormattingProvider calls one getter instead of several.
	get formattingOptions(): SqlDocumentFormatter.Options {
		return {
			tabWidth: this.formattingTabWidth,
			useTabs: this.formattingUseTabs,
			keywordCase: this.formattingKeywordCase,
			denseOperators: this.formattingDenseOperators,
			removeComments: this.formattingRemoveComments,
			linesBetweenQueries: this.formattingLinesBetweenQueries,
			expressionMaxWidth: this.formattingExpressionMaxWidth,
			selectFieldWrapping: this.formattingSelectFieldWrapping,
			clauseLayout: this.formattingClauseLayout,
			indentJoins: this.formattingIndentJoins,
			indentWhere: this.formattingIndentWhere
		};
	}

	set formattingOptions(options: SqlDocumentFormatter.Options) {
		void this.setFormattingOptions(options);
	}

	/** The awaitable form of the `formattingOptions` setter. Each option is its own setting, so this is eleven
	 * separate writes - it resolves once all of them have landed, rather than a caller polling the getter
	 * until they happen to. */
	async setFormattingOptions(options: SqlDocumentFormatter.Options): Promise<void> {
		await Promise.all([
			this.set(Configurations.Keys.FORMATTING_TAB_WIDTH, options.tabWidth),
			this.set(Configurations.Keys.FORMATTING_USE_TABS, options.useTabs),
			this.set(Configurations.Keys.FORMATTING_KEYWORD_CASE, options.keywordCase),
			this.set(Configurations.Keys.FORMATTING_DENSE_OPERATORS, options.denseOperators),
			this.set(Configurations.Keys.FORMATTING_REMOVE_COMMENTS, options.removeComments),
			this.set(Configurations.Keys.FORMATTING_LINES_BETWEEN_QUERIES, options.linesBetweenQueries),
			this.set(Configurations.Keys.FORMATTING_EXPRESSION_MAX_WIDTH, options.expressionMaxWidth),
			this.set(Configurations.Keys.FORMATTING_SELECT_FIELD_WRAPPING, options.selectFieldWrapping),
			this.set(Configurations.Keys.FORMATTING_CLAUSE_LAYOUT, options.clauseLayout),
			this.set(Configurations.Keys.FORMATTING_INDENT_JOINS, options.indentJoins),
			this.set(Configurations.Keys.FORMATTING_INDENT_WHERE, options.indentWhere)
		]);
	}

	async restoreFormattingDefaults(): Promise<void> {
		let formattingKeys = Object.values(Configurations.Keys).filter(key => key.startsWith('formatting.'));
		await Promise.all(formattingKeys.map(key => this.set(key, undefined)));
	}
}

export namespace Configurations {
	export enum Keys {
		CONNECTIONS = 'connections',
		USE_ALIAS = 'useAlias',
		CURSOR_FETCH_SIZE = 'cursorFetchSize',
		HISTORY_COUNT = 'historyCount',
		SQL_IMPORTS = 'sqlImports',
		SQL_IMPORT_ROW_LIMIT = 'sqlImportRowLimit',
		AUTO_FOCUS_RESULTS = 'autoFocusResults',
		RESULT_HEADING_LABELS = 'resultHeadingLabels',
		DATA_EDIT_DEFAULT_VALUES = 'dataEdit.defaultValues',
		DATA_EDIT_COLUMNS_WITH_TABLE_DEFAULT = 'dataEdit.columnsWithTableDefault',
		DATA_EDIT_NULLABLE_COLUMNS = 'dataEdit.nullableColumns',
		FORMATTING_TAB_WIDTH = 'formatting.tabWidth',
		FORMATTING_USE_TABS = 'formatting.useTabs',
		FORMATTING_KEYWORD_CASE = 'formatting.keywordCase',
		FORMATTING_DENSE_OPERATORS = 'formatting.denseOperators',
		FORMATTING_REMOVE_COMMENTS = 'formatting.removeComments',
		FORMATTING_LINES_BETWEEN_QUERIES = 'formatting.linesBetweenQueries',
		FORMATTING_EXPRESSION_MAX_WIDTH = 'formatting.expressionMaxWidth',
		FORMATTING_SELECT_FIELD_WRAPPING = 'formatting.selectFieldWrapping',
		FORMATTING_CLAUSE_LAYOUT = 'formatting.clauseLayout',
		FORMATTING_INDENT_JOINS = 'formatting.indentJoins',
		FORMATTING_INDENT_WHERE = 'formatting.indentWhere'
	}

	export enum UseAlias {
		ALWAYS = 'Always',
		SMART = 'Smart',
		NEVER = 'Never'
	}

	// Re-exported (value and type) from src/models/result-heading-label.ts rather than declared here -
	// this file imports vscode, which would make the enum unreachable from any unit-testable module. Every
	// `Configurations.ResultHeadingLabels.X` reference keeps working unchanged.
	export const ResultHeadingLabels = ResultHeadingLabel;
	export type ResultHeadingLabels = ResultHeadingLabel;

	export enum KeywordCase {
		UPPER = 'upper',
		LOWER = 'lower',
		PRESERVE = 'preserve'
	}

	export enum SelectFieldWrapping {
		ONE_COLUMN_PER_LINE = 'oneColumnPerLine',
		WRAP_TO_WIDTH = 'wrapToWidth'
	}

	export enum ClauseLayout {
		EXPANDED = 'expanded',
		COMPACT = 'compact'
	}
}