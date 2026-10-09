import { DbResult } from '../database/drivers/db-driver.js';
import { ConnectionInfo } from '../interfaces/connection-info.js';
import { HistoryParameter } from '../interfaces/history-parameter.js';
import { ProcedureOutParameter } from '../interfaces/procedure-out-parameter.js';
import { ConnectionConfig } from '../models/connection-config.js';
import { StatementParser } from '../utils/statement-parser.js';
import { Event } from './event.js';

export interface DbConnectionEvent extends Event {
	type: Event.Type.DB_CONNECTION;
	eventType: DbConnectionEvent.EventType;
	key: string;
	configuration: ConnectionConfig;
	connectionInfo?: ConnectionInfo;
	/** The parsed (or, for internal DDL that skips full parsing, classified-only) statement -
	 * carries originalSql and statementKind (SELECT/INSERT/CREATE/CALL/etc.) alongside statementType
	 * and isValid. */
	parseResults?: StatementParser.ParseResults;
	result?: DbResult;
	duration?: number;
	isCursorOpen?: boolean;
	error?: Error;
	historyParameters?: HistoryParameter[];
	/** Set on a RESULT event for a CALL statement - the procedure's OUT/INOUT parameters (by catalog
	 * metadata) paired with the values DbResult.parameters reported back after the call. Absent
	 * for a plain query, and for a CALL whose procedure/params couldn't be resolved from the catalog. */
	procedureOutParameters?: ProcedureOutParameter[];
	/** Set on a RESULT event when DbResult.columns reports two or more columns with the same
	 * name - see DuplicateColumnChecker. The row data itself has already silently collapsed to the
	 * last matching column's values by this point, so this is the only place left to detect it. */
	duplicateColumns?: string[];
	/** Set on an ERROR event fired from an internalQuery() failure, so the history entry it produces
	 * can be categorized as an internal statement rather than a user-run one. */
	isInternal?: boolean;
}

export namespace DbConnectionEvent {
	export enum EventType {
		CLOSED = 'closed',
		CONNECTED = 'connected',
		CONNECTING = 'connecting',
		EXECUTING = 'executing',
		ERROR = 'error',
		FETCHING = 'fetching',
		FETCHED = 'fetched',
		RESULT = 'result',
		READY = 'ready'
	}
}