// Where a program's source lives, and the statements that read it - kept free of vscode and the
// connection so the name checks and the generated SQL can be unit tested on their own (see
// program-source.spec.ts). ProgramQueries runs what this builds.
//
// A source member has no catalog view that returns its lines, so it is read the long-standing way: an
// alias over the one member, created in QTEMP (so it is private to the job and gone with it), selected
// from and dropped again. CREATE ALIAS can't bind parameter markers for the names it points at, so
// every name that goes into one is checked against the shape of an IBM i system name first - these come
// back from the catalog, but they are still text spliced into DDL.

/** One place a program's source was compiled from: a source file member, or an IFS stream file. */
export interface ProgramSourceLocation {
	/** The ILE module this source built - absent for an OPM program, which has only the one source. */
	module?: string;
	library?: string;
	file?: string;
	member?: string;
	/** Set instead of library/file/member when the source was compiled from the IFS. */
	streamFile?: string;
	/** When the module was compiled (BOUND_MODULE_INFO.MODULE_CREATE_TIMESTAMP) - absent for an OPM program. */
	compiled?: string;
}

/** A source member as SYSPARTITIONSTAT lists it - the recorded one, or a copy of it in another library. */
export interface SourceMember {
	library: string;
	file: string;
	member: string;
	/** SYSPARTITIONSTAT.LAST_CHANGE_TIMESTAMP, as the driver returns it. */
	lastChanged?: string;
}

/** Why a copy was chosen over the others - see chooseMemberCopy. */
export type MemberCopyReason = 'own library' | 'library list' | 'most recently changed';

const MEMBER_COLUMNS = 'system_table_schema, system_table_name, system_table_member, last_change_timestamp';

/** One statement saying which of these recorded members still exist - so a missing one is never read,
 * which would fail and report an error, and so the search for a copy only runs when one is missing. */
export function buildMemberExistsQuery(members: SourceMember[]): { sql: string; parameters: string[] } {
	return {
		sql: `select ${MEMBER_COLUMNS} from qsys2.syspartitionstat ` +
			`where ${members.map(() => '(system_table_schema = ? and system_table_name = ? and system_table_member = ?)').join(' or ')}`,
		parameters: members.flatMap(member => [member.library, member.file, member.member])
	};
}

/** One statement listing every user library holding a file by each of these names. Searching
 * SYSPARTITIONSTAT by member name alone reads every member on the system, which takes minutes live;
 * finding the libraries first keeps the member search to a handful of named files. */
export function buildSourceFileLibrariesQuery(files: string[]): { sql: string; parameters: string[] } {
	return {
		sql: files.map(() => `select objlib, objname from table(qsys2.object_statistics('*ALLUSR', ?, ?)) x`).join(' union all '),
		parameters: files.flatMap(file => ['*FILE', file])
	};
}

/** One statement finding each missing member in the libraries holding its source file. */
export function buildMemberCopiesQuery(searches: { file: string; member: string; libraries: string[] }[]): { sql: string; parameters: string[] } {
	return {
		sql: `select ${MEMBER_COLUMNS} from qsys2.syspartitionstat ` +
			`where ${searches.map(search => `(system_table_name = ? and system_table_member = ? and system_table_schema in (${search.libraries.map(() => '?').join(', ')}))`).join(' or ')}`,
		parameters: searches.flatMap(search => [search.file, search.member, ...search.libraries])
	};
}

/**
 * Which copy of a missing member to show: the one in the program's own library (where a promotion
 * usually leaves it), else the first on the library list, else the most recently changed. The rest are
 * named alongside it, so a person can still go and look at them.
 */
export function chooseMemberCopy(copies: SourceMember[], options: { programLibrary?: string; libraryList: string[] }): { copy: SourceMember; reason: MemberCopyReason; others: SourceMember[] } | undefined {
	let pick = (copy: SourceMember | undefined, reason: MemberCopyReason) => copy == null ? undefined : { copy: copy, reason: reason, others: copies.filter(other => other !== copy) };

	let own = copies.find(copy => options.programLibrary != null && copy.library.toUpperCase() === options.programLibrary.toUpperCase());

	if(own != null) {
		return pick(own, 'own library');
	}

	let listed = copies
		.map(copy => ({ copy: copy, position: options.libraryList.findIndex(library => library.toUpperCase() === copy.library.toUpperCase()) }))
		.filter(entry => entry.position >= 0)
		.sort((a, b) => a.position - b.position)[0];

	if(listed != null) {
		return pick(listed.copy, 'library list');
	}

	return pick([...copies].sort((a, b) => normalizeTimestamp(b.lastChanged).localeCompare(normalizeTimestamp(a.lastChanged)))[0], 'most recently changed');
}

/** Whether a member was changed after the module was compiled - when it was, it may not be what runs.
 * False when either time is unknown. */
export function isChangedSince(lastChanged: string | undefined, compiled: string | undefined): boolean {
	if(lastChanged == null || compiled == null) {
		return false;
	}

	return normalizeTimestamp(lastChanged) > normalizeTimestamp(compiled);
}

// DB2 timestamps come back as 'YYYY-MM-DD HH:MM:SS.ffffff' (or with a T, through a Date), which compare
// in order as text once the separator is the same.
function normalizeTimestamp(value: string | undefined): string {
	return (value ?? '').replace('T', ' ').replace(/Z$/, '');
}

/** What the source tab says about a copy shown in place of a member that's gone - kept short, so it reads
 * at a glance. A copy changed since the compile also gets the notice's warning severity. */
