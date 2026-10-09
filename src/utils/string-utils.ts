import { Nullable } from './nullable.js';

// Null-tolerant string helpers, for the checks the language has no one-liner for. Pure, so
// importable from webviews.
export class StringUtils {
	// Whether the value is null, undefined, empty, or only whitespace.
	static isBlank(value: string | null | undefined): value is '' | null | undefined {
		return value == null || value.trim().length === 0;
	}

	static isNotBlank(value: string | null | undefined): value is string {
		return !StringUtils.isBlank(value);
	}

	// Case-insensitive equality, where two absent values are equal and one absent value never
	// equals a present one.
	static equalsIgnoreCase(value: string | null | undefined, other: string | null | undefined): boolean {
		if(value == null || other == null) {
			return value == null && other == null;
		}

		return value.toUpperCase() === other.toUpperCase();
	}

	// Whether "value" starts with "prefix", ignoring case. Two absent values match; one absent value
	// never does.
	static beginsWithIgnoreCase(value: string | null | undefined, prefix: string | null | undefined): boolean {
		if(value == null || prefix == null) {
			return value == null && prefix == null;
		}

		return value.toUpperCase().startsWith(prefix.toUpperCase());
	}

	// The trimmed value, or "fallback"'s result when the value is blank.
	static default(value: string | null | undefined, fallback: () => string): string {
		return StringUtils.trim(value ?? undefined, {toUndefined: true}) ?? fallback();
	}

	// Null-tolerant trim, with options for the two things a plain value?.trim() can't do.
	static trim(value: Nullable<string>, options: StringUtils.TrimOptions = {}): Nullable<string> {
		if(options.toUndefined && StringUtils.isBlank(value)) {
			return undefined;
		}

		if(value == null || value.length === 0) {
			return value;
		}

		if(options.removeDuplicateWhiteSpace) {
			value = value.split(/\s+/).join(' ');
		}

		return value.trim();
	}

	// The plural suffix for "count" things: "pluralValue" (default "s") for zero or two or more
	// (either sign), otherwise "singularValue" (default "").
	static getPlural(count: number, pluralValue = 's', singularValue = ''): string {
		return count === 0 || Math.abs(count) >= 2 ? pluralValue : singularValue;
	}
}

export namespace StringUtils {
	export interface TrimOptions {
		// Returns undefined for a blank value, rather than an empty string.
		toUndefined?: boolean;
		// Collapses every run of whitespace inside the value to one space.
		removeDuplicateWhiteSpace?: boolean;
	}
}
