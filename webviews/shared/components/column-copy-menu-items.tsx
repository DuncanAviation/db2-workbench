import { MenuItem } from '@mui/material';
import type { ColumnDetails } from '../../../src/utils/column-details';

// A column's Copy Name / Copy Long Name / Copy Description items - a data grid header's right-click menu
// and a diagram column row's. "Name" is DB2's short system name, the one hand-written SQL against these
// files mostly uses. An item the column has no value for (a computed column has no short name) is shown
// disabled rather than left out, so the menu always reads the same.
const COLUMN_COPY_ITEMS: { label: string; value: (details: ColumnDetails) => string | undefined }[] = [
	{ label: 'Copy Name', value: details => details.shortName },
	{ label: 'Copy Long Name', value: details => details.longName },
	{ label: 'Copy Description', value: details => details.description }
];

/** One Copy menu item, disabled with nothing to copy. Closes the menu (`onDone`) before copying. */
export function copyMenuItem(label: string, value: string | undefined, onDone: () => void) {
	return (
		<MenuItem
			key={label}
			disabled={value == null || value.trim() === ''}
			onClick={() => {
				onDone();

				if (value != null) {
					void navigator.clipboard.writeText(value);
				}
			}}
		>
			{label}
		</MenuItem>
	);
}

/** An array, not a component: MUI's Menu needs its items as direct children. */
export function columnCopyMenuItems(details: ColumnDetails, onDone: () => void) {
	return COLUMN_COPY_ITEMS.map(item => copyMenuItem(item.label, item.value(details), onDone));
}
