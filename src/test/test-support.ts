import * as vscode from 'vscode';
import { DbConnections } from '../database/db-connections.js';
import { CatalogResponder } from '../database/drivers/fake/catalog-responder.js';
import { FakeDriver } from '../database/drivers/fake/fake-driver.js';
import { SAMPLE_DATABASE } from '../database/drivers/fake/fixtures/sample-database.js';
import { DbConnectionEvent } from '../events/db-connection-event.js';
import { Event } from '../events/event.js';
import { Extension, extension } from '../extension.js';
import { Parameter } from '../interfaces/parameter.js';
import { ConnectionConfig } from '../models/connection-config.js';
import { SqlImportConfig } from '../models/sql-import-config.js';
import { ArrayUtils } from '../utils/array-utils.js';
import { WindowFocusLog } from './window-focus-log.js';

// Installed while mocha loads the test files. Its hooks are root hooks, so they cover every file in the
// run, not only those that import this module. See WindowFocusLog for why focus is worth a timeline.
WindowFocusLog.install();

/**
 * Shared setup for the integration tests: activating the extension, pointing a connection at the
 * fake driver, and waiting on the events the extension actually fires rather than on a timer.
 *
 * These tests assert on DbConnectionEvent because that is the real contract between the database
 * layer and everything above it (see CLAUDE.md) - the UI reactions, the session store and the
 * webviews all hang off these events, so an assertion here covers the behaviour rather than one
 * view's rendering of it. Nothing here sleeps: a fixed delay would either be flaky or slow, and
 * WorkbenchViewProvider's concatMap render pipeline means "the call returned" is not "the UI
 * settled" anyway.
 */
export namespace TestSupport {
	export const CONFIG_ID = 'integration-test-connection';

	/** The fixture every test starts from - re-exported so a test can extend it with its own responses. */
	export const DATABASE = SAMPLE_DATABASE;

	export const CONNECTION: ConnectionConfig = {
		id: CONFIG_ID,
		name: 'Integration Test',
		host: 'FAKEHOST',
		userName: 'TESTUSER',
		defaultTableSchema: 'SALES',
		driver: FakeDriver.ID
	};

	/**
	 * Activates the extension and installs exactly one connection, pointed at the fake driver.
	 *
	 * One connection, not two: with several configured and no configId supplied, DbConnections falls
	 * back to a QuickPick that a headless run can't answer.
	 */
	export async function activate(): Promise<void> {
		await vscode.extensions.getExtension('DuncanAviation.db2-workbench')?.activate();
		await extension.configurations.setConnections([CONNECTION]);
	}

	/**
	 * Replaces the registered fake driver for one test - used to inject an error or a delay that the
	 * shared fixture deliberately doesn't have. Call restoreDriver() afterwards, or later tests
	 * inherit it.
	 */
	export function useDriver(options: FakeDriver.Options): void {
		extension.drivers.register(new FakeDriver(options));
	}

	export function restoreDriver(): void {
		extension.drivers.register(new FakeDriver({ database: SAMPLE_DATABASE }));
	}

	/**
	 * Installs a fake driver that records every statement reaching it, for the tests that have to ask
	 * "did this query the catalog again, or was it served from cache?" - a question the returned rows
	 * can't answer, since a hit and a miss look identical from the caller's side.
	 *
	 * Install it BEFORE the session under test opens. A ConnectionWrapper keeps the driver instance
	 * its connection was created from, so a driver registered afterwards never sees that session's
	 * statements - which is also why the "rig this statement to fail" trick in db-connections.test.ts
	 * only works across a session boundary.
	 */
	export function recordStatements(options?: FakeDriver.Options): StatementRecorder {
		let statements: RecordedStatement[] = [];

		extension.drivers.register(new FakeDriver({
			database: DATABASE,
			...options,
			onStatement: (sql, parameters) => {
				statements.push({ sql: sql, normalized: CatalogResponder.normalize(sql), parameters: <Parameter[]>ArrayUtils.toArray(parameters) });

				// A caller's own hook still runs, for the tests that have to act at the moment a specific
				// statement reaches the driver rather than after it comes back - closing a session while
				// something is still running, for instance.
				options?.onStatement?.(sql, parameters);
			}
		}));

		return {
			statements: statements,
			matching: pattern => statements.filter(statement => pattern.test(statement.normalized)),
			clear: () => statements.splice(0, statements.length)
		};
	}

