import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material';
import type { SchemaImportErrorUtils } from '../../../src/utils/schema-import-error-utils';

interface Props {
	open: boolean;
	error: SchemaImportErrorUtils.SerializedImportError | null;
	/** The raw text that failed to import - used to show the specific source line each problem's
	 * location points at. See ImportSchemaErrorMessage.content. */
	content: string;
	onClose: () => void;
}

// Blank for a problem with no location at all (e.g. a Frictionless JSON.parse failure, which has a
// message but no line/column) rather than a real one.
function sourceLine(content: string, lineNumber: number | undefined): string {
	if (!lineNumber) {
		return '';
	}

	return content.split('\n')[lineNumber - 1]?.trim() ?? '';
}

export function ImportErrorDialog({ open, error, content, onClose }: Props) {
	// error.diags is empty for an error with nothing more specific to say than its own message (see
	// SchemaImportErrorUtils.serialize) - falls back to a single problem built from just that message.
	// In practice this is always exactly one entry either way - both @dbml/core and the JSON parser
	// behind Frictionless import stop at the first problem rather than collecting several - but this
	// still renders sensibly if that ever changes, without needing a table for what's normally one row.
	const problems = error && error.diags.length > 0 ? error.diags : error ? [{ message: error.message }] : [];

	return (
		<Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
			<DialogTitle>Import Failed</DialogTitle>
			<DialogContent>
				{/* Plain text color, not error.main - unlike SqlErrorDisplay's surfaces (a colored line
				    inline among otherwise-normal content), this whole dialog is already about nothing but
				    the error, and red-on-the-dialog's-gray-background read poorly here. */}
				<Stack spacing={2}>
					{problems.map((problem, index) => (
						<Stack key={index} spacing={0.5}>
							<Typography variant="body2">{problem.message}</Typography>
							{problem.startLine && (
								<Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
									Line {problem.startLine}{problem.startColumn ? `, Col ${problem.startColumn}` : ''}: {sourceLine(content, problem.startLine)}
								</Typography>
							)}
						</Stack>
					))}
				</Stack>
			</DialogContent>
			<DialogActions>
				<Button onClick={onClose}>Close</Button>
			</DialogActions>
		</Dialog>
	);
}
