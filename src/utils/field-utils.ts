// No vscode/React dependency - safe to import from both extension-host code (src/) and webview
// code (webviews/), which is why the newer type-category/formatting/validation helpers below are
// kept here alongside the older default-value-literal logic rather than split across two files.
export class FieldUtils {
	static readonly LOW_DATE = '0001-01-01';
	static readonly LOW_TIME = '00:00:00';
	static readonly LOW_TIMESTAMP = `${FieldUtils.LOW_DATE}-00.00.00.000000`;

	// 'TIMESTMP' is DB2 for i's own truncated form (QSYS2.SYSCOLUMNS2.COLTYPE reports it that way for
	// a TIMESTAMP column, not the full word) - without it here, upper.includes('TIMESTAMP') below
	// misses, and a timestamp value falls through to the TIME branch instead (which turns its
	// "HH.MM.SS.NNNNNN" fractional-second period into a colon - invalid DB2 syntax).
	static readonly TIMESTAMP_TYPES = ['TIMESTAMP', 'TIMESTMP'];
	static readonly DATE_TYPES = ['DATE'];
	static readonly TIME_TYPES = ['TIME'];
	static readonly BOOLEAN_TYPES = ['BOOLEAN'];
	// VARG is how SYSCOLUMNS2 spells VARGRAPHIC.
	static readonly CHARACTER_TYPES = ['CHAR', 'CHARACTER', 'VARCHAR', 'GRAPHIC', 'VARGRAPHIC', 'VARG', 'CLOB', 'DBCLOB', 'XML', 'BINARY', 'VARBINARY', 'BLOB', 'ROWID'];

	// Large object types specifically - a subset of CHARACTER_TYPES whose value shouldn't be fetched
	// wholesale for display (e.g. the schema browser's Data tab selects LENGTH(col) instead of col
	// for these, and shows a size placeholder rather than the raw value).
	static readonly LOB_TYPES = ['BLOB', 'DBCLOB', 'CLOB'];

	// DECIMAL/NUMERIC (and the older DDS-style ZONED/PACKED) are the only types where the catalog's
	// length/scale genuinely mean "total digits" / "decimal places" - safe to both display and
	// enforce as a digit-count limit.
	static readonly PRECISION_SCALE_TYPES = ['DECIMAL', 'NUMERIC', 'ZONED', 'PACKED'];

	// Whole-number types - catalog length here is a byte size (e.g. INTEGER=4), not a digit count,
	// so it's not meaningful to display or enforce as a length limit; only the lack of a decimal
	// point is enforced.
	static readonly INTEGER_TYPES = ['INTEGER', 'SMALLINT', 'BIGINT'];

	// Floating-point types - same "catalog length isn't digit count" reasoning as INTEGER_TYPES,
	// but a decimal point is allowed.
	static readonly FLOATING_POINT_TYPES = ['FLOAT', 'DOUBLE', 'REAL', 'DECFLOAT'];

	static readonly NUMERIC_TYPES = [...FieldUtils.PRECISION_SCALE_TYPES, ...FieldUtils.INTEGER_TYPES, ...FieldUtils.FLOATING_POINT_TYPES];

	// Returns a SQL literal to use as a placeholder value for the column/parameter, based on its
	// data type: empty string for character/binary types, 0 for numeric types, and IBM i's "low
	// values" date/time/timestamp for temporal types. TIMESTAMP is checked before TIME since
	// "TIMESTAMP" contains "TIME" as a substring.
	static getDefaultValueLiteral(field: FieldUtils.TypedField): string {
		let dataType = field.dataType?.toUpperCase() ?? '';

		if(FieldUtils.TIMESTAMP_TYPES.some(type => dataType.includes(type))) {
			return `'${FieldUtils.LOW_TIMESTAMP}'`;
		}

		if(FieldUtils.DATE_TYPES.some(type => dataType.includes(type))) {
			return `'${FieldUtils.LOW_DATE}'`;
		}

		if(FieldUtils.TIME_TYPES.some(type => dataType.includes(type))) {
			return `'${FieldUtils.LOW_TIME}'`;
		}

		if(FieldUtils.BOOLEAN_TYPES.some(type => dataType.includes(type))) {
			return 'FALSE';
		}

		if(FieldUtils.CHARACTER_TYPES.some(type => dataType.includes(type))) {
			return `''`;
		}

		// Numeric types (DECIMAL, NUMERIC, INTEGER, SMALLINT, BIGINT, FLOAT, REAL, DOUBLE, DECFLOAT)
		// and anything unrecognized default to 0.
		return '0';
	}

