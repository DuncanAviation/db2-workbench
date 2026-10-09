import { useRef } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { Box } from '@mui/material';

/** What a host passes a panel to make it resizable - it owns the width, so it can save it. */
export interface PanelResize {
	width: number;
	/** Called with the clamped width on every move of a drag. */
	onResize: (width: number) => void;
	/** Called once a drag, an arrow key or a double-click (back to the default) has settled on a width -
	 * when to save it, rather than on every move. */
	onResizeEnd: (width: number) => void;
}

interface Props extends PanelResize {
	/** Which edge of the panel the divider is on - the side facing the panel it takes width from. */
	edge: 'left' | 'right';
	minWidth: number;
	defaultWidth: number;
	/** The narrowest a drag may leave the panel beside this one (on the divider's side). */
	reserveWidth: number;
	label: string;
	/** The panel itself, drawing its own border on the divider's edge. */
	children: ReactNode;
}

const KEY_STEP = 10;
const KEY_STEP_LARGE = 50;

/**
 * A panel with a draggable divider on one edge, straddling the border the panel already draws. The
 * divider sits in a wrapper rather than inside the panel, since a panel typically clips its overflow.
 * A drag widens the panel at the expense of its neighbour on the divider's side (the wrapper's sibling
 * there), never past the neighbour's reserveWidth. Pointer capture keeps the drag going when the pointer
 * runs ahead of the divider, and the divider is a focusable separator, so the arrow keys resize it too.
 */
export function ResizablePanel({ edge, width, minWidth, defaultWidth, reserveWidth, onResize, onResizeEnd, label, children }: Props) {
	const drag = useRef<{ startX: number; startWidth: number; maxWidth: number; width: number } | null>(null);
	const wrapperRef = useRef<HTMLDivElement>(null);
	// Moving the divider right widens a panel it is on the right edge of, and narrows one it is on the left of.
	const direction = edge === 'right' ? 1 : -1;

	// Measured each time rather than once, since the webview can be resized between drags. A neighbour
	// measuring 0 means no layout at all (jsdom), so only the minimum applies.
	function maxWidth(): number {
		let wrapper = wrapperRef.current;
		let neighbour = edge === 'right' ? wrapper?.nextElementSibling : wrapper?.previousElementSibling;
		let room = neighbour?.clientWidth ? neighbour.clientWidth - reserveWidth : Number.POSITIVE_INFINITY;
		return Math.max(minWidth, width + room);
	}

	function clamp(value: number, max = maxWidth()): number {
		return Math.round(Math.min(Math.max(value, minWidth), max));
	}

	function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
		if (event.button !== 0) {
			return;
		}

		// No text selection while dragging, and the col-resize cursor stays even off the divider.
		event.preventDefault();
		event.currentTarget.setPointerCapture?.(event.pointerId);
		drag.current = { startX: event.clientX, startWidth: width, maxWidth: maxWidth(), width: width };
		document.body.style.cursor = 'col-resize';
	}

	function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
		let current = drag.current;

		if (!current) {
			return;
		}

		current.width = clamp(current.startWidth + direction * (event.clientX - current.startX), current.maxWidth);
		onResize(current.width);
	}

	function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
		let current = drag.current;

		if (!current) {
			return;
		}

		drag.current = null;
		event.currentTarget.releasePointerCapture?.(event.pointerId);
		document.body.style.cursor = '';

		if (current.width !== current.startWidth) {
			onResizeEnd(current.width);
		}
	}

	function settle(next: number) {
		let clamped = clamp(next);

		if (clamped !== width) {
			onResize(clamped);
			onResizeEnd(clamped);
		}
	}

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		let step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;

		if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			event.preventDefault();
			settle(width + direction * (event.key === 'ArrowRight' ? step : -step));
		}
	}

	return (
		<Box ref={wrapperRef} sx={{ position: 'relative', height: '100%', flexShrink: 0, display: 'flex' }}>
			{children}
			<Box
				role="separator"
				aria-orientation="vertical"
				aria-label={label}
				aria-valuenow={width}
				aria-valuemin={minWidth}
				tabIndex={0}
				title="Drag to resize, double-click to reset"
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onPointerCancel={handlePointerUp}
				onDoubleClick={() => settle(defaultWidth)}
				onKeyDown={handleKeyDown}
				sx={{
					position: 'absolute',
					top: 0,
					[edge]: -3,
					width: 6,
					height: '100%',
					zIndex: 1,
					cursor: 'col-resize',
					touchAction: 'none',
					outline: 'none',
					'&:hover, &:focus-visible, &:active': { bgcolor: 'primary.main', opacity: 0.5 }
				}}
			/>
		</Box>
	);
}
