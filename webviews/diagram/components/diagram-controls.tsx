import { Box, IconButton, Tooltip } from '@mui/material';
import { useReactFlow } from '@xyflow/react';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import FitScreenIcon from '@mui/icons-material/FitScreen';

// Deliberately not React Flow's built-in <Controls> - same reasoning as SchemaOverviewMap's own
// deliberately-custom replacement of <MiniMap>: it's a self-positioning Panel internally, and can't be
// dropped into a shared flex row alongside the minimap panel to sit "just to its left" without fighting
// its own absolute positioning. Building the three buttons directly also makes matching the minimap's own
// background/border trivial (plain sx, not overriding React Flow's --xy-controls-* CSS variables).
export function DiagramControls() {
	let {zoomIn, zoomOut, fitView} = useReactFlow();

	return (
		<Box sx={{
			display: 'flex', flexDirection: 'column',
			backgroundColor: 'background.paper', border: '1px solid', borderColor: 'divider', borderRadius: 1,
			overflow: 'hidden'
		}}>
			<Tooltip title="Zoom in" placement="left">
				<IconButton size="small" onClick={() => void zoomIn()} sx={BUTTON_SX}>
					<ZoomInIcon fontSize="small" />
				</IconButton>
			</Tooltip>
			<Tooltip title="Zoom out" placement="left">
				<IconButton size="small" onClick={() => void zoomOut()} sx={BUTTON_SX}>
					<ZoomOutIcon fontSize="small" />
				</IconButton>
			</Tooltip>
			<Tooltip title="Fit view" placement="left">
				<IconButton size="small" onClick={() => void fitView({padding: 0.15})} sx={BUTTON_SX}>
					<FitScreenIcon fontSize="small" />
				</IconButton>
			</Tooltip>
		</Box>
	);
}

// borderRadius: 0 - the three buttons stack flush inside the shared outer border/radius above, rather
// than each drawing its own rounded corners. Icon color intentionally uses `primary.main` (VS Code's own
// button-background accent), not the muted `text.secondary` a plain icon button defaults to, so the
// controls stand out against the same paper/divider background the minimap uses.
const BUTTON_SX = {borderRadius: 0, color: 'primary.main'} as const;
