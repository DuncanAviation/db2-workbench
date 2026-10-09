import { ConnectionConfig } from '../models/connection-config.js';
import { ObjectComparator } from '../utils/object-comparator.js';
import { Event } from './event.js';

export interface ConnectionConfigEvent extends Event {
	type: Event.Type.CONNECTION_CONFIG;
	eventType: ConnectionConfigEvent.EventType;
	connectionConfig: ConnectionConfig;
	comparator?: ObjectComparator<ConnectionConfig>;
}

export namespace ConnectionConfigEvent {
	export enum EventType {
		UPDATED = 'updated',
		DELETED = 'deleted'
	}
}