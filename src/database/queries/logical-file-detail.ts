import { SystemLogicalFile } from '../../models/system-logical-file.js';
import { StringUtils } from '../../utils/string-utils.js';

// Pure helpers for CatalogQueries.getLogicalFile - no vscode, no odbc, so they're unit tested on their own.

/**
 * SYSFILES.BASED_ON is JSON: {"BASED_ON_FILES":[{"LIBRARY":"SALESLIB","FILE":"JOBHDR","MEMBER":"JOBHDR","LF_FORMAT":"JOBLIN"}]}.
 * Anything that isn't that shape gives no files rather than failing the Info tab over one field.
 */
export function parseBasedOnFiles(value: unknown): SystemLogicalFile.BasedOnFile[] {
	if(typeof value !== 'string' || StringUtils.isBlank(value)) {
		return [];
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(value);
	} catch {
		return [];
	}

	let files = (<{BASED_ON_FILES?: unknown}>parsed)?.BASED_ON_FILES;

	if(!Array.isArray(files)) {
		return [];
	}

	return files.flatMap(entry => {
		let library = text(entry?.LIBRARY);
		let file = text(entry?.FILE);

		if(library == null || file == null) {
			return [];
		}

		return [{library: library, file: file, member: text(entry?.MEMBER), format: text(entry?.LF_FORMAT)}];
	});
}

/** SYSFILES' YES/NO columns. */
export function isYes(value: unknown): boolean {
	return typeof value === 'string' && StringUtils.equalsIgnoreCase(value.trim(), 'YES');
}

/** The source member SYSFILES records, or undefined when any part of it is blank. */
export function toSourceMember(library: unknown, file: unknown, member: unknown): SystemLogicalFile.SourceMember | undefined {
	let parts = {library: text(library), file: text(file), member: text(member)};
	return parts.library != null && parts.file != null && parts.member != null ? <SystemLogicalFile.SourceMember>parts : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' ? StringUtils.trim(value, {toUndefined: true}) : undefined;
}
