import { Parameter } from '../interfaces/parameter.js';
import { StringUtils } from './string-utils.js';

// The rules behind changing a session's library list with CHGLIBL, and spotting a library command a user
// ran themselves. Pure and free of `vscode`, so the results webview's live Edit Schema List dialog can
// validate names with exactly the rules the host applies before it builds the command.
export class LibraryListUtils {
	/** An IBM i system name: up to 10 characters, starting with a letter, $, # or @. */
	static readonly SYSTEM_NAME_REGEX = /^[A-Z$#@][A-Z0-9$#@_]{0,9}$/i;

	/** The CL commands that change some part of a job's library list. */
	static readonly LIBRARY_LIST_COMMANDS = ['ADDLIBLE', 'RMVLIBLE', 'CHGLIBL', 'CHGCURLIB', 'CHGSYSLIBL', 'EDTLIBL'];

	static readonly QTEMP = 'QTEMP';

	private static readonly QCMDEXC_REGEX = /\bQCMDEXC\s*\(/i;
	private static readonly STRING_LITERAL_REGEX = /^\s*'((?:[^']|'')*)'/;

	/**
	 * Whether a name can go into a CHGLIBL command. The names are embedded in CL inside an SQL string
	 * literal, so anything that isn't a plain system name - a quote, a space, a parenthesis - is refused
	 * rather than escaped: it could only ever be a mistake or an attempt to run a second command.
	 */
	static isValidSystemName(name: string | null | undefined): boolean {
		return name != null && LibraryListUtils.SYSTEM_NAME_REGEX.test(name);
	}

	/**
	 * The CHGLIBL command that sets the user portion of a job's library list to `libraries`, in order.
	 * CHGLIBL drops every library it isn't given, so an empty list is `LIBL(*NONE)` rather than a command
	 * with nothing in it. Throws on a name isValidSystemName refuses.
	 */
	static buildChangeLibraryListCommand(libraries: string[]): string {
		let invalid = libraries.find(library => !LibraryListUtils.isValidSystemName(library));

		if(invalid != null) {
			throw new Error(`"${invalid}" is not a valid library name`);
		}

		return libraries.length === 0
			? 'CHGLIBL LIBL(*NONE)'
			: `CHGLIBL LIBL(${libraries.map(library => library.toUpperCase()).join(' ')})`;
	}

	/**
	 * `requested` with QTEMP kept. CHGLIBL would drop QTEMP along with anything else it isn't given, and
	 * nothing that edits the list should be able to do that. A request that carries QTEMP keeps it where
	 * it put it (the live dialog sends it in place, since removing a row above it moves it up by one); one
	 * that leaves it out gets it back at its current position (or past the end of a shorter list). It is
	 * never added to a job that doesn't have it on its list.
	 */
	static keepQtemp(current: string[], requested: string[]): string[] {
		let isQtemp = (library: string) => StringUtils.equalsIgnoreCase(library, LibraryListUtils.QTEMP);
		let libraries = requested.filter(library => !isQtemp(library));
		let currentPosition = current.findIndex(isQtemp);

		if(currentPosition < 0) {
			return libraries;
		}

		let requestedPosition = requested.findIndex(isQtemp);
		let position = requestedPosition >= 0 ? requestedPosition : currentPosition;

		return [...libraries.slice(0, position), LibraryListUtils.QTEMP, ...libraries.slice(position)];
	}

	/** The user portion of a library list - the part CHGLIBL sets - in list order. */
	static userLibraries(schemas: LibraryListUtils.Entry[]): string[] {
		return schemas.filter(schema => StringUtils.equalsIgnoreCase(schema.type, LibraryListUtils.EntryType.USER)).map(schema => schema.name.trim());
	}

	/** Whether two library lists hold the same entries, of the same types, in the same order. */
	static isSameList(first: LibraryListUtils.Entry[], second: LibraryListUtils.Entry[]): boolean {
		return first.length === second.length && first.every((entry, index) =>
			StringUtils.equalsIgnoreCase(entry.name?.trim(), second[index].name?.trim()) && StringUtils.equalsIgnoreCase(entry.type, second[index].type));
	}

	/**
	 * Whether a statement runs a library list command through QSYS2.QCMDEXC - as a CALL or as the scalar
	 * function (`values qsys2.qcmdexc(...)`). The command can be written into the statement as a literal
	 * or bound to it as a value, so the first argument's literal and every bound string are all checked.
	 * Regex-based, like SpParser: only the argument's leading command name matters here.
	 */
	static isLibraryListCommand(statement: string, parameters?: Parameter[] | null): boolean {
		let call = LibraryListUtils.QCMDEXC_REGEX.exec(statement);

		if(call == null) {
			return false;
		}

		let literal = LibraryListUtils.STRING_LITERAL_REGEX.exec(statement.slice(call.index + call[0].length))?.[1]?.replace(/''/g, '\'');
		let bound = (parameters ?? []).filter((value): value is string => typeof value === 'string');

		return [literal, ...bound].some(command => LibraryListUtils.isLibraryListCommandText(command));
	}

	/** Whether CL command text starts with one of LIBRARY_LIST_COMMANDS. */
	static isLibraryListCommandText(command: string | null | undefined): boolean {
		let name = /^\s*([A-Z]+)\b/i.exec(command ?? '')?.[1];
		return name != null && LibraryListUtils.LIBRARY_LIST_COMMANDS.some(candidate => StringUtils.equalsIgnoreCase(candidate, name));
	}
}

export namespace LibraryListUtils {
	/** The fields of a library list entry these rules read - a ConnectionSchema carries both. */
	export interface Entry {
		name: string;
		type: string;
	}

	/** QSYS2.LIBRARY_LIST_INFO's TYPE values. */
	export enum EntryType {
		SYSTEM = 'SYSTEM',
		PRODUCT = 'PRODUCT',
		CURRENT = 'CURRENT',
		USER = 'USER'
	}
}
