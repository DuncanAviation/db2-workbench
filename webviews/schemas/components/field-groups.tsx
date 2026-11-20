import type { ReactNode } from 'react';
import { Box, Stack, Typography } from '@mui/material';

export interface FieldGroup {
	title: string;
	fields: Array<{ label: string; value: string }>;
	/** Shown under the fields, for what a label/value grid can't lay out - a logical file's key list. */
	content?: ReactNode;
}

interface Props {
	groups: FieldGroup[];
}

// The labelled read-only field grid the view and routine Info tabs share - titled groups, each a grid
// of label/value pairs, with an empty value shown as a dash.
export function FieldGroups({ groups }: Props) {
	return (
		<Stack spacing={2} sx={{ p: 2 }}>
			{groups.map(group => (
				<Stack key={group.title} spacing={1}>
					<Typography variant="subtitle1">{group.title}</Typography>

					{group.fields.length > 0 && (
						<Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 2 }}>
							{group.fields.map(field => (
								<Stack key={field.label}>
									<Typography variant="subtitle2">{field.label}</Typography>
									<Typography sx={{ wordBreak: 'break-word' }}>{field.value || '—'}</Typography>
								</Stack>
							))}
						</Box>
					)}

					{group.content}
				</Stack>
			))}
		</Stack>
	);
}
