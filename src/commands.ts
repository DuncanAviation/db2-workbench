import { exhaustMap, Subject } from 'rxjs';
import * as vscode from 'vscode';
import { Extension } from './extension.js';
import { HistoryParameter } from './interfaces/history-parameter.js';
import { Parameter } from './interfaces/parameter.js';
import { ConnectionConfig } from './models/connection-config.js';
import { SystemRoutine } from './models/system-routine.js';
import { CteAssist } from './content-assist/cte-assist.js';
import { AlertUtils } from './utils/alert-utils.js';
import { DangerousStatementChecker } from './utils/dangerous-statement-checker.js';
import { EditorUtils } from './utils/editor-utils.js';
import { Nullable } from './utils/nullable.js';
import { ParameterParser } from './utils/parameter-parser.js';
import { SpParser } from './utils/sp-parser.js';
import { SqlParser } from './utils/sql-parser.js';
import { StatementParser } from './utils/statement-parser.js';
import { SchemasUtils } from './utils/schemas-utils.js';
import { StringUtils } from './utils/string-utils.js';
import { TryUtils } from './utils/try-utils.js';
import { DiagramEditorProvider } from './views/diagram-editor-provider.js';

export class Commands implements vscode.Disposable {
	private _executeSubject?: Subject<() => Promise<void>>;

	// The comment-stripped statement text(s) most recently attempted (run or blocked on missing
	// parameters) per uri - lets a later "Execute" trigger from the Parameters tab re-run the same
	// statement(s) without needing a live text editor/cursor position. Kept here rather than on
	// WorkbenchViewProvider's SqlSession, since a session doesn't exist yet the first time a
	// statement is attempted (it's only created as a side effect of a connection event, which a
	// blocked-on-missing-parameters attempt may never trigger).
	private lastAttemptedSqlsByUri = new Map<string, string[]>();

