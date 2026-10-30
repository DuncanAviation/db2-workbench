import { ConnectionConfig } from '../models/connection-config.js';
import { DbErrorUtils } from '../utils/db-error-utils.js';

export interface ConnectionEditorInitialState {
	config: ConnectionConfig;
	defaultConnectionString: string;
	/** Every saved SQL schema import (db2-workbench.sqlImports), so this connection can be linked to the
	 * ones that should run against it. Empty when none are saved, and the editor then shows no list at
	 * all rather than an empty one - see SqlSchemaImports. */
	sqlImports: ConnectionEditorSqlImport[];
}

export interface ConnectionEditorSqlImport {
	id: string;
	name: string;
}

export interface SaveConnectionMessage {
	command: 'saveConnection';
	connection: ConnectionConfig;
}

export interface CancelEditMessage {
	command: 'cancelEdit';
}

// Carries the same in-progress field values as SaveConnectionMessage (the connection may not have
// been saved yet), so the host can check driver availability - and, if that passes, attempt a real
// connect - without requiring a save first.
export interface TestConnectionMessage {
	command: 'testConnection';
	connection: ConnectionConfig;
}

// Takes the form's host and user name as typed rather than a saved connection: passwords are stored by
// host and user name, so a new connection can have one set before it is saved or tested.
export interface SetPasswordMessage {
	command: 'setPassword';
	host: string;
	userName: string;
}

export type ConnectionEditorOutboundMessage = SaveConnectionMessage | CancelEditMessage | TestConnectionMessage | SetPasswordMessage;

export interface TestConnectionResultMessage {
	command: 'testConnectionResult';
	success: boolean;
	message: string;
	driverErrors?: DbErrorUtils.DbErrorDetail[];
}

// Sent only once a new password is stored. Cancelling the prompt sends nothing, since nothing changed.
export interface PasswordSetMessage {
	command: 'passwordSet';
	message: string;
}

export type ConnectionEditorInboundMessage = TestConnectionResultMessage | PasswordSetMessage;
