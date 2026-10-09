// mxGraph's `style` attribute is its own small semicolon-delimited "key=value;key=value;" mini-format,
// packed into a single XML attribute string - not something xml-js (or anything else generic) parses for
// us. Column metadata (type/PK/FK/identity) rides in here rather than an <object> wrapper specifically
// because draw.io's own table-layout engine silently strips row-level object wrappers on render
// (confirmed by hands-on testing against the real draw.io editor) but leaves style strings untouched.

export function parseStyle(style: string | undefined): Record<string, string> {
	if(!style) {
		return {};
	}

	let entries: Record<string, string> = {};

	for(let part of style.split(';')) {
		if(!part) {
			continue;
		}

		let separatorIndex = part.indexOf('=');

		if(separatorIndex === -1) {
			// A bare flag (e.g. the leading shape name, "rounded") - not one of our own keys, but still
			// worth preserving on round-trip rather than silently dropping.
			entries[part] = '';
			continue;
		}

		entries[part.slice(0, separatorIndex)] = part.slice(separatorIndex + 1);
	}

	return entries;
}

export function buildStyle(entries: Record<string, string>): string {
	return Object.entries(entries).map(([key, value]) => value === '' ? `${key};` : `${key}=${value};`).join('');
}
