import { expect } from 'chai';
import { DiagramModel } from '../webview-messages/diagram-messages.js';
import { diagramModelToXml, xmlToDiagramModel } from './diagram-xml.js';

function sampleModel(): DiagramModel {
	return {
		schemas: [
			{id: 'SALES', name: 'SALES', color: '#4C9AFF', bounds: {x: 0, y: 0, width: 600, height: 260}}
		],
		tables: [
			{
				id: 'SALES.CUSTOMER', schemaId: 'SALES', name: 'CUSTOMER', description: 'Customer master',
				position: {x: 40, y: 30},
				columns: [
					{name: 'ID', type: 'INTEGER', primaryKey: true, foreignKey: false, identity: true, notNull: true, unique: false, indexed: false},
					{name: 'NAME', type: 'VARCHAR(100)', primaryKey: false, foreignKey: false, identity: false, notNull: false, unique: false, indexed: false}
				]
			},
			{
				id: 'SALES.ORDER', schemaId: 'SALES', name: 'ORDER',
				position: {x: 340, y: 30},
				columns: [
					{name: 'ID', type: 'INTEGER', primaryKey: true, foreignKey: false, identity: true, notNull: true, unique: false, indexed: false},
					{name: 'CUSTOMER_ID', type: 'INTEGER', primaryKey: false, foreignKey: true, identity: false, notNull: false, unique: false, indexed: false}
				]
			}
		],
		relationships: [
			{id: 'fk-0', fromTable: 'SALES.ORDER', fromColumn: 'CUSTOMER_ID', toTable: 'SALES.CUSTOMER', toColumn: 'ID'}
		]
	};
}

