import { HistoryParameter } from '../interfaces/history-parameter.js';
import { Row } from '../interfaces/row.js';
import { ColumnDetails } from '../utils/column-details.js';
import { DbErrorUtils } from '../utils/db-error-utils.js';
import { ExportDestination, ExportFormat, ExportWhat } from '../utils/export-utils.js';

export type ResultsAppState = 'noConnections' | 'noResults' | 'results';
export type ResultsSqlSessionState = 'connecting' | 'executing' | 'ready';
export type ResultsSqlHistoryType = 'connection' | 'error' | 'result';

export interface ResultsSessionSummary {
	uri: string;
	name: string;
}

export interface ResultsSqlHistory {
	date: string;
	type: ResultsSqlHistoryType;
	rowCount?: number;
	sql?: string;
	duration?: number;
	/** Only set for an 'error' entry - the whole caught error, normalized but not pre-formatted into a
	 * display string. See DbErrorUtils.serialize. */
	error?: DbErrorUtils.SerializedError;
	/** One entry per resolved ":name" occurrence in `sql` (in source order) - lets the History tab
	 * toggle between showing the "?"/":name" markers as-is and substituting each with its actual
	 * value, formatted as a SQL literal. */
	parameters?: HistoryParameter[];
	/** True when an 'error' entry originated from an internal (worker-connection) query rather than
	 * one the user ran - lets the History tab categorize it as an internal statement, not a user one. */
	isInternal?: boolean;
}

// A serialization-safe projection of ConnectionInfo - postMessage delivers Dates via structured
// clone, but the initial-state embed goes through JSON.stringify, so createdDate is normalized
// to an ISO string here to keep both delivery paths identical on the webview side.
export interface ResultsJobDetails {
	jobName: string;
	ip: string;
	createdDate: string;
	sortSequence: string;
}

export interface ResultsConnectionInfo {
	jobDetails: ResultsJobDetails;
	workerJobDetails: ResultsJobDetails;
	/** The session's library list in order, typed as QSYS2.LIBRARY_LIST_INFO.TYPE reports each entry. */
	schemas: { name: string; type: string }[];
}

export interface ResultsSqlParameter {
	key: string;
	label: string;
	dataType?: string;
	length?: number;
	scale?: number;
	/** True for a whole "col IN (:name)" list - the Parameters tab should render a multi-value
	 * (chip) input for this parameter instead of a plain text field. */
	allowMultiple?: boolean;
}

/** One OUT/INOUT parameter from the most recently executed CALL statement, with the value the
 * procedure returned for it - see ProcedureOutParameter (the host-side equivalent this is built
 * from) for how it's resolved. Empty whenever the last statement wasn't a CALL, or wasn't one the
 * catalog lookup could resolve. */
export interface ResultsProcedureOutParameter {
	name: string;
	mode: string;
	dataType?: string;
	length?: number;
	scale?: number;
	value: string | number | null;
}

export interface ResultsSessionDetail {
	uri: string;
	name: string;
	/** 'editor' is a SQL file the user runs statements from. The other two are metadata-only panels
	 * whose queries are all internal system-table lookups (see DbConnectionEvent.isInternal), so
	 * anything that only needs "is this a metadata panel" should test !== 'editor' rather than listing
	 * every one of them. */
	sessionKind: 'editor' | 'schemas' | 'diagram';
	host: string;
	connectionName: string;
	userName: string;
	state: ResultsSqlSessionState;
	connectionInfo?: ResultsConnectionInfo;
	resultBorderColor?: string;
	histories: ResultsSqlHistory[];
	rows: Row[];
	columns: string[];
	columnLabels: Record<string, string[]>;
	/** What each column key's header tooltip and Copy Name / Copy Long Name / Copy Description menu say -
	 * built from the same cached catalog columns as columnLabels, falling back to the driver's own column
	 * definitions for a computed column. Never the result of a query of its own. */
	columnDetails: Record<string, ColumnDetails>;
	/** Column names DbResult.columns reported more than once for the current result set - see
	 * DuplicateColumnChecker. When set, the row data has already silently collapsed to the last
	 * matching column's values, so the Data tab shows a warning banner naming them. */
	duplicateColumns?: string[];
	/** Driver-reported type name per column key (DbColumnDefinition.dataTypeName) - the Data tab
	 * right-aligns the numeric ones. */
	columnDataTypes: Record<string, string>;
	procedureOutParameters: ResultsProcedureOutParameter[];
	isCursorOpen: boolean;
	isFetchingAll: boolean;
	parameters: ResultsSqlParameter[];
	parameterValues: Record<string, string | string[]>;
	/** Set (with an incrementing nonce) whenever a blocked execute needs the Parameters tab to
	 * focus a specific field. Travels as part of the session state (rather than a dedicated
	 * message) so the webview can apply it whenever `parameters` actually includes that key,
	 * regardless of whether this or the parameters update arrives first. */
	parameterFocusRequest?: ResultsParameterFocusRequest;
}

