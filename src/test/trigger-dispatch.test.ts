import * as assert from 'assert';
import { defineFakeDatabase } from '../database/drivers/fake/fake-database.js';
import { findEntrySource } from '../database/queries/program-source.js';
import { extension } from '../extension.js';
import { TestSupport } from './test-support.js';

/**
 * TriggerDispatchQueries against the fake driver - finding the program a dispatching trigger program
 * (Trigger Mediator, or a home-grown one) calls for a table, through the routing table it reads. As with
 * the other catalog tests, this proves the flow and the fixture's reading of the statements, not that
 * SYSPROGRAMSTMTSTAT/OBJECT_STATISTICS/PROGRAM_EXPORT_IMPORT_INFO accept this exact SQL live.
 */
const DATABASE = defineFakeDatabase({
	schemas: [
		{
			name: 'APP',
			tables: [
				{ name: 'PARTS', triggers: [{ name: 'PARTS_MED_UPDATE', event: 'UPDATE', program: 'TRGMED', programLibrary: 'APP' }] },
				{ name: 'BINS', triggers: [{ name: 'BINS_MED_INSERT', event: 'INSERT', program: 'TRGMED', programLibrary: 'APP' }] },
				{ name: 'PLAIN', triggers: [{ name: 'PLAIN_AUDIT', event: 'INSERT', program: 'PLAINTRG', programLibrary: 'APP' }] },
				// Written to by the dispatcher, and naming PARTS next to a real program - a log, not a routing table.
				{ name: 'TRGLOG', columns: [{ systemName: 'LGFILE' }, { systemName: 'LGPGM' }], rows: [{ LGFILE: 'PARTS', LGPGM: 'PLAINTRG' }] }
			],
			programs: [
				{
					name: 'TRGMED',
					modules: [{ name: 'TRGMED01', sourceLibrary: 'APP', sourceFile: 'QSRC', sourceMember: 'TRGMED01' }],
					statements: [
						'DECLARE C1 CURSOR FOR SELECT RTFILE , RTLIB , RTPGM , RTPGMLIB , RTPROC FROM RTCTL WHERE RTACT = \'Y\'',
						'OPEN C1',
						'INSERT INTO APP . TRGLOG ( LGFILE , LGPGM ) VALUES ( : H , : H )'
					]
				},
				{ name: 'PLAINTRG', modules: [{ name: 'PLAINTRG', sourceLibrary: 'APP', sourceFile: 'QSRC', sourceMember: 'PLAINTRG' }] },
				{
					name: 'PARTSRV',
					objectType: '*SRVPGM',
					exports: ['FORMATPART', 'PARTSERVICE'],
					modules: [
						{ name: 'PARTSRV01', sourceLibrary: 'APP', sourceFile: 'QSRC', sourceMember: 'PARTSRV01' },
						{ name: 'PARTSRV02', sourceLibrary: 'APP', sourceFile: 'QSRC', sourceMember: 'PARTSRV02' }
					]
				},
				{ name: 'BINPGM', modules: [{ name: 'BINPGM', sourceLibrary: 'APP', sourceFile: 'QSRC', sourceMember: 'BINPGM' }] }
			],
			sourceMembers: [
				{ file: 'QSRC', member: 'PARTSRV01', lines: ['**free', 'dcl-proc formatPart export;', 'end-proc;'] },
				{ file: 'QSRC', member: 'PARTSRV02', lines: ['**free', 'dcl-proc partService export;', 'end-proc;'] }
			]
		},
		{
			// The routing table lives in its own library, reached through the library list - the
			// dispatcher names it unqualified.
			name: 'CTL',
			tables: [
				{
					name: 'RTCTL',
					columns: [
						{ systemName: 'RTFILE' }, { systemName: 'RTLIB' }, { systemName: 'RTACT', length: 1 },
						{ systemName: 'RTPGM' }, { systemName: 'RTPGMLIB' }, { systemName: 'RTPROC', length: 50 },
						{ systemName: 'RTSTAMP', dataType: 'TIMESTAMP' }
					],
					rows: [
						{ RTFILE: 'PARTS     ', RTLIB: 'APP       ', RTACT: 'Y', RTPGM: 'PARTSRV   ', RTPGMLIB: 'APP       ', RTPROC: 'PARTSERVICE', RTSTAMP: '2026-01-01 08:00:00' },
						{ RTFILE: 'BINS      ', RTLIB: 'APP       ', RTACT: 'Y', RTPGM: 'BINPGM    ', RTPGMLIB: '*LIBL     ', RTPROC: '', RTSTAMP: '2026-01-01 08:00:00' },
						// Switched off: the dispatcher's own SQL only reads rows where RTACT = 'Y'.
						{ RTFILE: 'SHELVES   ', RTLIB: 'APP       ', RTACT: 'N', RTPGM: 'BINPGM    ', RTPGMLIB: 'APP       ', RTPROC: '', RTSTAMP: '2026-01-01 08:00:00' }
					]
				}
			]
		}
	]
});

