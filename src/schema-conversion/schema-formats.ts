import { dbmlFormat } from './formats/dbml-format.js';
import { frictionlessFormat } from './formats/frictionless-format.js';
import { SchemaFormatConverter, SchemaFormatId } from './schema-format-converter.js';

export const SCHEMA_FORMATS: Record<SchemaFormatId, SchemaFormatConverter> = {
	dbml: dbmlFormat,
	frictionless: frictionlessFormat
};

// Both current formats resolve unambiguously by extension (.dbml vs .json). If a second JSON-shaped
// format is ever added, this will need to fall back to sniffing file content instead.
export function findSchemaFormatByFileName(fileName: string): SchemaFormatConverter | undefined {
	let extension = fileName.split('.').pop()?.toLowerCase();
	return Object.values(SCHEMA_FORMATS).find(format => format.fileExtension === extension);
}
