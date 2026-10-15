import { defineFakeDatabase } from '../fake-database.js';

/**
 * The default fixture: one user schema with three related tables plus a keyless one, one system
 * schema that isn't on the library list, and a procedure with an OUT parameter. Small enough to read in one screen, and
 * deliberately covers the cases that have caused real bugs:
 *
 * - columns whose system name and SQL name differ (ORDNO vs ORDER_NUMBER), which the results grid's
 *   heading labels, the diagram's column labels and the schema import mapping all turn on;
 * - a single-column foreign key between two tables, so the diagram's relationship lines and the
 *   Foreign Keys tab have something to render;
 * - a two-column foreign key (SHIPMENT -> ORDERS) referencing a unique rather than a primary key,
 *   with all four column names distinct, so the owning and referenced sides of the SYSCST/SYSKEYCST/
 *   SYSREFCST chain can't be confused for each other;
 * - a table with no key at all and a LOB column, which is what the Data tab's RRN row-keying and its
 *   LENGTH(...) placeholder select exist for;
 * - a schema off the library list, so "list every table" and "list this schema's tables" can't be
 *   confused for each other;
 * - a CALL with an OUT parameter, which is the only thing that exercises resolveProcedureOutParameters;
 * - a join view on the library list and a view in the off-list schema, so the view list has both of
 *   listTables' shapes to answer, and the Data tab has a keyless source it must not RRN();
 * - an overloaded scalar function (ORDER_TOTAL, two specific names), a table function with result
 *   columns, and an external function off the library list - so routine name and specific name can't be
 *   confused, and procedures and functions share one SYSROUTINES list without leaking into each other.
 *
 * Enough ORDERS rows to span more than one cursor batch at a small fetch size, so paging is testable
 * without a large fixture.
 */
