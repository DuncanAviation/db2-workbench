import { Box } from '@mui/material';
import type { ColumnDetailLine } from '../../../src/utils/column-details';

// "Label: value" lines for a hover tooltip - a diagram column's or table's, and a data grid column
// header's (see ColumnDetailsUtils.lines). One rendering so the diagram and the grids can't visually
// drift apart. Box rather than Stack/Typography: the diagram's table node imports this alongside
// @xyflow/react, whose typings conflict with MUI's Stack/Typography in the same file.
export function TooltipLines({ lines }: { lines: ColumnDetailLine[] }) {
	return (
		<Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
			{lines.map((line, index) => (
				<Box key={`${line.label}-${index}`} sx={{ fontSize: '0.7rem' }}>
					<Box component="span" sx={{ fontWeight: 600 }}>{line.label}:</Box> {line.value}
				</Box>
			))}
		</Box>
	);
}
