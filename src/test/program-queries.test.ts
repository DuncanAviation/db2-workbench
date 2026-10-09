import * as assert from 'assert';
import { CatalogLookupError } from '../database/queries/catalog-lookup.js';
import { defineFakeDatabase } from '../database/drivers/fake/fake-database.js';
import { ProgramQueries } from '../database/queries/program-queries.js';
import { extension } from '../extension.js';
import { TestSupport } from './test-support.js';

/**
 * ProgramQueries against the fake driver - how an external trigger's program source is found and read.
 * As with the catalog queries (see memory-cache.test.ts), this proves the flow and the fixture's reading
 * of the statements, not that PROGRAM_INFO/BOUND_MODULE_INFO/IFS_READ accept this exact SQL live.
 */
suite('ProgramQueries against the fake driver', () => {
	// A fresh key per test: a closed key stays closed (see DbConnections.closedKeys), and teardown closes it.
	let sequence = 0;
	let options = { key: '', configId: TestSupport.CONFIG_ID };

	setup(() => {
		options = { key: `test://program-source-${++sequence}`, configId: TestSupport.CONFIG_ID };
	});

	suiteSetup(async () => {
		await TestSupport.activate();
	});

	teardown(async () => {
		await TestSupport.closeSessions(options.key);
		TestSupport.restoreDriver();
	});

	test('an ILE program lists one source per module, member or stream file', async () => {
		let locations = await extension.programQueries.listSourceLocations({ ...options, library: 'sales', program: 'ordaudit' });

		assert.deepStrictEqual(locations, [
			{ module: 'ORDAUD01', library: 'SALES', file: 'QRPGLESRC', member: 'ORDAUD01', compiled: '2026-01-01 08:00:00.000000' },
			{ module: 'ORDAUD02', streamFile: '/home/src/ordaud02.rpgle', compiled: '2026-01-01 08:00:00.000000' },
			{ module: 'ORDAUD03', library: 'SALES', file: 'QRPGLESRC', member: 'ORDAUD03', compiled: '2026-01-01 08:00:00.000000' }
		]);
	});

	test('a program the catalog does not know is reported as missing, not as having no sources', async () => {
		assert.strictEqual(await extension.programQueries.listSourceLocations({ ...options, library: 'SALES', program: 'NOPGM' }), undefined);
	});

	test('a member is read through a QTEMP alias that is dropped again, each line right-trimmed', async () => {
		let recorder = TestSupport.recordStatements();

		let text = await extension.programQueries.readSource(options, { module: 'ORDAUD01', library: 'SALES', file: 'QRPGLESRC', member: 'ORDAUD01' });

		assert.strictEqual(text, '**free\ndcl-proc audit export;\nend-proc;');
		assert.strictEqual(recorder.matching(/^create alias qtemp\./).length, 1);
		assert.strictEqual(recorder.matching(/^drop alias qtemp\./).length, 1);
	});

	test('a stream file is read with IFS_READ', async () => {
		let text = await extension.programQueries.readSource(options, { module: 'ORDAUD02', streamFile: '/home/src/ordaud02.rpgle' });

		assert.strictEqual(text, '**free\ndcl-proc log;\nend-proc;');
	});

	test('a member gone since the compile fails the read, and the alias is still dropped', async () => {
		let recorder = TestSupport.recordStatements();

		await assert.rejects(
			extension.programQueries.readSource(options, { module: 'ORDAUD03', library: 'SALES', file: 'QRPGLESRC', member: 'ORDAUD03' }),
			(error: unknown) => error instanceof CatalogLookupError
		);
		assert.strictEqual(recorder.matching(/^drop alias qtemp\./).length, 1);
	});

	test('a module compiled from a temporary QTEMP copy is not read, and says why', async () => {
		let recorder = TestSupport.recordStatements();
		let locations = await extension.programQueries.listSourceLocations({ ...options, library: 'ARCHIVE', program: 'ORDEXP' });

		let sources = await extension.programQueries.readSources(options, locations ?? []);

		assert.deepStrictEqual(sources, [{
			location: { module: 'ORDEXP', library: 'QTEMP', file: 'QSQLPRE', member: 'ORDEXP', compiled: '2026-01-01 08:00:00.000000' },
			unavailable: ProgramQueries.TEMPORARY_SOURCE
		}]);
		assert.strictEqual(recorder.matching(/^create alias qtemp\./).length, 0);
	});

	test('every user library holding a program is listed, on the library list or not', async () => {
		assert.deepStrictEqual(await extension.programQueries.listLibrariesHolding({ ...options, objectType: '*PGM', program: 'ordexp' }), ['ARCHIVE']);
		assert.deepStrictEqual(await extension.programQueries.listLibrariesHolding({ ...options, objectType: '*PGM', program: 'NOPGM' }), []);
	});

	// A service program compiled from a test library that was later cleaned up, with copies of the
	// member left in several libraries - the current one in the program's own library.
	suite('a member gone since the compile', () => {
		const DATABASE = defineFakeDatabase({
			schemas: [
				{
					name: 'PROD',
					onLibraryList: false,
					programs: [{
						name: 'SRV1',
						objectType: '*SRVPGM',
						modules: [
							{ name: 'SRV1A', sourceLibrary: 'DEVTEST', sourceFile: 'DBSOURCE', sourceMember: 'SRV1A', created: '2026-03-01 08:00:00.000000' },
							{ name: 'SRV1B', sourceLibrary: 'DEVTEST', sourceFile: 'DBSOURCE', sourceMember: 'SRV1B', created: '2026-03-01 08:00:00.000000' },
							{ name: 'SRV1C', sourceLibrary: 'PROD', sourceFile: 'DBSOURCE', sourceMember: 'SRV1C', created: '2026-03-01 08:00:00.000000' }
						]
					}],
					sourceMembers: [
						{ file: 'DBSOURCE', member: 'SRV1A', lines: ['**free', '// prod copy'], lastChanged: '2026-02-01 08:00:00.000000' },
						{ file: 'DBSOURCE', member: 'SRV1C', lines: ['**free', '// still where it was compiled'] }
					]
				},
				{
					name: 'PRODLIB',
					onLibraryList: false,
					sourceMembers: [
						{ file: 'DBSOURCE', member: 'SRV1A', lines: ['**free', '// git copy'], lastChanged: '2026-04-01 08:00:00.000000' }
					]
				}
			]
		});

		test('reads the copy in the program\'s own library, names the others, and says when nothing is left', async () => {
			let recorder = TestSupport.recordStatements({ database: DATABASE });
			let locations = await extension.programQueries.listSourceLocations({ ...options, library: 'PROD', program: 'SRV1', objectType: '*SRVPGM' });

			let sources = await extension.programQueries.readSources(options, locations ?? [], { programLibrary: 'PROD' });

			assert.deepStrictEqual(sources.map(source => [source.location.module, `${source.location.library}/${source.location.file}(${source.location.member})`, source.text, source.unavailable, source.notice?.severity]), [
				['SRV1A', 'PROD/DBSOURCE(SRV1A)', '**free\n// prod copy', undefined, 'info'],
				['SRV1B', 'DEVTEST/DBSOURCE(SRV1B)', undefined, 'Compiled from DEVTEST/DBSOURCE(SRV1B), which no longer exists, and no copy of that member was found in another library.', undefined],
				['SRV1C', 'PROD/DBSOURCE(SRV1C)', '**free\n// still where it was compiled', undefined, undefined]
			]);
			assert.match(sources[0].notice?.text ?? '', /Showing PROD\/DBSOURCE\(SRV1A\)\. Also found: PRODLIB\/DBSOURCE\(SRV1A\)\.$/);

			// One existence check for all three, one library search, one member search - and no read of a
			// member that isn't there, which would fail and land in the History tab.
			assert.strictEqual(recorder.matching(/syspartitionstat/).length, 2);
			assert.strictEqual(recorder.matching(/object_statistics\('\*allusr'/).length, 1);
			assert.strictEqual(recorder.matching(/^create alias qtemp\..* for "devtest"/).length, 0);
		});

		test('warns when the copy shown was changed after the module was compiled', async () => {
			TestSupport.useDriver({ database: DATABASE });
			let locations = await extension.programQueries.listSourceLocations({ ...options, library: 'PROD', program: 'SRV1', objectType: '*SRVPGM' });

			// Not the program's library, not on the library list: the most recently changed copy, PRODLIB's.
			let [source] = await extension.programQueries.readSources(options, locations ?? [], { programLibrary: 'ELSEWHERE' });

			assert.strictEqual(source.text, '**free\n// git copy');
			assert.strictEqual(source.notice?.severity, 'warning');
			assert.match(source.notice?.text ?? '', /Showing PRODLIB\/DBSOURCE\(SRV1A\)\. Changed since compile\. Also found: PROD\/DBSOURCE\(SRV1A\)\.$/);
		});
	});

	// A session keeps the driver its connection opened with, so a member edited between two reads is
	// modelled as a second session, on the same connection config, opened against a changed fixture. The
	// first stays open so the cache they share isn't dropped in between (see DbConnections.close).
	suite('a member\'s text is cached while its change timestamp holds', () => {
		let other = { key: '', configId: TestSupport.CONFIG_ID };

		setup(() => {
			other = { key: `${options.key}-other`, configId: TestSupport.CONFIG_ID };
		});

		teardown(async () => {
			await TestSupport.closeSessions(other.key);
		});

		const database = (lines: string[], lastChanged: string) => defineFakeDatabase({
			schemas: [{
				name: 'CACHED',
				onLibraryList: false,
				programs: [{
					name: 'SRV2',
					objectType: '*SRVPGM',
					modules: [{ name: 'SRV2A', sourceLibrary: 'CACHED', sourceFile: 'QRPGLESRC', sourceMember: 'SRV2A' }]
				}],
				sourceMembers: [{ file: 'QRPGLESRC', member: 'SRV2A', lines: lines, lastChanged: lastChanged }]
			}]
		});

		const read = async (session: typeof options) => {
			let locations = await extension.programQueries.listSourceLocations({ ...session, library: 'CACHED', program: 'SRV2', objectType: '*SRVPGM' });
			return (await extension.programQueries.readSources(session, locations ?? []))[0];
		};

		test('an unchanged member is not read again', async () => {
			TestSupport.recordStatements({ database: database(['// first'], '2026-05-01 08:00:00.000000') });
			assert.strictEqual((await read(options)).text, '// first');

			// Same timestamp, different lines: only a cache hit can still show the first text.
			let recorder = TestSupport.recordStatements({ database: database(['// second'], '2026-05-01 08:00:00.000000') });
			assert.strictEqual((await read(other)).text, '// first');
			assert.strictEqual(recorder.matching(/syspartitionstat/).length, 1);
			assert.strictEqual(recorder.matching(/^create alias qtemp\./).length, 0);
		});

		test('a member changed since it was cached is read again', async () => {
			TestSupport.recordStatements({ database: database(['// first'], '2026-05-01 08:00:00.000000') });
			assert.strictEqual((await read(options)).text, '// first');

			let recorder = TestSupport.recordStatements({ database: database(['// second'], '2026-05-02 08:00:00.000000') });
			assert.strictEqual((await read(other)).text, '// second');
			assert.strictEqual(recorder.matching(/^create alias qtemp\./).length, 1);
		});

		test('a failed read is not cached', async () => {
			TestSupport.recordStatements({
				database: database(['// first'], '2026-05-01 08:00:00.000000'),
				responses: [{ match: /^select srcdta from qtemp\./i, error: { message: 'read failed' } }]
			});
			assert.ok((await read(options)).error instanceof CatalogLookupError);

			let recorder = TestSupport.recordStatements({ database: database(['// first'], '2026-05-01 08:00:00.000000') });
			assert.strictEqual((await read(other)).text, '// first');
			assert.strictEqual(recorder.matching(/^create alias qtemp\./).length, 1);
		});

		test('a stream file is read every time', async () => {
			TestSupport.recordStatements();
			await extension.programQueries.readSources(options, [{ module: 'ORDAUD02', streamFile: '/home/src/ordaud02.rpgle' }]);

			let recorder = TestSupport.recordStatements();
			let [source] = await extension.programQueries.readSources(other, [{ module: 'ORDAUD02', streamFile: '/home/src/ordaud02.rpgle' }]);
			assert.strictEqual(source.text, '**free\ndcl-proc log;\nend-proc;');
			assert.strictEqual(recorder.matching(/ifs_read/).length, 1);
		});
	});
});
