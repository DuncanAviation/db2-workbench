import { ResolvedColumn, ResolvedForeignKey, ResolvedTable, SchemaFormatConverter } from '../schema-format-converter.js';
import { FrictionlessField, FrictionlessFieldType, FrictionlessForeignKey, FrictionlessResource } from '../frictionless-table-schema.js';
import { ImportedTableSchema } from '../schema-format-converter.js';
import { groupByConstraint } from './key-grouping.js';

function mapColumnType(dataType: string): FrictionlessFieldType {
	switch(dataType.toUpperCase()) {
		case 'SMALLINT':
		case 'INTEGER':
		case 'BIGINT':
			return 'integer';
		case 'NUMERIC':
		case 'DECIMAL':
		case 'DECFLOAT':
		case 'FLOAT':
		case 'REAL':
		case 'DOUBLE':
			return 'number';
		case 'DATE':
			return 'date';
		case 'TIME':
			return 'time';
		case 'TIMESTAMP':
			return 'datetime';
		case 'BOOLEAN':
			return 'boolean';
		case 'BLOB':
		case 'BINARY':
		case 'VARBINARY':
			return 'any';
		default:
			// CHARACTER/VARCHAR/GRAPHIC/VARGRAPHIC/CLOB/DBCLOB and anything not recognized - the DB2 type
			// name itself is still preserved in the field's description, so nothing is silently lost.
			return 'string';
	}
}

function isNegativeFlag(flag: string | undefined): boolean {
	let upper = flag?.toUpperCase();
	return upper === 'N' || upper === 'NO';
}

// Same semantics as RowEditUtils.isRequired, but ResolvedColumn's hasDefault is optional (unknown for
// an imported-only column) where SystemColumn's never is - an unknown default is treated as "don't
// know", not "no default", so an imported-only column is never marked required on uncertain grounds.
function isRequired(nulls: string, hasDefault: string | undefined): boolean {
	return isNegativeFlag(nulls) && hasDefault !== undefined && isNegativeFlag(hasDefault);
}

// Table Schema's `constraints` are per-field only - there's no table-level "unique constraint" concept
// the way SQL has, so a composite (multi-column) UNIQUE constraint has nowhere to go and is left out
// (same inherent gap as the format having no index concept at all). A single-column one maps directly
// onto that field's own `constraints.unique`.
function isSingleColumnUnique(column: ResolvedColumn, keys: ResolvedTable['keys']): boolean {
	return groupByConstraint(keys)
		.some(group => group.length === 1 && group[0].constraintType === 'UNIQUE' && group[0].systemColumnName === column.systemName);
}

// CHAR is fixed-width (DB2 always pads to `length`), so both bounds are the same value; VARCHAR/GRAPHIC/
// CLOB etc. are only bounded above. Only meaningful for the `string` field type - Table Schema's
// minLength/maxLength constraints apply to string (and array) values, not numbers.
function lengthConstraints(column: ResolvedColumn, fieldType: FrictionlessFieldType): {minLength?: number; maxLength?: number} {
	if(fieldType !== 'string' || !column.length) {
		return {};
	}

	return column.dataType.toUpperCase() === 'CHAR' || column.dataType.toUpperCase() === 'GRAPHIC'
		? {minLength: column.length, maxLength: column.length}
		: {maxLength: column.length};
}

