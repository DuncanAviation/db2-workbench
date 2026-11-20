import type { MouseEvent } from 'react';
import { Link } from '@mui/material';
import { schemasVsCodeApi } from '../vscode-api';

interface Props {
	schema: string | undefined;
	table: string | undefined;
}

// A table name in a key tab (Foreign Keys, Referenced By) that opens that table's own tab. The host does
// the opening (see OpenTableMessage), so a table in a schema the panel doesn't list yet still opens. A
// row with no schema (an import that named only the table) has nothing to open, so it stays plain text.
export function TableLink({ schema, table }: Props) {
	if (!schema || !table) {
		return <>{table ?? ''}</>;
	}

	let target = { schema: schema, table: table };

	function handleClick(event: MouseEvent) {
		// The row's own click (selection) has nothing to do with opening another table.
		event.stopPropagation();
		schemasVsCodeApi.postMessage({ command: 'openTable', ...target });
	}

	return (
		<Link component="button" type="button" onClick={handleClick} title={`Open ${schema}.${table}`} sx={{ fontSize: 'inherit', verticalAlign: 'baseline' }}>
			{table}
		</Link>
	);
}
