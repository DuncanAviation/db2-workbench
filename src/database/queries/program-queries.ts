import { Extension } from '../../extension.js';
import { StringUtils } from '../../utils/string-utils.js';
import { DbConnections } from '../db-connections.js';
import { runCatalogLookup } from './catalog-lookup.js';
import { CatalogLookupError } from './catalog-lookup.js';
import {
	buildMemberCopiesQuery,
	buildMemberExistsQuery,
	buildMemberReadStatements,
	buildSourceFileLibrariesQuery,
	chooseMemberCopy,
	describeMemberCopy,
	describeMissingMember,
	hasSourceLocation,
	isChangedSince,
	ProgramSourceLocation,
	SourceMember,
	STREAM_FILE_READ_SQL
} from './program-source.js';

// Native programs and service programs - what the program behind an external trigger or routine was
// compiled from, and that source's text, for the schema browser's Triggers tab and Program Source tab.
// Where the source is, and which members exist, is looked up every time; a member's text is cached
// only while its change timestamp stays the same (see readSources), so it is whatever the member holds now.
export class ProgramQueries {
	// Names each QTEMP alias uniquely, so two reads in flight on the same worker connection can't collide.
	private aliasSequence = 0;

	constructor(private extension: Extension) {}

	/**
	 * Where a program's or service program's source is. An OPM program records one source member on the
	 * program itself (PROGRAM_INFO); an ILE object records one per module it binds (BOUND_MODULE_INFO),
	 * which may be a member or an IFS stream file. Modules bound in from other service programs are not
	 * part of the object and are not listed. A module with no recorded source is left out. Undefined when
	 * the object doesn't exist - an external routine can outlive the program it was registered against.
	 */
	async listSourceLocations(options: ProgramQueries.ProgramOptions): Promise<ProgramSourceLocation[] | undefined> {
		let library = options.library.toUpperCase();
		let program = options.program.toUpperCase();
		let objectType = options.objectType ?? '*PGM';

		let programs = await runCatalogLookup(this.extension, {
			key: options.key,
			configId: options.configId,
			sql: `select program_type, source_file_library, source_file, source_file_member ` +
				`from qsys2.program_info ` +
				`where program_library = ? and program_name = ? and object_type = ?`,
			parameters: [library, program, objectType],
			progressMessage: 'Finding program source...'
		});

		let found = programs[0];

		if(found == null) {
			return undefined;
		}

		if(!StringUtils.equalsIgnoreCase(ProgramQueries.read(found, 'PROGRAM_TYPE'), 'ILE')) {
			let location: ProgramSourceLocation = {
				library: ProgramQueries.read(found, 'SOURCE_FILE_LIBRARY'),
				file: ProgramQueries.read(found, 'SOURCE_FILE'),
				member: ProgramQueries.read(found, 'SOURCE_FILE_MEMBER')
			};

			return hasSourceLocation(location) ? [location] : [];
		}

		// Distinct, since BOUND_MODULE_INFO can list a module once per copy bound in.
		let modules = await runCatalogLookup(this.extension, {
			key: options.key,
			configId: options.configId,
			sql: `select distinct bound_module, source_file_library, source_file, source_file_member, source_stream_file_path, module_create_timestamp ` +
				`from qsys2.bound_module_info ` +
				`where program_library = ? and program_name = ? and object_type = ? ` +
				`order by bound_module`,
			parameters: [library, program, objectType],
			progressMessage: 'Finding program source...'
		});

		return modules
			.map(row => {
				let streamFile = ProgramQueries.read(row, 'SOURCE_STREAM_FILE_PATH');
				let compiled = row['MODULE_CREATE_TIMESTAMP'] == null ? undefined : String(row['MODULE_CREATE_TIMESTAMP']);

				return <ProgramSourceLocation>(streamFile != null
					? {module: ProgramQueries.read(row, 'BOUND_MODULE'), streamFile: streamFile, compiled: compiled}
					: {
						module: ProgramQueries.read(row, 'BOUND_MODULE'),
						library: ProgramQueries.read(row, 'SOURCE_FILE_LIBRARY'),
						file: ProgramQueries.read(row, 'SOURCE_FILE'),
						member: ProgramQueries.read(row, 'SOURCE_FILE_MEMBER'),
						compiled: compiled
					});
			})
			.filter(hasSourceLocation);
	}

