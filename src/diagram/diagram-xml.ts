import { ResultHeadingLabel } from '../models/result-heading-label.js';
import { StringUtils } from '../utils/string-utils.js';
import { DiagramColumn, DiagramModel, DiagramRelationship, DiagramSchemaGroup, DiagramTable } from '../webview-messages/diagram-messages.js';
import { DiagramCardinality, relationshipCardinality } from './diagram-cardinality.js';
import { columnDisplayName } from './diagram-column-labels.js';
import { MxCell, parseMxGraphDocument, serializeMxGraphDocument } from './mxgraph-document.js';
import { buildStyle, parseStyle } from './mxgraph-style.js';

// Maps DiagramModel <-> mxGraph cells using the conventions validated by hand against the real draw.io
// editor (see the diagram feature's design notes): a schema is a `group`-style cell whose own geometry is
// the authoritative bounding box for the zoomed-out view; a table is an <object>-wrapped `shape=table`
// cell nested under its schema group (table-level custom data survives draw.io's own table-layout engine
// fine); a column is a plain (NOT object-wrapped) `shape=tableRow` cell with its metadata packed into
// custom `db2wb*` style keys instead, since draw.io silently strips row-level object wrappers on render;
// a relationship is an edge connecting two specific column cells (not table-to-table), styled with
// draw.io's own crow's-foot ER connector.

const TABLE_WIDTH = 390;
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 24;
const DEFAULT_SCHEMA_COLOR = '#888888';

// startSize is draw.io's own reserved header-band height for a `table` shape - it MUST match HEADER_HEIGHT.
// A row cell's own geometry.y (see columnToCell) is stored relative to the table's top-left corner, not
// relative to the header band, so a mismatch (this used to be a bare 30 against a HEADER_HEIGHT of 36)
// left the first row's y=0..24 sitting inside the header band instead of below it - overlapping the table
// name in real draw.io, since our own React canvas never renders this XML directly and so never showed it.
const TABLE_STYLE = `shape=table;startSize=${HEADER_HEIGHT};container=1;collapsible=0;childLayout=tableLayout;`;

// mxGraph draws startArrow at the edge's *source* terminal and endArrow at its target. A relationship's
// source is its foreign-key end (see relationshipToCell below), which is the "many" side, so the crow's
// foot belongs on startArrow - the reverse of what this used to emit as a fixed string. The exact
// cardinality per end comes from diagram-cardinality.ts, the same derivation the on-screen rendering uses,
// so an exported diagram and the canvas can't disagree.
const RELATIONSHIP_STYLE_BASE = 'edgeStyle=entityRelationEdgeStyle;html=1;';
const ER_ARROWS: Record<DiagramCardinality, string> = {one: 'ERone', many: 'ERmany'};

const ROW_STYLE_BASE: Record<string, string> = {
	shape: 'tableRow', fillColor: 'none', strokeColor: 'inherit',
	top: '0', left: '0', bottom: '0', right: '0',
	collapsible: '0', dropTarget: '0', points: '[[0,0.5],[1,0.5]]', portConstraint: 'eastwest'
};

const SCHEMA_GROUP_STYLE_BASE: Record<string, string> = {
	group: '', fillColor: 'none', verticalAlign: 'top', fontSize: '14', fontStyle: '1', spacingTop: '4'
};

// `columnLabels` decides only what each column cell's VISIBLE label says (draw.io renders that string;
// nothing here or in xmlToDiagramModel ever parses it back), so which name form the user has configured
// can't affect a single identity, geometry or relationship in the file. Defaulted rather than required
// so a caller with no settings in reach - every unit test, most obviously - still round-trips.
export function diagramModelToXml(model: DiagramModel, columnLabels: readonly string[] = [ResultHeadingLabel.SHORT_NAME]): string {
	let cells: MxCell[] = [];

	for(let schema of model.schemas) {
		cells.push(schemaGroupToCell(schema));
	}

	for(let table of model.tables) {
		let schema = requireSchema(model.schemas, table.schemaId, `Table "${table.id}"`);
		cells.push(tableToCell(table, schema));
		table.columns.forEach((column, index) => cells.push(columnToCell(table.id, column, index, columnLabels)));
	}

	let tablesById = new Map(model.tables.map(table => [table.id, table]));

	for(let relationship of model.relationships) {
		cells.push(relationshipToCell(relationship, tablesById.get(relationship.fromTable)));
	}

	return serializeMxGraphDocument({cells: cells});
}

