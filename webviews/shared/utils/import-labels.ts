import { PASTED_SOURCE_LABEL } from '../../../src/schema-conversion/schema-format-converter';
import type { ImportSourceFormat } from '../../../src/schema-conversion/schema-format-converter';

// How an import's provenance is named wherever one is shown - the View Imports dialog's batch headers and
// the imported-only Info tab. Shared rather than per-surface so a file named in one place is named the
// same way in the other, and so the format labels aren't copied a third time.

export const FORMAT_LABELS: Record<string, string> = {
	dbml: 'DBML',
	frictionless: 'Frictionless Table Schema',
	sql: 'SQL'
};

// What a pasted import of this format would have been called had it come from a file - only used to say
// WHICH kind of text was pasted, never to name a real file.
const FORMAT_EXTENSIONS: Record<string, string> = {
	dbml: '.dbml',
	frictionless: '.json'
};

export function getFormatLabel(format: ImportSourceFormat): string {
	return FORMAT_LABELS[format] ?? format;
}

/** Full date + time, for the secondary "exactly when" line. Empty for an unparseable timestamp. */
export function formatImportTimestamp(iso: string): string {
	let date = new Date(iso);
	return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

// A single line naming one import: where it came from and when. The time is what separates two imports of
// the same file, so it is part of the primary label rather than buried below it. Today's imports show the
// time alone (the common case in a session-scoped list, where a date would be noise); anything older keeps
// its date, since the store survives as long as the extension host does.
//
//   orders.dbml - 9:30 AM
//   Pasted .dbml from 9:30 AM
//   orders.dbml - 9/14/2026, 4:02 PM
export function buildImportLabel(provenance: {sourceLabel: string; sourceFormat: ImportSourceFormat; importedAt: string}): string {
	let date = new Date(provenance.importedAt);

	if(Number.isNaN(date.getTime())) {
		return provenance.sourceLabel;
	}

	let now = new Date();
	let sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
	let when = sameDay ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : date.toLocaleString();

	if(provenance.sourceLabel === PASTED_SOURCE_LABEL) {
		return `Pasted ${FORMAT_EXTENSIONS[provenance.sourceFormat] ?? getFormatLabel(provenance.sourceFormat)} from ${when}`;
	}

	return `${provenance.sourceLabel} — ${when}`;
}
