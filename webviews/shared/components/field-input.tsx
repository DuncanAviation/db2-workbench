import { useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { IconButton, InputAdornment, TextField, Tooltip } from '@mui/material';
import { alpha } from '@mui/material/styles';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import HideSourceIcon from '@mui/icons-material/HideSource';
import { FieldUtils } from '../../../src/utils/field-utils';
import { buildFieldHelperText } from './multi-value-input';
import { FieldDateTimePicker } from './field-date-time-picker';

interface Props {
	field: FieldUtils.SizedField;
	/** null is SQL NULL: the field shows empty with nullPlaceholder, and typing replaces it. */
	value: string | null;
	onChange: (value: string) => void;
	/** Commit-on-blur, matching the Parameters tab's existing pattern - called with the field's current
	 * (already-sanitized) value, not the raw blur event. */
	onBlur?: (value: string) => void;
	label?: string;
	required?: boolean;
	/** Marks the field red - a value it can't be left with, e.g. a required column cleared in the grid. */
	error?: boolean;
	autoFocus?: boolean;
	disabled?: boolean;
	fullWidth?: boolean;
	size?: 'small' | 'medium';
	variant?: 'standard' | 'outlined' | 'filled';
	/** Suppresses the type/length helper text a dense grid cell (table-data-tab's inline editing) has
	 * no room for - every other consumer gets it by default. */
	hideHelperText?: boolean;
	/** Right-aligns the typed text of a numeric field, so it lines up with the grid column's read-only
	 * cells (which DataTable right-aligns for numeric columns). Only the grid's inline editing sets it. */
	alignNumericRight?: boolean;
	/** What a null value shows as - "<null>" unless the caller knows better (an Add Row field whose
	 * NULL means "use the column's default"). */
	nullPlaceholder?: string;
	/** Adds a "Set NULL" icon button inside the field - pass it only where NULL is allowed. Hidden while
	 * the value is already NULL or the field is disabled, rather than shown disabled. */
	onSetNull?: () => void;
	/** The Set NULL button's tooltip and accessible name - "Use Table Default" on an Add Row field whose NULL
	 * means its table default. */
	setNullLabel?: string;
	inputRef?: (element: HTMLInputElement | null) => void;
}

// The "smart field" shared by every place a raw DB2 value is typed - the Data tab's inline grid
// editing, the Add/Edit Row dialog, and the Parameters tab's scalar inputs - so a data-type check
// (sanitizing input, capping character length, and now deciding whether to offer a date/time picker)
// lives in exactly one place instead of being repeated at each call site. DATE/TIME/TIMESTAMP columns
// get a calendar/clock icon that opens FieldDateTimePicker; every other type renders a plain TextField
// exactly as each call site already did before this existed.
export function FieldInput({ field, value, onChange, onBlur, label, required, error, autoFocus, disabled, fullWidth, size, variant, hideHelperText, alignNumericRight, nullPlaceholder, onSetNull, setNullLabel = 'Set NULL', inputRef }: Props) {
	const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
	const ownInputRef = useRef<HTMLInputElement | null>(null);

	const category = FieldUtils.getTemporalCategory(field.dataType);
	const isCharacter = FieldUtils.isCharacterType(field.dataType);
	const alignRight = alignNumericRight && FieldUtils.isNumericType(field.dataType);
	const PickerIcon = category === 'time' ? AccessTimeIcon : CalendarMonthIcon;
	const text = value ?? '';
	const isNull = value === null;

	function handleChange(raw: string) {
		onChange(FieldUtils.sanitizeFieldInput(raw, field));
	}

	function handleOpenPicker(event: MouseEvent<HTMLElement>) {
		setAnchorEl(event.currentTarget);
	}

	function handleClosePicker() {
		setAnchorEl(null);
	}

	let showSetNull = onSetNull != null && !isNull && !disabled;

	// The button goes away once the value is NULL, so focus moves to the field rather than being lost.
	function handleSetNull() {
		onSetNull?.();
		ownInputRef.current?.focus();
	}

	let adornments = (category || showSetNull) && (
		<InputAdornment position="end">
			{showSetNull && (
				<Tooltip title={setNullLabel}>
					<IconButton aria-label={setNullLabel} onClick={handleSetNull}>
						<HideSourceIcon fontSize="small" />
					</IconButton>
				</Tooltip>
			)}
			{category && (
				<IconButton aria-label="Open date/time picker" onClick={handleOpenPicker}>
					<PickerIcon fontSize="small" />
				</IconButton>
			)}
		</InputAdornment>
	);

	return (
		<>
			<TextField
				label={label}
				required={required}
				error={error}
				sx={theme => ({
					// Same look as a read-only grid cell's <null>.
					'& input::placeholder': { fontStyle: 'italic' },
					// A dense grid cell's underline alone is easy to miss, so the input is tinted as well.
					...(error ? { '& .MuiInputBase-root': { backgroundColor: alpha(theme.palette.error.main, 0.15) } } : {})
				})}
				autoFocus={autoFocus}
				disabled={disabled}
				fullWidth={fullWidth}
				size={size}
				variant={variant}
				value={text}
				placeholder={isNull ? (nullPlaceholder ?? '<null>') : undefined}
				helperText={hideHelperText ? undefined : buildFieldHelperText(field, text)}
				onChange={event => handleChange(event.target.value)}
				onBlur={onBlur ? () => onBlur(text) : undefined}
				autoComplete="off"
				inputRef={(element: HTMLInputElement | null) => {
					ownInputRef.current = element;
					inputRef?.(element);
				}}
				slotProps={{
					// A label sitting in the empty field would hide the placeholder that says it's NULL.
					inputLabel: isNull ? { shrink: true } : undefined,
					htmlInput: {
						...(isCharacter && field.length ? { maxLength: field.length } : {}),
						...(alignRight ? { style: { textAlign: 'right' } } : {})
					},
					input: adornments ? { endAdornment: adornments } : undefined
				}}
			/>

			{category && (
				<FieldDateTimePicker
					category={category}
					anchorEl={anchorEl}
					open={Boolean(anchorEl)}
					value={text}
					onClose={handleClosePicker}
					onApply={onChange}
				/>
			)}
		</>
	);
}
