import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWebview } from '../../test-support/render-webview';
import { FieldInput } from './field-input';

function textAlign(label: string): string {
	return (screen.getByRole('textbox', { name: label }) as HTMLInputElement).style.textAlign;
}

describe('FieldInput', () => {
	it('right-aligns a numeric field only when asked to, as the grid\'s inline editing does', () => {
		renderWebview(
			<>
				<FieldInput label="Grid amount" field={{ dataType: 'DECIMAL', length: 9, scale: 2 }} value="12.50" onChange={() => {}} alignNumericRight />
				<FieldInput label="Grid name" field={{ dataType: 'VARCHAR', length: 30 }} value="Hex bolt" onChange={() => {}} alignNumericRight />
				<FieldInput label="Dialog amount" field={{ dataType: 'DECIMAL', length: 9, scale: 2 }} value="12.50" onChange={() => {}} />
			</>
		);

		expect(textAlign('Grid amount')).toBe('right');
		expect(textAlign('Grid name')).toBe('');
		expect(textAlign('Dialog amount')).toBe('');
	});
});