	export interface StatementRecorder {
		/** Every statement the driver has been asked to resolve, in order. */
		statements: RecordedStatement[];
		/** Those whose normalized (lower-cased, whitespace-collapsed) text matches - e.g. /syscolumns2/. */
		matching(pattern: RegExp): RecordedStatement[];
		/** Drops what's been recorded so far - used to discard a session's connection-time lookups. */
		clear(): void;
	}

	export interface RecordedStatement {
		sql: string;
		normalized: string;
		parameters: Parameter[];
	}

	/** Closes every open session, so one test's connection state can't leak into the next. */
	export async function closeSessions(...keys: string[]): Promise<void> {
		for(let key of keys) {
			await extension.connections.close({ key: key });
		}
	}

	/**
	 * Records every DbConnectionEvent fired for `key` until stop() is called, and lets a test await a
	 * specific one. Recording starts immediately, so an event fired between the call that triggers it
	 * and the await is still caught - the race a bare "wait for the next event" helper would lose.
	 */
	export function recordEvents(key: string): EventRecorder {
		let events: DbConnectionEvent[] = [];
		let waiters: { matches: (event: DbConnectionEvent) => boolean; resolve: (event: DbConnectionEvent) => void }[] = [];

		let subscription = extension.eventManager.onEvent(event => {
			if(event.type !== Event.Type.DB_CONNECTION) {
				return;
			}

			let dbEvent = <DbConnectionEvent>event;

			if(dbEvent.key !== key) {
				return;
			}

			events.push(dbEvent);

			for(let waiter of [...waiters]) {
				if(waiter.matches(dbEvent)) {
					waiters.splice(waiters.indexOf(waiter), 1);
					waiter.resolve(dbEvent);
				}
			}
		});

		return {
			events: events,
			ofType: (eventType, options) => events.filter(event => matches(event, eventType, options)),
			waitFor: (eventType, options) => {
				let existing = events.find(event => matches(event, eventType, options));

				if(existing) {
					return Promise.resolve(existing);
				}

				return new Promise<DbConnectionEvent>((resolve, reject) => {
					let timer = setTimeout(
						() => reject(new Error(`Timed out waiting for a ${eventType} event on ${key}. Saw: ${events.map(event => event.eventType).join(', ')}`)),
						options?.timeoutMs ?? 10000
					);

					waiters.push({
						matches: event => matches(event, eventType, options),
						resolve: event => {
							clearTimeout(timer);
							resolve(event);
						}
					});
				});
			},
			stop: () => subscription.dispose()
		};
	}

	function matches(event: DbConnectionEvent, eventType: DbConnectionEvent.EventType, options?: WaitOptions): boolean {
		return event.eventType === eventType && !(options?.userStatementsOnly && event.isInternal);
	}

	export interface EventRecorder {
		/** Every DbConnectionEvent seen for this key, in order. */
		events: DbConnectionEvent[];
		ofType(eventType: DbConnectionEvent.EventType, options?: WaitOptions): DbConnectionEvent[];
		waitFor(eventType: DbConnectionEvent.EventType, options?: WaitOptions): Promise<DbConnectionEvent>;
		stop(): void;
	}

	export interface WaitOptions {
		/** Ignores the catalog lookups the extension runs for itself - see execute(). */
		userStatementsOnly?: boolean;
		timeoutMs?: number;
	}

