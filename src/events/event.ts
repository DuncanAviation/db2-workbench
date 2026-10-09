export interface Event {
	type: Event.Type;
}

export namespace Event {
	export enum Type {
		CONNECTION_CONFIG = 'connection-config',
		DB_CONNECTION = 'db-connection',
		DIAGRAM_TABLE_SELECTED = 'diagram-table-selected',
		SCHEMA_TREE_CHANGED = 'schema-tree-changed'
	}
}