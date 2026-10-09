import { DbErrorUtils } from '../../../utils/db-error-utils.js';
import { StringUtils } from '../../../utils/string-utils.js';
import { FakeDatabase, FakeTable, findTable } from './fake-database.js';

/**
 * INSERT/UPDATE/DELETE against a FakeDatabase's rows, so the schema browser's row editing can be
 * exercised end to end: build the statement with RowEditUtils, run it through
 * DataQueries.executeStatements, then read the table back and see exactly which row changed.
 *
 * Deliberately not a SQL engine. It understands exactly the shape RowEditUtils generates - delimited
 * identifiers, literal values, and a WHERE built from key equalities joined by AND - and **throws**
 * on anything else, for the same reason FakeDriver throws on a statement no fixture covers: a fake
 * that quietly did nothing would let a row-editing test pass while proving nothing.
 *
 * What it therefore does not prove: that the generated SQL is valid DB2, that the database would
 * accept a value as typed, or that a constraint would have rejected the edit. The statement text is
 * asserted separately for that reason, and live verification of a real edit is still owed.
 */
export class FakeDml {
	// Row numbers are handed out per table and never reused, so deleting a row does not renumber the
	// rows after it - matching RRN(), which is a physical position on a real system rather than an
	// ordinal into the current result. Keyed by row identity, since an UPDATE mutates the row object
	// in place and must keep its number.
	private rowNumbers = new WeakMap<Record<string, unknown>, number>();
	private nextRowNumbers = new Map<FakeTable, number>();

	constructor(private database: FakeDatabase) {}

	/** Whether this statement is one to apply rather than one to resolve to rows. */
	static isDml(normalized: string): boolean {
		return /^(insert|update|delete)\b/.test(normalized);
	}

	/** RRN(table) for a row - the value the synthetic "$RRN" fallback key column carries. */
	rowNumber(table: FakeTable, row: Record<string, unknown>): number {
		this.assignRowNumbers(table);
		return <number>this.rowNumbers.get(row);
	}

	/** Applies the statement to the fixture and returns the number of rows it affected. */
	apply(sql: string): number {
		let statement = sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
		let insert = /^insert\s+into\s+(.+?)\s*\((.+?)\)\s*values\s*\((.+)\)$/is.exec(statement);

		if(insert) {
			return this.applyInsert(insert[1], insert[2], insert[3]);
		}

		let update = /^update\s+(.+?)\s+set\s+(.+)$/is.exec(statement);

		if(update) {
			let [assignments, where] = FakeDml.splitAtWhere(update[2]);
			return this.applyUpdate(update[1], assignments, where);
		}

		let remove = /^delete\s+from\s+(.+)$/is.exec(statement);

		if(remove) {
			let [target, where] = FakeDml.splitAtWhere(remove[1]);
			return this.applyDelete(target, where);
		}

		throw FakeDml.error(`FakeDml: cannot apply statement: ${statement}`);
	}

	private applyInsert(target: string, columnList: string, valueList: string): number {
		let table = this.findTable(target);
		let columns = FakeDml.splitTopLevel(columnList, ',').map(column => FakeDml.readIdentifier(column));
		let values = FakeDml.splitTopLevel(valueList, ',').map(value => FakeDml.readLiteral(value));

		if(columns.length !== values.length) {
			throw FakeDml.error(`FakeDml: ${columns.length} columns but ${values.length} values.`);
		}

		let row: Record<string, unknown> = {};
		columns.forEach((column, index) => row[column] = values[index]);

		this.assignRowNumbers(table);
		let rowNumber = <number>this.nextRowNumbers.get(table);
		this.rowNumbers.set(row, rowNumber);
		this.nextRowNumbers.set(table, rowNumber + 1);
		table.rows.push(row);

		return 1;
	}

	private applyUpdate(target: string, assignmentList: string, where: string): number {
		let table = this.findTable(target);
		let matched = this.selectRows(table, where);
		let assignments = FakeDml.splitTopLevel(assignmentList, ',').map(assignment => {
			let parts = FakeDml.splitTopLevel(assignment, '=');

			if(parts.length !== 2) {
				throw FakeDml.error(`FakeDml: cannot read assignment: ${assignment}`);
			}

			return { column: FakeDml.readIdentifier(parts[0]), value: FakeDml.readLiteral(parts[1]) };
		});

		for(let row of matched) {
			for(let assignment of assignments) {
				row[assignment.column] = assignment.value;
			}
		}

		return matched.length;
	}

	private applyDelete(target: string, where: string): number {
		let table = this.findTable(target);
		let matched = this.selectRows(table, where);

		for(let row of matched) {
			table.rows.splice(table.rows.indexOf(row), 1);
		}

		return matched.length;
	}

	/**
	 * The rows a WHERE built of key equalities selects. Values are compared as text, since a fixture
	 * declares a numeric key as the number it is while a generated statement carries whatever the user
	 * typed into the dialog.
	 */
	private selectRows(table: FakeTable, where: string): Record<string, unknown>[] {
		let predicates = FakeDml.splitTopLevel(where, ' and ').map(predicate => FakeDml.readPredicate(predicate));

		if(predicates.length === 0) {
			throw FakeDml.error('FakeDml: refusing a statement with no WHERE clause.');
		}

		this.assignRowNumbers(table);

		return table.rows.filter(row => predicates.every(predicate => predicate.isRrn
			? this.rowNumbers.get(row) === Number(predicate.value)
			: String(row[predicate.column]) === String(predicate.value)));
	}

