import { Box, Stack, Typography } from '@mui/material';
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

function buildGroups(table: SchemasSystemTable): FieldGroup[] {
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
				{ label: 'Enabled', value: table.enabled },
				{ label: 'Maintain', value: table.maintain },
				{ label: 'Refresh', value: table.refresh },
				{ label: 'Isolation', value: table.isolation },
				{ label: 'Partitioned Table', value: table.partTable },
				{ label: 'Control', value: table.control },
				{ label: 'Temporal Type', value: table.temporalType },
				{ label: 'Drop Rule', value: table.dropRule }
			]
		},
		{
			title: 'Materialized Query Table',
			fields: [
				{ label: 'MQT Definition', value: table.mqtDef },
				{ label: 'MQT Refresh Deferred', value: table.mqtRstDfr },
				{ label: 'Decimal Float Rounding', value: table.decFltRnd }
			]
		},
		{
			title: 'History',
			fields: [
				{ label: 'Altered', value: formatTimestamp(table.alteredTimestamp) },
				{ label: 'Refreshed', value: formatTimestamp(table.refreshTimestamp) }
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
