import { Event } from './event.js';

// Fired whenever the schema tree for a connection changes in a way every panel showing that tree needs
// to know about: an "Edit Schema List" save, a schema import, or an imported table being discarded. The
// state itself lives in SchemaTrees (one store per connection config, shared by the schema browser and
// every diagram) - this event only says "rebuild yours", carrying the config id so a panel pointed at a
// different connection can ignore it.
//
// Goes through EventManager rather than SchemaTrees calling into the providers for the same reason
// DbConnectionEvent does: SchemaTrees has no business knowing which panel kinds exist, and a third one
// (or a companion extension) can listen without it changing. It's also what makes the originating panel
// and every other one take the SAME path - the provider that handled the action doesn't push its own
// update, it just reacts to this like anybody else.
export interface SchemaTreeChangedEvent extends Event {
	type: Event.Type.SCHEMA_TREE_CHANGED;
	configId: string;
}
