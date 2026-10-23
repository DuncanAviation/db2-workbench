import { act } from '@testing-library/react';

// jsdom has no layout engine: offsetHeight, clientHeight and scrollHeight are all 0, and scrollTop never
// moves. @tanstack/react-virtual sizes its window from exactly those values - the scroll element's
// clientHeight is its viewport, and a row's offsetHeight is its measured size (see getRect and
// measureElement in @tanstack/virtual-core) - so under plain jsdom a virtualized list renders no rows at
// all. This supplies just those numbers, which is enough to exercise the windowing logic: which rows
// render for a given viewport and scroll position, and what a scroll handler decides from them.
//
// What it cannot do is prove the real CSS produces that viewport. A virtualizer whose container has no
// bounded height renders every row in a browser, and here it would still look windowed, because the
// height comes from this stub rather than from the stylesheet. That class of bug needs a real browser.

export interface FakeLayout {
	/** clientHeight of any element, and offsetHeight of any but a virtualized row - what a virtualizer reads as its viewport. */
	viewportHeight: number;
	/** offsetHeight of a row the virtualizer measures (one carrying `data-index`). Defaults to viewportHeight. */
	rowHeight?: number;
	width?: number;
}

export interface FakeLayoutHandle {
	/**
	 * Scrolls `element` the way a user would: moves its scrollTop, gives it the clientHeight/scrollHeight a
	 * scroll handler reads, and dispatches the scroll event the virtualizer and any onScroll listen for.
	 * scrollHeight defaults to what the viewport plus the new offset would imply for "not at the end".
	 */
	scroll(element: HTMLElement, position: { top: number; scrollHeight?: number }): void;
	restore(): void;
}

// jsdom defines the offset* getters on HTMLElement and the client* getters on Element.
const PATCHED = [
	[HTMLElement.prototype, 'offsetHeight'],
	[HTMLElement.prototype, 'offsetWidth'],
	[Element.prototype, 'clientHeight'],
	[Element.prototype, 'clientWidth']
] as const;

export function useFakeLayout(layout: FakeLayout): FakeLayoutHandle {
	let originals = PATCHED.map(([prototype, name]) => [prototype, name, Object.getOwnPropertyDescriptor(prototype, name)] as const);
	let rowHeight = layout.rowHeight ?? layout.viewportHeight;
	let width = layout.width ?? 1024;

	Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
		configurable: true,
		get(this: HTMLElement) {
			return this.hasAttribute('data-index') ? rowHeight : layout.viewportHeight;
		}
	});

	Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
		configurable: true,
		get() {
			return width;
		}
	});

	Object.defineProperty(Element.prototype, 'clientHeight', {
		configurable: true,
		get() {
			return layout.viewportHeight;
		}
	});

	Object.defineProperty(Element.prototype, 'clientWidth', {
		configurable: true,
		get() {
			return width;
		}
	});

	let scrolled = new Set<HTMLElement>();

	return {
		scroll(element, { top, scrollHeight }) {
			scrolled.add(element);

			// Instance properties shadow jsdom's prototype getters. scrollTop stays writable, since a
			// virtualizer's own scrollTo adjustments assign it.
			Object.defineProperty(element, 'scrollTop', { configurable: true, writable: true, value: top });
			Object.defineProperty(element, 'clientHeight', { configurable: true, value: layout.viewportHeight });
			Object.defineProperty(element, 'scrollHeight', { configurable: true, value: scrollHeight ?? top + layout.viewportHeight * 10 });

			act(() => {
				element.dispatchEvent(new Event('scroll'));
			});
		},
		restore() {
			for (let [prototype, name, descriptor] of originals) {
				if (descriptor) {
					Object.defineProperty(prototype, name, descriptor);
				} else {
					delete (prototype as unknown as Record<string, unknown>)[name];
				}
			}

			for (let element of scrolled) {
				for (let name of ['scrollTop', 'clientHeight', 'scrollHeight']) {
					delete (element as unknown as Record<string, unknown>)[name];
				}
			}
		}
	};
}
