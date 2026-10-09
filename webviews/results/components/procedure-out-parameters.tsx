import { Box, Stack, Tooltip } from '@mui/material';
import type { ResultsProcedureOutParameter } from '../../../src/webview-messages/results-messages';
import { FieldUtils } from '../../../src/utils/field-utils';

interface Props {
	parameters: ResultsProcedureOutParameter[];
}

function formatValue(value: ResultsProcedureOutParameter['value']): string {
	return value === null || value === undefined ? '<null>' : String(value);
}

// QSYS2.SYSPARMS reports this as "OUT"/"INOUT" already - normalized here only in case a driver
// ever reports the underscored spelling ("IN_OUT") instead.
function formatMode(mode: string): string {
	return mode.replace(/_/g, '').toUpperCase();
}

export function ProcedureOutParameters({ parameters }: Props) {
	if(parameters.length === 0) {
		return null;
	}

	return (
		<Stack
			direction="row"
			useFlexGap
			sx={{ flexWrap: 'wrap', alignItems: 'center', gap: 1, px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider', flexShrink: 0 }}
		>
			{parameters.map(param => (
				<Tooltip key={param.name} title={`${formatMode(param.mode)} · ${FieldUtils.formatDataType(param) || ''}`}>
					<Box component="span">
						<Box component="span" sx={{ fontWeight: 600 }}>{param.name}</Box>
						{': '}
						{formatValue(param.value)}
					</Box>
				</Tooltip>
			))}
		</Stack>
	);
}
