import { rmSync } from 'node:fs';
import type { TestProject } from 'vitest/node';

// Global setup for the real browser suite (vitest.browser.config.ts), run once in Node before any test
// starts. A failing browser test leaves a screenshot under the attachments directory, named by a hash of
// its content, and vitest only ever creates that directory, never empties it - so without this the
// screenshots of every past failure pile up there. Clearing it first leaves exactly the current run's
// failures. It runs however the suite is started (the npm script, or vitest pointed at this config
// directly), and CI starts from a fresh clone anyway, so its failure artifacts are unaffected.
export default function clearAttachments(project: TestProject) {
	rmSync(project.config.attachmentsDir, { recursive: true, force: true });
}