export interface ResultsParameterFocusRequest {
	nonce: number;
	/** ResultsSqlParameter.key of the first missing required parameter, if focusing was triggered
	 * by a blocked execute. */
	parameterKey?: string;
}

export interface ResultsInitialState {
	appState: ResultsAppState;
	extensionName: string;
	sessions: ResultsSessionSummary[];
	activeUri?: string;
	activeSession?: ResultsSessionDetail;
	/** db2-workbench.autoFocusResults - whether the Data tab should be selected automatically when
	 * a query returns rows, mirroring the host's decision to reveal the panel on execute. */
	autoFocusResults: boolean;
}

export interface SessionsStateMessage {
	command: 'sessionsState';
	appState: ResultsAppState;
	sessions: ResultsSessionSummary[];
	activeUri?: string;
	activeSession?: ResultsSessionDetail;
	autoFocusResults: boolean;
}

export interface AddRowsMessage {
	command: 'addRows';
	rows: Row[];
	isCursorOpen: boolean;
}

// The host's answer to a SetLibraryListMessage. On success the new list arrives with the next
// sessionsState, like any other session change; this only tells the live Edit Library List dialog to
// close, or to stay open on the user's edits and show why the change was refused.
export interface LibraryListResultMessage {
	command: 'libraryListResult';
	uri: string;
	error?: DbErrorUtils.SerializedError;
}

// The host's answer to a CheckLibraryMessage. `exists` is false only when the lookup ran and found no
// such library; a lookup that failed carries `error` instead.
export interface LibraryCheckResultMessage {
	command: 'libraryCheckResult';
	uri: string;
	requestId: number;
	exists: boolean;
	error?: DbErrorUtils.SerializedError;
}

export type ResultsInboundMessage = SessionsStateMessage | AddRowsMessage | LibraryListResultMessage | LibraryCheckResultMessage;

export interface SelectSessionMessage {
	command: 'selectSession';
	uri: string;
}

export interface LoadMoreMessage {
	command: 'loadMore';
}

export interface AddConnectionMessage {
	command: 'addConnection';
}

export interface FetchAllMessage {
	command: 'fetchAll';
}

export interface CancelFetchAllMessage {
	command: 'cancelFetchAll';
}

export interface ReconnectMessage {
	command: 'reconnect';
	uri: string;
}

export interface ExportDataMessage {
	command: 'exportData';
	destination: ExportDestination;
	what: ExportWhat;
	format: ExportFormat;
	/** Only present when `what === 'filtered'` - the host has no visibility into client-side filter state. */
	filteredRows?: Row[];
	/** Only present when `what === 'selected'` - the host has no visibility into client-side row selection. */
	selectedRows?: Row[];
}

export interface SetParameterValueMessage {
	command: 'setParameterValue';
	key: string;
	value: string | string[];
}

export interface ExecuteSqlMessage {
	command: 'executeSql';
}

// Re-runs the session driver's own setup check (DbDriver.checkSetup) for the active session's
// connection, and shows the same native "driver missing" notification (with its setup actions)
// that already fired when the error first occurred - so the user can summon it again from the
// History tab after dismissing it.
export interface CheckDriverSetupMessage {
	command: 'checkDriverSetup';
}

// Sets the user portion of a session's library list, on both its jobs, for as long as it stays connected
// (DbConnections.setLibraryList). Answered with a LibraryListResultMessage.
export interface SetLibraryListMessage {
	command: 'setLibraryList';
	uri: string;
	userLibraries: string[];
}

// Asks whether a library exists before the live Edit Library List dialog adds it, so a name that isn't
// on the system is refused at Add rather than failing the whole change at OK. Answered with a
// LibraryCheckResultMessage carrying the same requestId.
export interface CheckLibraryMessage {
	command: 'checkLibrary';
	uri: string;
	requestId: number;
	library: string;
}

export type ResultsOutboundMessage = SetLibraryListMessage | CheckLibraryMessage | SelectSessionMessage | LoadMoreMessage | AddConnectionMessage | FetchAllMessage | CancelFetchAllMessage | ExportDataMessage | ReconnectMessage | SetParameterValueMessage | ExecuteSqlMessage | CheckDriverSetupMessage;
