import { ArrayUtils } from '../../../utils/array-utils.js';
import { StringUtils } from '../../../utils/string-utils.js';

// No vscode/React dependency - safe to import from both extension-host code (src/) and webview
// code (webviews/), same reasoning as FieldUtils (see field-utils.ts).
export class ConnectionStringUtils {
	// Splits a raw ODBC connection string into its semicolon-delimited "Keyword=value" properties.
	static parseProperties(connectionString: string): string[] {
		return connectionString
			.split(';')
			.map(property => property.trim())
			.filter(property => StringUtils.isNotBlank(property));
	}

	// Drops any property whose keyword starts with one of the given prefixes (case-insensitive) -
	// used to strip out keywords a caller is about to override (System/Uid/Pwd in DbConnection.connect(),
	// Sort*/LanguageID in SortSequenceUtils) so the override can't collide with a pre-existing value.
	static removeProperties(properties: string[], keywordPrefixes: string[]): string[] {
		let result = [...properties];
		ArrayUtils.removeIf(result, property => keywordPrefixes.some(prefix => StringUtils.beginsWithIgnoreCase(property, prefix)));
		return result;
	}
}
