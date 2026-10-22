import { Parameter } from '../../../interfaces/parameter.js';
import { Nullable } from '../../../utils/nullable.js';
import { StringUtils } from '../../../utils/string-utils.js';
import { CatalogResponder } from './catalog-responder.js';
import { FakeDatabase } from './fake-database.js';
import { FakeDriver } from './fake-driver.js';

/**
 * One job's library list. A real session has two jobs (the main and the worker connection), each with a
 * library list of its own that only a command run on that job changes - so every FakeDriverConnection
 * keeps one of these, and a test asserting that a change reached "both jobs" is asserting something.
 *
 * It starts from the fixture's onLibraryList schemas, answers QSYS2.LIBRARY_LIST_INFO, and applies the
 * library commands that reach it through QSYS2.QCMDEXC - as a CALL (which throws on a failed command, the
 * way the procedure does) or as the scalar function (which returns -1 and leaves the list alone, as
 * verified live). CHGLIBL, ADDLIBLE and RMVLIBLE are understood; any other command throws, since a fake
 * that quietly accepted one would assert against nothing.
 */
export class FakeLibraryList {
	private entries: FakeLibraryList.Entry[];

	constructor(private database: FakeDatabase) {
		this.entries = database.schemas
			.filter(schema => schema.onLibraryList)
			.map(schema => ({ name: schema.name, type: schema.type === 'System' ? 'SYSTEM' : 'USER', description: schema.description }));
	}

	/** LIBRARY_LIST_INFO's rows for this job, in list order. */
	rows(): Record<string, unknown>[] {
		return this.entries.map((entry, index) => ({
			ORDINAL_POSITION: index + 1,
			SYSTEM_SCHEMA_NAME: entry.name,
			TYPE: entry.type,
			TEXT_DESCRIPTION: entry.description
		}));
	}

	/** The rows for `sql`, or undefined when it is neither a library list read nor a QCMDEXC. */
	respond(sql: string, parameters?: Array<Parameter>): Nullable<Record<string, unknown>[]> {
		let normalized = CatalogResponder.normalize(sql);

		if(normalized.includes('qsys2.library_list_info')) {
			return this.rows();
		}

		if(!/\bqcmdexc\s*\(/.test(normalized)) {
			return undefined;
		}

		let command = typeof parameters?.[0] === 'string'
			? parameters[0]
			: /\bqcmdexc\s*\(\s*'((?:[^']|'')*)'/i.exec(sql)?.[1]?.replace(/''/g, '\'');

		if(command == null) {
			throw FakeDriver.toError({ message: `FakeDriver: no command text in ${normalized}` });
		}

		if(!normalized.startsWith('values') && !normalized.startsWith('select')) {
			this.run(command);
			return [];
		}

		try {
			this.run(command);
			return [{ '00001': 1 }];
		} catch {
			return [{ '00001': -1 }];
		}
	}

	private run(command: string): void {
		let parts = /^\s*([A-Z]+)\b(.*)$/i.exec(command);
		let name = parts?.[1]?.toUpperCase();
		let rest = parts?.[2] ?? '';

		if(name === 'CHGLIBL') {
			let libraries = (FakeLibraryList.keyword(rest, 'LIBL') ?? '').split(/\s+/).filter(library => StringUtils.isNotBlank(library)).map(library => library.toUpperCase());
			libraries = libraries.length === 1 && libraries[0] === '*NONE' ? [] : libraries;
			libraries.forEach(library => this.checkExists(library));
			this.entries = [...this.entries.filter(entry => entry.type !== 'USER'), ...libraries.map(library => this.toEntry(library))];
		} else if(name === 'ADDLIBLE') {
			let library = this.readLibrary(rest);

			if(this.entries.some(entry => entry.name === library)) {
				throw FakeLibraryList.cpfError('CPF2103', `Library ${library} already exists in library list.`);
			}

			let position = (FakeLibraryList.keyword(rest, 'POSITION') ?? '*FIRST').toUpperCase();
			let firstUser = this.entries.findIndex(entry => entry.type === 'USER');
			let index = position === '*LAST' || firstUser < 0 ? this.entries.length : firstUser;
			this.entries.splice(index, 0, this.toEntry(library));
		} else if(name === 'RMVLIBLE') {
			let library = this.readLibrary(rest);
			let index = this.entries.findIndex(entry => entry.name === library && entry.type === 'USER');

			if(index < 0) {
				throw FakeLibraryList.cpfError('CPF2104', `Library ${library} not removed from the library list.`);
			}

			this.entries.splice(index, 1);
		} else {
			throw FakeDriver.toError({ message: `FakeDriver: no fixture response for the CL command ${command}` });
		}
	}

	private readLibrary(rest: string): string {
		let library = (FakeLibraryList.keyword(rest, 'LIB') ?? '').trim().toUpperCase();
		this.checkExists(library);
		return library;
	}

	// QTEMP exists in every job; anything else has to be a schema the fixture declares.
	private checkExists(library: string): void {
		if(library !== 'QTEMP' && !this.database.schemas.some(schema => schema.name === library)) {
			throw FakeLibraryList.cpfError('CPF2110', `Library ${library} not found.`);
		}
	}

	private toEntry(library: string): FakeLibraryList.Entry {
		let schema = this.database.schemas.find(candidate => candidate.name === library);
		return { name: library, type: 'USER', description: schema?.description ?? '' };
	}

	private static keyword(text: string, keyword: string): Nullable<string> {
		return new RegExp(`\\b${keyword}\\s*\\(([^)]*)\\)`, 'i').exec(text)?.[1];
	}

	// The shape a failed QCMDEXC takes through node-odbc: SQL0443, with the CPF message as its text.
	private static cpfError(messageId: string, text: string): Error {
		let message = `${messageId} ${text}`;

		return FakeDriver.toError({
			message: `[IBM][System i Access ODBC Driver][DB2 for i5/OS]SQL0443 - ${message}`,
			driverErrors: [{ code: -443, state: '38501', message: `[IBM][System i Access ODBC Driver][DB2 for i5/OS]SQL0443 - ${message}` }]
		});
	}
}

export namespace FakeLibraryList {
	export interface Entry {
		name: string;
		/** LIBRARY_LIST_INFO.TYPE - SYSTEM or USER here (the fixture declares no product or current library). */
		type: string;
		description: string;
	}
}
