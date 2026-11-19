import { Box, Stack, Typography } from '@mui/material';
import { SystemView } from '../../../src/models/system-view.js';
import { IndexKeyUtils } from '../../../src/utils/index-key-utils.js';
import type { SchemasLogicalFile, SchemasSystemView } from '../../../src/webview-messages/schemas-messages';
import { SqlErrorDisplay } from '../../shared/components/sql-error-display';
import type { FieldGroup } from './field-groups';
import { FieldGroups } from './field-groups';
import { useLogicalFile } from './logical-file-data';

interface Props {
	view: SchemasSystemView;
}

// SYSVIEWS' CHECK column - N/C/L rather than anything readable.
function describeCheckOption(checkOption: string | undefined): string | undefined {
	switch(checkOption) {
		case 'N': return 'None';
		case 'C': return 'Cascaded';
		case 'L': return 'Local';
		default: return checkOption;
	}
}

function buildGroups(view: SchemasSystemView): FieldGroup[] {
	return [
		{
			title: 'General',
			fields: [
				{ label: 'Schema', value: view.schema },
				{ label: 'Name', value: view.name },
				{ label: 'SQL Schema', value: view.sqlSchema },
				{ label: 'SQL Name', value: view.sqlName },
				{ label: 'Description', value: view.description },
				{ label: 'Remarks', value: view.remarks },
				{ label: 'Owner', value: view.owner },
				{ label: 'Definer', value: view.definer ?? '' }
			]
		},
		{
			title: 'Behavior',
			fields: [
				{ label: 'Insertable', value: view.insertable },
				{ label: 'Updatable', value: view.updatable ?? '' },
				{ label: 'Deletable', value: view.deletable ?? '' },
				{ label: 'Check Option', value: describeCheckOption(view.checkOption) ?? '' },
				{ label: 'Decimal Float Rounding', value: view.decFltRnd ?? '' }
			]
		},
		{
			title: 'Storage',
			fields: [
				{ label: 'Sequence Number', value: String(view.sequenceNumber ?? '') },
				{ label: 'ASP Number', value: String(view.iaspNumber ?? '') }
			]
		}
	];
}

// A logical file has no SYSVIEWS row. Its own SYSTABLES row (what the tree carried) shows at once; its
// SYSFILES row - based-on files, access path, record format - joins it when the host's lookup answers.
function buildLogicalFileGroups(file: SchemasSystemView, detail: SchemasLogicalFile | undefined): FieldGroup[] {
	let groups: FieldGroup[] = [
		{
			title: 'General',
			fields: [
				{ label: 'Schema', value: file.schema },
				{ label: 'Name', value: file.name },
				{ label: 'SQL Schema', value: file.sqlSchema },
				{ label: 'SQL Name', value: file.sqlName },
				{ label: 'Description', value: file.description },
				{ label: 'Remarks', value: file.remarks },
				{ label: 'Owner', value: file.owner },
				...(detail ? [{ label: 'Last Altered', value: detail.alteredTimestamp ?? '' }] : [])
			]
		}
	];

	if (detail) {
		groups.push(
			{
				title: 'Based On',
				fields: detail.basedOn.length > 0
					? detail.basedOn.map((based, index) => ({ label: detail.basedOn.length > 1 ? `File ${index + 1}` : 'File', value: describeBasedOn(based) }))
					: [{ label: 'File', value: '' }]
			},
			{
				title: 'Access Path',
				fields: [
					{ label: 'Type', value: detail.accessPathType ?? '' },
					{ label: 'Key Field Count', value: detail.keyFieldCount ? String(detail.keyFieldCount) : '' },
					{ label: 'Maintenance', value: detail.maintenance ?? '' },
					{ label: 'Select/Omit', value: detail.selectOmit ? 'Yes' : 'No' },
					{ label: 'Dynamic Selection', value: detail.dynamicSelection ? 'Yes' : 'No' },
					{ label: 'Join Logical File', value: detail.joinLogical ? 'Yes' : 'No' }
				]
			}
		);

		let keys = IndexKeyUtils.parseKeyColumns(detail.keyFields);

		if (keys.length > 0) {
			groups.push({ title: 'Key Fields', fields: [], content: <KeyFieldList keys={keys} /> });
		}
	} else {
		groups.push({
			title: 'Behavior',
			fields: [
				{ label: 'Select/Omit', value: file.selectOmit === 'Y' ? 'Yes' : 'No' }
			]
		});
	}

	groups.push({
		title: 'Storage',
		fields: [
			{ label: 'Insertable', value: file.insertable },
			...(detail ? [{ label: 'Record Format', value: detail.formatName ?? '' }] : []),
			{ label: 'ASP Number', value: String(file.iaspNumber ?? '') }
		]
	});

	return groups;
}

// How many keys show before the list scrolls - a file can have up to 120, and the groups below shouldn't
// be pushed off the tab by them.
const VISIBLE_KEY_ROWS = 8;
const KEY_ROW_HEIGHT = 28;

// The key in key order, labelled as the green screen labels it (K01, K02...). Its own group rather than
// fields in the Access Path grid, which wraps - numbered tiles there would scatter the order across rows
// and push the other fields in among them.
function KeyFieldList({ keys }: { keys: IndexKeyUtils.KeyColumn[] }) {
	return (
		<Box
			component="ol"
			aria-label="Key fields"
			sx={{
				m: 0, p: 0, listStyle: 'none', maxWidth: 480,
				maxHeight: VISIBLE_KEY_ROWS * KEY_ROW_HEIGHT, overflowY: 'auto',
				border: 1, borderColor: 'divider', borderRadius: 1
			}}
		>
			{keys.map(key => (
				<Stack component="li" key={key.position} direction="row" spacing={2} sx={{ alignItems: 'center', height: KEY_ROW_HEIGHT, px: 1, boxSizing: 'border-box' }}>
					<Typography variant="body2" color="text.secondary" sx={{ fontFamily: 'monospace', minWidth: '3.5em' }}>{IndexKeyUtils.label({ position: key.position, descending: false })}</Typography>
					<Typography variant="body2" noWrap sx={{ flexGrow: 1, minWidth: 0 }} title={key.name}>{key.name}</Typography>
					{key.descending && <Typography variant="body2" color="text.secondary">Descending</Typography>}
				</Stack>
			))}
		</Box>
	);
}

function describeBasedOn(based: SchemasLogicalFile['basedOn'][number]): string {
	let parts = [`${based.library}/${based.file}`];

	if (based.member && based.member !== based.file) {
		parts.push(`member ${based.member}`);
	}

	if (based.format) {
		parts.push(`format ${based.format}`);
	}

	return parts.join(', ');
}

function LogicalFileInfo({ file }: { file: SchemasSystemView }) {
	const loaded = useLogicalFile({ schema: file.schema, name: file.name });

	return (
		<>
			<FieldGroups groups={buildLogicalFileGroups(file, loaded.value?.file)} />
			{loaded.error && (
				<Stack sx={{ px: 2, pb: 2 }}>
					<SqlErrorDisplay error={loaded.error} label="Failed to read the logical file's description from QSYS2.SYSFILES" />
				</Stack>
			)}
		</>
	);
}

// Same layout as the table InfoTab, over SYSVIEWS' fields instead of SYSTABLES' - or, for a logical file,
// over its SYSTABLES and SYSFILES rows.
export function ViewInfoTab({ view }: Props) {
	return SystemView.isLogicalFile(view) ? <LogicalFileInfo file={view} /> : <FieldGroups groups={buildGroups(view)} />;
}
