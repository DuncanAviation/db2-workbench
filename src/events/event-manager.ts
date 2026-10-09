import * as vscode from 'vscode';
import { Nullable } from '../utils/nullable.js';
import { ConnectionConfigEvent } from './connection-config-event.js';
import { DbConnectionEvent } from './db-connection-event.js';
import { DiagramTableSelectedEvent } from './diagram-table-selected-event.js';
import { Event } from './event.js';
import { SchemaTreeChangedEvent } from './schema-tree-changed-event.js';

export class EventManager implements vscode.Disposable {
	private _emitter: Nullable<vscode.EventEmitter<Event>>;

	private get emitter(): vscode.EventEmitter<Event> {
		return this._emitter ??= new vscode.EventEmitter();
	}

	onEvent(consumer: (value: Event) => void): vscode.Disposable {
		return this.emitter.event(event => consumer(event));
	}

	fire<E extends ConnectionConfigEvent>(event: E): void;
	fire<E extends DbConnectionEvent>(event: E): void;
	fire<E extends DiagramTableSelectedEvent>(event: E): void;
	fire<E extends SchemaTreeChangedEvent>(event: E): void;
	fire<E extends Event>(event: E) {
		// this.emitter.event = event => console.log(event);
		this.emitter.fire(event);
	}

	dispose() {
		this.emitter.dispose();
	}
}