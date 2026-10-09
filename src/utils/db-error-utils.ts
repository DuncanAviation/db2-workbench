// No vscode/React dependency - safe to import from both extension-host code (src/) and webview
// code (webviews/), same reasoning as FieldUtils (see field-utils.ts).
//
// Driver-neutral by design: a database error reaches the UI as a message plus the driver's own
// reported chain of parts, whichever driver produced it (see DbDriver's error contract). Anything
// specific to ODBC - the IM002 "driver not found" SQLSTATE and the setup guidance behind it - lives
// with the ODBC driver instead, not here.
export class DbErrorUtils {
	/**
	 * Pulls the driver-reported chain of error parts (SQLSTATE + native code + text per part) off a
	 * caught error. A single `.message` collapses/truncates that chain, so any surface showing a
	 * database error (History tab, Test Connection, the schema browser's Run SQL panel) should use
	 * this rather than just displaying `.message`.
	 *
	 * Drivers are required to normalize their native errors onto `driverErrors` before throwing. The
	 * ODBC-shaped `odbcErrors` fallback covers an error that escaped a driver's normalization - an
	 * entry cached by a build from before drivers existed, most likely.
	 */
	static extractDriverErrors(error: any): DbErrorUtils.DbErrorDetail[] | undefined {
		let details = error?.driverErrors ?? error?.odbcErrors;

		if(Array.isArray(details) && details.length > 0) {
			return details.map((detail: any) => ({ code: detail.code, state: detail.state, message: detail.message }));
		}

		return undefined;
	}

	/**
	 * The one place a caught error is turned into the postMessage-safe shape a webview actually
	 * renders - callers (schemas-provider.ts, data-queries.ts) should send this whole object over
	 * rather than pre-formatting a display string themselves, so the webview side (see
	 * webviews/shared/components/sql-error-display.tsx) always has the full detail (message +
	 * driverErrors) to decide how to present it, not just whatever the host happened to keep.
	 *
	 * `isSetupError` is the host's answer to a question a webview can't ask for itself - only the
	 * host holds the driver, and only the driver knows whether an error means "this driver isn't
	 * installed" rather than "this statement is wrong" (see DbDriver.isSetupError). Callers that
	 * have the session's driver in hand should pass it; the ones that don't leave it undefined,
	 * and the webview simply shows no setup guidance.
	 */
	static serialize(error: unknown, isSetupError?: boolean): DbErrorUtils.SerializedError {
		return {
			message: error instanceof Error ? error.message : String(error),
			driverErrors: DbErrorUtils.extractDriverErrors(error),
			isSetupError: isSetupError === true ? true : undefined
		};
	}
}

export namespace DbErrorUtils {
	export interface ErrorLike {
		message?: string;
		driverErrors?: { state?: string }[];
	}

	/** One part of a driver's reported error chain. */
	export interface DbErrorDetail {
		code: string | number;
		state: string;
		message: string;
	}

	// A caught error, normalized to a plain, postMessage-safe shape - see serialize().
	export interface SerializedError {
		message: string;
		driverErrors?: DbErrorDetail[];
		/** True when the driver reported that it isn't set up on this machine, so the surface showing
		 * this error can offer setup guidance instead of presenting it as a SQL problem. Absent when
		 * the serializing caller had no driver to ask - see serialize(). */
		isSetupError?: boolean;
	}
}
