import type { SchemasLogicalFile, SchemasProgramSource } from '../../../src/webview-messages/schemas-messages';
import type { Loaded } from './routine-data';
import { useObjectLoad } from './routine-data';

/** A logical file as its tabs address it. */
export interface LogicalFileTarget {
	schema: string;
	name: string;
}

export interface LogicalFileDetail {
	/** Undefined when SYSFILES has no row for the file. */
	file?: SchemasLogicalFile;
}

// The file's SYSFILES row and key fields - the Info and Columns tabs both ask on mount; the host caches per file.
export function useLogicalFile(target: LogicalFileTarget): Loaded<LogicalFileDetail> {
	return useObjectLoad<LogicalFileDetail>({ schema: target.schema, specificName: target.name }, 'loadLogicalFile', message => {
		if (message.command === 'logicalFileLoaded') {
			return { value: { file: message.file } };
		}

		return message.command === 'logicalFileError' ? { error: message.error } : undefined;
	});
}

export interface LogicalFileSource {
	sources: SchemasProgramSource[];
	unavailable?: string;
}

// The DDS member the file was created from - read fresh every time it's asked for.
export function useLogicalFileSource(target: LogicalFileTarget): Loaded<LogicalFileSource> {
	return useObjectLoad<LogicalFileSource>({ schema: target.schema, specificName: target.name }, 'loadLogicalFileSource', message => {
		if (message.command === 'logicalFileSourceLoaded') {
			return { value: { sources: message.sources, unavailable: message.unavailable } };
		}

		return message.command === 'logicalFileSourceError' ? { error: message.error } : undefined;
	});
}
