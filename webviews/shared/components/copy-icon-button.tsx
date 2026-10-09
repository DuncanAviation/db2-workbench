import { useState } from 'react';
import { IconButton, Tooltip } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';

interface Props {
	text: string;
	/** Tooltip and accessible name. */
	label?: string;
	sx?: SxProps<Theme>;
}

// The copy-to-clipboard icon that sits in a corner of a block of source text (SqlStatementBlock,
// SourceEditor), swapping to a check mark for a moment once the text is on the clipboard. Each instance
// owns its own feedback - nothing coordinates "which one was just copied".
export function CopyIconButton({ text, label = 'Copy', sx }: Props) {
	const [copied, setCopied] = useState(false);

	function handleCopy() {
		void navigator.clipboard.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	}

	return (
		<Tooltip title={label}>
			<IconButton size="small" aria-label={label} onClick={handleCopy} sx={sx}>
				{copied ? <CheckIcon fontSize="small" /> : <ContentCopyIcon fontSize="small" />}
			</IconButton>
		</Tooltip>
	);
}