	/** The library an unqualified (or `*LIBL`) program name resolves to - the first on the connection's
	 * library list that holds it, as the system resolves it when the routine runs. Undefined when none does. */
	async resolveLibrary(options: DbConnections.CommonListOptions & {objectType: '*PGM' | '*SRVPGM'; program: string}): Promise<string | undefined> {
		let objects = await runCatalogLookup(this.extension, {
			key: options.key,
			configId: options.configId,
			sql: `select objlib from table(qsys2.object_statistics('*LIBL', ?, ?)) x`,
			parameters: [options.objectType, options.program.toUpperCase()],
			progressMessage: 'Finding program...'
		});

		return objects[0] == null ? undefined : ProgramQueries.read(objects[0], 'OBJLIB');
	}

	/** Every user library holding an object of this name and type, on the library list or not - where to
	 * look when a *LIBL name finds nothing, e.g. a copy left in a developer's own library. Only asked once
	 * the library list has come up empty, since it reads every user library's objects. */
	async listLibrariesHolding(options: DbConnections.CommonListOptions & {objectType: '*PGM' | '*SRVPGM'; program: string}): Promise<string[]> {
		let objects = await runCatalogLookup(this.extension, {
			key: options.key,
			configId: options.configId,
			sql: `select objlib from table(qsys2.object_statistics('*ALLUSR', ?, ?)) x order by objlib`,
			parameters: [options.objectType, options.program.toUpperCase()],
			progressMessage: 'Finding program...'
		});

		return objects.map(object => ProgramQueries.read(object, 'OBJLIB')).filter(library => library != null);
	}

	/**
	 * Every location's text, in order. A failure reading one is carried on that source rather than thrown,
	 * so one bad module doesn't hide the ones that can still be shown. A location in QTEMP isn't read at
	 * all: it was a temporary copy the compile job made (the SQL precompiler's output, typically QSQLPRE or
	 * QSQLTEMP1), gone when that job ended, and the module doesn't record the member it was made from.
	 *
	 * A member that no longer exists - typically compiled from a test or staging library cleaned up after
	 * the object was promoted - isn't read either. A copy by the same file and member name in another
	 * library is shown in its place, with a notice saying which and why (see chooseMemberCopy); with no
	 * copy, the source says so rather than failing. That costs one statement for every member at once,
	 * plus two more only when one is missing.
	 *
	 * Those statements also return each member's LAST_CHANGE_TIMESTAMP, and a member's text is reused
	 * from MemoryCache while that is unchanged, saving the three statements a read takes. A stream file,
	 * or a member whose timestamp couldn't be looked up, is read every time.
	 */
	async readSources(options: DbConnections.CommonListOptions, locations: ProgramSourceLocation[], context: ProgramQueries.ReadContext = {}): Promise<ProgramQueries.ReadSource[]> {
		let members = locations.filter(location => location.streamFile == null && !StringUtils.equalsIgnoreCase(location.library, 'QTEMP') && hasSourceLocation(location));
		let {replacements, found} = await this.findMembers(options, members, context);
		let sources: ProgramQueries.ReadSource[] = [];

		for(let location of locations) {
			if(StringUtils.equalsIgnoreCase(location.library, 'QTEMP')) {
				sources.push({location: location, unavailable: ProgramQueries.TEMPORARY_SOURCE});
				continue;
			}

			let replacement = replacements.get(location);

			if(replacement != null && replacement.copy == null) {
				sources.push({location: location, unavailable: describeMissingMember(location)});
				continue;
			}

			let read = replacement?.copy ?? location;
			let member = read.streamFile == null ? found.find(candidate => ProgramQueries.sameMember(candidate, <SourceMember>read)) : undefined;
			let lastChanged = member?.lastChanged;

			try {
				let text = member != null && lastChanged != null
					? await this.extension.memoryCache.getSourceText(options, {...member, lastChanged: lastChanged}, () => this.readSource(options, read))
					: await this.readSource(options, read);

				sources.push({location: read, text: text, notice: replacement?.notice});
			} catch(error) {
				sources.push({location: read, error: error, notice: replacement?.notice});
			}
		}

		return sources;
	}