export function xmlToDiagramModel(xml: string): DiagramModel {
	let {cells} = parseMxGraphDocument(xml);

	let schemas = cells.filter(isSchemaGroupCell).map(cellToSchemaGroup);
	let tables = cells.filter(isTableCell).map(cell => cellToTable(cell, cells, schemas));
	let relationships = cells.filter(cell => cell.edge).map(cellToRelationship);

	return {schemas: schemas, tables: tables, relationships: relationships};
}

function requireSchema(schemas: DiagramSchemaGroup[], schemaId: string, context: string): DiagramSchemaGroup {
	let schema = schemas.find(candidate => candidate.id === schemaId);

	if(!schema) {
		throw new Error(`${context} references unknown schema "${schemaId}".`);
	}

	return schema;
}

function columnCellId(tableId: string, columnName: string): string {
	return `${tableId}.${columnName}`;
}

// A column cell id is "<schema>.<table>.<column>" - splitting on the *last* dot isolates the column name
// regardless of how the table id itself is shaped, since it's always exactly what columnCellId produced.
function splitColumnCellId(id: string): {tableId: string; columnName: string} {
	let lastDotIndex = id.lastIndexOf('.');
	return {tableId: id.slice(0, lastDotIndex), columnName: id.slice(lastDotIndex + 1)};
}

function schemaGroupToCell(schema: DiagramSchemaGroup): MxCell {
	return {
		id: schema.id,
		value: schema.name,
		style: buildStyle({...SCHEMA_GROUP_STYLE_BASE, strokeColor: schema.color}),
		vertex: true,
		connectable: false,
		parent: '1',
		geometry: {x: schema.bounds.x, y: schema.bounds.y, width: schema.bounds.width, height: schema.bounds.height}
	};
}

function isSchemaGroupCell(cell: MxCell): boolean {
	return parseStyle(cell.style).group !== undefined;
}

function cellToSchemaGroup(cell: MxCell): DiagramSchemaGroup {
	let style = parseStyle(cell.style);

	return {
		id: cell.id,
		name: cell.value ?? cell.id,
		color: style.strokeColor ?? DEFAULT_SCHEMA_COLOR,
		bounds: {
			x: cell.geometry?.x ?? 0,
			y: cell.geometry?.y ?? 0,
			width: cell.geometry?.width ?? 0,
			height: cell.geometry?.height ?? 0
		}
	};
}

function tableToCell(table: DiagramTable, schema: DiagramSchemaGroup): MxCell {
	return {
		id: table.id,
		value: table.name,
		style: TABLE_STYLE,
		vertex: true,
		parent: schema.id,
		// Positions are stored parent-relative in mxGraph - table.position is absolute canvas coordinates,
		// so it's converted against the owning schema group's own (also absolute) bounds here.
		geometry: {
			x: table.position.x - schema.bounds.x,
			y: table.position.y - schema.bounds.y,
			width: TABLE_WIDTH,
			height: HEADER_HEIGHT + table.columns.length * ROW_HEIGHT
		},
		// importStatus is written only when present (same optional convention as description) so a plain,
		// never-imported table's XML is byte-identical to before this field existed. See DiagramTable's own
		// comment - unlike DiagramColumn.imported below, this is a point-in-time snapshot the host recomputes
		// on every resolve, not something xmlToDiagramModel derives.
		data: {
			schema: schema.name, tableId: table.id,
			...(table.description ? {description: table.description} : {}),
			...(table.importStatus ? {importStatus: table.importStatus} : {}),
			// <object> attributes are strings, so a group of columns (unlike the flat per-column style flags
			// above) has to be JSON-encoded rather than spread across several keys - written only when
			// non-empty, same optional convention as description/importStatus.
			...(table.uniqueKeys?.length ? {uniqueKeys: JSON.stringify(table.uniqueKeys)} : {}),
			...(table.indexes?.length ? {indexes: JSON.stringify(table.indexes)} : {})
		}
	};
}

