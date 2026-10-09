import { vi } from 'vitest';

/**
 * Fakes setTimeout/clearTimeout for one test, in a way Testing Library can live with.
 *
 * Every userEvent action finishes by draining React work through Testing Library's asyncWrapper, which
 * waits on a `setTimeout(resolve, 0)`. Under fake timers that timeout never fires on its own, and
 * Testing Library only advances it itself when it recognises *Jest's* fake timers - it checks for a
 * global `jest` object, which vitest doesn't provide. So without this, the first userEvent call in a
 * fake-timer test hangs until the test times out. The shim gives Testing Library the one method it
 * calls, backed by vitest's clock, and is removed again by the returned cleanup.
 *
 * Only setTimeout/clearTimeout are faked, so nothing else a component or MUI relies on changes clock.
 * Pair with `userEvent.setup({ delay: null })`, since userEvent's own between-action pause is also a
 * setTimeout.
 */
export function useFakeTimeouts(): () => void {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

	let target = globalThis as unknown as { jest?: { advanceTimersByTime: (ms: number) => void } };
	target.jest = { advanceTimersByTime: ms => vi.advanceTimersByTime(ms) };

	return () => {
		delete target.jest;
		vi.useRealTimers();
	};
}