	// For each member that no longer exists, the copy to read instead (or none), and every member found -
	// recorded or copy - with its change timestamp. Best effort: when a lookup here fails, every member is
	// read as recorded, as before there was a fallback, and none from cache.
	private async findMembers(options: DbConnections.CommonListOptions, members: ProgramSourceLocation[], context: ProgramQueries.ReadContext): Promise<{replacements: Map<ProgramSourceLocation, ProgramQueries.Replacement>; found: SourceMember[]}> {
		let replacements = new Map<ProgramSourceLocation, ProgramQueries.Replacement>();

		if(members.length === 0) {
			return {replacements: replacements, found: []};
		}

		try {
			let existing = await this.queryMembers(options, buildMemberExistsQuery(members.map(ProgramQueries.toMember)));
			let missing = members.filter(location => !existing.some(member => ProgramQueries.sameMember(member, ProgramQueries.toMember(location))));

			if(missing.length === 0) {
				return {replacements: replacements, found: existing};
			}

			let copies = await this.findMemberCopies(options, missing);
			let libraryList = (await this.extension.connections.getConnectionInfo(options))?.schemas.map(schema => schema.name) ?? [];

			for(let location of missing) {
				let candidates = copies.filter(copy => StringUtils.equalsIgnoreCase(copy.file, location.file) && StringUtils.equalsIgnoreCase(copy.member, location.member));
				let choice = chooseMemberCopy(candidates, {programLibrary: context.programLibrary, libraryList: libraryList});

				if(choice == null) {
					replacements.set(location, {});
					continue;
				}

				let changed = isChangedSince(choice.copy.lastChanged, location.compiled);

				replacements.set(location, {
					copy: {module: location.module, library: choice.copy.library, file: choice.copy.file, member: choice.copy.member, compiled: location.compiled},
					notice: {text: describeMemberCopy(location, choice, changed), severity: changed ? 'warning' : 'info'}
				});
			}

			return {replacements: replacements, found: [...existing, ...copies]};
		} catch(error) {
			if(!(error instanceof CatalogLookupError)) {
				throw error;
			}

			return {replacements: new Map(), found: []};
		}
	}

	// Two statements however many members are missing: the libraries holding each source file, then the
	// members in those.
	private async findMemberCopies(options: DbConnections.CommonListOptions, missing: ProgramSourceLocation[]): Promise<SourceMember[]> {
		let files = [...new Set(missing.map(location => (<string>location.file).toUpperCase()))];
		let holders = await runCatalogLookup(this.extension, {key: options.key, configId: options.configId, ...buildSourceFileLibrariesQuery(files), progressMessage: 'Finding source...'});

		let searches = missing.map(location => ({
			file: (<string>location.file).toUpperCase(),
			member: (<string>location.member).toUpperCase(),
			libraries: holders.filter(row => StringUtils.equalsIgnoreCase(ProgramQueries.read(row, 'OBJNAME'), location.file)).map(row => <string>ProgramQueries.read(row, 'OBJLIB'))
		})).filter(search => search.libraries.length > 0);

		return searches.length === 0 ? [] : this.queryMembers(options, buildMemberCopiesQuery(searches));
	}

