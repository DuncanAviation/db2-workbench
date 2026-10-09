import { Parameter } from '../interfaces/parameter.js';
import { Nullable } from './nullable.js';
import { StatementParser } from './statement-parser.js';

import { StringUtils } from './string-utils.js';

export class SpParser {
	// Only anchors the "{CALL " / "CALL " prefix and the procedure name — deliberately not
	// anchored to the end of the statement, so a call is recognized as soon as the procedure name
	// is typed, before any parameter list (or even the opening paren) exists. The parameter list,
	// if any, is extracted separately by extractParameterString.
	static readonly CALL_REGEX = /^\s*(?:\{\s*CALL\s+|\bCALL\s+)([^(\s}]+)/i;

	static readonly KEY_WORDS = [
		'CALL'
	];

	static isSp(statement: string): boolean {
		return StringUtils.beginsWithIgnoreCase(StatementParser.stripComments(statement), 'call');
	}

	static parse(statement: string): Nullable<SpParser.SpParseResults> {
		let callParts = statement.match(SpParser.CALL_REGEX);

		if(callParts == null) {
			return {
				statementType: StatementParser.StatementType.SP,
				statementKind: StatementParser.StatementKind.CALL,
				originalSql: statement,
				isValid: false
			};
		}

		const fullProcedureName = callParts[1];
		const parameterString = SpParser.extractParameterString(statement, <number>callParts.index + callParts[0].length);

		let catalog: Nullable<string>;
		let schema: Nullable<string>;
		let name: string;

		const parts = fullProcedureName.split('.');

		if (parts.length === 3) {
			catalog = parts[0];
			schema = parts[1];
			name = parts[2];
		} else if (parts.length === 2) {
			schema = parts[0];
			name = parts[1];
		} else {
			name = parts[0];
		}

		return {
			statementType: StatementParser.StatementType.SP,
			statementKind: StatementParser.StatementKind.CALL,
			originalSql: statement,
			catalog: catalog,
			schema: schema,
			name: name,
			parameters: SpParser.parseCallParameters(parameterString),
			isValid: true
		};
	}

	// Everything between the first "(" after the procedure name and the matching closing ")", if
	// both exist. Handles a still-in-progress call — no "(" yet ("CALL proc"), an empty/unclosed
	// list ("CALL proc(", "CALL proc(1, 2"), or nested parens in an already-closed list
	// ("CALL proc(UPPER('a'))") — by only stripping a trailing ")" (plus optional "}" and
	// whitespace) when one is actually present at the end, rather than requiring it.
	private static extractParameterString(statement: string, afterProcedureName: number): string {
		let remainder = statement.slice(afterProcedureName);
		let openParenIndex = remainder.indexOf('(');

		if(openParenIndex === -1) {
			return '';
		}

		let afterOpenParen = remainder.slice(openParenIndex + 1);
		let closeMatch = afterOpenParen.match(/\)\s*\}?\s*$/);
		return closeMatch ? afterOpenParen.slice(0, closeMatch.index) : afterOpenParen;
	}

	private static parseCallParameters(parameterString: string): Array<Parameter> {
		const parameters: Array<Parameter> = [];

		if (StringUtils.isBlank(parameterString)) {
			return parameters;
		}

		// A simple state machine to parse parameters, handling quoted strings and escaped quotes
		let currentParam = '';
		let inQuote = false;
		let quoteChar = '';
		// A quoted value is always a string, even when its text reads as a number or "null"
		let wasQuoted = false;

		for (let i = 0; i < parameterString.length; i++) {
			const char = parameterString[i];

			if (inQuote) {
				if (char === quoteChar && parameterString[i + 1] === quoteChar) { // Escaped quote (e.g., '' or "")
					currentParam += quoteChar;
					i++; // Skip the next quote character
				} else if (char === quoteChar) { // End of quote
					inQuote = false;
					quoteChar = '';
				} else {
					currentParam += char;
				}
			} else if (char === '\'' || char === '"') {
				inQuote = true;
				wasQuoted = true;
				quoteChar = char;
				currentParam = ''; // Drop whitespace before the opening quote
			} else if (char === ',') {
				parameters.push(wasQuoted ? currentParam : this.parseLiteral(currentParam.trim()));
				currentParam = '';
				wasQuoted = false;
			} else if (!wasQuoted) { // Whitespace after a closing quote isn't part of the value
				currentParam += char;
			}
		}

		// Add the last parameter after the loop finishes
		parameters.push(wasQuoted ? currentParam : this.parseLiteral(currentParam.trim()));
		return parameters;
	}

	// An unquoted NULL still takes its position in the call - dropping it would shift every
	// later argument left and leave the call one parameter short
	private static parseLiteral(literal: string): Parameter {
		if (literal.toLowerCase() === 'null') {
			return null;
		}
		// Check if it's a number, but ensure it's not an empty string or just whitespace
		if (!isNaN(Number(literal)) && literal.trim() !== '') {
			return Number(literal);
		}
		// If it was a quoted string, the quotes would have been removed by the state machine
		return literal;
	}
}

export namespace SpParser {
	export enum ParameterMode {
		IN = 'IN',
		OUT = 'OUT',
		IN_OUT = 'IN_OUT'
	}

	export interface SpParseResults extends StatementParser.ParseResults {
		statementType: StatementParser.StatementType.SP;
		catalog?: string;
		schema?: string;
		name?: string;
		parameters?: Array<Parameter>;
	}
}