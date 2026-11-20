// No vscode/React dependency - safe to import from both extension-host code (src/) and webview code
// (webviews/), same reasoning as FieldUtils (see field-utils.ts).
export class IndexKeyUtils {
	/**
	 * Splits QSYS2.SYSPARTITIONINDEXSTAT.COLUMN_NAMES - an index's or keyed logical file's key, in key order
	 * ("JOBTYPE, JOBSTAT DESC, BILLDT") - into its keys. Two things a plain split on commas gets wrong, both
	 * seen live:
	 * - A trailing " DESC" marks a descending key, but a column may itself be named DESC: "DESC, JOBSTAT"
	 *   starts with the column DESC, and "DESC DESC" is that column descending. Only a word after the name
	 *   is a direction.
	 * - An expression key ("CHAR ( SUBSTR ( JOBNO , 1 , 4 ) , 5 )") has commas inside its parentheses, so
	 *   only a comma outside every parenthesis separates keys. Quoted names are kept whole the same way.
	 */
	static parseKeyColumns(columnNames: string | null | undefined): IndexKeyUtils.KeyColumn[] {
		return IndexKeyUtils.splitTopLevel(columnNames ?? '')
			.map(part => part.trim())
			.filter(part => part.length > 0)
			.map((part, index) => {
				let match = /^(.*\S)\s+(ASC|DESC)$/i.exec(part);
				let name = match ? match[1] : part;
				let descending = match ? match[2].toUpperCase() === 'DESC' : false;
				return {position: index + 1, name: name, descending: descending};
			});
	}

	/** The green-screen label for a key: K01, K02... with " D" after a descending one. */
	static label(key: Pick<IndexKeyUtils.KeyColumn, 'position' | 'descending'>): string {
		return `K${String(key.position).padStart(2, '0')}${key.descending ? ' D' : ''}`;
	}

	private static splitTopLevel(text: string): string[] {
		let parts: string[] = [];
		let depth = 0;
		let quoted = false;
		let start = 0;

		for(let index = 0; index < text.length; index++) {
			let char = text[index];

			if(char === '"') {
				quoted = !quoted;
			} else if(!quoted && char === '(') {
				depth++;
			} else if(!quoted && char === ')') {
				depth = Math.max(0, depth - 1);
			} else if(!quoted && depth === 0 && char === ',') {
				parts.push(text.substring(start, index));
				start = index + 1;
			}
		}

		parts.push(text.substring(start));
		return parts;
	}
}

export namespace IndexKeyUtils {
	export interface KeyColumn {
		/** 1-based place in the key. */
		position: number;
		/** The column (or, for an expression key, the expression) as COLUMN_NAMES gives it. */
		name: string;
		descending: boolean;
	}
}