	/** Sets the session fetch size, which is what actually paginates a cursor (DbConnections.execute
	 * passes it to openCursor), rather than the fake driver's own fallback. */
	export async function setCursorFetchSize(rows: number): Promise<void> {
		await vscode.workspace.getConfiguration(Extension.ID).update('cursorFetchSize', rows, vscode.ConfigurationTarget.Global);
	}

	/**
	 * The saved SQL schema imports, in the user (global) scope `Configurations.sqlImports` reads.
	 *
	 * These run by themselves: opening any connection runs every saved import its config links, so a
	 * test that leaves one behind changes what every later session does. Clear them in teardown along
	 * with the links (see linkSqlImports).
	 */
	export async function setSqlImports(imports: SqlImportConfig[]): Promise<void> {
		await extension.configurations.setSqlImports(imports);
	}

	/** Points the one test connection at these saved imports - none of them, when called with nothing. */
	export async function linkSqlImports(...importIds: string[]): Promise<void> {
		await extension.configurations.setConnections([{ ...CONNECTION, sqlImportIds: importIds }]);
	}

	/** The per-statement row cap a SQL schema import runs under - lowered so truncation is testable. */
	export async function setSqlImportRowLimit(rows: number): Promise<void> {
		await vscode.workspace.getConfiguration(Extension.ID).update('sqlImportRowLimit', rows, vscode.ConfigurationTarget.Global);
	}

	/** How many entries a session's history keeps before the oldest is dropped. */
	export async function setHistoryCount(count: number): Promise<void> {
		await vscode.workspace.getConfiguration(Extension.ID).update('historyCount', count, vscode.ConfigurationTarget.Global);
	}

	/**
	 * Polls until `predicate` holds, for the handful of things VS Code reports through an event with
	 * no awaitable handle of its own - switching the active editor, closing a tab, a configuration
	 * write landing in the extension host.
	 *
	 * This is not a sleep: it returns as soon as the condition is true, and fails loudly with the
	 * caller's description rather than letting a later assertion fail for an unrelated-looking reason.
	 * Anything the extension signals with an event of its own is awaited through recordEvents()
	 * instead.
	 *
	 * The default limit is generous on purpose: a wait returns as soon as its condition holds, so the limit
	 * only matters when something is stuck, and CI's Windows runner is several times slower than a
	 * developer machine - a 5s default that was never close locally timed out there.
	 *
	 * `describeState`, when given, is appended to the timeout error - for a wait whose failure only
	 * shows up on a CI runner, where the message is all there is to go on.
	 */
	export async function waitUntil(description: string, predicate: () => boolean, timeoutMs = 15000, describeState?: () => string): Promise<void> {
		let start = Date.now();

		while(!predicate()) {
			if(Date.now() - start > timeoutMs) {
				throw new Error(`Timed out waiting for ${description}.${describeState ? `\n${describeState()}` : ''}`);
			}

			await new Promise(resolve => setTimeout(resolve, 10));
		}
	}

	/**
	 * Runs a statement on a session and resolves once it has produced a RESULT (or an ERROR).
	 *
	 * Internal statements are skipped. Opening a session kicks off its own catalog lookups (the table
	 * scan behind autocomplete, saved SQL imports), and those fire RESULT events on the same key -
	 * waiting for "the next RESULT" would hand back a SYSTABLES lookup instead of the statement under
	 * test, which is exactly the wrong-answer-that-looks-right this suite exists to catch.
	 */
	export async function execute(key: string, sql: string, options?: Partial<DbConnections.ExecuteOptions>): Promise<DbConnectionEvent> {
		let recorder = recordEvents(key);

		try {
			let settled = Promise.race([
				recorder.waitFor(DbConnectionEvent.EventType.RESULT, { userStatementsOnly: true }),
				recorder.waitFor(DbConnectionEvent.EventType.ERROR, { userStatementsOnly: true })
			]);

			await extension.connections.execute({ key: key, configId: CONFIG_ID, sql: sql, ...options });
			return await settled;
		} finally {
			recorder.stop();
		}
	}
}