describe('diagram-xml', () => {
	describe('round trip', () => {
		it('round-trips a full model (schemas, tables, columns, relationships) unchanged', () => {
			let model = sampleModel();
			expect(xmlToDiagramModel(diagramModelToXml(model))).to.deep.equal(model);
		});

		it('round-trips a table with no description', () => {
			let model = sampleModel();
			expect(xmlToDiagramModel(diagramModelToXml(model)).tables[1].description).to.be.undefined;
		});

		it('round-trips an empty model', () => {
			let empty: DiagramModel = {schemas: [], tables: [], relationships: []};
			expect(xmlToDiagramModel(diagramModelToXml(empty))).to.deep.equal(empty);
		});

		it('round-trips a column\'s three name forms', () => {
			let model = sampleModel();
			model.tables[0].columns[0] = {
				name: 'EMPLOYEE_ID', shortName: 'EMNO', longName: 'EMPLOYEE_ID', description: 'Employee Code',
				type: 'INTEGER', primaryKey: true, foreignKey: false, identity: true, notNull: true, unique: false, indexed: false
			};

			expect(xmlToDiagramModel(diagramModelToXml(model)).tables[0].columns[0]).to.deep.equal(model.tables[0].columns[0]);
		});

		// mxGraph's style format is "key=value;key=value;" with no escaping whatsoever, so an unencoded
		// heading containing either delimiter would corrupt every key after it.
		it('round-trips a description containing style delimiters', () => {
			let model = sampleModel();
			model.tables[0].columns[0] = {
				name: 'ID', description: 'Rate = margin; net', type: 'INTEGER',
				primaryKey: true, foreignKey: false, identity: true, notNull: true, unique: false, indexed: false
			};

			let parsed = xmlToDiagramModel(diagramModelToXml(model));

			expect(parsed.tables[0].columns[0].description).to.equal('Rate = margin; net');
			expect(parsed.tables[0].columns[0].type).to.equal('INTEGER');
			expect(parsed.tables[0].columns[0].primaryKey).to.be.true;
		});

		// Every diagram saved before the name forms were stored, which must keep opening unchanged.
		it('leaves a column with no name forms exactly as it was', () => {
			let column = xmlToDiagramModel(diagramModelToXml(sampleModel())).tables[0].columns[0];

			expect(column).to.not.have.property('shortName');
			expect(column).to.not.have.property('longName');
			expect(column).to.not.have.property('description');
		});

		// Phase 4: a column/table an import touched round-trips its flag, so a diagram opened cold (without
		// re-importing anything this session) still shows Imported/Enhanced/New - see DiagramColumn.imported
		// and DiagramTable.importStatus's own comments.
		it('round-trips a column\'s imported flag', () => {
			let model = sampleModel();
			model.tables[0].columns[0].imported = true;

			expect(xmlToDiagramModel(diagramModelToXml(model)).tables[0].columns[0].imported).to.be.true;
		});

		// The optional-spread convention every other column field already uses (shortName/longName/
		// description) - an unimported column's XML carries db2wbImported=0, but the field comes back
		// absent rather than an explicit false, so it round-trips identically to a diagram saved before
		// this field existed and can't cause a spurious "changed" detection against a freshly-resolved
		// column (see diagram-resolved-table.ts's toDiagramColumn, which only ever sets it when true).
		it('omits the imported flag on a column with no import contribution', () => {
			let column = xmlToDiagramModel(diagramModelToXml(sampleModel())).tables[0].columns[0];

			expect(column).to.not.have.property('imported');
		});

		it('round-trips a column\'s notNull/unique/indexed flags', () => {
			let model = sampleModel();
			model.tables[0].columns[0].notNull = true;
			model.tables[0].columns[0].unique = true;
			model.tables[0].columns[0].indexed = true;

			let column = xmlToDiagramModel(diagramModelToXml(model)).tables[0].columns[0];

			expect(column.notNull).to.be.true;
			expect(column.unique).to.be.true;
			expect(column.indexed).to.be.true;
		});

		// A diagram saved before these flags existed has no db2wb* style key for them at all - proves they
		// read back false (not undefined/thrown), the same "unknown, not asserted" default primaryKey/
		// foreignKey/identity already fall back to.
		it('reads a column with no notNull/unique/indexed style keys as false for all three', () => {
			let column = xmlToDiagramModel(diagramModelToXml(sampleModel())).tables[0].columns[1];

			expect(column.notNull).to.be.false;
			expect(column.unique).to.be.false;
			expect(column.indexed).to.be.false;
		});

		it('round-trips a table\'s uniqueKeys and indexes', () => {
			let model = sampleModel();
			model.tables[0].uniqueKeys = [{name: 'UQ_NAME', columns: ['ID', 'NAME']}];
			model.tables[0].indexes = [{name: 'IDX_NAME', columns: ['NAME'], unique: false}];

			let table = xmlToDiagramModel(diagramModelToXml(model)).tables[0];

			expect(table.uniqueKeys).to.deep.equal([{name: 'UQ_NAME', columns: ['ID', 'NAME']}]);
			expect(table.indexes).to.deep.equal([{name: 'IDX_NAME', columns: ['NAME'], unique: false}]);
		});

		it('omits uniqueKeys/indexes on a table with neither', () => {
			let table = xmlToDiagramModel(diagramModelToXml(sampleModel())).tables[0];

			expect(table).to.not.have.property('uniqueKeys');
			expect(table).to.not.have.property('indexes');
		});

		it('round-trips a table\'s importStatus, for each of its three values', () => {
			for(let importStatus of ['imported', 'enhanced', 'orphaned'] as const) {
				let model = sampleModel();
				model.tables[0].importStatus = importStatus;

				expect(xmlToDiagramModel(diagramModelToXml(model)).tables[0].importStatus).to.equal(importStatus);
			}
		});

		// A plain table's XML must stay exactly what it was before importStatus existed - written only
		// when present, same convention as description.
		it('omits importStatus on a table with no import contribution', () => {
			let table = xmlToDiagramModel(diagramModelToXml(sampleModel())).tables[0];

			expect(table).to.not.have.property('importStatus');
		});

		// The table-level flag (a data attribute on the <object> wrapper) and the column-level flag (a
		// db2wbImported style key on the row cell) are read/written independently - a sync that kept an
		// orphaned table carries both at once (see diagram-add-tables.ts's syncTables), so this proves
		// neither one's presence disturbs the other's round trip.
		it('round-trips a table\'s importStatus and a column\'s imported flag together', () => {
			let model = sampleModel();
			model.tables[0].importStatus = 'orphaned';
			model.tables[0].columns[0].imported = true;

			let table = xmlToDiagramModel(diagramModelToXml(model)).tables[0];

			expect(table.importStatus).to.equal('orphaned');
			expect(table.columns[0].imported).to.be.true;
			expect(table.columns[1]).to.not.have.property('imported');
		});
	});

	describe('column labels', () => {
		// The visible label follows the user's setting; nothing ever parses it back (identity rides in the
		// cell id, everything else in the style), so which form is written can't affect the model.
		it('labels a column cell with the first configured name form', () => {
			let model = sampleModel();
			model.tables[0].columns[0] = {
				name: 'EMPLOYEE_ID', shortName: 'EMNO', longName: 'EMPLOYEE_ID',
				type: 'INTEGER', primaryKey: true, foreignKey: false, identity: true, notNull: true, unique: false, indexed: false
			};

			expect(diagramModelToXml(model, ['Short Name'])).to.contain('value="EMNO : INTEGER"');
			expect(diagramModelToXml(model, ['Long Name'])).to.contain('value="EMPLOYEE_ID : INTEGER"');
		});

		it('keeps the column identity in the cell id whatever the label setting is', () => {
			let model = sampleModel();
			model.tables[0].columns[0] = {
				name: 'EMPLOYEE_ID', shortName: 'EMNO', longName: 'EMPLOYEE_ID',
				type: 'INTEGER', primaryKey: true, foreignKey: false, identity: true, notNull: true, unique: false, indexed: false
			};

			for(let labels of [['Short Name'], ['Long Name'], ['Description']]) {
				expect(xmlToDiagramModel(diagramModelToXml(model, labels)).tables[0].columns[0].name).to.equal('EMPLOYEE_ID');
			}
		});
	});

	describe('diagramModelToXml conventions', () => {
		it('stores a table position relative to its schema group, not absolute', () => {
			let xml = diagramModelToXml(sampleModel());
			// Schema origin (0,0) + table position (40,30) - relative geometry should read exactly 40/30.
			expect(xml).to.match(/id="SALES\.CUSTOMER"[\s\S]*?<mxGeometry[^>]*x="40"[^>]*y="30"/);
		});

		it('never wraps a column row in an <object> - only tables get object-wrapped', () => {
			let model = sampleModel();
			let xml = diagramModelToXml(model);

			// Every <object> in the document should account for exactly one table, not a table+its columns -
			// if a row ever got wrapped too, this count would be higher than the table count.
			expect(xml.match(/<object /g)).to.have.length(model.tables.length);
		});

		it('does wrap tables in <object>, carrying schema/tableId as inspectable custom data', () => {
			let model: DiagramModel = {
				schemas: [{id: 'S', name: 'S', color: '#000', bounds: {x: 0, y: 0, width: 100, height: 100}}],
				tables: [{id: 'S.T', schemaId: 'S', name: 'T', position: {x: 0, y: 0}, columns: []}],
				relationships: []
			};

			let xml = diagramModelToXml(model);
			expect(xml).to.include('<object');
			expect(xml).to.match(/tableId="S\.T"/);
		});

		it('packs column metadata into custom db2wb* style keys, not a separate object', () => {
			let xml = diagramModelToXml(sampleModel());
			expect(xml).to.match(/db2wbPrimaryKey=1/);
			expect(xml).to.match(/db2wbForeignKey=1/);
			expect(xml).to.match(/db2wbIdentity=1/);
			expect(xml).to.match(/db2wbNotNull=1/);
		});

		it('connects a relationship edge to the specific source/target column cells, not the tables', () => {
			let xml = diagramModelToXml(sampleModel());
			expect(xml).to.match(/source="SALES\.ORDER\.CUSTOMER_ID"/);
			expect(xml).to.match(/target="SALES\.CUSTOMER\.ID"/);
		});

		it('styles relationships with draw.io\'s crow\'s-foot ER connector', () => {
			let xml = diagramModelToXml(sampleModel());
			expect(xml).to.include('entityRelationEdgeStyle');
			// startArrow is the source (foreign-key) terminal, so that's the end the crow's foot belongs on -
			// see RELATIONSHIP_STYLE_BASE's comment for why these two were previously the wrong way round.
			expect(xml).to.include('startArrow=ERmany');
			expect(xml).to.include('endArrow=ERone');
		});

		it('writes a one-to-one relationship with a bar on both ends, not a crow\'s foot', () => {
			let model = sampleModel();
			// Make ORDER.CUSTOMER_ID the table's whole primary key - a shared-primary-key extension table,
			// which makes this 1:1 rather than 1:N (see diagram-cardinality.ts).
			model.tables[1].columns = [{name: 'CUSTOMER_ID', type: 'INTEGER', primaryKey: true, foreignKey: true, identity: false, notNull: true, unique: false, indexed: false}];
			model.relationships[0].fromColumn = 'CUSTOMER_ID';

			let xml = diagramModelToXml(model);
			expect(xml).to.include('startArrow=ERone');
			expect(xml).to.include('endArrow=ERone');
			expect(xml).to.not.include('ERmany');
		});
	});

	describe('error handling', () => {
		it('throws when a table references a schema that does not exist', () => {
			let model: DiagramModel = {
				schemas: [],
				tables: [{id: 'S.T', schemaId: 'MISSING', name: 'T', position: {x: 0, y: 0}, columns: []}],
				relationships: []
			};

			expect(() => diagramModelToXml(model)).to.throw(/unknown schema/);
		});

		it('throws when reading a relationship edge with no source/target', () => {
			let xml = `<mxfile><diagram><mxGraphModel><root>
				<mxCell id="0" /><mxCell id="1" parent="0" />
				<mxCell id="bad-edge" edge="1" parent="1" />
			</root></mxGraphModel></diagram></mxfile>`;

			expect(() => xmlToDiagramModel(xml)).to.throw(/missing a source or target/);
		});
	});
});
