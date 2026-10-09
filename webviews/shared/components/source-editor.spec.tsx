import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState } from 'react';
import { renderWebview } from '../../test-support/render-webview';
import { SourceEditor } from './source-editor';

function editor(): HTMLTextAreaElement {
	return screen.getByRole('textbox', { name: 'Source' }) as HTMLTextAreaElement;
}

function EditableHarness({ onPaste }: { onPaste?: () => void }) {
	const [value, setValue] = useState('select 1');
	return <SourceEditor aria-label="Source" value={value} onChange={setValue} onPaste={onPaste} />;
}

describe('SourceEditor', () => {
	it('reports edits through onChange and forwards paste', async () => {
		let user = userEvent.setup();
		let onPaste = vi.fn();
		renderWebview(<EditableHarness onPaste={onPaste} />);

		await user.click(editor());
		await user.keyboard('{Control>}{End}{/Control} from sysibm.sysdummy1');
		expect(editor().value).toBe('select 1 from sysibm.sysdummy1');

		await user.paste(' -- pasted');
		expect(onPaste).toHaveBeenCalledTimes(1);
	});

	it('is read-only when asked, and exposes the textarea through inputRef', async () => {
		let user = userEvent.setup();
		let inputRef = createRef<HTMLTextAreaElement>();
		renderWebview(<SourceEditor aria-label="Source" value="select 1" readOnly inputRef={inputRef} />);

		await user.click(editor());
		await user.keyboard('x');

		expect(editor().readOnly).toBe(true);
		expect(editor().value).toBe('select 1');
		expect(inputRef.current).toBe(editor());
	});
});
