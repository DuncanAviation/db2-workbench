import { cloneElement, createContext, useContext, useState } from 'react';
import type { MouseEvent, ReactElement } from 'react';
import { Tooltip } from '@mui/material';
import type { TooltipProps } from '@mui/material';

/**
 * True while a right-click menu is open over the tooltips below it. Provided by whatever owns that menu
 * (DataTable's header menu, the diagram's node menu); a MenuAwareTooltip outside any provider behaves like
 * a plain Tooltip.
 */
export const ContextMenuOpenContext = createContext(false);

interface ChildHandlers {
	onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
	onMouseLeave?: (event: MouseEvent<HTMLElement>) => void;
}

/**
 * A Tooltip that stays out of the way of a right-click menu. A tooltip sits above a menu (MUI's z-index
 * 1500 vs 1300), so a pointer straying back over the thing it describes would cover the menu with it.
 * This one shows nothing while the surrounding ContextMenuOpenContext says a menu is open, and stays
 * hidden on the element that was right-clicked until the pointer leaves it - otherwise dismissing the menu
 * by clicking that same element pops the tooltip straight back.
 *
 * Whether the pointer is over the element is tracked here rather than left to onOpen/onClose alone: MUI
 * calls onClose only for a tooltip it believes is open, and every tooltip is held shut while the menu is,
 * so an element the pointer merely crossed then would never hear it had left - and every one of them
 * opened at once when the menu closed. So leaving the element clears it directly, and a hover that
 * begins while the menu is open doesn't count.
 *
 * The child must forward onContextMenu and onMouseLeave to its DOM element, as a plain element or MUI
 * component does - the same requirement Tooltip itself has for its hover handlers.
 */
export function MenuAwareTooltip({ children, ...props }: Omit<TooltipProps, 'open' | 'onOpen' | 'onClose'> & { children: ReactElement<ChildHandlers> }) {
	const menuOpen = useContext(ContextMenuOpenContext);
	const [hovered, setHovered] = useState(false);
	const [suppressed, setSuppressed] = useState(false);

	const child = cloneElement(children, {
		onContextMenu: (event: MouseEvent<HTMLElement>) => {
			setSuppressed(true);
			children.props.onContextMenu?.(event);
		},
		onMouseLeave: (event: MouseEvent<HTMLElement>) => {
			setSuppressed(false);
			setHovered(false);
			children.props.onMouseLeave?.(event);
		}
	});

	return (
		<Tooltip {...props} open={hovered && !menuOpen && !suppressed} onOpen={() => setHovered(!menuOpen)} onClose={() => setHovered(false)}>
			{child}
		</Tooltip>
	);
}