	private findTable(target: string): FakeTable {
		let parts = FakeDml.splitTopLevel(target, '.').map(part => FakeDml.readIdentifier(part));
		let found = parts.length === 2 ? findTable(this.database, parts[0], parts[1]) : findTable(this.database, undefined, parts[0]);

		if(!found) {
			throw FakeDml.error(`FakeDml: no table ${target} in the fixture.`);
		}

		return found.table;
	}

	private assignRowNumbers(table: FakeTable): void {
		if(this.nextRowNumbers.has(table)) {
			return;
		}

		table.rows.forEach((row, index) => this.rowNumbers.set(row, index + 1));
		this.nextRowNumbers.set(table, table.rows.length + 1);
	}

	/** `"COL" = <literal>`, or the `RRN(table) = <number>` form the $RRN fallback key produces. */
	private static readPredicate(predicate: string): { column: string; value: unknown; isRrn: boolean } {
		let rrn = /^rrn\s*\(.+?\)\s*=\s*(.+)$/is.exec(predicate.trim());

		if(rrn) {
			return { column: '', value: FakeDml.readLiteral(rrn[1]), isRrn: true };
		}

		let parts = FakeDml.splitTopLevel(predicate, '=');

		if(parts.length !== 2) {
			throw FakeDml.error(`FakeDml: cannot read predicate: ${predicate}`);
		}

		return { column: FakeDml.readIdentifier(parts[0]), value: FakeDml.readLiteral(parts[1]), isRrn: false };
	}

	/** A delimited identifier with its doubled quotes collapsed; a bare name is accepted too. */
	private static readIdentifier(text: string): string {
		let trimmed = text.trim();
		let delimited = /^"(.*)"$/s.exec(trimmed);
		return delimited ? delimited[1].replace(/""/g, '"') : trimmed.toUpperCase();
	}

	/** NULL, a boolean, a quoted string (doubled quotes collapsed) or a number. */
	private static readLiteral(text: string): unknown {
		let trimmed = text.trim();

		if(StringUtils.equalsIgnoreCase(trimmed, 'null')) {
			return null;
		}

		if(StringUtils.equalsIgnoreCase(trimmed, 'true') || StringUtils.equalsIgnoreCase(trimmed, 'false')) {
			return StringUtils.equalsIgnoreCase(trimmed, 'true');
		}

		let quoted = /^'(.*)'$/s.exec(trimmed);

		if(quoted) {
			return quoted[1].replace(/''/g, '\'');
		}

		let numeric = Number(trimmed);

		if(StringUtils.isNotBlank(trimmed) && !Number.isNaN(numeric)) {
			return numeric;
		}

		throw FakeDml.error(`FakeDml: cannot read value: ${trimmed}`);
	}

	/** Splits the SET clause from the WHERE clause, ignoring a "where" inside a string literal. */
	private static splitAtWhere(text: string): [string, string] {
		let parts = FakeDml.splitTopLevel(text, ' where ');

		if(parts.length !== 2) {
			throw FakeDml.error(`FakeDml: expected exactly one WHERE clause in: ${text}`);
		}

		return [parts[0], parts[1]];
	}

	/**
	 * Splits on a separator that is outside both string literals and parentheses - the commas of a
	 * VALUES list, the AND between the halves of a two-column key, the = of one assignment. A plain
	 * split() would cut a value like 'Smith, John' in half, or an RRN(TABLE) predicate at its
	 * parentheses.
	 */
	private static splitTopLevel(text: string, separator: string): string[] {
		let parts: string[] = [];
		let current = '';
		let inString = false;
		let depth = 0;
		let position = 0;

		while(position < text.length) {
			let character = text[position];

			if(inString) {
				// A doubled quote inside a literal is an escaped quote, not the end of the literal.
				if(character === '\'' && text[position + 1] === '\'') {
					current += '\'\'';
					position += 2;
					continue;
				}

				inString = character !== '\'';
				current += character;
				position++;
				continue;
			}

			if(character === '\'') {
				inString = true;
				current += character;
				position++;
				continue;
			}

			if(character === '(') {
				depth++;
			}

			if(character === ')') {
				depth--;
			}

			if(depth === 0 && text.slice(position, position + separator.length).toLowerCase() === separator.toLowerCase()) {
				parts.push(current);
				current = '';
				position += separator.length;
				continue;
			}

			current += character;
			position++;
		}

		parts.push(current);

		return parts.map(part => part.trim()).filter(part => StringUtils.isNotBlank(part));
	}

	private static error(message: string): Error {
		let thrown = <Error & { driverErrors?: DbErrorUtils.DbErrorDetail[] }>new Error(message);
		thrown.driverErrors = [{ code: -1, state: 'HY000', message: message }];
		return thrown;
	}
}