	// Formats a raw, freely-typed parameter value as the SQL literal it would need to be for the
	// substituted statement to remain valid: numeric/boolean stay bare, everything else (character,
	// date/time/timestamp, and any unrecognized type) is single-quoted with embedded quotes doubled.
	// Only the typed (numeric/boolean/date/time) values are trimmed - a character value is kept verbatim.
	// Blank/missing values become the NULL keyword rather than an empty string literal, since an
	// omitted optional parameter is closer in intent to "no value" than "empty string".
	static formatValueLiteral(dataType: string | undefined, value: string): string {
		if(!value) {
			return 'NULL';
		}

		let upper = dataType?.toUpperCase() ?? '';
		let trimmed = value.trim();

		if(FieldUtils.BOOLEAN_TYPES.some(type => upper.includes(type))) {
			return /^(1|true|t|y|yes)$/i.test(trimmed) ? 'TRUE' : 'FALSE';
		}

		if(FieldUtils.isNumericType(dataType)) {
			return trimmed;
		}

		if(FieldUtils.TIMESTAMP_TYPES.some(type => upper.includes(type))) {
			return `'${FieldUtils.formatTimestampLiteral(trimmed)}'`;
		}

		if(FieldUtils.DATE_TYPES.some(type => upper.includes(type))) {
			return `'${FieldUtils.formatDateLiteral(trimmed)}'`;
		}

		if(FieldUtils.TIME_TYPES.some(type => upper.includes(type))) {
			return `'${FieldUtils.formatTimeLiteral(trimmed)}'`;
		}

		// Character (and unrecognized) values keep their whitespace exactly as typed - unlike the typed
		// literals above, a leading or trailing space here can be real data (and a key value with a
		// leading space has to be matched as-is, or its UPDATE/DELETE quietly hits no rows).
		return `'${value.replace(/'/g, '\'\'')}'`;
	}

	// Accepts either a plain "YYYY-MM-DD" or an ISO "YYYY-MM-DDTHH:mm:ss" and keeps only the date part.
	private static formatDateLiteral(value: string): string {
		return value.split(/[T ]/)[0].replace(/'/g, '\'\'');
	}

	// DB2 for i's native TIME literal separator is ":" (matching FieldUtils.LOW_TIME) - accepts either
	// separator on input (a "." from a timestamp-style entry, or ":") and normalizes to ":".
	private static formatTimeLiteral(value: string): string {
		let timePart = value.includes('T') ? value.split('T')[1] : value;
		return timePart.replace(/Z$/i, '').replace(/\./g, ':').replace(/'/g, '\'\'');
	}

	// DB2 for i's native TIMESTAMP literal format is "YYYY-MM-DD-HH.MM.SS.NNNNNN" (matching
	// FieldUtils.LOW_TIMESTAMP) - accepts an ISO "YYYY-MM-DDTHH:mm:ss.SSS" entry (or a bare date) and
	// reformats the separators, padding/truncating the fractional part to 6 digits (microseconds).
	private static formatTimestampLiteral(value: string): string {
		let [datePart, timePart = '00:00:00'] = value.replace(/Z$/i, '').split(/[T ]/);
		let [time, fraction = ''] = timePart.split('.');
		let normalizedTime = time.replace(/:/g, '.');
		let micros = fraction.padEnd(6, '0').slice(0, 6);
		return `${datePart}-${normalizedTime}.${micros}`.replace(/'/g, '\'\'');
	}

	static isCharacterType(dataType?: string): boolean {
		let upper = dataType?.toUpperCase() ?? '';
		return FieldUtils.CHARACTER_TYPES.some(type => upper.includes(type));
	}

	// The character types DB2 blank-pads to their declared length on the way in, so trailing blanks in
	// a fetched value are padding, never data - 'ABC' and 'ABC ' are the same stored value. Matched
	// exactly rather than by substring like isCharacterType, since "VARCHAR" contains "CHAR" and a
	// variable-length value's trailing blanks are real. BINARY isn't here: it pads with X'00'.
	static isFixedLengthCharacterType(dataType?: string): boolean {
		return FieldUtils.FIXED_LENGTH_CHARACTER_TYPES.includes(dataType?.toUpperCase() ?? '');
	}

	private static readonly FIXED_LENGTH_CHARACTER_TYPES = ['CHAR', 'CHARACTER', 'GRAPHIC', 'NCHAR'];

	// The single "which picker, if any" decision point for FieldInput/FieldDateTimePicker - same
	// precedence TIMESTAMP_TYPES/DATE_TYPES/TIME_TYPES checks already use elsewhere (TIMESTAMP first,
	// since "TIMESTAMP" and "TIMESTMP" both contain "TIME" as a substring).
	static getTemporalCategory(dataType?: string): 'timestamp' | 'date' | 'time' | null {
		let upper = dataType?.toUpperCase() ?? '';

		if(FieldUtils.TIMESTAMP_TYPES.some(type => upper.includes(type))) {
			return 'timestamp';
		}

		if(FieldUtils.DATE_TYPES.some(type => upper.includes(type))) {
			return 'date';
		}

		if(FieldUtils.TIME_TYPES.some(type => upper.includes(type))) {
			return 'time';
		}

		return null;
	}