	constructor(private extension: Extension) {
		extension.context.subscriptions.push(vscode.commands.registerCommand(`${Extension.ID}.executeSql`, () => this.executeSubject.next(async () => await this.onExecute())));
		extension.context.subscriptions.push(vscode.commands.registerCommand(`${Extension.ID}.executeAllSql`, () => this.executeSubject.next(async () => await this.onExecuteAll())));
		extension.context.subscriptions.push(vscode.commands.registerCommand(`${Extension.ID}.executeSelectedSql`, () => this.executeSubject.next(async () => await this.onExecuteSelected())));
		extension.context.subscriptions.push(vscode.commands.registerCommand(`${Extension.ID}.formatSql`, () => this.onFormatSql()));
		extension.context.subscriptions.push(vscode.commands.registerCommand(`${Extension.ID}.openResultsInEditor`, () => this.onOpenResultsInEditor()));
		extension.context.subscriptions.push(vscode.commands.registerCommand(`${Extension.ID}.openResultsInNewWindow`, () => this.onOpenResultsInNewWindow()));
		extension.context.subscriptions.push(vscode.commands.registerCommand(`${Extension.ID}.addConnection`, () => this.onAddConnection()));
		extension.context.subscriptions.push(vscode.commands.registerCommand(`${Extension.ID}.openSchemas`, (event: ContextMenuEvent) => this.onOpenSchemas(event)));
		extension.context.subscriptions.push(vscode.commands.registerCommand(`${Extension.ID}.newDiagram`, () => this.onNewDiagram()));
		extension.context.subscriptions.push(vscode.commands.registerCommand(`${Extension.ID}.newDiagramForConnection`, (event: ContextMenuEvent) => this.onNewDiagramForConnection(event)));
		extension.context.subscriptions.push(vscode.commands.registerCommand(`${Extension.ID}.viewTableDetails`, () => this.onViewTableDetails()));
		extension.context.subscriptions.push(vscode.commands.registerCommand(`${Extension.ID}.editConnection`, (event: ContextMenuEvent) => this.onEditConnection(event)));
		extension.context.subscriptions.push(vscode.commands.registerCommand(`${Extension.ID}.deleteConnection`, (event: ContextMenuEvent) => this.onDeleteConnection(event)));
		extension.context.subscriptions.push(vscode.commands.registerCommand(`${Extension.ID}.editSqlImport`, () => this.onEditSqlImport()));
		extension.context.subscriptions.push(vscode.commands.registerCommand(`${Extension.ID}.refreshSqlImport`, () => this.onRefreshSqlImport()));
		extension.context.subscriptions.push(vscode.commands.registerCommand(`${Extension.ID}.editFormatting`, () => this.onEditFormatting()));
		extension.context.subscriptions.push(vscode.commands.registerCommand(`${Extension.ID}.restoreFormattingDefaults`, () => this.onRestoreFormattingDefaults()));

		extension.subscriptionManager.add(Commands.name, this.executeSubject
			.pipe(
				exhaustMap(async promise => await promise())
			)
			.subscribe()
		);

		extension.context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(event => {
			event.closed.forEach(tab => {
				if(tab.input instanceof vscode.TabInputText) {
					this.lastAttemptedSqlsByUri.delete(tab.input.uri.toString());
				}
			});
		}));
	}

	private get executeSubject(): Subject<() => Promise<void>> {
		return this._executeSubject ??= new Subject();
	}
	
	// Shared by onExecute/onExecuteSelected/onExecuteAll - they differ only in how they resolve
	// which statement(s) to run from the active editor; the "no .sql editor"/"nothing resolved"
	// guards and the try/error-reporting wrapper around runStatements are otherwise identical.
	private async executeResolvedSql(context: string, resolveSqls: (editor: vscode.TextEditor) => string[]): Promise<void> {
		let editor = vscode.window.activeTextEditor;

		if(!editor || editor.document.languageId !== 'sql') {
			AlertUtils.onError('Please open a .sql file to execute SQL.');
			return;
		}

		let sqls = resolveSqls(editor);

		if(sqls.length === 0) {
			AlertUtils.onWarning('Could not find any SQL to execute.');
			return;
		}

		return TryUtils.tryAsync({
			context: `commands ${context}()`,
			try: () => this.runStatements(editor.document, sqls),
			onError: error => AlertUtils.onError(error)
		});
	}

	// Highlighting more than one statement runs only the first of them.
	private async onExecute(): Promise<void> {
		return this.executeResolvedSql('onExecute', editor => EditorUtils.getSelectedSql(editor.document, editor.selection).slice(0, 1));
	}

	// Unlike onExecute (which runs only the first statement a highlighted selection touches), this
	// runs every statement the selection touches. An empty selection still runs the single statement
	// at the cursor, same as onExecute in that case.
	private async onExecuteSelected(): Promise<void> {
		return this.executeResolvedSql('onExecuteSelected', editor => EditorUtils.getSelectedSql(editor.document, editor.selection));
	}

	private async onExecuteAll(): Promise<void> {
		return this.executeResolvedSql('onExecuteAll', editor => EditorUtils.getAllSql(editor.document));
	}

	// Resolves which statement(s) an "Execute" click from the Parameters tab should run, since
	// there's no live cursor position to fall back on there (unlike the editor keybinding/menu
	// commands). In priority order: (1) whatever was last attempted for this session - covers the
	// overwhelmingly common case of "I got blocked on missing parameters, filled them in, now retry";
	// (2) if the file only has one statement at all, run it; (3) if only one of several statements
	// currently has parameters, run that one; (4) otherwise it's genuinely ambiguous - say so instead
	// of guessing.
	executeFromParametersTab(uri: string): void {
		this.executeSubject.next(async () => await this.resolveAndRunFromParametersTab(uri));
	}

	private async resolveAndRunFromParametersTab(uri: string): Promise<void> {
		let document = vscode.workspace.textDocuments.find(findDocument => findDocument.uri.toString() === uri);

		if(document == null) {
			AlertUtils.onWarning('Could not find the SQL file to execute.');
			return;
		}

		let lastAttemptedSqls = this.lastAttemptedSqlsByUri.get(uri);

		if(lastAttemptedSqls?.length) {
			return this.runStatements(<vscode.TextDocument>document, lastAttemptedSqls);
		}

		let allSqls = EditorUtils.getAllSql(<vscode.TextDocument>document);

		if(allSqls.length === 0) {
			AlertUtils.onWarning('Could not find any SQL to execute.');
			return;
		}

		if(allSqls.length === 1) {
			return this.runStatements(<vscode.TextDocument>document, allSqls);
		}

		let withParameters = allSqls.filter(sql => ParameterParser.findOccurrences(StatementParser.stripComments(sql)).length > 0);

		if(withParameters.length === 1) {
			return this.runStatements(<vscode.TextDocument>document, withParameters);
		}

		AlertUtils.onWarning(withParameters.length === 0
			? `Could not determine which SQL statement to execute - none of the statements in this file currently have parameters.`
			: `Could not determine which SQL statement to execute - multiple statements have parameters. Place your cursor in the statement you want and use Execute SQL instead.`);
	}

	// Validates every statement's parameters up front (fail-fast) - if any statement is missing a
	// required parameter value, nothing runs, the Parameters tab is focused, and one warning is
	// shown, rather than partially executing statements ahead of the blocked one.
	private async runStatements(document: vscode.TextDocument, sqls: string[]): Promise<void> {
		let uri = document.uri.toString();

		// Before resolving parameters, which already reads the connection - a file whose session was
		// closed (its tab closed and reopened, or its sidebar session closed) connects again here.
		this.extension.connections.allowConnect(uri);

		if(this.extension.configurations.autoFocusResults) {
			this.extension.resultsViewProvider.reveal();
		}

		this.lastAttemptedSqlsByUri.set(uri, sqls);
		let plans: {sql: string; parameters: Array<Parameter>; historyParameters: HistoryParameter[]}[] = [];

		for(let rawSql of sqls) {
			let sql = StatementParser.stripComments(rawSql);
			let resolved = await ParameterParser.resolveTypesForStatement(this.extension, uri, sql);
			let session = this.extension.resultsViewProvider.getSession(uri);

			if(resolved.length === 0) {
				// A CALL with no ":name" bind markers still needs its full positional literal list built -
				// buildCallParameters parses that straight from the SQL text regardless of `resolved`, so it
				// must run even here; only a non-SP statement with no markers truly has zero parameters.
				let parameters = SpParser.isSp(sql) ? ParameterParser.buildCallParameters(sql, resolved, session?.parameterValues) : [];
				plans.push({sql, parameters, historyParameters: []});
				continue;
			}
			let values: Array<Parameter> = [];
			let regions: ParameterParser.SubstitutionRegion[] = [];
			let missing: string[] = [];
			let firstMissingKey: string | undefined;

			for(let param of resolved) {
				let raw = session?.parameterValues?.[param.key];

				if(param.allowMultiple) {
					let list = (Array.isArray(raw) ? raw : raw != null ? [<string>raw] : []).filter(entry => StringUtils.isNotBlank(entry));

					if(list.length === 0) {
						missing.push(param.label);
						firstMissingKey ??= param.key;
						continue;
					}

					values.push(...list);
					regions.push({start: <number>param.substitutionStart, end: <number>param.substitutionEnd, count: list.length});
				} else {
					let value = Array.isArray(raw) ? raw[0] : raw;

					if(StringUtils.isBlank(value)) {
						missing.push(param.label);
						firstMissingKey ??= param.key;
						continue;
					}

					values.push(<string>value);
					regions.push({start: <number>param.substitutionStart, end: <number>param.substitutionEnd});
				}
			}

			if(missing.length > 0) {
				// Refreshes session.parameters (what the Parameters tab renders fields from) before
				// focusing it - CONNECTED already triggers this once per newly-opened connection, but
				// a retry against a connection that was already open wouldn't otherwise get one, and
				// would show whatever the tab last had (possibly nothing yet).
				await this.extension.resultsViewProvider.refreshParameters(uri);
				this.extension.resultsViewProvider.focusParametersTab(uri, firstMissingKey);
				AlertUtils.onWarning(`Please provide a value for parameter${missing.length > 1 ? 's' : ''}: ${Array.from(new Set(missing)).join(', ')}`);
				return;
			}

			// Recorded alongside the plan so the History tab can later show the same statement with
			// its "?"/":name" markers replaced by these actual values - one entry per resolved
			// occurrence (in source order), not flattened, so both the positional "?" case and the
			// name-keyed CALL case can be reconstructed from it.
			let historyParameters: HistoryParameter[] = resolved.map(param => ({
				name: param.name,
				dataType: param.dataType,
				value: session?.parameterValues?.[param.key] ?? (param.allowMultiple ? [] : '')
			}));

			if(SpParser.isSp(sql)) {
				// CALL statements aren't text-substituted - callProcedure never consumes SQL text/"?"
				// markers, only the name/schema/catalog plus a parameters array. That array has to be
				// the FULL positional argument list (every literal SpParser already parses correctly,
				// plus each ":name" marker's resolved value spliced in) - `values` above only holds
				// the markers themselves, which is exactly the array shape callProcedure needs for the
				// SQL "?"-substitution path but not for a CALL's positional binding.
				plans.push({sql, parameters: ParameterParser.buildCallParameters(sql, resolved, session?.parameterValues), historyParameters});
			} else {
				plans.push({sql: ParameterParser.substituteMarkers(sql, regions), parameters: values, historyParameters});
			}
		}

		if(!(await this.confirmDangerousStatements(plans))) {
			return;
		}

		for(let plan of plans) {
			await this.extension.connections.execute({key: uri, sql: plan.sql, parameters: plan.parameters, historyParameters: plan.historyParameters});
		}
	}

	// Checked as its own up-front pass (not folded into the plan-building loop above) so that
	// cancelling any single confirmation aborts the entire batch -- including statements before it
	// that were already confirmed or weren't dangerous at all -- rather than letting some of the
	// batch run before the user gets a chance to back out.
	private async confirmDangerousStatements(plans: {sql: string}[]): Promise<boolean> {
		for(let plan of plans) {
			let danger = DangerousStatementChecker.check(plan.sql);

			if(danger == null) {
				continue;
			}

			let sqlPreview = plan.sql.length > 500 ? `${plan.sql.slice(0, 500)}…` : plan.sql;
			let confirm = await vscode.window.showWarningMessage(
				'You are about to run a dangerous statement.',
				{modal: true, detail: `${danger.reason}\n\n${sqlPreview}`},
				'Run Anyway'
			);

			if(confirm !== 'Run Anyway') {
				return false;
			}
		}

		return true;
	}

	// Delegates to VS Code's own format command rather than hand-rolling a WorkspaceEdit, so this
	// keybinding and the native "Format Document"/"Format Selection" menu entries are always the
	// same code path (SqlFormattingProvider) -- no risk of the two drifting out of sync -- and VS
	// Code's own undo-grouping/provider-arbitration is reused for free.
	private async onFormatSql(): Promise<void> {
		let editor = vscode.window.activeTextEditor;

		if(!editor || editor.document.languageId !== 'sql') {
			AlertUtils.onError('Please open a .sql file to format SQL.');
			return;
		}

		await vscode.commands.executeCommand(editor.selection.isEmpty ? 'editor.action.formatDocument' : 'editor.action.formatSelection');
	}

	private async onOpenResultsInEditor(): Promise<void> {
		return this.extension.resultsViewProvider.openInEditor();
	}

	private async onOpenResultsInNewWindow(): Promise<void> {
		return this.extension.resultsViewProvider.openInNewWindow();
	}

	private async onAddConnection(): Promise<void> {
		return this.extension.connectionEditorProvider.show();
	}

	private getConnectionConfig(id: string): Nullable<ConnectionConfig> {
		return this.extension.configurations.connections.find(findConfig => findConfig.id === id);
	}

	private async onOpenSchemas(event: ContextMenuEvent): Promise<void> {
		let config = this.getConnectionConfig(event.id);

		if(config == null) {
			return;
		}

		return this.extension.schemasProvider.show(config);
	}

	// A blank diagram, opened disconnected - the user picks a connection from the diagram's own menu
	// afterwards. onNewDiagramForConnection below is the same thing with that step already answered.
	private async onNewDiagram(): Promise<void> {
		await this.createBlankDiagram();
	}

	// "New Diagram" from a connection's own context menu in the connections tree: the same blank
	// diagram, but pointed at the connection that was right-clicked instead of asking again. The
	// configId is handed to the editor provider rather than connected here, because the connection has
	// to be established under the *document's* session key (see DiagramUtils.buildKey) - which doesn't
	// exist until the file does.
	private async onNewDiagramForConnection(event: ContextMenuEvent): Promise<void> {
		let config = this.getConnectionConfig(event.id);

		if(config == null) {
			return;
		}

		await this.createBlankDiagram(config.id);
	}

	// Opens a blank UNTITLED .db2diagram immediately - no save dialog up front. Nothing is written
	// anywhere until the user does an ordinary Ctrl+S/Save As, which VS Code turns into a save dialog of
	// its own and delivers to DiagramEditorProvider.saveCustomDocumentAs. DiagramDocument.create
	// recognizes the untitled scheme and starts from an empty model rather than reading a file that
	// doesn't exist.
	private async createBlankDiagram(configId?: string): Promise<void> {
		let targetUri = Commands.buildUntitledDiagramUri();

		try {
			// Registered BEFORE the editor opens: the provider picks it up when the webview reports ready,
			// so the connect can't race the panel being created.
			if(StringUtils.isNotBlank(configId)) {
				this.extension.diagramEditorProvider.connectOnOpen(targetUri.toString(), configId);
			}

			await vscode.commands.executeCommand('vscode.openWith', targetUri, DiagramEditorProvider.VIEW_TYPE);
		} catch(error) {
			AlertUtils.onError(error);
		}
	}

	// The first Untitled-N.db2diagram that isn't already open. Reusing a name would be more than
	// cosmetic: a custom editor is identified by its uri, so opening one that's already open just reveals
	// the existing diagram instead of creating a second one.
	//
	// Built by joining a workspace folder and then overriding the scheme (the shape VS Code's own custom
	// editor sample uses) so the eventual Save As dialog starts somewhere sensible; with no folder open
	// it's a bare untitled uri and the dialog picks its own default.
	private static buildUntitledDiagramUri(): vscode.Uri {
		let folder = vscode.workspace.workspaceFolders?.[0];

		let taken = new Set(vscode.window.tabGroups.all
			.flatMap(group => group.tabs)
			.filter(tab => tab.input instanceof vscode.TabInputCustom)
			.map(tab => (<vscode.TabInputCustom>tab.input).uri.toString()));

		for(let index = 1; ; index++) {
			let name = `Untitled-${index}.db2diagram`;
			let uri = folder ? vscode.Uri.joinPath(folder.uri, name).with({scheme: 'untitled'}) : vscode.Uri.parse(`untitled:${name}`);

			if(!taken.has(uri.toString())) {
				return uri;
			}
		}
	}

	// Go to Definition for a SQL editor, bound to F12 alongside its usual right-click menu entry.
	// Resolution order for the word under the cursor: (1) a CTE name - jump to its WITH-clause
	// declaration in this same file, taking priority over a same-named real table since that's the
	// one the query actually resolves to; (2) a table alias - jump to its FROM/JOIN declaration;
	// (3) a routine call - open the function, or the procedure a CALL names, in the schema browser, provided
	// the catalog has one by that name (see showRoutineDetails); (4) a table name - open the schema browser (see showTableDetails
	// below for how its schema is picked); (5) anything else (a column, a keyword, plain whitespace, an unrecognized word) - do
	// nothing at all, the same as native F12 on something with no definition to go to.
	private async onViewTableDetails(): Promise<void> {
		let editor = vscode.window.activeTextEditor;

		if(!editor || editor.document.languageId !== 'sql') {
			AlertUtils.onError('Please open a .sql file to view table details.');
			return;
		}

		let position = editor.selection.active;
		let context = EditorUtils.getWordContextAtPosition(editor.document, position);

		if(context == null) {
			return;
		}

		let cteOffset = CteAssist.findCteDeclarationOffset(context.sql, context.word);

		if(cteOffset != null) {
			this.revealStatementOffset(editor, position, cteOffset);
			return;
		}

		let uri = editor.document.uri.toString();

		if(context.routineCall != null && await this.showRoutineDetails(uri, context.routineCall)) {
			return;
		}

		let occurrence = context.occurrence;

		if(occurrence == null) {
			return;
		}

		if(occurrence.matchedAs === 'alias') {
			let aliasOffset = SqlParser.findAliasDeclarationOffset(context.sql, occurrence.reference);

			if(aliasOffset != null) {
				this.revealStatementOffset(editor, position, aliasOffset);
			}

			return;
		}

		return this.showTableDetails(uri, occurrence.reference);
	}

	// Opens the routine a call names. The schema is the one written in the SQL, else:
	// - a procedure: the first schema on the library list that has one by the name - the same procedure an
	//   unqualified CALL runs (MemoryCache.resolveProcedureSchema);
	// - a function: the one schema on the library list that has one by the name, else the connection's
	//   default, the same priority as showTableDetails.
	// One overload opens its tab; several (or a function name in several schemas, with none written) open the
	// tree filtered to the name so the user can pick. False when no routine by that name exists at all -
	// "name(" is a regex match, not proof of a call, so the caller carries on to the table path.
	private async showRoutineDetails(uri: string, call: SqlParser.RoutineCall): Promise<boolean> {
		let config = await this.extension.connections.connect({key: uri});

		if(config == null) {
			return true;
		}

		let isProcedure = call.routineType === 'PROCEDURE';
		let options = StringUtils.isNotBlank(call.schema) ? {key: uri, schema: call.schema} : {key: uri};
		let routines = isProcedure
			? await this.extension.memoryCache.getProcedures(options)
			: await this.extension.memoryCache.getFunctions(options);

		let matches = routines.filter(routine => StringUtils.equalsIgnoreCase(routine.name, call.name));

		if(matches.length === 0) {
			return false;
		}

		let targetSchema = StringUtils.isNotBlank(call.schema)
			? call.schema
			: isProcedure
				? await this.extension.memoryCache.resolveProcedureSchema({key: uri, procedure: call.name})
				: Commands.soleSchema(matches) ?? config.defaultTableSchema;

		let inSchema = matches.filter(routine => StringUtils.equalsIgnoreCase(routine.schema, targetSchema));

		await this.extension.schemasProvider.show(config, inSchema.length === 1
			? {kind: isProcedure ? 'procedure' : 'function', schema: inSchema[0].schema, table: inSchema[0].specificName}
			: {kind: 'filter', filterText: call.name});

		return true;
	}

	private static soleSchema(routines: SystemRoutine[]): Nullable<string> {
		let schemas = Array.from(new Set(routines.map(routine => routine.schema.toUpperCase())));
		return schemas.length === 1 ? schemas[0] : undefined;
	}

	// Moves the cursor (and scrolls if needed) to "statementLocalOffset" within the SQL statement
	// containing "cursorPosition" - the shared last step for both the CTE and alias Go to Definition
	// cases above, which only differ in how that local offset was found.
	private revealStatementOffset(editor: vscode.TextEditor, cursorPosition: vscode.Position, statementLocalOffset: number): void {
		let statementStartOffset = EditorUtils.getStatementStartOffset(editor.document, cursorPosition);
		let targetPosition = editor.document.positionAt(statementStartOffset + statementLocalOffset);
		editor.selection = new vscode.Selection(targetPosition, targetPosition);
		editor.revealRange(new vscode.Range(targetPosition, targetPosition), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}

	// Resolves "tableReference" to a real table or view and opens the schema browser to it. Schema
	// resolution priority: (1) a schema explicit in the SQL itself ("FROM myschema.mytable") always
	// wins - it's the one the query will actually run against; (2) failing that, if the table name is
	// unambiguous across every schema on the connection, use that schema; (3) otherwise (the name
	// doesn't exist anywhere, or exists in more than one schema) fall back to the connection's
	// configured default table schema. If the resolved schema still doesn't have a table by that
	// name, don't guess further - just open the browser with the tree filtered to the name so the
	// user can find it themselves.
	private async showTableDetails(uri: string, tableReference: SqlParser.TableReference): Promise<void> {
		let config = await this.extension.connections.connect({key: uri});

		if(config == null) {
			return;
		}

		// A schema-qualified reference fetches just that one schema directly instead of every schema on
		// the library list - trusts the SQL text over library-list membership, and works for any schema.
		// Whether the resolved table ends up visible in the tree (added/unhidden if needed) is
		// SchemasProvider.show's job, not this method's - this only needs to know whether it exists.
		// Views count as well as tables - the tree lists both, and a view opens its own view tab.
		let relations = StringUtils.isNotBlank(tableReference.schema)
			? await this.extension.memoryCache.getRelations({key: uri, schema: tableReference.schema})
			: await this.extension.memoryCache.getRelations({key: uri});

		let matches = relations.filter(relation => StringUtils.equalsIgnoreCase(relation.name, tableReference.table));
		let matchingSchemas = Array.from(new Set(matches.map(relation => relation.schema)));
		let targetSchema = StringUtils.isNotBlank(tableReference.schema)
			? <string>tableReference.schema
			: matchingSchemas.length === 1 ? matchingSchemas[0] : config.defaultTableSchema;

		let resolved = matches.find(relation => StringUtils.equalsIgnoreCase(relation.schema, targetSchema));

		return this.extension.schemasProvider.show(config, resolved != null
			? {kind: resolved.kind, schema: resolved.schema, table: resolved.name}
			: {kind: 'filter', filterText: tableReference.table});
	}

	// "DB2: Edit SQL Import" - the dialog lives in the schema browser's webview, so the command picks the
	// import, then opens (or reveals) the browser for a connection that links it and tells it to open the
	// editor. Opening the panel rather than refusing when none is open: the command is the entry point for
	// someone who wants to fix a saved import, and making them find the browser first helps nobody.
	private async onEditSqlImport(): Promise<void> {
		let picked = await this.pickSqlImport('Select an import to edit');

		if(!picked) {
			return;
		}

		await this.extension.schemasProvider.show(picked.config, undefined, picked.importId);
	}

	// "DB2: Refresh SQL Import" - runs every section of one saved import again. No panel needed: this is
	// host-side work, and every open panel repaints off SCHEMA_TREE_CHANGED like any other import change.
	private async onRefreshSqlImport(): Promise<void> {
		let picked = await this.pickSqlImport('Select an import to refresh');

		if(!picked) {
			return;
		}

		let key = SchemasUtils.buildKey(picked.config.id);
		this.extension.connections.allowConnect(key);

		await this.extension.sqlSchemaImports.refreshImport(
			{key: key, configId: picked.config.id},
			picked.importId
		);
	}

	// One QuickPick over every saved import that some connection actually links, skipped when there is only
	// one of them. The connection comes with it: an import runs against a connection, and picking the import
	// has already picked one - the first that links it, since they all produce the same rows for a host.
	private async pickSqlImport(placeHolder: string): Promise<Nullable<{config: ConnectionConfig; importId: string}>> {
		let connections = this.extension.configurations.connections;

		let items = this.extension.sqlSchemaImports.getSavedImports().flatMap(saved => {
			let config = connections.find(connection => (connection.sqlImportIds ?? []).includes(saved.id));
			return config ? [{label: saved.name, description: config.name, config: config, importId: saved.id}] : [];
		});

		if(items.length === 0) {
			AlertUtils.onWarning('There are no saved SQL imports linked to a connection. Import one with "Save this import" checked first.');
			return;
		}

		if(items.length === 1) {
			return items[0];
		}

		return vscode.window.showQuickPick(items, {placeHolder: placeHolder});
	}

	private async onEditConnection(event: ContextMenuEvent): Promise<void> {
		let config = this.getConnectionConfig(event.id);
		
		if(config == null) {
			return;
		}

		return this.extension.connectionEditorProvider.show(config);
	}

	private async onDeleteConnection(event: ContextMenuEvent): Promise<void> {
		let config = this.getConnectionConfig(event.id);

		if (config == null) {
			AlertUtils.onError('Invalid connection selected to delete.');
			return;
		}

		let confirm = await vscode.window.showInformationMessage(
			`Are you sure you want to delete the connection '${config.name}'? This will also remove any related SQL results.`,
			{ modal: true },
			'Delete'
		);

		if (confirm !== 'Delete') {
			return;
		}

		let connections = this.extension.configurations.connections.filter(findConfig => findConfig.id !== config.id);
		this.extension.configurations.connections = connections;
		this.extension.connectionsViewProvider.refresh();
		AlertUtils.onInfo(`Connection '${config.name}' deleted.`);
	}

	private async onEditFormatting(): Promise<void> {
		return this.extension.formattingEditorProvider.show();
	}

	private async onRestoreFormattingDefaults(): Promise<void> {
		let confirm = await vscode.window.showInformationMessage(
			`Are you sure you want to restore all SQL formatting options to their defaults?`,
			{ modal: true },
			'Restore Defaults'
		);

		if (confirm !== 'Restore Defaults') {
			return;
		}

		await this.extension.configurations.restoreFormattingDefaults();
		AlertUtils.onInfo('Formatting options restored to defaults.');
	}

	dispose() {
		this.extension.subscriptionManager.unsubscribe(Commands.name);
	}
}

interface ContextMenuEvent {
	collaspibleState: number;
	contextValue: string;
	description: string;
	id: string;
	label: string;
}