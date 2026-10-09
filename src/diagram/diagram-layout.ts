import ElkModule, { ELK as ElkInstance, ELKConstructorArguments, ElkNode } from 'elkjs';

// elkjs's own .d.ts re-exports its default (`export * from './elk-api'; import X from './elk-api'; export
// default X;`) in a shape TypeScript's Node16 module resolution mistypes as the whole module namespace
// instead of the constructor `X` actually names - a declaration-file quirk, not a runtime one: Node's real
// ESM/CJS interop for a plain default import already binds `ElkModule` to elkjs's `module.exports` (the
// constructor itself), confirmed by inspecting node_modules/elkjs/lib/elk-api.js directly. The cast below
// corrects only the TYPE to what elk-api.d.ts already declares it to be; it changes nothing at runtime.
type ElkConstructor = new (args?: ELKConstructorArguments) => ElkInstance;
const ELK = ElkModule as unknown as ElkConstructor;

// The one place elkjs is imported anywhere in the codebase - every caller (new-diagram/export,
// add-to-existing, "Rearrange Tables") goes through layoutTables below instead of touching ELK
// directly, so swapping layout engines later only means rewriting this file. Pure (no vscode, no
// DiagramModel, no undo) - what to DO with a layout (merge into a model, serialize to .drawio, diff
// against the current arrangement) is entirely the caller's job.
//
// elkjs's own license is EPL-2.0 OR GPL-3.0-or-later (a choice, not a combination) - this project
// elects EPL-2.0, which only carries copyleft obligations for the EPL-covered files themselves, not for
// code that merely depends on it. See the diagram-layout-library-license-decision memory for the
// pre-open-source TODO this creates (third-party notices).
const elk = new ELK();

// Mirrors diagram-add-tables.ts's own geometry constants (TABLE_GAP/SCHEMA_PADDING/SCHEMA_GAP), which in
// turn mirror diagram-xml.ts/layout-constants.ts - same convention as those, a small enough duplication
// that a single shared source isn't worth the coupling.
const SCHEMA_PADDING = 40;
const SCHEMA_PADDING_TOP = 60;
const TABLE_GAP = 40;

export interface LayoutNode {
	id: string;
	// Doubles as the group's own id - the set of groups is whatever distinct groupIds appear here, in
	// first-seen order, so there's no separate group list to keep in sync with the nodes.
	groupId: string;
	width: number;
	height: number;
}

export interface LayoutEdge {
	fromId: string;
	toId: string;
}

export interface LayoutBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface LayoutResult {
	positions: Map<string, {x: number; y: number}>;
	groupBounds: Map<string, LayoutBounds>;
}

/**
 * Lays out every node in `nodes` from scratch, grouped into boxes by `groupId` (a schema, on a real
 * diagram) - nothing is pinned, so this is only for a fresh arrangement of the WHOLE set handed in: a
 * new diagram, an export straight from the schema browser, or a "Rearrange Tables" pass over everything
 * already on the canvas. Placing new tables into an EXISTING diagram without disturbing what's already
 * there is a different, not-yet-built problem (needs pinned/fixed nodes, which this function doesn't
 * support) - see the diagram-layout-library-license-decision memory.
 *
 * Uses ELK's hierarchical layout (`elk.hierarchyHandling: INCLUDE_CHILDREN`): each group is a compound
 * node whose own bounds are derived from its children, and an edge between two DIFFERENT groups is
 * still routed correctly (confirmed by spike - plain per-group layout can't do this at all, since each
 * group would be laid out with no knowledge the other group's node even exists).
 */
export async function layoutTables(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Promise<LayoutResult> {
	if(nodes.length === 0) {
		return {positions: new Map(), groupBounds: new Map()};
	}

	// A Map preserves insertion order, so iterating its entries below yields groups in the same
	// first-seen order the nodes arrived in - no separate ordered id list needed to keep in sync.
	let nodesByGroup = new Map<string, LayoutNode[]>();

	for(let node of nodes) {
		let existing = nodesByGroup.get(node.groupId);

		if(existing) {
			existing.push(node);
		} else {
			nodesByGroup.set(node.groupId, [node]);
		}
	}

	let graph: ElkNode = {
		id: 'root',
		layoutOptions: {
			'elk.algorithm': 'layered',
			'elk.hierarchyHandling': 'INCLUDE_CHILDREN'
		},
		children: [...nodesByGroup.entries()].map(([groupId, groupNodes]) => ({
			id: groupId,
			layoutOptions: {
				'elk.algorithm': 'layered',
				'elk.padding': `[top=${SCHEMA_PADDING_TOP},left=${SCHEMA_PADDING},bottom=${SCHEMA_PADDING},right=${SCHEMA_PADDING}]`,
				'elk.spacing.nodeNode': String(TABLE_GAP),
				'elk.layered.spacing.nodeNodeBetweenLayers': String(TABLE_GAP)
			},
			children: groupNodes.map(node => ({id: node.id, width: node.width, height: node.height}))
		})),
		edges: edges.map((edge, index) => ({id: `e${index}`, sources: [edge.fromId], targets: [edge.toId]}))
	};

	let result = await elk.layout(graph);

	let positions = new Map<string, {x: number; y: number}>();
	let groupBounds = new Map<string, LayoutBounds>();

	for(let group of result.children ?? []) {
		let groupX = group.x ?? 0;
		let groupY = group.y ?? 0;

		groupBounds.set(group.id, {x: groupX, y: groupY, width: group.width ?? 0, height: group.height ?? 0});

		// ELK reports a child's x/y relative to its own parent's origin, not the overall canvas - has to be
		// translated by the group's own absolute position to land in the same coordinate space every other
		// group's tables are in.
		for(let table of group.children ?? []) {
			positions.set(table.id, {x: groupX + (table.x ?? 0), y: groupY + (table.y ?? 0)});
		}
	}

	return {positions: positions, groupBounds: groupBounds};
}
