import * as vscode from 'vscode';
import { Disposable } from 'vscode';
import { DbConnectionEvent } from './events/db-connection-event.js';
import { Event } from './events/event.js';
import { Extension } from './extension.js';
import { AlertUtils } from './utils/alert-utils.js';

import { Nullable } from './utils/nullable.js';

export class InfoManager implements Disposable {
	private eventListener: Nullable<vscode.Disposable>;

	constructor(extension: Extension) {
		this.eventListener = extension.eventManager.onEvent(event => this.onEvent(event));
	}

	private onEvent(event: Event) {
		if(event.type === Event.Type.DB_CONNECTION) {
			this.onDbConnectionEvent(<DbConnectionEvent>event);
		}
	}

	private onDbConnectionEvent(event: DbConnectionEvent) {
		if(event.eventType === DbConnectionEvent.EventType.CLOSED) {
			AlertUtils.onInfo(`Connection to ${event.configuration.name} is closed.`);
		}

	}

	dispose() {
		if(this.eventListener) {
			this.eventListener.dispose();
		}
	}
}