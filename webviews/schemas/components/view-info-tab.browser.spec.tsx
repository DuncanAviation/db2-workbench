import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import type { SchemasInboundMessage } from '../../../src/webview-messages/schemas-messages';
import { postFromHost } from '../../test-support/host-messages';
import { renderWebview } from '../../test-support/render-webview';
import { logicalFile } from '../test-fixtures';
import { ViewInfoTab } from './view-info-tab';

// A logical file's key list in a real browser (see vitest.browser.config.ts). A file can have up to 120 key
// fields, and the list caps its own height and scrolls, so the groups after it stay on screen. jsdom can't
// check that: every element there measures 0x0.

const KEY_COUNT = 40;

describe('logical file Info tab in a real browser', () => {
	it('scrolls a long key list inside a bounded height, leaving the groups after it in view', async () => {
		renderWebview(<ViewInfoTab view={logicalFile('SALESLIB', 'JOBHDRL39')} />);

		postFromHost<SchemasInboundMessage>({ command: 'logicalFileLoaded', schema: 'SALESLIB', table: 'JOBHDRL39', file: {
			schema: 'SALESLIB', name: 'JOBHDRL39', basedOn: [{ library: 'SALESLIB', file: 'JOBHDR' }], accessPathType: 'KEYED',
			keyFieldCount: KEY_COUNT, keyFields: Array.from({ length: KEY_COUNT }, (_, index) => `KEY${index + 1}`).join(', '),
			selectOmit: false, joinLogical: false, dynamicSelection: false
		} });

		let list = await screen.findByRole('list', { name: 'Key fields' });

		// Eight rows show (see VISIBLE_KEY_ROWS), the rest scroll.
		expect(list.clientHeight).toBeGreaterThan(150);
		expect(list.clientHeight).toBeLessThan(260);
		expect(list.scrollHeight).toBeGreaterThan(list.clientHeight * 3);

		// The Storage group follows the keys and is still on the 800px-high page.
		let storage = screen.getByRole('heading', { name: 'Storage' });
		expect(storage.getBoundingClientRect().bottom).toBeLessThan(window.innerHeight);
	});
});