function isTableCell(cell: MxCell): boolean {
	return parseStyle(cell.style).shape === 'table';
}

function cellToTable(cell: MxCell, allCells: MxCell[], schemas: DiagramSchemaGroup[]): DiagramTable {
	let schema = requireSchema(schemas, cell.parent ?? '', `Table cell "${cell.id}"`);

	let columns = allCells
		.filter(candidate => candidate.parent === cell.id && isColumnCell(candidate))
		.sort((a, b) => (a.geometry?.y ?? 0) - (b.geometry?.y ?? 0))
		.map(cellToColumn);

	let uniqueKeys = decodeJsonArray<NonNullable<DiagramTable['uniqueKeys']>[number]>(cell.data?.uniqueKeys);
	let indexes = decodeJsonArray<NonNullable<DiagramTable['indexes']>[number]>(cell.data?.indexes);

	return {
		id: cell.id,
		schemaId: schema.id,
		name: cell.value ?? cell.id,
		...(cell.data?.description ? {description: cell.data.description} : {}),
		...(cell.data?.importStatus ? {importStatus: cell.data.importStatus as DiagramTable['importStatus']} : {}),
		...(uniqueKeys ? {uniqueKeys: uniqueKeys} : {}),
		...(indexes ? {indexes: indexes} : {}),
		position: {
			x: (cell.geometry?.x ?? 0) + schema.bounds.x,
			y: (cell.geometry?.y ?? 0) + schema.bounds.y
		},
		columns: columns
	};
}

// Guards against a diagram saved before these fields existed (no key at all - the common case) and
// against hand-edited or otherwise malformed JSON (falls back to absent rather than throwing and failing
// the whole file's load) - same "absent, not a crash" posture as decodeAlias's own encoding-failure catch.
function decodeJsonArray<T>(value: string | undefined): T[] | undefined {
	if(!value || StringUtils.isBlank(value)) {
		return undefined;
	}

	try {
		let parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed as T[] : undefined;
	} catch {
		return undefined;
	}
}

function columnToCell(tableId: string, column: DiagramColumn, index: number, columnLabels: readonly string[]): MxCell {
	return {
		id: columnCellId(tableId, column.name),
		value: `${columnDisplayName(column, columnLabels)} : ${column.type}`,
		style: buildStyle({
			...ROW_STYLE_BASE,
			db2wbColumnType: column.type,
			db2wbPrimaryKey: column.primaryKey ? '1' : '0',
			db2wbForeignKey: column.foreignKey ? '1' : '0',
			db2wbIdentity: column.identity ? '1' : '0',
			db2wbNotNull: column.notNull ? '1' : '0',
			db2wbUnique: column.unique ? '1' : '0',
			db2wbIndexed: column.indexed ? '1' : '0',
			// Same unconditional style key as the three flags above (always written, '1'/'0') - but read
			// back with the optional spread convention below (cellToColumn), matching shortName/longName/
			// description, so a column with no import contribution round-trips with the field absent rather
			// than an explicit false, which is what every consumer already expects (see diagram-resolved-
			// table.ts's toDiagramColumn, which only ever sets this when true).
			db2wbImported: column.imported ? '1' : '0',
			// The cell id already carries the identity; these are the OTHER name forms the column answers
			// to, which is what lets a foreign key that names a column the short way (every imported one
			// does) still find it. Omitted entirely when absent rather than written empty, so a diagram
			// whose columns have no aliases produces exactly the style string it always did.
			...aliasStyle(column)
		}),
		vertex: true,
		parent: tableId,
		// Offset past the header band (see TABLE_STYLE) - a bare index * ROW_HEIGHT put row 0 at y=0,
		// directly under the table name instead of below it.
		geometry: {y: HEADER_HEIGHT + index * ROW_HEIGHT, width: TABLE_WIDTH, height: ROW_HEIGHT}
	};
}