	private async queryMembers(options: DbConnections.CommonListOptions, query: {sql: string; parameters: string[]}): Promise<SourceMember[]> {
		let rows = await runCatalogLookup(this.extension, {key: options.key, configId: options.configId, ...query, progressMessage: 'Finding source...'});

		return rows.map(row => ({
			library: <string>ProgramQueries.read(row, 'SYSTEM_TABLE_SCHEMA'),
			file: <string>ProgramQueries.read(row, 'SYSTEM_TABLE_NAME'),
			member: <string>ProgramQueries.read(row, 'SYSTEM_TABLE_MEMBER'),
			lastChanged: row['LAST_CHANGE_TIMESTAMP'] == null ? undefined : String(row['LAST_CHANGE_TIMESTAMP'])
		}));
	}

	private static toMember(location: ProgramSourceLocation): SourceMember {
		return {library: (<string>location.library).toUpperCase(), file: (<string>location.file).toUpperCase(), member: (<string>location.member).toUpperCase()};
	}

	private static sameMember(a: SourceMember, b: SourceMember): boolean {
		return StringUtils.equalsIgnoreCase(a.library, b.library) && StringUtils.equalsIgnoreCase(a.file, b.file) && StringUtils.equalsIgnoreCase(a.member, b.member);
	}

	/** One location's text, lines joined with newlines and trailing blanks trimmed from each. Throws a
	 * CatalogLookupError when it can't be read - e.g. the member was removed after the compile. */
	async readSource(options: DbConnections.CommonListOptions, location: ProgramSourceLocation): Promise<string> {
		if(location.streamFile != null) {
			let lines = await runCatalogLookup(this.extension, {
				key: options.key,
				configId: options.configId,
				sql: STREAM_FILE_READ_SQL,
				parameters: [location.streamFile],
				progressMessage: 'Reading source...'
			});

			return ProgramQueries.joinLines(lines, 'LINE');
		}

		let statements = buildMemberReadStatements(location, `WBSRC${++this.aliasSequence % 100000}`);
		let run = (sql: string) => runCatalogLookup(this.extension, {key: options.key, configId: options.configId, sql: sql, progressMessage: 'Reading source...'});

		await run(statements.create);

		try {
			return ProgramQueries.joinLines(await run(statements.select), 'SRCDTA');
		} finally {
			// Best effort - a leftover alias in QTEMP is harmless and ends with the job.
			await run(statements.drop).catch(() => undefined);
		}
	}

	private static joinLines(rows: Record<string, unknown>[], column: string): string {
		return rows.map(row => String(row[column] ?? '').trimEnd()).join('\n');
	}

	private static read(row: Record<string, unknown>, column: string): string | undefined {
		return StringUtils.trim(<string>row[column], {toUndefined: true});
	}
}

export namespace ProgramQueries {
	export interface ProgramOptions extends DbConnections.CommonListOptions {
		library: string;
		program: string;
		/** Defaults to *PGM - a trigger always runs a program. */
		objectType?: '*PGM' | '*SRVPGM';
	}

	export const TEMPORARY_SOURCE = 'Compiled from a temporary copy in QTEMP - the SQL precompiler\'s output, for example - which was '
		+ 'deleted when the compile job ended. The member it was made from is not recorded on the module.';

	export interface ReadContext {
		/** The library of the program the sources belong to - where a copy of a missing member is looked for first. */
		programLibrary?: string;
	}

	/** A member that no longer exists: the copy read in its place and what to say about it, or neither. */
	export interface Replacement {
		copy?: ProgramSourceLocation;
		notice?: Notice;
	}

	export interface Notice {
		text: string;
		/** A warning when the copy was changed after the compile, so it may not be what runs. */
		severity: 'info' | 'warning';
	}

	/** One location's text, or why it couldn't be read - a failed read, or one not attempted. */
	export interface ReadSource {
		/** What was read - a copy, when the recorded member was gone (see notice). */
		location: ProgramSourceLocation;
		text?: string;
		error?: unknown;
		unavailable?: string;
		notice?: Notice;
	}
}
