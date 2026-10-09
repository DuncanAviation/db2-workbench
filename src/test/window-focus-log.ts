import * as vscode from 'vscode';

/**
 * A timeline of the test window's focus across the whole integration run, kept to diagnose the
 * formatting flake: once in a while every native format command in a run quietly does nothing.
 *
 * The one failure with diagnostics reported "Window focused: false", but that alone is not the cause:
 * runs that were unfocused from start to end have passed. The timeline shows whether a failing run
 * lost or regained focus at some point, and which test was running when it did, so a change of focus
 * can be lined up with the failure instead of guessed at.
 *
 * Installed once, from test-support.ts, while mocha is loading the test files. A hook registered
 * outside any suite() is a root hook, so it sees every test in every file.
 */
export namespace WindowFocusLog {
	export interface Change {
		/** Milliseconds since the log was installed. */
		elapsedMs: number;
		focused: boolean;
		/** Whether the window has been interacted with recently (WindowState.active). */
		active: boolean;
		/** The test running when the change arrived, or where in the run it happened. */
		during: string;
	}

	let installed = false;
	let startedAt = 0;
	let current = 'before the first test';
	const changes: Change[] = [];

	export function install() {
		if(installed) {
			return;
		}

		installed = true;
		startedAt = Date.now();
		record(vscode.window.state, 'at the start of the run');
		vscode.window.onDidChangeWindowState(state => record(state, current));

		setup(function() {
			current = this.currentTest?.fullTitle() ?? 'an unnamed test';
		});

		teardown(function() {
			let test = this.currentTest;
			current = `after ${test?.fullTitle() ?? 'an unnamed test'}`;

			// Any failure, not only a formatting one, gets the timeline: a test that depends on focus without
			// knowing it would fail the same way.
			if(test?.state === 'failed' && changes.length > 1) {
				console.log(`Window focus during this run, up to the failure of "${test.fullTitle()}":\n${describe()}`);
			}
		});

		// Printed on a passing run too, so there is a passing timeline to compare a failing one against.
		suiteTeardown(function() {
			console.log(`Window focus during this run:\n${describe()}`);
		});
	}

	/** Whether the window has lost focus at any point since `sinceMs` (elapsed time, as in Change). */
	export function lostFocusSince(sinceMs: number): boolean {
		return changes.some(change => change.elapsedMs >= sinceMs && !change.focused);
	}

	export function elapsedMs(): number {
		return Date.now() - startedAt;
	}

	/** The timeline, one change per line. */
	export function describe(): string {
		return changes
			.map(change => `  ${change.elapsedMs}ms: focused=${change.focused}, active=${change.active}, ${change.during}`)
			.join('\n');
	}

	function record(state: vscode.WindowState, during: string) {
		let last = changes[changes.length - 1];

		// onDidChangeWindowState also fires when only `active` changes; both are kept, but an event that
		// changes neither adds nothing.
		if(last && last.focused === state.focused && last.active === state.active) {
			return;
		}

		changes.push({elapsedMs: elapsedMs(), focused: state.focused, active: state.active, during: during});
	}
}
