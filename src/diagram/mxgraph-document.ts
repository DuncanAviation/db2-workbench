import { js2xml, xml2js } from 'xml-js';
import { ArrayUtils } from '../utils/array-utils.js';
import { StringUtils } from '../utils/string-utils.js';

// Generic mxGraph (draw.io) document model - knows nothing about tables/columns/schemas, only the
// underlying cell/geometry shape every .drawio file is built from. The diagram-specific mapping
// (src/diagram/diagram-xml.ts) is a separate layer on top of this one, so each is independently testable:
// this layer answers "can we read/write a valid mxGraph document at all," the layer above answers
// "does our diagram model map to/from it correctly."

export interface MxGeometry {
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	// Edge geometries are always relative (no fixed x/y/width/height of their own) - see MxCell.geometry.
	relative?: boolean;
}

export interface MxCell {
	id: string;
	parent?: string;
	value?: string;
	style?: string;
	vertex?: boolean;
	edge?: boolean;
	connectable?: boolean;
	source?: string;
	target?: string;
	geometry?: MxGeometry;
	// Present only for a cell that round-trips as an <object>-wrapped mxCell (draw.io's convention for
	// attaching custom key/value data to a shape, editable via its own "Edit Data" dialog) - e.g.
	// {schema: 'SALES', tableId: 'SALES.CUSTOMER'}. Column-level metadata deliberately does NOT use this -
	// see diagram-xml.ts for why (draw.io's table-layout engine silently strips row-level object wrappers).
	data?: Record<string, string>;
}

export interface MxGraphDocument {
	cells: MxCell[];
}

// The two cells every valid mxGraphModel needs (an invisible root container and the default layer) -
// pure mxGraph plumbing, never meaningful to the diagram domain layer above. Stripped on parse, always
// injected fresh on serialize, so nothing above this module ever has to think about them.
const ROOT_CELL_ID = '0';
const DEFAULT_LAYER_ID = '1';

const MXFILE_ATTRIBUTES = {host: 'db2-workbench'};
const GRAPH_MODEL_ATTRIBUTES = {
	dx: '800', dy: '600', grid: '1', gridSize: '10', guides: '1', tooltips: '1', connect: '1',
	arrows: '1', fold: '1', page: '1', pageScale: '1', pageWidth: '850', pageHeight: '1100',
	math: '0', shadow: '0'
};

export function parseMxGraphDocument(xml: string): MxGraphDocument {
	if(StringUtils.isBlank(xml)) {
		return {cells: []};
	}

	let parsed = xml2js(xml, {compact: true}) as MxGraphXml.ParsedRoot;
	let root = parsed.mxfile?.diagram?.mxGraphModel?.root;

	if(root == null) {
		return {cells: []};
	}

	let plainCells = ArrayUtils.toArray(root.mxCell ?? []).map(elementToCell);
	let objectCells = ArrayUtils.toArray(root.object ?? []).map(element => elementToCell(objectElementToCellElement(element)));

	return {
		cells: [...plainCells, ...objectCells]
			.filter(cell => cell.id !== ROOT_CELL_ID && !(cell.id === DEFAULT_LAYER_ID && cell.parent === ROOT_CELL_ID && !cell.vertex && !cell.edge))
	};
}

export function serializeMxGraphDocument(document: MxGraphDocument): string {
	let plainCellElements: MxGraphXml.CellElement[] = [];
	let objectElements: MxGraphXml.ObjectElement[] = [];

	for(let cell of document.cells) {
		let element = cellToElement(cell);

		if(element.object) {
			objectElements.push(element.object);
		} else {
			plainCellElements.push(element.mxCell);
		}
	}

	let root: MxGraphXml.RootElement = {
		mxCell: [
			{_attributes: {id: ROOT_CELL_ID}},
			{_attributes: {id: DEFAULT_LAYER_ID, parent: ROOT_CELL_ID}},
			...plainCellElements
		],
		object: objectElements
	};

	let parsedRoot: MxGraphXml.ParsedRoot = {
		mxfile: {
			_attributes: MXFILE_ATTRIBUTES,
			diagram: {
				_attributes: {name: 'Page-1', id: 'diagram-1'},
				mxGraphModel: {
					_attributes: GRAPH_MODEL_ATTRIBUTES,
					root: root
				}
			}
		}
	};

	return js2xml(escapeAttributesDeep(parsedRoot), {compact: true, spaces: 2});
}

// js2xml has no attribute-value escaping of its own - confirmed empirically (xml2js decodes entities on
// the way in, but js2xml never encodes them on the way out), so a value like "Sales & Marketing" would
// otherwise be written straight into an attribute and produce invalid XML. Rather than remembering to
// escape at every individual attribute assignment above, this walks the whole structure once, right
// before handing it to js2xml, and escapes every string found under an `_attributes` key - one choke
// point instead of many places that could silently forget.
function escapeAttributesDeep(node: unknown): object {
	if(Array.isArray(node)) {
		return node.map(escapeAttributesDeep) as unknown as object;
	}

	if(!(typeof node === 'object' && node !== null)) {
		return node as object;
	}

	let result: Record<string, unknown> = {};

	for(let [key, value] of Object.entries(node as Record<string, unknown>)) {
		if(key === '_attributes' && (typeof value === 'object' && value !== null)) {
			result[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([attributeName, attributeValue]) => [attributeName, escapeXmlAttribute(attributeValue as string | undefined)]));
		} else {
			result[key] = escapeAttributesDeep(value);
		}
	}

	return result;
}

