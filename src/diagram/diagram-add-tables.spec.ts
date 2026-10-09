import { expect } from 'chai';
import { DiagramColumn, DiagramModel } from '../webview-messages/diagram-messages.js';
import { addTables, filterSyncResolve, rearrangeTables, ResolvedForeignKey, ResolvedTable, syncTables, tableHeight, updateTables } from './diagram-add-tables.js';

function column(name: string, options: Partial<DiagramColumn> = {}): DiagramColumn {
	return {name: name, type: 'CHAR(10)', primaryKey: false, foreignKey: false, identity: false, notNull: false, unique: false, indexed: false, ...options};
}

function resolved(schema: string, table: string, options: Partial<ResolvedTable> = {}): ResolvedTable {
	return {schema: schema, table: table, columns: [column('ID', {primaryKey: true})], foreignKeys: [], ...options};
}

function emptyModel(): DiagramModel {
	return {schemas: [], tables: [], relationships: []};
}

function positionOf(model: DiagramModel, name: string): {x: number; y: number} {
	let table = model.tables.find(candidate => candidate.name === name);

	if(!table) {
		throw new Error(`table ${name} not found on the diagram`);
	}

	return table.position;
}

describe('diagram-add-tables', () => {
	it('creates a schema group for a table whose schema is not on the diagram yet', async () => {
		let model = emptyModel();

		let edit = await addTables(model, [resolved('HR', 'EMPLOYEE')]);

		expect(edit).to.not.be.undefined;
		expect(model.schemas).to.have.lengthOf(1);
		expect(model.schemas[0].id).to.equal('HR');
		expect(model.schemas[0].name).to.equal('HR');
		expect(model.tables.map(table => table.id)).to.deep.equal(['HR.EMPLOYEE']);
		expect(model.tables[0].schemaId).to.equal('HR');
	});

	it('carries uniqueKeys and indexes onto the placed table', async () => {
		let model = emptyModel();

		await addTables(model, [resolved('HR', 'EMPLOYEE', {
			uniqueKeys: [{name: 'UQ_BADGE', columns: ['BADGE']}],
			indexes: [{name: 'IDX_NAME', columns: ['NAME'], unique: false}]
		})]);

		expect(model.tables[0].uniqueKeys).to.deep.equal([{name: 'UQ_BADGE', columns: ['BADGE']}]);
		expect(model.tables[0].indexes).to.deep.equal([{name: 'IDX_NAME', columns: ['NAME'], unique: false}]);
	});

	it('omits uniqueKeys and indexes on a placed table that has neither', async () => {
		let model = emptyModel();

		await addTables(model, [resolved('HR', 'EMPLOYEE')]);

		expect(model.tables[0]).to.not.have.property('uniqueKeys');
		expect(model.tables[0]).to.not.have.property('indexes');
	});

	it('sizes the new schema group to contain the table it was created for', async () => {
		let model = emptyModel();

		await addTables(model, [resolved('HR', 'EMPLOYEE')]);

		let bounds = model.schemas[0].bounds;
		let table = model.tables[0];

		expect(bounds.width).to.be.greaterThan(0);
		expect(bounds.height).to.be.greaterThan(0);
		expect(table.position.x).to.be.greaterThan(bounds.x);
		expect(table.position.y).to.be.greaterThan(bounds.y);
		expect(table.position.x).to.be.lessThan(bounds.x + bounds.width);
		expect(table.position.y).to.be.lessThan(bounds.y + bounds.height);
	});

	it('gives a second new schema group its own color and places it clear of the first', async () => {
		let model = emptyModel();

		await addTables(model, [resolved('HR', 'EMPLOYEE'), resolved('SALES', 'ORDER')]);

		let [hr, sales] = model.schemas;

		expect(model.schemas).to.have.lengthOf(2);
		expect(sales.color).to.not.equal(hr.color);
		expect(sales.bounds.x).to.be.greaterThanOrEqual(hr.bounds.x + hr.bounds.width);
	});

	it('reuses an existing schema group and places new tables below the ones already in it', async () => {
		let model: DiagramModel = {
			schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
			tables: [{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID')]}],
			relationships: []
		};

		await addTables(model, [resolved('HR', 'DEPARTMENT')]);

		expect(model.schemas).to.have.lengthOf(1);
		expect(model.tables).to.have.lengthOf(2);
		expect(model.tables[1].position.y).to.be.greaterThan(model.tables[0].position.y);
	});

	it('grows an existing schema group so a table placed below its old bottom edge is still inside it', async () => {
		let model: DiagramModel = {
			schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 200}}],
			tables: [{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID')]}],
			relationships: []
		};

		await addTables(model, [resolved('HR', 'DEPARTMENT')]);

		let bounds = model.schemas[0].bounds;
		let added = model.tables[1];

		expect(bounds.height).to.be.greaterThan(200);
		expect(added.position.y).to.be.lessThan(bounds.y + bounds.height);
	});

	it('never shrinks a schema group the user has already resized larger', async () => {
		let model: DiagramModel = {
			schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 2000, height: 1500}}],
			tables: [],
			relationships: []
		};

		await addTables(model, [resolved('HR', 'EMPLOYEE')]);

		expect(model.schemas[0].bounds).to.deep.equal({x: 0, y: 0, width: 2000, height: 1500});
	});

	it('does not overlap any two tables in a larger unconnected batch', async () => {
		let model = emptyModel();
		let tables = ['A', 'B', 'C', 'D'].map(name => resolved('HR', name));

		await addTables(model, tables);

		let rects = model.tables.map(table => ({
			left: table.position.x,
			top: table.position.y,
			right: table.position.x + 390,
			bottom: table.position.y + tableHeight(table.columns.length)
		}));

		for(let i = 0; i < rects.length; i++) {
			for(let j = i + 1; j < rects.length; j++) {
				let overlapsX = rects[i].left < rects[j].right && rects[j].left < rects[i].right;
				let overlapsY = rects[i].top < rects[j].bottom && rects[j].top < rects[i].bottom;

				expect(overlapsX && overlapsY, `${tables[i].table} and ${tables[j].table} overlap`).to.be.false;
			}
		}
	});

	// Verifies actual geometry now that layoutTables (ELK) decides it, not array order the way the old
	// orderForLocality's grid-fill sequence used to. Anchoring a new table near a SPECIFIC EXISTING
	// sibling (rather than just among its own new batch) needs layoutTables to know about existing
	// positions at all - pinned/fixed-node layout it deliberately doesn't support yet (see placeTables'
	// own comment in diagram-add-tables.ts) - so that narrower case isn't covered here; relationship
	// correctness for it is still covered by the "draws a relationship..." tests further down.
	describe('placement locality', () => {
		it('lands two foreign-key-connected new tables on the same row, unlike an unrelated one', async () => {
			let model = emptyModel();

			await addTables(model, [
				resolved('HR', 'X'),
				resolved('HR', 'EMPLOYEE', {
					columns: [column('DEPTID', {foreignKey: true})],
					foreignKeys: [{fromColumn: 'DEPTID', toSchema: 'HR', toTable: 'DEPARTMENT', toColumn: 'ID'}]
				}),
				resolved('HR', 'Y'),
				resolved('HR', 'DEPARTMENT')
			]);

			let employee = positionOf(model, 'EMPLOYEE');
			let department = positionOf(model, 'DEPARTMENT');
			let x = positionOf(model, 'X');

			// ELK's layered algorithm places a connected pair in adjacent layers along the same row - a
			// direct, short edge between them - while an unconnected table is free to land anywhere,
			// including (by chance) nearer by raw distance than the actual connected pair. Same-row
			// adjacency, not nearest-neighbor distance, is what "layered" actually guarantees here.
			expect(department.y).to.equal(employee.y);
			expect(x.y).to.not.equal(employee.y);
		});

		it('leaves an unconnected batch in its original order', async () => {
			let model = emptyModel();

			await addTables(model, ['A', 'B', 'C'].map(name => resolved('HR', name)));

			expect(model.tables.map(table => table.name)).to.deep.equal(['A', 'B', 'C']);
		});

		it('places a new table beside an existing sibling it has a foreign key to, instead of below everything', async () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 1200, height: 300}}],
				tables: [{id: 'HR.DEPARTMENT', schemaId: 'HR', name: 'DEPARTMENT', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true})]}],
				relationships: []
			};

			await addTables(model, [resolved('HR', 'EMPLOYEE', {
				columns: [column('DEPTID', {foreignKey: true})],
				foreignKeys: [{fromColumn: 'DEPTID', toSchema: 'HR', toTable: 'DEPARTMENT', toColumn: 'ID'}]
			})]);

			let employee = positionOf(model, 'EMPLOYEE');
			let department = positionOf(model, 'DEPARTMENT');

			expect(employee.y).to.equal(department.y);
			expect(employee.x).to.be.greaterThan(department.x);
		});

		// The other direction: nothing in the NEW table's own foreignKeys points at the sibling - it's the
		// sibling ALREADY on the diagram whose key points at it, the same inbound case buildRelationships
		// draws an edge for.
		it('places a new table beside an existing sibling that points at it', async () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 1200, height: 300}}],
				tables: [{id: 'HR.MANAGER', schemaId: 'HR', name: 'MANAGER', position: {x: 40, y: 60}, columns: [column('TEAM_ID', {foreignKey: true})]}],
				relationships: []
			};
			let existing = new Map<string, ResolvedForeignKey[]>([
				['HR.MANAGER', [{fromColumn: 'TEAM_ID', toSchema: 'HR', toTable: 'TEAM', toColumn: 'ID'}]]
			]);

			await addTables(model, [resolved('HR', 'TEAM', {columns: [column('ID', {primaryKey: true})]})], existing);

			let manager = positionOf(model, 'MANAGER');
			let team = positionOf(model, 'TEAM');

			expect(team.y).to.equal(manager.y);
			expect(team.x).to.be.greaterThan(manager.x);
		});

		it('falls back to placing below everything when the spot beside the anchor is already occupied', async () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 1200, height: 300}}],
				tables: [
					{id: 'HR.DEPARTMENT', schemaId: 'HR', name: 'DEPARTMENT', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true})]},
					// Sits exactly where "beside DEPARTMENT" would land the new EMPLOYEE table.
					{id: 'HR.BLOCKER', schemaId: 'HR', name: 'BLOCKER', position: {x: 470, y: 60}, columns: [column('ID')]}
				],
				relationships: []
			};

			await addTables(model, [resolved('HR', 'EMPLOYEE', {
				columns: [column('DEPTID', {foreignKey: true})],
				foreignKeys: [{fromColumn: 'DEPTID', toSchema: 'HR', toTable: 'DEPARTMENT', toColumn: 'ID'}]
			})]);

			let employee = positionOf(model, 'EMPLOYEE');
			let blocker = positionOf(model, 'BLOCKER');

			// Below the tallest existing sibling's bottom edge, same as an anchorless add.
			expect(employee.y).to.be.greaterThan(blocker.y);
		});
	});

	it('draws a relationship between two tables added in the same batch', async () => {
		let model = emptyModel();

		await addTables(model, [
			resolved('HR', 'EMPLOYEE', {
				columns: [column('ID', {primaryKey: true}), column('DEPTID', {foreignKey: true})],
				foreignKeys: [{fromColumn: 'DEPTID', toSchema: 'HR', toTable: 'DEPARTMENT', toColumn: 'ID'}]
			}),
			resolved('HR', 'DEPARTMENT')
		]);

		expect(model.relationships).to.have.lengthOf(1);
		expect(model.relationships[0].fromTable).to.equal('HR.EMPLOYEE');
		expect(model.relationships[0].fromColumn).to.equal('DEPTID');
		expect(model.relationships[0].toTable).to.equal('HR.DEPARTMENT');
		expect(model.relationships[0].toColumn).to.equal('ID');
	});

	it('draws a relationship to a table that was already on the diagram', async () => {
		let model: DiagramModel = {
			schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
			tables: [{id: 'HR.DEPARTMENT', schemaId: 'HR', name: 'DEPARTMENT', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true})]}],
			relationships: []
		};

		await addTables(model, [resolved('HR', 'EMPLOYEE', {
			columns: [column('DEPTID', {foreignKey: true})],
			foreignKeys: [{fromColumn: 'DEPTID', toSchema: 'HR', toTable: 'DEPARTMENT', toColumn: 'ID'}]
		})]);

		expect(model.relationships).to.have.lengthOf(1);
		expect(model.relationships[0].toTable).to.equal('HR.DEPARTMENT');
	});

	// The missing-FK-target marker flow lands here: the key belongs to a table already on the diagram,
	// and the table being added is the one it points AT. Only considering the new table's own keys
	// misses this case entirely, which showed up as "the table appears but no line is drawn".
	it('draws a relationship for a foreign key declared by a table already on the diagram', async () => {
		let model: DiagramModel = {
			schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
			tables: [{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('GRADE_CODE', {foreignKey: true})]}],
			relationships: []
		};
		let existing = new Map<string, ResolvedForeignKey[]>([
			['HR.EMPLOYEE', [{fromColumn: 'GRADE_CODE', toSchema: 'PAY', toTable: 'GRADE', toColumn: 'GRADE_CODE'}]]
		]);

		await addTables(model, [resolved('PAY', 'GRADE', {columns: [column('GRADE_CODE', {primaryKey: true})]})], existing);

		expect(model.relationships).to.have.lengthOf(1);
		expect(model.relationships[0].fromTable).to.equal('HR.EMPLOYEE');
		expect(model.relationships[0].fromColumn).to.equal('GRADE_CODE');
		expect(model.relationships[0].toTable).to.equal('PAY.GRADE');
		expect(model.relationships[0].toColumn).to.equal('GRADE_CODE');
	});

	it('draws relationships in both directions in one add', async () => {
		let model: DiagramModel = {
			schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
			tables: [{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true}), column('DEPARTMENT_ID', {foreignKey: true})]}],
			relationships: []
		};
		let existing = new Map<string, ResolvedForeignKey[]>([
			['HR.EMPLOYEE', [{fromColumn: 'DEPARTMENT_ID', toSchema: 'HR', toTable: 'DEPARTMENT', toColumn: 'ID'}]]
		]);

		// DEPARTMENT is referenced BY employee and itself references employee back.
		await addTables(model, [resolved('HR', 'DEPARTMENT', {
			columns: [column('ID', {primaryKey: true}), column('MANAGER_ID', {foreignKey: true})],
			foreignKeys: [{fromColumn: 'MANAGER_ID', toSchema: 'HR', toTable: 'EMPLOYEE', toColumn: 'ID'}]
		})], existing);

		expect(model.relationships.map(relationship => relationship.id)).to.deep.equal([
			'HR.DEPARTMENT.MANAGER_ID->HR.EMPLOYEE.ID',
			'HR.EMPLOYEE.DEPARTMENT_ID->HR.DEPARTMENT.ID'
		]);
	});

	// Widening the inbound pass to every target would make an add quietly draw edges between two tables
	// that were both already sitting on the diagram, and put them in this edit's undo step.
	it('does not draw an inbound relationship between two tables that were both already on the diagram', async () => {
		let model: DiagramModel = {
			schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
			tables: [
				{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('DEPARTMENT_ID', {foreignKey: true})]},
				{id: 'HR.DEPARTMENT', schemaId: 'HR', name: 'DEPARTMENT', position: {x: 40, y: 200}, columns: [column('ID', {primaryKey: true})]}
			],
			relationships: []
		};
		let existing = new Map<string, ResolvedForeignKey[]>([
			['HR.EMPLOYEE', [{fromColumn: 'DEPARTMENT_ID', toSchema: 'HR', toTable: 'DEPARTMENT', toColumn: 'ID'}]]
		]);

		await addTables(model, [resolved('HR', 'JOB')], existing);

		expect(model.relationships).to.be.empty;
	});

	it('does not duplicate an inbound relationship that is already on the diagram', async () => {
		let model: DiagramModel = {
			schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
			tables: [{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('GRADE_CODE', {foreignKey: true})]}],
			relationships: [{id: 'HR.EMPLOYEE.GRADE_CODE->PAY.GRADE.GRADE_CODE', fromTable: 'HR.EMPLOYEE', fromColumn: 'GRADE_CODE', toTable: 'PAY.GRADE', toColumn: 'GRADE_CODE'}]
		};
		let existing = new Map<string, ResolvedForeignKey[]>([
			['HR.EMPLOYEE', [{fromColumn: 'GRADE_CODE', toSchema: 'PAY', toTable: 'GRADE', toColumn: 'GRADE_CODE'}]]
		]);

		await addTables(model, [resolved('PAY', 'GRADE', {columns: [column('GRADE_CODE', {primaryKey: true})]})], existing);

		expect(model.relationships).to.have.lengthOf(1);
	});

	it('skips an inbound foreign key naming a column the new table does not have', async () => {
		let model: DiagramModel = {
			schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
			tables: [{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('GRADE_CODE', {foreignKey: true})]}],
			relationships: []
		};
		let existing = new Map<string, ResolvedForeignKey[]>([
			['HR.EMPLOYEE', [{fromColumn: 'GRADE_CODE', toSchema: 'PAY', toTable: 'GRADE', toColumn: 'MISSING'}]]
		]);

		await addTables(model, [resolved('PAY', 'GRADE', {columns: [column('GRADE_CODE', {primaryKey: true})]})], existing);

		expect(model.relationships).to.be.empty;
	});

	it('undoes an inbound relationship along with the rest of the batch', async () => {
		let model: DiagramModel = {
			schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
			tables: [{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('GRADE_CODE', {foreignKey: true})]}],
			relationships: []
		};
		let before = JSON.parse(JSON.stringify(model));
		let existing = new Map<string, ResolvedForeignKey[]>([
			['HR.EMPLOYEE', [{fromColumn: 'GRADE_CODE', toSchema: 'PAY', toTable: 'GRADE', toColumn: 'GRADE_CODE'}]]
		]);

		let edit = await addTables(model, [resolved('PAY', 'GRADE', {columns: [column('GRADE_CODE', {primaryKey: true})]})], existing);
		edit?.undo();

		expect(model).to.deep.equal(before);
	});

	it('skips a foreign key whose referenced table is not on the diagram', async () => {
		let model = emptyModel();

		await addTables(model, [resolved('HR', 'EMPLOYEE', {
			columns: [column('DEPTID', {foreignKey: true})],
			foreignKeys: [{fromColumn: 'DEPTID', toSchema: 'HR', toTable: 'DEPARTMENT', toColumn: 'ID'}]
		})]);

		expect(model.relationships).to.be.empty;
	});

	it('skips a foreign key whose referenced column is not among the target table columns', async () => {
		let model = emptyModel();

		await addTables(model, [
			resolved('HR', 'EMPLOYEE', {
				columns: [column('DEPTID', {foreignKey: true})],
				foreignKeys: [{fromColumn: 'DEPTID', toSchema: 'HR', toTable: 'DEPARTMENT', toColumn: 'MISSING'}]
			}),
			resolved('HR', 'DEPARTMENT')
		]);

		expect(model.relationships).to.be.empty;
	});

	it('does not duplicate a relationship that is already on the diagram', async () => {
		let model: DiagramModel = {
			schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
			tables: [{id: 'HR.DEPARTMENT', schemaId: 'HR', name: 'DEPARTMENT', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true})]}],
			relationships: [{id: 'HR.EMPLOYEE.DEPTID->HR.DEPARTMENT.ID', fromTable: 'HR.EMPLOYEE', fromColumn: 'DEPTID', toTable: 'HR.DEPARTMENT', toColumn: 'ID'}]
		};

		await addTables(model, [resolved('HR', 'EMPLOYEE', {
			columns: [column('DEPTID', {foreignKey: true})],
			foreignKeys: [{fromColumn: 'DEPTID', toSchema: 'HR', toTable: 'DEPARTMENT', toColumn: 'ID'}]
		})]);

		expect(model.relationships).to.have.lengthOf(1);
	});

	it('ignores tables already on the diagram and returns undefined when none are new', async () => {
		let model: DiagramModel = {
			schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
			tables: [{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID')]}],
			relationships: []
		};

		let edit = await addTables(model, [resolved('HR', 'EMPLOYEE')]);

		expect(edit).to.be.undefined;
		expect(model.tables).to.have.lengthOf(1);
	});

	it('labels the edit by how many tables were actually added', async () => {
		let single = await addTables(emptyModel(), [resolved('HR', 'EMPLOYEE')]);
		let batch = await addTables(emptyModel(), [resolved('HR', 'EMPLOYEE'), resolved('HR', 'DEPARTMENT')]);

		expect(single?.label).to.equal('Add Table');
		expect(batch?.label).to.equal('Add 2 Tables');
	});

	it('restores the exact previous model on undo and re-adds everything on redo', async () => {
		let model: DiagramModel = {
			schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 200}}],
			tables: [{id: 'HR.DEPARTMENT', schemaId: 'HR', name: 'DEPARTMENT', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true})]}],
			relationships: []
		};
		let before = JSON.parse(JSON.stringify(model));

		let edit = await addTables(model, [
			resolved('HR', 'EMPLOYEE', {
				columns: [column('DEPTID', {foreignKey: true})],
				foreignKeys: [{fromColumn: 'DEPTID', toSchema: 'HR', toTable: 'DEPARTMENT', toColumn: 'ID'}]
			}),
			resolved('SALES', 'ORDER')
		]);
		let after = JSON.parse(JSON.stringify(model));

		edit?.undo();
		expect(model).to.deep.equal(before);

		edit?.redo();
		expect(model).to.deep.equal(after);
	});

	it('undoes repeatedly without accumulating changes', async () => {
		let model = emptyModel();
		let edit = await addTables(model, [resolved('HR', 'EMPLOYEE')]);

		edit?.undo();
		edit?.undo();

		expect(model).to.deep.equal(emptyModel());
	});

	describe('updateTables', () => {
		it('replaces the columns of a table already on the diagram', () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true})]}],
				relationships: []
			};

			let newColumns = [column('ID', {primaryKey: true}), column('NOTE', {imported: true})];
			updateTables(model, [resolved('HR', 'EMPLOYEE', {columns: newColumns})]);

			expect(model.tables[0].columns).to.deep.equal(newColumns);
		});

		it('refreshes uniqueKeys and indexes on a table already on the diagram, e.g. via Sync', () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [{
					id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60},
					columns: [column('ID', {primaryKey: true})], uniqueKeys: [{name: 'UQ_OLD', columns: ['OLD']}]
				}],
				relationships: []
			};

			updateTables(model, [resolved('HR', 'EMPLOYEE', {
				columns: [column('ID', {primaryKey: true})],
				uniqueKeys: [{name: 'UQ_BADGE', columns: ['BADGE']}],
				indexes: [{name: 'IDX_NAME', columns: ['NAME'], unique: false}]
			})]);

			expect(model.tables[0].uniqueKeys).to.deep.equal([{name: 'UQ_BADGE', columns: ['BADGE']}]);
			expect(model.tables[0].indexes).to.deep.equal([{name: 'IDX_NAME', columns: ['NAME'], unique: false}]);
		});

		it('clears a table\'s uniqueKeys when a refresh no longer reports any', () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [{
					id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60},
					columns: [column('ID', {primaryKey: true})], uniqueKeys: [{name: 'UQ_OLD', columns: ['OLD']}]
				}],
				relationships: []
			};

			updateTables(model, [resolved('HR', 'EMPLOYEE', {columns: [column('ID', {primaryKey: true})]})]);

			expect(model.tables[0]).to.not.have.property('uniqueKeys');
		});

		it('ignores an update for a table that is not on the diagram', () => {
			let model = emptyModel();

			let edit = updateTables(model, [resolved('HR', 'EMPLOYEE')]);

			expect(edit).to.be.undefined;
			expect(model.tables).to.be.empty;
		});

		it('returns undefined when the resolved columns are unchanged', () => {
			let sameColumns = [column('ID', {primaryKey: true})];
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: sameColumns}],
				relationships: []
			};

			let edit = updateTables(model, [resolved('HR', 'EMPLOYEE', {columns: [column('ID', {primaryKey: true})]})]);

			expect(edit).to.be.undefined;
		});

		it('draws a relationship an import introduces between two tables already on the diagram', () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [
					{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true})]},
					{id: 'HR.DEPARTMENT', schemaId: 'HR', name: 'DEPARTMENT', position: {x: 40, y: 200}, columns: [column('ID', {primaryKey: true})]}
				],
				relationships: []
			};

			updateTables(model, [resolved('HR', 'EMPLOYEE', {
				columns: [column('ID', {primaryKey: true}), column('DEPTID', {foreignKey: true})],
				foreignKeys: [{fromColumn: 'DEPTID', toSchema: 'HR', toTable: 'DEPARTMENT', toColumn: 'ID'}]
			})]);

			expect(model.relationships).to.have.lengthOf(1);
			expect(model.relationships[0]).to.deep.equal({
				id: 'HR.EMPLOYEE.DEPTID->HR.DEPARTMENT.ID',
				fromTable: 'HR.EMPLOYEE', fromColumn: 'DEPTID', toTable: 'HR.DEPARTMENT', toColumn: 'ID'
			});
		});

		it('does not draw a relationship whose target is not on the diagram', () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID')]}],
				relationships: []
			};

			updateTables(model, [resolved('HR', 'EMPLOYEE', {
				columns: [column('DEPTID', {foreignKey: true})],
				foreignKeys: [{fromColumn: 'DEPTID', toSchema: 'HR', toTable: 'DEPARTMENT', toColumn: 'ID'}]
			})]);

			expect(model.relationships).to.be.empty;
		});

		it('does not duplicate a relationship already on the diagram', () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [
					{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('DEPTID', {foreignKey: true})]},
					{id: 'HR.DEPARTMENT', schemaId: 'HR', name: 'DEPARTMENT', position: {x: 40, y: 200}, columns: [column('ID', {primaryKey: true})]}
				],
				relationships: [{id: 'HR.EMPLOYEE.DEPTID->HR.DEPARTMENT.ID', fromTable: 'HR.EMPLOYEE', fromColumn: 'DEPTID', toTable: 'HR.DEPARTMENT', toColumn: 'ID'}]
			};

			updateTables(model, [resolved('HR', 'EMPLOYEE', {
				columns: [column('DEPTID', {foreignKey: true})],
				foreignKeys: [{fromColumn: 'DEPTID', toSchema: 'HR', toTable: 'DEPARTMENT', toColumn: 'ID'}]
			})]);

			expect(model.relationships).to.have.lengthOf(1);
		});

		it('undoes a column replacement and any relationship it introduced', () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [
					{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true})]},
					{id: 'HR.DEPARTMENT', schemaId: 'HR', name: 'DEPARTMENT', position: {x: 40, y: 200}, columns: [column('ID', {primaryKey: true})]}
				],
				relationships: []
			};
			let before = JSON.parse(JSON.stringify(model));

			let edit = updateTables(model, [resolved('HR', 'EMPLOYEE', {
				columns: [column('ID', {primaryKey: true}), column('DEPTID', {foreignKey: true})],
				foreignKeys: [{fromColumn: 'DEPTID', toSchema: 'HR', toTable: 'DEPARTMENT', toColumn: 'ID'}]
			})]);
			let after = JSON.parse(JSON.stringify(model));

			edit?.undo();
			expect(model).to.deep.equal(before);

			edit?.redo();
			expect(model).to.deep.equal(after);
		});
	});

	describe('rearrangeTables', () => {
		it('returns undefined for an empty diagram', async () => {
			let edit = await rearrangeTables(emptyModel());

			expect(edit).to.be.undefined;
		});

		it('does not overlap any two tables after rearranging, even across schemas', async () => {
			let model: DiagramModel = {
				schemas: [
					{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}},
					{id: 'SALES', name: 'SALES', color: '#36B37E', bounds: {x: 500, y: 0, width: 400, height: 300}}
				],
				tables: [
					{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true})]},
					{id: 'HR.DEPARTMENT', schemaId: 'HR', name: 'DEPARTMENT', position: {x: 40, y: 200}, columns: [column('ID', {primaryKey: true})]},
					{id: 'SALES.ORDER', schemaId: 'SALES', name: 'ORDER', position: {x: 540, y: 60}, columns: [column('ID', {primaryKey: true})]}
				],
				relationships: [{id: 'SALES.ORDER.CUST_ID->HR.EMPLOYEE.ID', fromTable: 'SALES.ORDER', fromColumn: 'CUST_ID', toTable: 'HR.EMPLOYEE', toColumn: 'ID'}]
			};

			await rearrangeTables(model);

			let rects = model.tables.map(table => ({
				left: table.position.x, top: table.position.y,
				right: table.position.x + 390, bottom: table.position.y + tableHeight(table.columns.length)
			}));

			for(let i = 0; i < rects.length; i++) {
				for(let j = i + 1; j < rects.length; j++) {
					let overlapsX = rects[i].left < rects[j].right && rects[j].left < rects[i].right;
					let overlapsY = rects[i].top < rects[j].bottom && rects[j].top < rects[i].bottom;

					expect(overlapsX && overlapsY).to.be.false;
				}
			}
		});

		it('keeps every table strictly inside its own schema\'s new bounds', async () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [
					{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true})]},
					{id: 'HR.DEPARTMENT', schemaId: 'HR', name: 'DEPARTMENT', position: {x: 40, y: 200}, columns: [column('ID', {primaryKey: true})]}
				],
				relationships: []
			};

			await rearrangeTables(model);

			let bounds = model.schemas[0].bounds;

			for(let table of model.tables) {
				expect(table.position.x).to.be.greaterThanOrEqual(bounds.x);
				expect(table.position.y).to.be.greaterThanOrEqual(bounds.y);
				expect(table.position.x + 390).to.be.lessThanOrEqual(bounds.x + bounds.width);
				expect(table.position.y + tableHeight(table.columns.length)).to.be.lessThanOrEqual(bounds.y + bounds.height);
			}
		});

		it('leaves an empty schema\'s bounds untouched', async () => {
			let model: DiagramModel = {
				schemas: [
					{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}},
					{id: 'EMPTY', name: 'EMPTY', color: '#FF8B00', bounds: {x: 900, y: 900, width: 111, height: 222}}
				],
				tables: [{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true})]}],
				relationships: []
			};

			await rearrangeTables(model);

			expect(model.schemas.find(schema => schema.id === 'EMPTY')?.bounds).to.deep.equal({x: 900, y: 900, width: 111, height: 222});
		});

		it('labels the edit and supports undo/redo', async () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [
					{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true})]},
					{id: 'HR.DEPARTMENT', schemaId: 'HR', name: 'DEPARTMENT', position: {x: 40, y: 200}, columns: [column('ID', {primaryKey: true})]}
				],
				relationships: []
			};
			let before = JSON.parse(JSON.stringify(model));

			let edit = await rearrangeTables(model);
			expect(edit?.label).to.equal('Rearrange Tables');

			let after = JSON.parse(JSON.stringify(model));

			edit?.undo();
			expect(model).to.deep.equal(before);

			edit?.redo();
			expect(model).to.deep.equal(after);
		});
	});

	describe('syncTables', () => {
		it('applies resolved updates the same way updateTables does', () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true})]}],
				relationships: []
			};

			let newColumns = [column('ID', {primaryKey: true}), column('NOTE', {imported: true})];
			syncTables(model, [resolved('HR', 'EMPLOYEE', {columns: newColumns})], [], []);

			expect(model.tables[0].columns).to.deep.equal(newColumns);
		});

		// The "Remove Imported Change" path's own parameter (reconcileRelationshipsFor) - see
		// findStrandedRelationships. Sync itself never passes it, which the sibling test below pins down.
		it('prunes a reconciled table\'s relationship that the resolve no longer declares', () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [
					{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true}), column('DEPTID', {foreignKey: true})], importStatus: 'enhanced'},
					{id: 'HR.DEPARTMENT', schemaId: 'HR', name: 'DEPARTMENT', position: {x: 40, y: 200}, columns: [column('ID', {primaryKey: true})]}
				],
				relationships: [{id: 'HR.EMPLOYEE.DEPTID->HR.DEPARTMENT.ID', fromTable: 'HR.EMPLOYEE', fromColumn: 'DEPTID', toTable: 'HR.DEPARTMENT', toColumn: 'ID'}]
			};

			// What EMPLOYEE resolves to once the import that added its DEPTID foreign key is gone: the column
			// is still a real one, but the table no longer declares any foreign key at all.
			let update = resolved('HR', 'EMPLOYEE', {columns: [column('ID', {primaryKey: true}), column('DEPTID', {foreignKey: true})], foreignKeys: []});

			let result = syncTables(model, [update], [], [], ['HR.EMPLOYEE']);

			expect(model.relationships).to.be.empty;
			expect(model.tables.map(table => table.id)).to.deep.equal(['HR.EMPLOYEE', 'HR.DEPARTMENT']);

			result.edit?.undo();
			expect(model.relationships.map(relationship => relationship.id)).to.deep.equal(['HR.EMPLOYEE.DEPTID->HR.DEPARTMENT.ID']);
		});

		it('leaves the same relationship alone when no table is named for reconciliation', () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [
					{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true}), column('DEPTID', {foreignKey: true})], importStatus: 'enhanced'},
					{id: 'HR.DEPARTMENT', schemaId: 'HR', name: 'DEPARTMENT', position: {x: 40, y: 200}, columns: [column('ID', {primaryKey: true})]}
				],
				relationships: [{id: 'HR.EMPLOYEE.DEPTID->HR.DEPARTMENT.ID', fromTable: 'HR.EMPLOYEE', fromColumn: 'DEPTID', toTable: 'HR.DEPARTMENT', toColumn: 'ID'}]
			};

			syncTables(model, [resolved('HR', 'EMPLOYEE', {columns: [column('ID', {primaryKey: true}), column('DEPTID', {foreignKey: true})], foreignKeys: []})], [], []);

			expect(model.relationships.map(relationship => relationship.id)).to.deep.equal(['HR.EMPLOYEE.DEPTID->HR.DEPARTMENT.ID']);
		});

		it('keeps a reconciled table\'s relationship that the resolve still declares', () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [
					{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true}), column('DEPTID', {foreignKey: true})], importStatus: 'enhanced'},
					{id: 'HR.DEPARTMENT', schemaId: 'HR', name: 'DEPARTMENT', position: {x: 40, y: 200}, columns: [column('ID', {primaryKey: true})]}
				],
				relationships: [{id: 'HR.EMPLOYEE.DEPTID->HR.DEPARTMENT.ID', fromTable: 'HR.EMPLOYEE', fromColumn: 'DEPTID', toTable: 'HR.DEPARTMENT', toColumn: 'ID'}]
			};

			let foreignKey: ResolvedForeignKey = {fromColumn: 'DEPTID', toSchema: 'HR', toTable: 'DEPARTMENT', toColumn: 'ID'};
			let update = resolved('HR', 'EMPLOYEE', {columns: [column('ID', {primaryKey: true}), column('DEPTID', {foreignKey: true})], foreignKeys: [foreignKey]});

			syncTables(model, [update], [], [], ['HR.EMPLOYEE']);

			expect(model.relationships.map(relationship => relationship.id)).to.deep.equal(['HR.EMPLOYEE.DEPTID->HR.DEPARTMENT.ID']);
		});

		it('prunes an incoming relationship whose target column the reconciled table no longer has', () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [
					{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('DEPTID', {foreignKey: true})]},
					{id: 'HR.DEPARTMENT', schemaId: 'HR', name: 'DEPARTMENT', position: {x: 40, y: 200}, columns: [column('ID', {primaryKey: true}), column('LEGACYID', {imported: true})], importStatus: 'enhanced'}
				],
				relationships: [{id: 'HR.EMPLOYEE.DEPTID->HR.DEPARTMENT.LEGACYID', fromTable: 'HR.EMPLOYEE', fromColumn: 'DEPTID', toTable: 'HR.DEPARTMENT', toColumn: 'LEGACYID'}]
			};

			// DEPARTMENT resolves without the imported LEGACYID column the relationship was anchored to.
			let update = resolved('HR', 'DEPARTMENT', {columns: [column('ID', {primaryKey: true})]});

			syncTables(model, [update], [], [], ['HR.DEPARTMENT']);

			expect(model.relationships).to.be.empty;
		});

		it('marks a kept orphan as orphaned, leaving its data untouched', () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true})]}],
				relationships: []
			};

			syncTables(model, [], ['HR.EMPLOYEE'], []);

			expect(model.tables).to.have.lengthOf(1);
			expect(model.tables[0].importStatus).to.equal('orphaned');
			expect(model.tables[0].columns).to.deep.equal([column('ID', {primaryKey: true})]);
		});

		it('removes a chosen orphan along with the relationships that touched it', () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [
					{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('DEPTID', {foreignKey: true})]},
					{id: 'HR.DEPARTMENT', schemaId: 'HR', name: 'DEPARTMENT', position: {x: 40, y: 200}, columns: [column('ID', {primaryKey: true})]}
				],
				relationships: [{id: 'HR.EMPLOYEE.DEPTID->HR.DEPARTMENT.ID', fromTable: 'HR.EMPLOYEE', fromColumn: 'DEPTID', toTable: 'HR.DEPARTMENT', toColumn: 'ID'}]
			};

			syncTables(model, [], ['HR.DEPARTMENT'], ['HR.DEPARTMENT']);

			expect(model.tables.map(table => table.id)).to.deep.equal(['HR.EMPLOYEE']);
			expect(model.relationships).to.be.empty;
		});

		it('resolves a mixed batch of orphans - some kept, some removed - in one call', () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [
					{id: 'HR.KEEPME', schemaId: 'HR', name: 'KEEPME', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true})]},
					{id: 'HR.DROPME', schemaId: 'HR', name: 'DROPME', position: {x: 40, y: 200}, columns: [column('ID', {primaryKey: true})]},
					{id: 'HR.ALSODROP', schemaId: 'HR', name: 'ALSODROP', position: {x: 40, y: 340}, columns: [column('ID', {primaryKey: true})]}
				],
				relationships: []
			};

			let result = syncTables(model, [], ['HR.KEEPME', 'HR.DROPME', 'HR.ALSODROP'], ['HR.DROPME', 'HR.ALSODROP']);

			expect(model.tables.map(table => table.id)).to.deep.equal(['HR.KEEPME']);
			expect(model.tables[0].importStatus).to.equal('orphaned');
			expect(result.changedTables).to.have.deep.members([
				{tableId: 'HR.KEEPME', schema: 'HR', table: 'KEEPME', status: 'orphaned'},
				{tableId: 'HR.DROPME', schema: 'HR', table: 'DROPME', status: 'removed'},
				{tableId: 'HR.ALSODROP', schema: 'HR', table: 'ALSODROP', status: 'removed'}
			]);
		});

		it('does not re-mark an already-orphaned table, so a repeat sync with nothing new is a no-op', () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID')], importStatus: 'orphaned'}],
				relationships: []
			};

			let result = syncTables(model, [], ['HR.EMPLOYEE'], []);

			expect(result.edit).to.be.undefined;
			expect(result.changedTables).to.be.empty;
		});

		it('returns undefined when there is nothing to update, keep-as-orphan, or remove', () => {
			let model = emptyModel();
			let result = syncTables(model, [], [], []);

			expect(result.edit).to.be.undefined;
			expect(result.changedTables).to.be.empty;
		});

		it('applies an update and a removal together as one edit, and reports both in changedTables', () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [
					{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true})]},
					{id: 'HR.GHOST', schemaId: 'HR', name: 'GHOST', position: {x: 40, y: 200}, columns: [column('ID', {primaryKey: true})]}
				],
				relationships: []
			};

			let newColumns = [column('ID', {primaryKey: true}), column('NOTE', {imported: true})];
			let result = syncTables(model, [resolved('HR', 'EMPLOYEE', {columns: newColumns})], ['HR.GHOST'], ['HR.GHOST']);

			expect(result.edit).to.not.be.undefined;
			expect(model.tables.map(table => table.id)).to.deep.equal(['HR.EMPLOYEE']);
			expect(model.tables[0].columns).to.deep.equal(newColumns);
			expect(result.changedTables).to.deep.equal([
				{tableId: 'HR.EMPLOYEE', schema: 'HR', table: 'EMPLOYEE', status: 'updated'},
				{tableId: 'HR.GHOST', schema: 'HR', table: 'GHOST', status: 'removed'}
			]);
		});

		it('reports a kept orphan\'s status as "orphaned" in changedTables', () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true})]}],
				relationships: []
			};

			let result = syncTables(model, [], ['HR.EMPLOYEE'], []);

			expect(result.changedTables).to.deep.equal([{tableId: 'HR.EMPLOYEE', schema: 'HR', table: 'EMPLOYEE', status: 'orphaned'}]);
		});

		// Two tables already on the diagram, each already resolving with the exact columns they already
		// have - so neither hits the columnsEqual/importStatus diff - but not yet connected by a
		// relationship (the missing-FK-target flow's own premise, just reached through Sync). Only the
		// FK-declaring table (EMPLOYEE, the "many" side) should read as changed - DEPARTMENT hasn't gained
		// or lost anything of its own.
		it('flags the FK-declaring table as updated when a sync draws a new relationship with no column diff', () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [
					{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('DEPTID', {foreignKey: true})]},
					{id: 'HR.DEPARTMENT', schemaId: 'HR', name: 'DEPARTMENT', position: {x: 40, y: 200}, columns: [column('ID', {primaryKey: true})]}
				],
				relationships: []
			};

			let result = syncTables(model, [
				resolved('HR', 'EMPLOYEE', {
					columns: [column('DEPTID', {foreignKey: true})],
					foreignKeys: [{fromColumn: 'DEPTID', toSchema: 'HR', toTable: 'DEPARTMENT', toColumn: 'ID'}]
				}),
				resolved('HR', 'DEPARTMENT', {columns: [column('ID', {primaryKey: true})]})
			], [], []);

			expect(model.relationships).to.have.lengthOf(1);
			expect(result.changedTables).to.deep.equal([{tableId: 'HR.EMPLOYEE', schema: 'HR', table: 'EMPLOYEE', status: 'updated'}]);
		});

		it('undoes and redoes a combined update-plus-removal as a single step', () => {
			let model: DiagramModel = {
				schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
				tables: [
					{id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60}, columns: [column('ID', {primaryKey: true})]},
					{id: 'HR.GHOST', schemaId: 'HR', name: 'GHOST', position: {x: 40, y: 200}, columns: [column('ID', {primaryKey: true})]}
				],
				relationships: []
			};
			let before = JSON.parse(JSON.stringify(model));

			let newColumns = [column('ID', {primaryKey: true}), column('NOTE', {imported: true})];
			let result = syncTables(model, [resolved('HR', 'EMPLOYEE', {columns: newColumns})], ['HR.GHOST'], ['HR.GHOST']);
			let after = JSON.parse(JSON.stringify(model));

			result.edit?.undo();
			expect(model).to.deep.equal(before);

			result.edit?.redo();
			expect(model).to.deep.equal(after);
		});
	});

	describe('filterSyncResolve', () => {
		let enhancedModel = (): DiagramModel => ({
			schemas: [{id: 'HR', name: 'HR', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 400, height: 300}}],
			tables: [
				{
					id: 'HR.EMPLOYEE', schemaId: 'HR', name: 'EMPLOYEE', position: {x: 40, y: 60},
					columns: [column('ID', {primaryKey: true}), column('DEPTID', {foreignKey: true, imported: true})],
					importStatus: 'enhanced'
				},
				{id: 'HR.NOTES', schemaId: 'HR', name: 'NOTES', position: {x: 40, y: 200}, columns: [column('ID', {primaryKey: true})], importStatus: 'imported'},
				{id: 'HR.PLAIN', schemaId: 'HR', name: 'PLAIN', position: {x: 40, y: 340}, columns: [column('ID', {primaryKey: true})]}
			],
			relationships: []
		});

		it('drops an already-flagged table from both updates and orphans when nothing has been imported this session', () => {
			let model = enhancedModel();
			let updates = [resolved('HR', 'EMPLOYEE', {columns: [column('ID', {primaryKey: true})]})];
			let orphanTargets = [{schema: 'HR', table: 'NOTES'}];

			let filtered = filterSyncResolve(model, updates, orphanTargets, false);

			expect(filtered.updates).to.be.empty;
			expect(filtered.orphanTargets).to.be.empty;
		});

		it('filters a protected entry while leaving an unprotected one through, in the same call', () => {
			let model = enhancedModel();
			// EMPLOYEE (enhanced) sits alongside PLAIN (never imported) in one updates batch, and NOTES
			// (imported, wholly import-sourced) sits alongside GONE (a genuine, never-seen table) in one
			// orphanTargets batch - the two rules have to apply per-entry within a single call, not just
			// when each is the only thing being resolved.
			let updates = [
				resolved('HR', 'EMPLOYEE', {columns: [column('ID', {primaryKey: true})]}),
				resolved('HR', 'PLAIN', {columns: [column('ID', {primaryKey: true}), column('NEWCOL')]})
			];
			let orphanTargets = [{schema: 'HR', table: 'NOTES'}, {schema: 'HR', table: 'GONE'}];

			let filtered = filterSyncResolve(model, updates, orphanTargets, false);

			expect(filtered.updates).to.deep.equal([updates[1]]);
			expect(filtered.orphanTargets).to.deep.equal([orphanTargets[1]]);
		});

		it('leaves a plain (never-imported) table\'s update and a genuine unresolved table through unchanged', () => {
			let model = enhancedModel();
			let updates = [resolved('HR', 'PLAIN', {columns: [column('ID', {primaryKey: true}), column('NEWCOL')]})];
			let orphanTargets = [{schema: 'HR', table: 'GONE'}];

			let filtered = filterSyncResolve(model, updates, orphanTargets, false);

			expect(filtered.updates).to.deep.equal(updates);
			expect(filtered.orphanTargets).to.deep.equal(orphanTargets);
		});

		it('applies everything unfiltered once at least one import has been loaded this session', () => {
			let model = enhancedModel();
			let updates = [resolved('HR', 'EMPLOYEE', {columns: [column('ID', {primaryKey: true})]})];
			let orphanTargets = [{schema: 'HR', table: 'NOTES'}];

			let filtered = filterSyncResolve(model, updates, orphanTargets, true);

			expect(filtered.updates).to.deep.equal(updates);
			expect(filtered.orphanTargets).to.deep.equal(orphanTargets);
		});
	});
});
