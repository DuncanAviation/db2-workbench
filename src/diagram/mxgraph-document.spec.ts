import { expect } from 'chai';
import { MxCell, MxGraphDocument, parseMxGraphDocument, serializeMxGraphDocument } from './mxgraph-document.js';

describe('mxgraph-document', () => {
	describe('parseMxGraphDocument', () => {
		it('returns an empty document for blank input', () => {
			expect(parseMxGraphDocument('')).to.deep.equal({cells: []});
			expect(parseMxGraphDocument('   ')).to.deep.equal({cells: []});
		});

		it('strips the boilerplate root container and default layer cells', () => {
			let xml = `<mxfile><diagram><mxGraphModel><root>
				<mxCell id="0" />
				<mxCell id="1" parent="0" />
				<mxCell id="a" vertex="1" parent="1"><mxGeometry x="10" y="20" width="100" height="50" as="geometry" /></mxCell>
			</root></mxGraphModel></diagram></mxfile>`;

			let document = parseMxGraphDocument(xml);

			expect(document.cells.map(cell => cell.id)).to.deep.equal(['a']);
		});

		it('parses a single mxCell the same as multiple (xml-js gives a bare element, not a 1-item array, for a single sibling)', () => {
			let xml = `<mxfile><diagram><mxGraphModel><root>
				<mxCell id="0" />
				<mxCell id="1" parent="0" />
				<mxCell id="only-one" vertex="1" parent="1" />
			</root></mxGraphModel></diagram></mxfile>`;

			expect(parseMxGraphDocument(xml).cells).to.deep.equal([
				{id: 'only-one', parent: '1', value: undefined, style: undefined, vertex: true, edge: false, connectable: undefined, source: undefined, target: undefined, geometry: undefined, data: undefined}
			]);
		});

		it('parses a single object-wrapped cell the same as multiple', () => {
			let xml = `<mxfile><diagram><mxGraphModel><root>
				<mxCell id="0" />
				<mxCell id="1" parent="0" />
				<object label="CUSTOMER" schema="SALES" id="SALES.CUSTOMER">
					<mxCell style="shape=table" vertex="1" parent="1" />
				</object>
			</root></mxGraphModel></diagram></mxfile>`;

			let cells = parseMxGraphDocument(xml).cells;

			expect(cells).to.have.length(1);
			expect(cells[0]).to.deep.equal({
				id: 'SALES.CUSTOMER', parent: '1', value: 'CUSTOMER', style: 'shape=table', vertex: true, edge: false,
				connectable: undefined, source: undefined, target: undefined, geometry: undefined, data: {schema: 'SALES'}
			});
		});

		it('throws on a cell with no id', () => {
			let xml = `<mxfile><diagram><mxGraphModel><root>
				<mxCell id="0" /><mxCell id="1" parent="0" />
				<mxCell vertex="1" parent="1" />
			</root></mxGraphModel></diagram></mxfile>`;

			expect(() => parseMxGraphDocument(xml)).to.throw(/no id/);
		});
	});

	describe('round trip (serialize then parse)', () => {
		function roundTrip(document: MxGraphDocument): MxCell[] {
			return parseMxGraphDocument(serializeMxGraphDocument(document)).cells;
		}

		it('round-trips a plain vertex cell with geometry', () => {
			let cell: MxCell = {
				id: 'a', parent: '1', value: 'A', style: 'rounded=1', vertex: true, edge: false,
				geometry: {x: 10, y: 20, width: 100, height: 50}
			};

			expect(roundTrip({cells: [cell]})).to.deep.equal([
				{...cell, connectable: undefined, source: undefined, target: undefined, data: undefined, geometry: {...cell.geometry, relative: false}}
			]);
		});

		it('round-trips an edge with relative geometry and no fixed dimensions', () => {
			let cell: MxCell = {
				id: 'fk-0', parent: '1', style: 'edgeStyle=entityRelationEdgeStyle', edge: true,
				source: 'a.col1', target: 'b.col1', geometry: {relative: true}
			};

			expect(roundTrip({cells: [cell]})).to.deep.equal([
				{...cell, value: undefined, vertex: false, connectable: undefined, data: undefined, geometry: {x: undefined, y: undefined, width: undefined, height: undefined, relative: true}}
			]);
		});

		it('round-trips an object-wrapped cell, preserving its custom data', () => {
			let cell: MxCell = {
				id: 'SALES.CUSTOMER', parent: 'schema-SALES', value: 'CUSTOMER', style: 'shape=table', vertex: true,
				geometry: {x: 0, y: 0, width: 220, height: 90}, data: {schema: 'SALES', tableId: 'SALES.CUSTOMER'}
			};

			expect(roundTrip({cells: [cell]})).to.deep.equal([
				{...cell, edge: false, connectable: undefined, source: undefined, target: undefined, geometry: {...cell.geometry, relative: false}}
			]);
		});

		it('round-trips multiple cells, plain and object-wrapped, in one document', () => {
			let plain: MxCell = {id: 'p1', parent: '1', vertex: true};
			let wrapped1: MxCell = {id: 'w1', parent: '1', vertex: true, data: {foo: 'bar'}};
			let wrapped2: MxCell = {id: 'w2', parent: '1', vertex: true, data: {foo: 'baz'}};

			let result = roundTrip({cells: [plain, wrapped1, wrapped2]});

			expect(result.map(cell => cell.id)).to.have.members(['p1', 'w1', 'w2']);
			expect(result.find(cell => cell.id === 'w1')?.data).to.deep.equal({foo: 'bar'});
			expect(result.find(cell => cell.id === 'w2')?.data).to.deep.equal({foo: 'baz'});
		});

		it('preserves a style string containing custom namespaced keys verbatim', () => {
			let style = 'shape=tableRow;fillColor=none;db2wbColumnType=INTEGER;db2wbPrimaryKey=1;db2wbForeignKey=0;';
			let cell: MxCell = {id: 'row1', parent: 't1', style: style, vertex: true};

			expect(roundTrip({cells: [cell]})[0].style).to.equal(style);
		});
	});

	describe('serializeMxGraphDocument', () => {
		it('always emits the boilerplate root container and default layer cells', () => {
			let xml = serializeMxGraphDocument({cells: [{id: 'a', parent: '1', vertex: true}]});

			expect(xml).to.include('<mxCell id="0"');
			expect(xml).to.include('<mxCell id="1" parent="0"');
		});

		it('produces well-formed XML that escapes special characters in values', () => {
			let xml = serializeMxGraphDocument({cells: [{id: 'a', parent: '1', value: 'A & B < C', vertex: true}]});

			expect(xml).to.include('A &amp; B &lt; C');
			expect(parseMxGraphDocument(xml).cells[0].value).to.equal('A & B < C');
		});
	});
});