suite('TriggerDispatchQueries against the fake driver', () => {
	let sequence = 0;
	let options = { key: '', configId: TestSupport.CONFIG_ID };

	setup(() => {
		options = { key: `test://trigger-dispatch-${++sequence}`, configId: TestSupport.CONFIG_ID };
		TestSupport.useDriver({ database: DATABASE });
	});

	suiteSetup(async () => {
		await TestSupport.activate();
	});

	teardown(async () => {
		await TestSupport.closeSessions(options.key);
		TestSupport.restoreDriver();
	});

	test('a dispatcher\'s routing row names the service program and the export it calls', async () => {
		let recorder = TestSupport.recordStatements({ database: DATABASE });
		let handlers = await extension.triggerDispatchQueries.findHandlers({ ...options, schema: 'APP', table: 'PARTS', programLibrary: 'APP', programName: 'TRGMED' });

		assert.deepStrictEqual(handlers, [{
			library: 'APP', object: 'PARTSRV', objectType: '*SRVPGM', entry: 'PARTSERVICE', score: 3, via: { schema: 'CTL', table: 'RTCTL' }
		}]);

		// The CHAR(1) flag can't hold the name, and binding it there fails the statement live (CWB0111).
		let [routing] = recorder.matching(/from "ctl"\."rtctl"/);
		assert.ok(routing, 'the routing table was read');
		assert.ok(!routing.normalized.includes('"rtact" = ?'), routing.normalized);
	});

	test('a *LIBL library in the routing row is resolved through the library list', async () => {
		let handlers = await extension.triggerDispatchQueries.findHandlers({ ...options, schema: 'APP', table: 'BINS', programLibrary: 'APP', programName: 'TRGMED' });

		assert.deepStrictEqual(handlers.map(handler => [handler.library, handler.object, handler.objectType, handler.entry]), [['APP', 'BINPGM', '*PGM', undefined]]);
	});

	test('a routing row the dispatcher\'s own SQL passes over still resolves, marked with the condition it fails', async () => {
		let recorder = TestSupport.recordStatements({ database: DATABASE });
		let handlers = await extension.triggerDispatchQueries.findHandlers({ ...options, schema: 'APP', table: 'SHELVES', programLibrary: 'APP', programName: 'TRGMED' });

		assert.deepStrictEqual(handlers.map(handler => [handler.library, handler.object, handler.unselected]), [['APP', 'BINPGM', { column: 'RTACT', value: 'Y', actual: 'N' }]]);

		// The flag is selected so it can be judged, but never compared to the table name.
		let [routing] = recorder.matching(/from "ctl"\."rtctl"/);
		assert.ok(routing.normalized.includes('"rtact"'), routing.normalized);
		assert.ok(!routing.normalized.includes('"rtact" = ?'), routing.normalized);
	});

	test('an ordinary trigger program dispatches nothing, and nothing past its statements is read', async () => {
		let recorder = TestSupport.recordStatements({ database: DATABASE });

		let handlers = await extension.triggerDispatchQueries.findHandlers({ ...options, schema: 'APP', table: 'PLAIN', programLibrary: 'APP', programName: 'PLAINTRG' });

		assert.deepStrictEqual(handlers, []);
		assert.strictEqual(recorder.matching(/sysprogramstmtstat/).length, 1);
		assert.strictEqual(recorder.matching(/object_statistics|syscolumns2/).length, 0);
	});

	test('the handler\'s source narrows to the module defining its entry', async () => {
		let [handler] = await extension.triggerDispatchQueries.findHandlers({ ...options, schema: 'APP', table: 'PARTS', programLibrary: 'APP', programName: 'TRGMED' });
		let locations = await extension.programQueries.listSourceLocations({ ...options, library: handler.library, program: handler.object, objectType: handler.objectType });
		let sources = await extension.programQueries.readSources(options, locations ?? []);

		let entry = findEntrySource(sources.map(source => ({ module: source.location.module, text: source.text })), <string>handler.entry, handler.object);

		assert.strictEqual(entry == null ? undefined : sources[entry].location.module, 'PARTSRV02');
	});
});
