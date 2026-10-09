import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { Chip, Tooltip } from '@mui/material';

// The one color for anything that says a row, column, or table came from (or was touched by) a schema
// import - "Imported", "Enhanced", "New", all of it - shared by the schema browser (table-detail.tsx and
// its Columns/Table Keys/Foreign Keys/Indexes tabs) and the diagram (table-node.tsx) rather than each
// picking its own. A vscode chart token first (so it follows the user's theme), falling back to a plain
// goldenrod hex for a theme that doesn't define it - the same var()-with-fallback pattern diagram-colors.ts
// already uses for SCHEMA_LINK_COLOR.
export const IMPORT_COLOR = 'var(--vscode-charts-yellow, #DAA520)';

export type ImportBadgeKind = 'imported' | 'enhanced' | 'new';

const LABELS: Record<ImportBadgeKind, string> = {imported: 'Imported', enhanced: 'Enhanced', new: 'New'};

interface Props {
	kind: ImportBadgeKind;
	tooltip?: string;
}

// Golden yellow outline + text + icon, with an explicit VS Code editor background (not transparent) -
// wherever "Imported"/"Enhanced"/"New" appears. The schema browser's own panel already sits on that
// background, so a transparent chip read the same there either way - but the diagram's table header sits
// on the schema's own color, and a transparent chip there just showed that color through it instead of
// looking like a badge. `background.paper` is this theme's own resolved --vscode-editor-background (see
// create-vscode-theme.ts) - dark in a dark theme, light in a light one - rather than a hardcoded value.
export function ImportBadge({kind, tooltip}: Props) {
	let chip = (
		<Chip
			size="small"
			variant="outlined"
			icon={<AutoAwesomeIcon sx={{color: `${IMPORT_COLOR} !important`}} />}
			label={LABELS[kind]}
			sx={{color: IMPORT_COLOR, borderColor: IMPORT_COLOR, backgroundColor: 'background.paper'}}
		/>
	);

	return tooltip ? <Tooltip title={tooltip}>{chip}</Tooltip> : chip;
}
