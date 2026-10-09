import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { Menu } from '@mui/material';

export interface ContextMenuPosition {
	mouseX: number;
	mouseY: number;
}

interface ContextMenuProps {
	// Pass the caller's own context-menu state object directly - it only needs to carry mouseX/mouseY,
	// any extra fields (kind, ids, items, targetRows, ...) are ignored here and read back by the caller
	// when building `children`.
	position: ContextMenuPosition | null;
	onClose: () => void;
	children: ReactNode;
}

// A right-click-positioned action menu, shared by every place in the app that opens one (schema tree
// rows, diagram nodes, results grid rows): MUI's Menu renders a full-page invisible backdrop on top of
// whatever it was opened over, so a right-click meant for a *different* row/node lands on that backdrop
// instead of its real target - and the backdrop only closes on a plain click, not a right-click. Rather
// than hit-test through the backdrop, sx/slotProps.paper below make the whole Popover click-through
// except the menu's own Paper, so a click (including a right-click) always reaches the real target
// underneath; the effect here takes over the click-away job instead of the (now unreachable) backdrop
// click. That means a right-click on another row closes this menu first via mousedown, then the row's
// own onContextMenu fires normally and opens the new one - both part of the same physical click, landing
// in the same render with no visible flicker.
export function ContextMenu({ position, onClose, children }: ContextMenuProps) {
	useEffect(() => {
		if(!position) {
			return;
		}

		function handleGlobalMouseDown(event: globalThis.MouseEvent) {
			if((event.target as HTMLElement).closest('[role="menu"]')) {
				return;
			}

			onClose();
		}

		document.addEventListener('mousedown', handleGlobalMouseDown, true);
		return () => document.removeEventListener('mousedown', handleGlobalMouseDown, true);
	}, [position, onClose]);

	if(!position) {
		return null;
	}

	return (
		<Menu
			open
			onClose={onClose}
			anchorReference="anchorPosition"
			anchorPosition={{ top: position.mouseY, left: position.mouseX }}
			autoFocus={false}
			sx={{ pointerEvents: 'none' }}
			slotProps={{ paper: { sx: { pointerEvents: 'auto' } } }}
		>
			{children}
		</Menu>
	);
}