	static isLobType(dataType?: string): boolean {
		let upper = dataType?.toUpperCase() ?? '';
		return FieldUtils.LOB_TYPES.some(type => upper.includes(type));
	}

	static isPrecisionScaleType(dataType?: string): boolean {
		let upper = dataType?.toUpperCase() ?? '';
		return FieldUtils.PRECISION_SCALE_TYPES.some(type => upper.includes(type));
	}

	static isIntegerType(dataType?: string): boolean {
		let upper = dataType?.toUpperCase() ?? '';
		return FieldUtils.INTEGER_TYPES.some(type => upper.includes(type));
	}

	static isFloatingPointType(dataType?: string): boolean {
		let upper = dataType?.toUpperCase() ?? '';
		return FieldUtils.FLOATING_POINT_TYPES.some(type => upper.includes(type));
	}

	static isNumericType(dataType?: string): boolean {
		let upper = dataType?.toUpperCase() ?? '';
		return FieldUtils.NUMERIC_TYPES.some(type => upper.includes(type));
	}

	// A human-readable type + size, e.g. "CHAR(30)", "DECIMAL(9,2)", "INTEGER" - length/scale are
	// only appended where the catalog's length actually means something to a person filling in a
	// value (character size, or decimal precision/scale); fixed-size numeric types are shown bare.
	static formatDataType(field: FieldUtils.SizedField): string {
		let dataType = field.dataType?.toUpperCase() ?? '';

		if(!dataType) {
			return '';
		}

		if(FieldUtils.isCharacterType(dataType) && field.length) {
			return `${dataType}(${field.length})`;
		}

		if(FieldUtils.isPrecisionScaleType(dataType) && field.length) {
			return (field.scale ?? 0) > 0 ? `${dataType}(${field.length},${field.scale})` : `${dataType}(${field.length})`;
		}

		return dataType;
	}

	// Restricts free-typed text to what the field's numeric type actually allows: a single leading
	// "-", digits, and (only for types where a decimal point is meaningful) a single ".".
	// PRECISION_SCALE_TYPES (DECIMAL/NUMERIC/...) additionally get their digit counts capped to the
	// field's length/scale - INTEGER/FLOATING_POINT types skip that cap since the catalog's length
	// there is a byte size, not a digit count. Shared by any free-text input for a DB2-typed value -
	// the results grid's Parameters tab (scalar and multi-value inputs) and the schema browser's Data
	// tab search dialog both use this.
	static sanitizeNumericInput(raw: string, field: FieldUtils.SizedField): string {
		let negative = raw.trimStart().startsWith('-');
		let cleaned = raw.replace(/[^0-9.]/g, '');
		let isPrecisionScale = FieldUtils.isPrecisionScaleType(field.dataType);
		let scale = field.scale ?? 0;
		let allowDecimalPoint = FieldUtils.isFloatingPointType(field.dataType) || (isPrecisionScale && scale > 0);

		if(!allowDecimalPoint) {
			cleaned = cleaned.replace(/\./g, '');
		} else {
			let firstDot = cleaned.indexOf('.');

			if(firstDot !== -1) {
				cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
			}
		}

		if(isPrecisionScale && field.length) {
			let [integerPart, decimalPart] = cleaned.split('.');
			integerPart = integerPart.slice(0, Math.max(field.length - scale, 0));
			cleaned = decimalPart !== undefined ? `${integerPart}.${decimalPart.slice(0, scale)}` : integerPart;
		}

		return negative ? `-${cleaned}` : cleaned;
	}

	// Numeric filtering/digit-capping via sanitizeNumericInput() for numeric types, plus (for
	// character types) capping to the field's length so a paste that bypasses a native maxLength
	// attribute still can't produce an oversized value. Passes anything else through unchanged.
	static sanitizeFieldInput(raw: string, field: FieldUtils.SizedField): string {
		if(FieldUtils.isNumericType(field.dataType)) {
			return FieldUtils.sanitizeNumericInput(raw, field);
		}

		return FieldUtils.isCharacterType(field.dataType) && field.length ? raw.slice(0, field.length) : raw;
	}
}

export namespace FieldUtils {
	export interface TypedField {
		dataType?: string;
	}

	export interface SizedField extends TypedField {
		length?: number;
		scale?: number;
	}
}