// Style values live in mxGraph's own "key=value;" mini-format, which has no escaping of any kind (see
// mxgraph-style.ts) - a column heading containing ';' or '=' would silently corrupt every key after it.
// Hence encodeURIComponent, and hence these three riding in the style at all rather than an <object>
// wrapper: draw.io strips row-level object wrappers on render.
function aliasStyle(column: DiagramColumn): Record<string, string> {
	return {
		...encodedAlias('db2wbShortName', column.shortName),
		...encodedAlias('db2wbLongName', column.longName),
		...encodedAlias('db2wbDescription', column.description)
	};
}

function encodedAlias(key: string, value: string | undefined): Record<string, string> {
	// `value &&` first: StringUtils.isNotBlank isn't a type guard, so it alone doesn't narrow away undefined.
	return value && StringUtils.isNotBlank(value) ? {[key]: encodeURIComponent(value)} : {};
}

// A value that isn't valid percent-encoding (hand-edited, or written by draw.io itself) makes
// decodeURIComponent throw - taken as-is rather than losing the column's alias, the same fallback
// diagramFileName uses for the same reason.
function decodeAlias(value: string | undefined): string | undefined {
	// Truthiness first, since StringUtils.isBlank isn't a type guard and so doesn't narrow on its own.
	if(!value || StringUtils.isBlank(value)) {
		return undefined;
	}

	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function isColumnCell(cell: MxCell): boolean {
	return parseStyle(cell.style).shape === 'tableRow';
}

function cellToColumn(cell: MxCell): DiagramColumn {
	let style = parseStyle(cell.style);
	let tableId = cell.parent ?? '';

	let shortName = decodeAlias(style.db2wbShortName);
	let longName = decodeAlias(style.db2wbLongName);
	let description = decodeAlias(style.db2wbDescription);

	return {
		name: cell.id.startsWith(`${tableId}.`) ? cell.id.slice(tableId.length + 1) : cell.id,
		// Spread in rather than assigned so an absent alias stays absent instead of becoming an explicit
		// undefined - which would then be written back out, and would break deep-equality in tests.
		...(shortName ? {shortName: shortName} : {}),
		...(longName ? {longName: longName} : {}),
		...(description ? {description: description} : {}),
		type: style.db2wbColumnType ?? '',
		primaryKey: style.db2wbPrimaryKey === '1',
		foreignKey: style.db2wbForeignKey === '1',
		identity: style.db2wbIdentity === '1',
		// Absent on a diagram saved before these flags existed - reads back as false ("unknown, not
		// asserted"), the same honest default diagram-resolved-table.ts uses when there's nothing better to
		// go on; a Sync repopulates them like any other stale field.
		notNull: style.db2wbNotNull === '1',
		unique: style.db2wbUnique === '1',
		indexed: style.db2wbIndexed === '1',
		...(style.db2wbImported === '1' ? {imported: true} : {})
	};
}

function relationshipToCell(relationship: DiagramRelationship, fromTable: DiagramTable | undefined): MxCell {
	let cardinality = relationshipCardinality(relationship, fromTable);

	return {
		id: relationship.id,
		style: `${RELATIONSHIP_STYLE_BASE}startArrow=${ER_ARROWS[cardinality.from]};endArrow=${ER_ARROWS[cardinality.to]};`,
		edge: true,
		parent: '1',
		source: columnCellId(relationship.fromTable, relationship.fromColumn),
		target: columnCellId(relationship.toTable, relationship.toColumn),
		geometry: {relative: true}
	};
}

function cellToRelationship(cell: MxCell): DiagramRelationship {
	if(!cell.source || !cell.target) {
		throw new Error(`Relationship edge "${cell.id}" is missing a source or target.`);
	}

	let from = splitColumnCellId(cell.source);
	let to = splitColumnCellId(cell.target);

	return {id: cell.id, fromTable: from.tableId, fromColumn: from.columnName, toTable: to.tableId, toColumn: to.columnName};
}
