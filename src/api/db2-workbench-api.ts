import * as vscode from 'vscode';
import { DbConnectionEvent } from '../events/db-connection-event.js';
import { DiagramTableSelectedEvent } from '../events/diagram-table-selected-event.js';
import { Event } from '../events/event.js';
import { Extension } from '../extension.js';
import { StatementParser } from '../utils/statement-parser.js';

// The public surface handed to other extensions via activate()'s return value / getExtension().exports.
// Deliberately narrow and hand-shaped - never the raw Extension/EventManager instances - so internal
// refactors don't silently break a consumer that only has a compiled .d.ts or a hand-copied type file
// to go on (as a companion extension carrying its own copy of these types does).
export interface Db2WorkbenchApi {
	readonly onStatementExecuted: vscode.Event<Db2WorkbenchApi.StatementExecutedEvent>;
	readonly onDiagramTableSelected: vscode.Event<Db2WorkbenchApi.DiagramTableSelectedEvent>;
}

export namespace Db2WorkbenchApi {
	export interface StatementExecutedEvent {
		kind: StatementParser.StatementKind;
		sql: string;
		success: boolean;
		/** Only set when success is false. */
		error?: Error;
		/** True for statements run outside the normal SQL-editor flow (e.g. Create Index from the
		 * schema browser, or a future create/alter-table screen) - not filtered out, so a consumer
		 * that only cares about editor-run statements can filter on this itself. */
		isInternal: boolean;
		connectionName: string;
		documentUri: string;
	}

	export interface DiagramTableSelectedEvent {
		documentUri: string;
		schema: string;
		table: string;
	}
}

export class ExtensionApi implements Db2WorkbenchApi {
	private _statementExecutedEmitter?: vscode.EventEmitter<Db2WorkbenchApi.StatementExecutedEvent>;
	private _diagramTableSelectedEmitter?: vscode.EventEmitter<Db2WorkbenchApi.DiagramTableSelectedEvent>;

	constructor(extension: Extension) {
		extension.context.subscriptions.push(this.statementExecutedEmitter);
		extension.context.subscriptions.push(this.diagramTableSelectedEmitter);
		extension.context.subscriptions.push(extension.eventManager.onEvent(event => this.onEvent(event)));
	}

	private get statementExecutedEmitter(): vscode.EventEmitter<Db2WorkbenchApi.StatementExecutedEvent> {
		return this._statementExecutedEmitter ??= new vscode.EventEmitter();
	}

	private get diagramTableSelectedEmitter(): vscode.EventEmitter<Db2WorkbenchApi.DiagramTableSelectedEvent> {
		return this._diagramTableSelectedEmitter ??= new vscode.EventEmitter();
	}

	get onStatementExecuted(): vscode.Event<Db2WorkbenchApi.StatementExecutedEvent> {
		return this.statementExecutedEmitter.event;
	}

	get onDiagramTableSelected(): vscode.Event<Db2WorkbenchApi.DiagramTableSelectedEvent> {
		return this.diagramTableSelectedEmitter.event;
	}

	private onEvent(event: Event): void {
		if(event.type === Event.Type.DB_CONNECTION) {
			this.onDbConnectionEvent(<DbConnectionEvent>event);
		} else if(event.type === Event.Type.DIAGRAM_TABLE_SELECTED) {
			this.onDiagramTableSelectedEvent(<DiagramTableSelectedEvent>event);
		}
	}

	private onDbConnectionEvent(dbEvent: DbConnectionEvent): void {
		if(dbEvent.eventType !== DbConnectionEvent.EventType.RESULT && dbEvent.eventType !== DbConnectionEvent.EventType.ERROR) {
			return;
		}

		this.statementExecutedEmitter.fire({
			kind: dbEvent.parseResults?.statementKind ?? StatementParser.StatementKind.OTHER,
			sql: dbEvent.parseResults?.originalSql ?? '',
			success: dbEvent.eventType === DbConnectionEvent.EventType.RESULT,
			error: dbEvent.error,
			isInternal: dbEvent.isInternal ?? false,
			connectionName: dbEvent.configuration.name,
			documentUri: dbEvent.key
		});
	}

	private onDiagramTableSelectedEvent(diagramEvent: DiagramTableSelectedEvent): void {
		this.diagramTableSelectedEmitter.fire({
			documentUri: diagramEvent.documentUri,
			schema: diagramEvent.schema,
			table: diagramEvent.table
		});
	}
}
