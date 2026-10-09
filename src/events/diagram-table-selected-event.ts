import { Event } from './event.js';

// Fired when a table is clicked in a diagram editor (not a column click - that's a separate,
// diagram-local relationship-highlighting interaction, not something other consumers need to know
// about). Consumed by ExtensionApi to re-emit as the public onDiagramTableSelected event - the same
// event-bus-mediated pattern DbConnectionEvent already uses for onStatementExecuted, so a future
// "jump to this table in the schema browser" feature (or a companion extension) has something real to
// listen to without DiagramEditorProvider needing to know about it.
export interface DiagramTableSelectedEvent extends Event {
	type: Event.Type.DIAGRAM_TABLE_SELECTED;
	documentUri: string;
	schema: string;
	table: string;
}
