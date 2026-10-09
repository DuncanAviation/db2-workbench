import type { SchemasSystemView } from '../../../src/webview-messages/schemas-messages';
import type { FieldGroup } from './field-groups';
import { FieldGroups } from './field-groups';

interface Props {
	view: SchemasSystemView;
}

// SYSVIEWS' CHECK column - N/C/L rather than anything readable.
function describeCheckOption(checkOption: string): string {
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
				{ label: 'Definer', value: view.definer }
			]
		},
		{
			title: 'Behavior',
			fields: [
				{ label: 'Insertable', value: view.insertable },
				{ label: 'Updatable', value: view.updatable },
				{ label: 'Deletable', value: view.deletable },
				{ label: 'Check Option', value: describeCheckOption(view.checkOption) },
				{ label: 'Decimal Float Rounding', value: view.decFltRnd }
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

// Same layout as the table InfoTab, over SYSVIEWS' fields instead of SYSTABLES'.
export function ViewInfoTab({ view }: Props) {
	return <FieldGroups groups={buildGroups(view)} />;
}
