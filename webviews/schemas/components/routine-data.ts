import { useEffect, useState } from 'react';
import type { SchemasInboundMessage, SchemasOutboundMessage, SchemasProgramSource, SchemasRoutineDetail, SchemasRoutineParam, SchemasSystemRoutine } from '../../../src/webview-messages/schemas-messages';
import type { DbErrorUtils } from '../../../src/utils/db-error-utils';
import { schemasVsCodeApi } from '../vscode-api';

/** A routine as its tabs address it: the schema plus the specific name that picks out one overload. */
export interface RoutineTarget {
	schema: string;
	specificName: string;
}

/** What the tabs call a routine in their messages - "function" or "procedure". */
export function routineNoun(routine: Pick<SchemasSystemRoutine, 'routineType'>): string {
	return routine.routineType === 'PROCEDURE' ? 'procedure' : 'function';
}

export interface Loaded<T> {
	/** Null while loading (and again after a refresh, until the reply lands). */
	value: T | null;
	error: DbErrorUtils.SerializedError | null;
	refresh: () => void;
}

// A routine's SYSPARMS rows - parameters and a function's results both, split by row type in the tabs that
// read them. Each tab that needs them asks on mount: the host caches per routine (MemoryCache.getRoutineParams), so
// a second tab asking costs nothing.
export function useRoutineParams(target: RoutineTarget): Loaded<SchemasRoutineParam[]> {
	return useRoutineLoad<SchemasRoutineParam[]>(target, 'loadRoutineParams', message => {
		if (message.command === 'routineParamsLoaded') {
			return { value: message.params };
		}

		return message.command === 'routineParamsError' ? { error: message.error } : undefined;
	});
}

export interface RoutineDetail {
	/** Undefined when the routine no longer exists. */
	detail?: SchemasRoutineDetail;
	formattedDefinition: string;
}

// The rest of the function's SYSROUTINES row, body included - cached on the host the same way.
export function useRoutineDetail(target: RoutineTarget): Loaded<RoutineDetail> {
	return useRoutineLoad<RoutineDetail>(target, 'loadRoutineDetail', message => {
		if (message.command === 'routineDetailLoaded') {
			return { value: { detail: message.detail, formattedDefinition: message.formattedDefinition } };
		}

		return message.command === 'routineDetailError' ? { error: message.error } : undefined;
	});
}

// The statement that recreates the routine (QSYS2.GENERATE_SQL), cached on the host. An error here is
// expected on some systems - the Definition tab falls back to the stored body.
export function useRoutineDdl(routine: Pick<SchemasSystemRoutine, 'schema' | 'specificName' | 'routineType'>): Loaded<string> {
	return useRoutineLoad<string>(routine, 'loadRoutineDdl', message => {
		if (message.command === 'routineDdlLoaded') {
			return { value: message.ddl };
		}

		return message.command === 'routineDdlError' ? { error: message.error } : undefined;
	}, { routineType: routine.routineType });
}

export interface RoutineSource {
	program: string;
	entry?: string;
	sources: SchemasProgramSource[];
	entryModuleFound?: boolean;
	resolvedFromLibraryList?: boolean;
	unavailable?: string;
}

// An external routine's program source - read fresh every time it's asked for.
export function useRoutineSource(target: RoutineTarget): Loaded<RoutineSource> {
	return useRoutineLoad<RoutineSource>(target, 'loadRoutineSource', message => {
		if (message.command === 'routineSourceLoaded') {
			return { value: { program: message.program, entry: message.entry, sources: message.sources, entryModuleFound: message.entryModuleFound, resolvedFromLibraryList: message.resolvedFromLibraryList, unavailable: message.unavailable } };
		}

		return message.command === 'routineSourceError' ? { error: message.error } : undefined;
	});
}

type Outcome<T> = { value: T } | { error: DbErrorUtils.SerializedError } | undefined;

type LoadCommand = 'loadRoutineParams' | 'loadRoutineDetail' | 'loadRoutineDdl' | 'loadRoutineSource';

// `extra` carries what one request needs beyond the routine's identity (the DDL's routine type).
function useRoutineLoad<T>(target: RoutineTarget, command: LoadCommand, read: (message: SchemasInboundMessage) => Outcome<T>, extra?: { routineType?: SchemasSystemRoutine['routineType'] }): Loaded<T> {
	const [value, setValue] = useState<T | null>(null);
	const [error, setError] = useState<DbErrorUtils.SerializedError | null>(null);

	useEffect(() => {
		setValue(null);
		setError(null);

		function onMessage(event: MessageEvent<SchemasInboundMessage>) {
			let message = event.data;

			if (message.schema !== target.schema || message.table !== target.specificName) {
				return;
			}

			let outcome = read(message);

			if (outcome && 'value' in outcome) {
				setValue(outcome.value);
			} else if (outcome) {
				setError(outcome.error);
			}
		}

		window.addEventListener('message', onMessage);
		schemasVsCodeApi.postMessage(<SchemasOutboundMessage>{ command: command, schema: target.schema, table: target.specificName, ...extra });
		return () => window.removeEventListener('message', onMessage);
		// `read` is a fresh closure every render, but which messages it accepts never changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [target.schema, target.specificName, command]);

	function refresh() {
		setValue(null);
		setError(null);
		schemasVsCodeApi.postMessage(<SchemasOutboundMessage>{ command: command, schema: target.schema, table: target.specificName, ...extra, forceRefresh: true });
	}

	return { value, error, refresh };
}
