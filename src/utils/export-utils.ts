import { Row } from '../interfaces/row.js';
import { ColumnNameUtils } from './column-name-utils.js';

export type ExportWhat = 'loaded' | 'filtered' | 'selected' | 'all';
export type ExportFormat = 'csv' | 'json';
export type ExportDestination = 'clipboard' | 'file';

export class ExportUtils {
	// Same separator the webview dialogs use when they put several labels on one line.
	private static readonly HEADING_PART_SEPARATOR = ' / ';

	static buildDefaultFileName(namePrefix: string, format: ExportFormat): string {
		let sanitizedPrefix = namePrefix.replace(/[^A-Za-z0-9_-]/g, '_');
		let now = new Date();
		let pad = (value: number) => value.toString().padStart(2, '0');
		let timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

		return `${sanitizedPrefix}-${timestamp}.${format}`;
	}

	static buildHeadings(columns: string[], columnLabels: Record<string, string[]>): string[] {
		return columns.map(column => ColumnNameUtils.labelsForKey(columnLabels, column).join(ExportUtils.HEADING_PART_SEPARATOR));
	}

	/** CSV always has a header row. */
	static toCsv(options: ExportUtils.ToCsvOptions): string {
		let lines: string[] = [];

		lines.push(options.columns.map((column, index) => ExportUtils.escapeCsvField(options.headings[index] ?? column)).join(','));

		for(let row of options.rows) {
			lines.push(options.columns.map(column => ExportUtils.escapeCsvField(ExportUtils.formatCsvValue(row[column]))).join(','));
		}

		return lines.join('\r\n');
	}

	/** JSON never has headers - each row is a plain array of values in column order. */
	static toJson(options: ExportUtils.ToJsonOptions): string {
		let valueRows = options.rows.map(row => options.columns.map(column => ExportUtils.trimIfString(row[column] ?? null)));
		return JSON.stringify(valueRows, null, 2);
	}

	private static trimIfString(value: unknown): unknown {
		return typeof value === 'string' ? value.replace(/\s+$/, '') : value;
	}

	private static formatCsvValue(value: unknown): string {
		if(value === null || value === undefined) {
			return '';
		}

		return String(ExportUtils.trimIfString(value));
	}

	private static escapeCsvField(value: string): string {
		if(/[",\r\n]/.test(value)) {
			return `"${value.replace(/"/g, '""')}"`;
		}

		return value;
	}
}

export namespace ExportUtils {
	export interface ToCsvOptions {
		rows: Row[];
		columns: string[];
		headings: string[];
	}

	export interface ToJsonOptions {
		rows: Row[];
		columns: string[];
	}
}