function toResource(table: ResolvedTable): FrictionlessResource {
	let {columns, keys, foreignKeys} = table;

	let fields: FrictionlessField[] = columns.map(column => {
		let fieldType = mapColumnType(column.dataType);
		let constraints = {
			...(isRequired(column.nulls, column.hasDefault) ? {required: true} : {}),
			...(isSingleColumnUnique(column, keys) ? {unique: true} : {}),
			...lengthConstraints(column, fieldType)
		};

		return {
			name: column.systemName,
			type: fieldType,
			description: column.text || column.heading || undefined,
			constraints: Object.keys(constraints).length > 0 ? constraints : undefined,
			'x-sqlName': column.sqlName
		};
	});

	let primaryKeyColumns = keys
		.filter(key => key.constraintType === 'PRIMARY KEY')
		.sort((first, second) => first.ordinalPosition - second.ordinalPosition)
		.map(key => key.systemColumnName);

	let foreignKeysByConstraint = new Map<string, ResolvedForeignKey[]>();

	for(let foreignKey of foreignKeys) {
		// isNew (imported, no real constraint) rows have no constraintName - each is its own group.
		let groupKey = foreignKey.constraintName ?? `${foreignKey.referencedTable}:${foreignKey.systemColumnName}`;
		let group = foreignKeysByConstraint.get(groupKey) ?? [];
		group.push(foreignKey);
		foreignKeysByConstraint.set(groupKey, group);
	}

	let frictionlessForeignKeys: FrictionlessForeignKey[] = Array.from(foreignKeysByConstraint.values()).map(group => {
		let sorted = group.slice().sort((first, second) => first.ordinalPosition - second.ordinalPosition);

		return {
			fields: sorted.map(row => row.systemColumnName),
			reference: {
				resource: `${sorted[0].referencedSchema ?? ''}.${sorted[0].referencedTable}`,
				fields: sorted.map(row => row.referencedSystemColumnName)
			}
		};
	});

	return {
		name: `${table.schema}.${table.name}`,
		schema: {
			fields: fields,
			primaryKey: primaryKeyColumns.length > 0 ? primaryKeyColumns : undefined,
			foreignKeys: frictionlessForeignKeys.length > 0 ? frictionlessForeignKeys : undefined
		}
	};
}

function toStringArray(value: string | string[] | undefined): string[] {
	if(!value) {
		return [];
	}

	return Array.isArray(value) ? value : [value];
}

function splitResourceName(resourceName: string): {schema?: string; name: string} {
	let lastDot = resourceName.lastIndexOf('.');
	return lastDot === -1 ? {name: resourceName} : {schema: resourceName.slice(0, lastDot), name: resourceName.slice(lastDot + 1)};
}

function fromResource(resource: FrictionlessResource): Omit<ImportedTableSchema, 'provenance'> {
	let {schema, name} = splitResourceName(resource.name);

	return {
		schema: schema,
		name: name,
		columns: resource.schema.fields.map(field => ({
			name: field.name,
			type: field.type,
			nullable: !field.constraints?.required,
			sqlName: field['x-sqlName'],
			description: field.description
		})),
		primaryKeyColumns: toStringArray(resource.schema.primaryKey),
		// Table Schema's primaryKey/constraints.unique have no name concept at all (unlike DBML, which at
		// least has a place for one on a named indexes-block entry) - every unique key recovered here is
		// necessarily nameless.
		uniqueKeys: resource.schema.fields.filter(field => field.constraints?.unique).map(field => ({columns: [field.name]})),
		foreignKeys: (resource.schema.foreignKeys ?? []).map(foreignKey => {
			let referenced = splitResourceName(foreignKey.reference.resource);

			return {
				columns: toStringArray(foreignKey.fields),
				referencedSchema: referenced.schema,
				referencedTable: referenced.name,
				referencedColumns: toStringArray(foreignKey.reference.fields)
			};
		}),
		// Table Schema has no index concept of its own - only primaryKey/foreignKeys imply uniqueness.
		indexes: []
	};
}

export const frictionlessFormat: SchemaFormatConverter = {
	id: 'frictionless',
	label: 'Frictionless Table Schema',
	fileExtension: 'json',

	export(tables: ResolvedTable[]): string {
		let resources = tables.map(toResource);
		return JSON.stringify(resources.length === 1 ? resources[0] : resources, null, 2);
	},

	async import(content: string): Promise<Omit<ImportedTableSchema, 'provenance'>[]> {
		let parsed: FrictionlessResource | FrictionlessResource[] = JSON.parse(content);
		let resources = Array.isArray(parsed) ? parsed : [parsed];
		return resources.map(fromResource);
	}
};