function escapeXmlAttribute(value: string | undefined): string | undefined {
	if(value === undefined) {
		return undefined;
	}

	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

// Folds an <object schema="..." tableId="..." id="..."><mxCell .../></object> wrapper down into a plain
// cell element: the object's own attributes (minus `label`, which becomes the cell's value, and `id`,
// which wins over any id on the inner mxCell - matching draw.io's own convention) become MxCell.data.
function objectElementToCellElement(element: MxGraphXml.ObjectElement): MxGraphXml.CellElement {
	let {label, id, ...data} = element._attributes;

	return {
		...element.mxCell,
		_attributes: {...element.mxCell._attributes, id: id, value: element.mxCell._attributes.value ?? label},
		_data: data != null ? data : undefined
	};
}

function elementToCell(element: MxGraphXml.CellElement): MxCell {
	let attributes = element._attributes;
	let geometryAttributes = element.mxGeometry?._attributes;
	let id = attributes.id;

	if(!id) {
		throw new Error('Encountered an mxCell with no id - not a valid mxGraph document.');
	}

	return {
		id: id,
		parent: attributes.parent,
		value: attributes.value,
		style: attributes.style,
		vertex: attributes.vertex === '1',
		edge: attributes.edge === '1',
		connectable: attributes.connectable === undefined ? undefined : attributes.connectable === '1',
		source: attributes.source,
		target: attributes.target,
		geometry: geometryAttributes ? {
			x: numberOrUndefined(geometryAttributes.x),
			y: numberOrUndefined(geometryAttributes.y),
			width: numberOrUndefined(geometryAttributes.width),
			height: numberOrUndefined(geometryAttributes.height),
			relative: geometryAttributes.relative === '1'
		} : undefined,
		data: element._data
	};
}

function cellToElement(cell: MxCell): {mxCell: MxGraphXml.CellElement; object?: MxGraphXml.ObjectElement} {
	let geometry: MxGraphXml.GeometryElement | undefined = cell.geometry ? {
		_attributes: {
			...(cell.geometry.x !== undefined ? {x: String(cell.geometry.x)} : {}),
			...(cell.geometry.y !== undefined ? {y: String(cell.geometry.y)} : {}),
			...(cell.geometry.width !== undefined ? {width: String(cell.geometry.width)} : {}),
			...(cell.geometry.height !== undefined ? {height: String(cell.geometry.height)} : {}),
			...(cell.geometry.relative ? {relative: '1'} : {}),
			as: 'geometry'
		}
	} : undefined;

	// Shared by both branches below - everything except id/value, since those two are the only fields
	// that move from the mxCell to the wrapping <object> once this cell carries custom data.
	let sharedAttributes: Record<string, string> = {
		...(cell.style !== undefined ? {style: cell.style} : {}),
		...(cell.parent !== undefined ? {parent: cell.parent} : {}),
		...(cell.vertex ? {vertex: '1'} : {}),
		...(cell.edge ? {edge: '1'} : {}),
		...(cell.connectable === false ? {connectable: '0'} : {}),
		...(cell.source !== undefined ? {source: cell.source} : {}),
		...(cell.target !== undefined ? {target: cell.target} : {})
	};

	if(!cell.data) {
		return {
			mxCell: {
				_attributes: {id: cell.id, ...(cell.value !== undefined ? {value: cell.value} : {}), ...sharedAttributes},
				...(geometry ? {mxGeometry: geometry} : {})
			}
		};
	}

	let mxCellElement: MxGraphXml.CellElement = {_attributes: sharedAttributes, ...(geometry ? {mxGeometry: geometry} : {})};

	let objectElement: MxGraphXml.ObjectElement = {
		_attributes: {id: cell.id, ...(cell.value !== undefined ? {label: cell.value} : {}), ...cell.data},
		mxCell: mxCellElement
	};

	return {mxCell: mxCellElement, object: objectElement};
}

function numberOrUndefined(value: string | undefined): number | undefined {
	return value === undefined ? undefined : Number(value);
}

// Shapes matching xml-js's "compact" mode exactly (see the library's own docs) - kept file-local since
// nothing outside this module should ever touch raw xml-js structures.
namespace MxGraphXml {
	export interface CellElement {
		_attributes: Record<string, string | undefined>;
		mxGeometry?: GeometryElement;
		// Not part of the real XML shape - only ever set transiently by objectElementToCellElement, to
		// carry an object-wrapped cell's custom data through to elementToCell.
		_data?: Record<string, string>;
	}

	export interface GeometryElement {
		_attributes: Record<string, string>;
	}

	export interface ObjectElement {
		_attributes: Record<string, string> & {id: string};
		mxCell: CellElement;
	}

	export interface RootElement {
		// xml-js's compact mode gives a bare element (not a 1-item array) when only one sibling of that
		// tag exists in the source XML - ArrayUtils.toArray normalizes both shapes below.
		mxCell?: CellElement | CellElement[];
		object?: ObjectElement | ObjectElement[];
	}

	export interface ParsedRoot {
		mxfile?: {
			_attributes?: Record<string, string>;
			diagram?: {
				_attributes?: Record<string, string>;
				mxGraphModel?: {
					_attributes?: Record<string, string>;
					root?: RootElement;
				};
			};
		};
	}
}