export const SAMPLE_DATABASE = defineFakeDatabase({
	streamFiles: [
		{ path: '/home/src/ordaud02.rpgle', lines: ['**free', 'dcl-proc log;', 'end-proc;'] }
	],
	schemas: [
		{
			name: 'SALES',
			description: 'Sales data',
			tables: [
				{
					name: 'CUSTOMER',
					description: 'Customers',
					columns: [
						{ systemName: 'CUSTNO', sqlName: 'CUSTOMER_NUMBER', dataType: 'INTEGER', length: 4, heading: 'Cust No' },
						{ systemName: 'CUSTNM', sqlName: 'CUSTOMER_NAME', dataType: 'VARCHAR', length: 40, heading: 'Customer' },
						{ systemName: 'ACTIVE', sqlName: 'IS_ACTIVE', dataType: 'CHAR', length: 1, nulls: 'N' }
					],
					keys: [
						{ name: 'CUSTOMER_PK', type: 'PRIMARY KEY', columns: ['CUSTNO'] }
					],
					indexes: [
						{ name: 'CUSTOMER_PK', indexType: 'PRIMARY KEY', unique: 0, columnNames: 'CUSTNO' }
					],
					rows: [
						{ CUSTNO: 1, CUSTNM: 'Prairie Air', ACTIVE: 'Y' },
						{ CUSTNO: 2, CUSTNM: 'Example Air', ACTIVE: 'Y' },
						{ CUSTNO: 3, CUSTNM: 'Retired Charter', ACTIVE: 'N' }
					]
				},
				{
					name: 'ORDERS',
					description: 'Order headers',
					columns: [
						{ systemName: 'ORDNO', sqlName: 'ORDER_NUMBER', dataType: 'INTEGER', length: 4, heading: 'Order No' },
						{ systemName: 'CUSTNO', sqlName: 'CUSTOMER_NUMBER', dataType: 'INTEGER', length: 4, heading: 'Cust No' },
						{ systemName: 'ORDDT', sqlName: 'ORDER_DATE', dataType: 'DATE', length: 10 },
						{ systemName: 'ORDAMT', sqlName: 'ORDER_AMOUNT', dataType: 'DECIMAL', length: 11, scale: 2, precision: 11 }
					],
					keys: [
						{ name: 'ORDERS_PK', type: 'PRIMARY KEY', columns: ['ORDNO'] },
						// The unique key SHIPMENT's composite foreign key references.
						{ name: 'ORDERS_CUST_DATE_UK', type: 'UNIQUE', columns: ['CUSTNO', 'ORDDT'] }
					],
					foreignKeys: [
						{ name: 'ORDERS_CUSTOMER_FK', columns: ['CUSTNO'], referencedSchema: 'SALES', referencedTable: 'CUSTOMER', referencedColumns: ['CUSTNO'] }
					],
					indexes: [
						{ name: 'ORDERS_PK', indexType: 'PRIMARY KEY', unique: 0, columnNames: 'ORDNO' },
						{ name: 'ORDERS_BY_CUST', indexType: 'INDEX', unique: 2, columnNames: 'CUSTNO, ORDDT', owner: 'QSECOFR', comment: 'Lookup by customer' }
					],
					advisedIndexes: [
						{ keyColumnsAdvised: 'ORDDT', reasonAdvised: 'Ordering/Grouping', timesAdvised: 12 }
					],
					triggers: [
						// An external trigger - a native program, so no body - and an SQL one over two events,
						// which SYSTRIGGERS reports as MULTI with the events in their own flag columns.
						{ name: 'ORDERS_AUDIT_INSERT', event: 'INSERT', program: 'ORDAUDIT', programLibrary: 'SALES' },
						{
							name: 'ORDERS_STAMP', event: 'MULTI', events: ['INSERT', 'UPDATE'], timing: 'BEFORE', mode: 'DB2SQL', updateCondition: 'ALWAYS',
							condition: 'N.ORDAMT > 0', text: 'BEGIN\n\tSET N.ORDDT = CURRENT DATE;\nEND', description: 'Stamp the order date'
						}
					],
					rows: Array.from({ length: 25 }, (_unused, index) => ({
						ORDNO: 1000 + index,
						CUSTNO: (index % 3) + 1,
						ORDDT: '2026-02-01',
						ORDAMT: 100.5 + index
					}))
				},
				{
					// A two-column foreign key, referencing ORDERS' unique key rather than its primary key,
					// where no column name is shared with the column it points at and no system name is
					// shared with its own SQL name. That is deliberate: with ORDERS_CUSTOMER_FK alone
					// (CUSTNO -> CUSTNO, both spelled CUSTOMER_NUMBER) a foreign-key query that crossed the
					// owning and referenced sides over, or that lost the ordinal pairing between a
					// multi-column key's halves, would still produce exactly the right-looking rows. Every
					// name here is distinct, so it can't.
					name: 'SHIPMENT',
					description: 'Shipments against an order',
					columns: [
						{ systemName: 'SHPNO', sqlName: 'SHIPMENT_NUMBER', dataType: 'INTEGER', length: 4 },
						{ systemName: 'SHPCUS', sqlName: 'SHIPMENT_CUSTOMER', dataType: 'INTEGER', length: 4 },
						{ systemName: 'SHPDT', sqlName: 'SHIPMENT_ORDER_DATE', dataType: 'DATE', length: 10 },
						{ systemName: 'SHPCAR', sqlName: 'SHIPMENT_CARRIER', dataType: 'CHAR', length: 8 }
					],
					keys: [
						{ name: 'SHIPMENT_PK', type: 'PRIMARY KEY', columns: ['SHPNO'] }
					],
					foreignKeys: [
						{
							name: 'SHIPMENT_ORDERS_FK',
							columns: ['SHPCUS', 'SHPDT'],
							referencedSchema: 'SALES',
							referencedTable: 'ORDERS',
							referencedColumns: ['CUSTNO', 'ORDDT'],
							updateRule: 'RESTRICT',
							deleteRule: 'CASCADE'
						}
					],
					rows: []
				},
				{
					// No key of any kind, and a LOB column. Both are what the schema browser's Data tab
					// falls back on rather than what it normally does: a table with neither a primary key
					// nor a unique constraint has to key its rows by RRN() for an edit to target one row,
					// and a LOB column is selected as its length rather than its value. Neither path is
					// reachable against CUSTOMER/ORDERS/SHIPMENT, which all have a primary key.
					name: 'ORDNOTE',
					description: 'Free-text notes against an order',
					columns: [
						{ systemName: 'ORDNO', sqlName: 'ORDER_NUMBER', dataType: 'INTEGER', length: 4 },
						{ systemName: 'NOTETX', sqlName: 'NOTE_TEXT', dataType: 'CLOB', length: 1048576 },
						{ systemName: 'NOTEBY', sqlName: 'NOTE_AUTHOR', dataType: 'CHAR', length: 10 }
					],
					rows: [
						{ ORDNO: 1000, NOTETX: 'Call before delivery', NOTEBY: 'ORDCLERK' },
						{ ORDNO: 1001, NOTETX: 'Split shipment', NOTEBY: 'ORDCLERK' },
						{ ORDNO: 1002, NOTETX: 'Hold for credit check', NOTEBY: 'QSECOFR' }
					]
				},
				{
					// A materialized query table: a table in every catalog but SYSTABLES.TYPE, where it is 'M'
					// with its select in MQTDEF - which is what lists it under its own node in the schema tree
					// and gives it a Definition tab.
					name: 'CUSTTOT',
					description: 'Order totals by customer',
					mqtDefinition: 'SELECT CUSTNO, COUNT(*) AS ORDCNT FROM SALES.ORDERS GROUP BY CUSTNO',
					columns: [
						{ systemName: 'CUSTNO', sqlName: 'CUSTOMER_NUMBER', dataType: 'INTEGER', length: 4 },
						{ systemName: 'ORDCNT', sqlName: 'ORDER_COUNT', dataType: 'INTEGER', length: 4 }
					],
					rows: [
						{ CUSTNO: 1, ORDCNT: 2 },
						{ CUSTNO: 2, ORDCNT: 1 }
					]
				}
			],
			views: [
				{
					name: 'CUSTORD',
					description: 'Orders with customer names',
					definition: 'SELECT O.ORDNO, C.CUSTNM FROM SALES.ORDERS O JOIN SALES.CUSTOMER C ON C.CUSTNO = O.CUSTNO',
					columns: [
						{ systemName: 'ORDNO', sqlName: 'ORDER_NUMBER', dataType: 'INTEGER', length: 4 },
						{ systemName: 'CUSTNM', sqlName: 'CUSTOMER_NAME', dataType: 'VARCHAR', length: 40 }
					],
					rows: [
						{ ORDNO: 1000, CUSTNM: 'Prairie Air' },
						{ ORDNO: 1001, CUSTNM: 'Example Air' }
					]
				}
			],
			procedures: [
				{
					name: 'NEXT_ORDER_NUMBER',
					description: 'Reserves the next order number',
					definition: 'BEGIN SET OUT_ORDER_NUMBER = NEXT VALUE FOR SALES.ORDSEQ; END',
					parameters: [
						{ name: 'IN_PREFIX', mode: 'IN', dataType: 'CHAR', length: 3 },
						{ name: 'OUT_ORDER_NUMBER', mode: 'OUT', dataType: 'INTEGER', length: 4 }
					]
				},
				// Two overloads, told apart by parameter count, and named like a function - procedures and
				// functions are separate objects, so neither overloads the other.
				{
					name: 'ORDER_TOTAL',
					specificName: 'ORDER_TOTAL_RECALC',
					description: 'Recalculates the total of every open order',
					definition: 'BEGIN UPDATE SALES.ORDERS SET ORDTOT = SALES.ORDER_TOTAL(ORDNO); END',
					parameters: []
				},
				{
					name: 'ORDER_TOTAL',
					specificName: 'ORDER_TOTAL_RECALC1',
					description: 'Recalculates the total of one order',
					definition: 'BEGIN UPDATE SALES.ORDERS SET ORDTOT = SALES.ORDER_TOTAL(IN_ORDNO) WHERE ORDNO = IN_ORDNO; END',
					parameters: [{ name: 'IN_ORDNO', mode: 'IN', dataType: 'INTEGER', length: 4 }]
				},
				// An external procedure on a service program entry, returning result sets.
				{
					name: 'ORDER_HISTORY',
					body: 'EXTERNAL',
					language: 'RPGLE',
					externalName: 'SALES/ORDSRV(ORDHIST)',
					description: 'Order history for a customer',
					resultSets: 2,
					parameters: [{ name: 'IN_CUSTNO', mode: 'IN', dataType: 'CHAR', length: 8 }]
				},
				// An OPM program found through the library list, and a service program deleted since the
				// procedure was registered against it.
				{
					name: 'ORDER_REPORT',
					body: 'EXTERNAL',
					language: 'RPG',
					externalName: '*LIBL/ORDRPT',
					description: 'Prints the order report'
				},
				{
					name: 'ORDER_PURGE',
					body: 'EXTERNAL',
					language: 'RPGLE',
					externalName: 'OLDLIB/PURGESRV(PURGE)',
					description: 'Purges closed orders'
				},
				// A *LIBL program on no library-list schema - only a copy left in ARCHIVE, the way a test
				// copy lingers in a developer's own library.
				{
					name: 'ORDER_EXPORT',
					body: 'EXTERNAL',
					language: 'RPGLE',
					externalName: '*LIBL/ORDEXP',
					description: 'Exports orders'
				}
			],
			functions: [
				{
					name: 'ORDER_TOTAL',
					description: 'Total value of an order',
					definition: 'BEGIN RETURN (SELECT SUM(LINEAMT) FROM SALES.ORDLINE WHERE ORDNO = IN_ORDNO); END',
					parameters: [{ name: 'IN_ORDNO', dataType: 'INTEGER', length: 4 }],
					returns: { dataType: 'DECIMAL', precision: 11, scale: 2 }
				},
				{
					name: 'ORDER_TOTAL',
					specificName: 'ORDER_TOTAL_CURRENCY',
					description: 'Total value of an order in a currency',
					definition: 'BEGIN RETURN SALES.ORDER_TOTAL(IN_ORDNO); END',
					parameters: [
						{ name: 'IN_ORDNO', dataType: 'INTEGER', length: 4 },
						{ name: 'IN_CURRENCY', dataType: 'CHAR', length: 3 }
					],
					returns: { dataType: 'DECIMAL', precision: 11, scale: 2 }
				},
				{
					name: 'OPEN_ORDERS',
					functionType: 'T',
					description: 'Orders still open for a customer',
					definition: 'RETURN SELECT ORDNO, ORDDT FROM SALES.ORDERS WHERE CUSTNO = IN_CUSTNO',
					parameters: [{ name: 'IN_CUSTNO', dataType: 'CHAR', length: 8 }],
					resultColumns: [
						{ name: 'ORDNO', dataType: 'INTEGER', length: 4 },
						{ name: 'ORDDT', dataType: 'DATE', length: 4 }
					]
				}
			],
			// ORDERS_AUDIT_INSERT's program: one module per way a module's source can turn out - a member
			// that is there, an IFS file, and a member that has gone since the compile.
			programs: [
				{
					name: 'ORDAUDIT',
					type: 'ILE',
					modules: [
						{ name: 'ORDAUD01', sourceLibrary: 'SALES', sourceFile: 'QRPGLESRC', sourceMember: 'ORDAUD01' },
						{ name: 'ORDAUD02', streamFile: '/home/src/ordaud02.rpgle' },
						{ name: 'ORDAUD03', sourceLibrary: 'SALES', sourceFile: 'QRPGLESRC', sourceMember: 'ORDAUD03' }
					]
				},
				// ORDER_HISTORY's service program. Neither module is named like the ORDHIST entry, so the one
				// that defines it has to be found in the source.
				{
					name: 'ORDSRV',
					objectType: '*SRVPGM',
					type: 'ILE',
					modules: [
						{ name: 'ORDSRV01', sourceLibrary: 'SALES', sourceFile: 'QRPGLESRC', sourceMember: 'ORDSRV01' },
						{ name: 'ORDSRV02', sourceLibrary: 'SALES', sourceFile: 'QRPGLESRC', sourceMember: 'ORDSRV02' }
					]
				},
				// ORDER_REPORT's program, an OPM one.
				{
					name: 'ORDRPT',
					type: 'OPM',
					sourceLibrary: 'SALES',
					sourceFile: 'QRPGSRC',
					sourceMember: 'ORDRPT'
				}
			],
			sourceMembers: [
				{ file: 'QRPGLESRC', member: 'ORDAUD01', lines: ['**free', 'dcl-proc audit export;     ', 'end-proc;'] },
				{ file: 'QRPGLESRC', member: 'ORDSRV01', lines: ['**free', 'ctl-opt nomain;', 'dcl-proc formatDate export;', 'end-proc;'] },
				{ file: 'QRPGLESRC', member: 'ORDSRV02', lines: ['**free', 'ctl-opt nomain;', 'dcl-proc ordHist export;', 'end-proc;'] },
				{ file: 'QRPGSRC', member: 'ORDRPT', lines: ['     C                   SETON                    LR'] }
			]
		},
		{
			// Off the library list, so it only appears when asked for by name.
			name: 'ARCHIVE',
			description: 'Archived sales data',
			onLibraryList: false,
			tables: [
				{
					name: 'ORDERS2024',
					columns: [
						{ systemName: 'ORDNO', sqlName: 'ORDER_NUMBER', dataType: 'INTEGER', length: 4 }
					],
					rows: []
				}
			],
			// ORDER_EXPORT's stray copy, compiled from the SQL precompiler's temporary QTEMP output.
			programs: [
				{
					name: 'ORDEXP',
					type: 'ILE',
					modules: [{ name: 'ORDEXP', sourceLibrary: 'QTEMP', sourceFile: 'QSQLPRE', sourceMember: 'ORDEXP' }]
				}
			],
			views: [
				{
					name: 'ORDERS2024V',
					definition: 'SELECT ORDNO FROM ARCHIVE.ORDERS2024',
					columns: [
						{ systemName: 'ORDNO', sqlName: 'ORDER_NUMBER', dataType: 'INTEGER', length: 4 }
					]
				}
			],
			functions: [
				{
					name: 'ARCHIVE_DATE',
					body: 'EXTERNAL',
					language: 'RPGLE',
					externalName: 'ARCHIVE/ARCDATE(ARCDATE)',
					parameters: [{ name: 'IN_ORDNO', dataType: 'INTEGER', length: 4 }],
					returns: { dataType: 'DATE', length: 4 }
				}
			]
		}
	]
});
