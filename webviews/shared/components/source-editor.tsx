import type { ClipboardEvent, Ref } from 'react';
import { Box, TextField } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import { CopyIconButton } from './copy-icon-button';

interface Props {
	value: string;
	/** Omit for a read-only editor that only ever shows `value`. */
	onChange?: (value: string) => void;
	onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
	/** The underlying <textarea> - for a host that has to read the DOM value before React re-renders
	 * (the formatting editor's paste handler does). */
	inputRef?: Ref<HTMLTextAreaElement>;
	readOnly?: boolean;
	disabled?: boolean;
	placeholder?: string;
	'aria-label'?: string;
	/**
	 * Sizing. Without either, the editor fills its flex parent and scrolls internally (a panel's main
	 * editor). With them, it autosizes between the two row counts at full width (an editor inside a
	 * dialog or a form).
	 */
	minRows?: number;
	maxRows?: number;
	/** Shows a copy icon in the top-right corner, the same one SqlStatementBlock has. */
	copyable?: boolean;
	/** Merged after the editor's own styles on the TextField, so a host can size or pad it. */
	sx?: SxProps<Theme>;
}

// Room for the copy icon, so text never runs underneath it.
const COPY_ICON_GUTTER = '32px';

// The one plain-text source editor every webview uses (the formatting editor's SQL box, a view's
// Definition tab, and the SQL fields in dialogs), so anything added to it - highlighting, line numbers,
// a language mode for RPG or another language - reaches every place at once. Named for source text
// rather than SQL on purpose.
//
// In fill mode the `!important` height/overflow override the inline height MUI's multiline autosize
// writes onto the textarea, which is what lets it fill the parent instead of growing.
export function SourceEditor({ value, onChange, onPaste, inputRef, readOnly, disabled, placeholder, 'aria-label': ariaLabel, minRows, maxRows, copyable, sx }: Props) {
	let fill = minRows == null && maxRows == null;

	return (
		<Box sx={fill
			? { position: 'relative', flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }
			: { position: 'relative', width: '100%' }}
		>
			<TextField
				value={value}
				onChange={event => onChange?.(event.target.value)}
				onPaste={onPaste}
				multiline
				fullWidth
				minRows={minRows}
				maxRows={maxRows}
				disabled={disabled}
				placeholder={placeholder}
				inputRef={inputRef}
				slotProps={{ htmlInput: { readOnly: readOnly, spellCheck: false, 'aria-label': ariaLabel } }}
				sx={[
					{
						'& .MuiInputBase-input': {
							fontFamily: 'var(--vscode-editor-font-family, monospace)',
							...(copyable ? { paddingRight: COPY_ICON_GUTTER } : {})
						}
					},
					fill && {
						flexGrow: 1,
						minHeight: 0,
						display: 'flex',
						'& .MuiInputBase-root': { height: '100%', alignItems: 'flex-start' },
						'& .MuiInputBase-input': {
							height: '100% !important',
							overflow: 'auto !important'
						}
					},
					...(Array.isArray(sx) ? sx : [sx])
				]}
			/>

			{/* Inset past the input's own padding and the textarea's scrollbar, so it sits inside the text area. */}
			{copyable && <CopyIconButton text={value} sx={{ position: 'absolute', top: 4, right: 20 }} />}
		</Box>
	);
}
