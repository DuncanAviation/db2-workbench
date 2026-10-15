import { Box, Stack, Typography } from '@mui/material';
import { SystemTable } from '../../../src/models/system-table.js';
import type { SchemasSystemTable } from '../../../src/webview-messages/schemas-messages';

interface Props {
	table: SchemasSystemTable;
}

interface FieldGroup {
	title: string;
	fields: Array<{ label: string; value: string }>;
}

function formatTimestamp(iso: string): string {
	let date = new Date(iso);
	return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

// SYSTABLES.ISOLATION - the isolation level a materialized query table's select ran under.
function describeIsolation(isolation: string): string {
	switch(isolation) {
		case 'RR': return 'Repeatable Read (*RR)';
		case 'RS': return 'Read Stability (*ALL)';
		case 'CS': return 'Cursor Stability (*CS)';
		case 'UR': return 'Uncommitted Read (*CHG)';
		case 'NC': return 'No Commit (*NONE)';
		default: return isolation;
	}
}

// The SYSTABLES columns only a materialized query table fills in - every one is null for any other table,
// so the group is left out there rather than shown as a row of dashes. The select statement itself is the
// Definition tab.
function buildMqtGroup(table: SchemasSystemTable): FieldGroup {
	return {
		title: 'Materialized Query Table',
		fields: [
			{ label: 'Maintained By', value: table.maintain },
			{ label: 'Refresh', value: table.refresh },
			{ label: 'Last Refreshed', value: table.refreshTimestamp ? formatTimestamp(table.refreshTimestamp) : 'Never' },
			{ label: 'Query Optimization', value: table.enabled },
			{ label: 'Isolation', value: describeIsolation(table.isolation) },
			{ label: 'Restore Deferred', value: table.mqtRstDfr }
		]
	};
}

function buildGroups(table: SchemasSystemTable): FieldGroup[] {
	let isMqt = SystemTable.isMqt(table);

	return [
		{
			title: 'General',
			fields: [
				{ label: 'Schema', value: table.schema },
				{ label: 'Name', value: table.name },
				{ label: 'Description', value: table.description },
				{ label: 'Remarks', value: table.remarks },
				{ label: 'Definer', value: table.definer },
				{ label: 'File Type', value: table.fileType },
				{ label: 'Location', value: table.location }
			]
		},
		{
			title: 'Storage',
			fields: [
				{ label: 'Database Name', value: table.dbName },
				{ label: 'Table Database Name', value: table.tbDbName },
				{ label: 'Table Name', value: table.tbName },
				{ label: 'Table Member', value: table.tbMember },
				{ label: 'System Table', value: table.sysTable },
				{ label: 'ASP Number', value: String(table.iaspNumber ?? '') }
			]
		},
		{
			title: 'Behavior',
			fields: [
				{ label: 'Select Omit', value: table.selectOmit },
				{ label: 'Insertable', value: table.insertable },
				{ label: 'Partitioned Table', value: table.partTable },
				{ label: 'Control', value: table.control },
				{ label: 'Temporal Type', value: table.temporalType },
				{ label: 'Drop Rule', value: table.dropRule },
				{ label: 'Decimal Float Rounding', value: table.decFltRnd }
			]
		},
		...(isMqt ? [buildMqtGroup(table)] : []),
		{
			title: 'History',
			fields: [
				{ label: 'Altered', value: formatTimestamp(table.alteredTimestamp) }
			]
		}
	];
}

export function InfoTab({ table }: Props) {
	let groups = buildGroups(table);

	return (
		<Stack spacing={2} sx={{ p: 2 }}>
			{groups.map(group => (
				<Stack key={group.title} spacing={1}>
					<Typography variant="subtitle1">{group.title}</Typography>

					<Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 2 }}>
						{group.fields.map(field => (
							<Stack key={field.label}>
								<Typography variant="subtitle2">{field.label}</Typography>
								<Typography sx={{ wordBreak: 'break-word' }}>{field.value || '—'}</Typography>
							</Stack>
						))}
					</Box>
				</Stack>
			))}
		</Stack>
	);
}
