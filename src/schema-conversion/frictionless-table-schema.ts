// Minimal subset of the Frictionless "Table Schema" spec (https://datapackage.org/standard/table-schema/)
// that this project round-trips: fields, primaryKey, foreignKeys. `name` is the DB2 short/system
// column name (the real, actually-queryable identifier) - the long SQL name (sqlName) has no home in
// the spec's field shape, so it rides along as a custom `x-sqlName` property purely for human reference.
//
// Table Schema itself has no `name` for the table it describes (that lives one level up, on a Data
// Package "resource") - FrictionlessResource is that minimal resource envelope, just enough to carry
// table identity alongside the schema.

export type FrictionlessFieldType = 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'datetime' | 'time' | 'year' | 'duration' | 'any';

export interface FrictionlessField {
	name: string;
	type: FrictionlessFieldType;
	description?: string;
	constraints?: {
		required?: boolean;
		unique?: boolean;
		minLength?: number;
		maxLength?: number;
	};
	'x-sqlName'?: string;
}

export interface FrictionlessForeignKeyReference {
	resource: string;
	fields: string | string[];
}

export interface FrictionlessForeignKey {
	fields: string | string[];
	reference: FrictionlessForeignKeyReference;
}

export interface FrictionlessTableSchema {
	fields: FrictionlessField[];
	primaryKey?: string | string[];
	foreignKeys?: FrictionlessForeignKey[];
}

export interface FrictionlessResource {
	name: string;
	schema: FrictionlessTableSchema;
}