export function describeMemberCopy(recorded: ProgramSourceLocation, choice: { copy: SourceMember; others: SourceMember[] }, changedSinceCompile: boolean): string {
	let text = `Compiled from ${describeSourceLocation(recorded)}, which no longer exists. Showing ${describeSourceLocation(choice.copy)}.`;

	if(changedSinceCompile) {
		text += ' Changed since compile.';
	}

	if(choice.others.length) {
		text += ` Also found: ${choice.others.map(other => describeSourceLocation(other)).join(', ')}.`;
	}

	return text;
}

/** What the source tab says when a member is gone and no copy of it was found. */
export function describeMissingMember(recorded: ProgramSourceLocation): string {
	return `Compiled from ${describeSourceLocation(recorded)}, which no longer exists, and no copy of that member was found in another library.`;
}

// A system object name: 1-10 characters, A-Z 0-9 _ $ # @, not starting with a digit or underscore.
const SYSTEM_NAME = /^[A-Z$#@][A-Z0-9_$#@]{0,9}$/;

export function isSystemName(value: string | undefined): boolean {
	return value != null && SYSTEM_NAME.test(value);
}

/** How a location reads to a person - the member form IBM i itself uses (LIB/FILE(MBR)), or the path. */
export function describeSourceLocation(location: ProgramSourceLocation): string {
	return location.streamFile ?? `${location.library}/${location.file}(${location.member})`;
}

/** Whether a location names a member or a stream file at all - a module compiled from source that was
 * never recorded (or from a source the system didn't keep) comes back with every field blank. */
export function hasSourceLocation(location: ProgramSourceLocation): boolean {
	return location.streamFile != null || (location.library != null && location.file != null && location.member != null);
}

/**
 * The three statements that read one source member: create the alias, select its lines in sequence
 * order, drop it. Throws when a name isn't a valid system name, rather than building DDL around it.
 */
export function buildMemberReadStatements(location: ProgramSourceLocation, aliasName: string): { create: string; select: string; drop: string } {
	for(let [label, value] of [['library', location.library], ['file', location.file], ['member', location.member], ['alias', aliasName]]) {
		if(!isSystemName(value)) {
			throw new Error(`Not a valid system name for a source ${label}: ${value ?? '(blank)'}`);
		}
	}

	return {
		create: `create alias qtemp."${aliasName}" for "${location.library}"."${location.file}" ("${location.member}")`,
		select: `select srcdta from qtemp."${aliasName}" order by srcseq`,
		drop: `drop alias qtemp."${aliasName}"`
	};
}

/** The native object an external routine runs, read from SYSROUTINES.EXTERNAL_NAME. */
export interface ExternalProgram {
	objectType: '*PGM' | '*SRVPGM';
	/** Absent for `*LIBL` or an unqualified name - the library list decides which library it is. */
	library?: string;
	object: string;
	/** A service program's exported procedure - the routine's entry point. Case kept as written: an
	 * export's symbol can be mixed case (a C function, an RPG EXTPROC name). */
	entry?: string;
}

const EXTERNAL_NAME = /^(?:([^/()]+)\/)?([^/()]+)(?:\((.+)\))?$/;

/**
 * The program an external routine runs: `LIB/PGM` is a program, `LIB/SRVPGM(ENTRY)` a service program's
 * export, and either may name `*LIBL` or no library at all. Undefined for anything that isn't one of
 * those - notably a Java routine's `class.method` or `jar:class.method`, which names no IBM i object.
 */
export function parseExternalName(externalName: string | undefined): ExternalProgram | undefined {
	let match = EXTERNAL_NAME.exec(externalName?.trim() ?? '');

	if(match == null) {
		return undefined;
	}

	let unquote = (value: string | undefined) => value?.trim().replace(/^"(.*)"$/, '$1');
	let library = unquote(match[1])?.toUpperCase();
	let object = unquote(match[2])?.toUpperCase();
	let entry = unquote(match[3]);

	if(!isSystemName(object) || (library != null && library !== '*LIBL' && !isSystemName(library))) {
		return undefined;
	}

	return {
		objectType: entry ? '*SRVPGM' : '*PGM',
		library: library === '*LIBL' ? undefined : library,
		object: <string>object,
		entry: entry || undefined
	};
}

/**
 * Which of a service program's module sources holds the routine's entry point. No catalog maps an export
 * to the module it came from, so the module is found the way a person would find it: a module named like
 * the entry, else the source that defines a procedure by that name - an RPG `dcl-proc` or fixed-form P
 * spec, a COBOL PROGRAM-ID, or a C function definition - else a module named like the service program
 * itself, the usual home of its exports when the rest are utility modules bound in by copy. Undefined when
 * none of those holds (the first match wins, in module order).
 */
export function findEntrySource(sources: { module?: string; text?: string }[], entry: string, object?: string): number | undefined {
	let named = sources.findIndex(source => source.module != null && source.module.toUpperCase() === entry.toUpperCase());

	if(named >= 0) {
		return named;
	}

	let name = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	let definitions = [
		new RegExp(`^\\s*dcl-proc\\s+${name}(\\s|;|$)`, 'im'),
		new RegExp(`^.{5}P\\s*${name}\\s+B(\\s|$)`, 'im'),
		new RegExp(`PROGRAM-ID\\.?\\s+['"]?${name}(['".\\s]|$)`, 'im'),
		new RegExp(`^[A-Za-z_][\\w\\s*]*\\b${name}\\s*\\([^;]*$`, 'm')
	];

	let found = sources.findIndex(source => source.text != null && definitions.some(definition => definition.test(<string>source.text)));

	if(found >= 0) {
		return found;
	}

	let home = object == null ? -1 : sources.findIndex(source => source.module != null && source.module.toUpperCase() === object.toUpperCase());
	return home >= 0 ? home : undefined;
}

/** Reads an IFS stream file's lines - the path is bound, so it needs no checking beyond being present. */
export const STREAM_FILE_READ_SQL = `select line from table(qsys2.ifs_read(path_name => ?)) order by line_number`;
