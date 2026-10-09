import { useState } from 'react';
import type { FocusEvent } from 'react';
import { Autocomplete, TextField } from '@mui/material';
import { FieldUtils } from '../../../src/utils/field-utils';

interface Props {
	label: string;
	field: FieldUtils.SizedField;
	value: string[];
	onChange: (value: string[]) => void;
	inputRef?: (element: HTMLInputElement | null) => void;
}

// Also used by the scalar (non-multiple) case, so a field's helper text reads the same whether it's
// entered as one value or a chip in a multi-value list.
export function buildFieldHelperText(field: FieldUtils.SizedField, currentValue: string): string {
	let typeDisplay = FieldUtils.formatDataType(field) || '';

	if(FieldUtils.isCharacterType(field.dataType) && field.length) {
		let remaining = Math.max(field.length - currentValue.length, 0);
		return `${typeDisplay} · ${remaining} character${remaining === 1 ? '' : 's'} left`;
	}

	return typeDisplay;
}

// A chip-style multi-value input (MUI Autocomplete, multiple + freeSolo) for anywhere a DB2-typed
// value needs to be entered as a list rather than a scalar - the results grid's Parameters tab
// (IN (:param)-style multi-value parameters) and the schema browser Data tab's Edit Search dialog
// (the IN operator) both use this. Sanitizes each chip via FieldUtils (numeric filtering/digit
// capping, character length capping) and commits whatever's typed-but-not-yet-a-chip on blur, so
// tabbing or clicking away doesn't silently discard it - the caller only ever sees committed chips.
export function MultiValueInput({ label, field, value, onChange, inputRef }: Props) {
	const [inputValue, setInputValue] = useState('');
	const isCharacterList = FieldUtils.isCharacterType(field.dataType);

	function commitPending() {
		let pending = inputValue.trim();

		if(!pending) {
			return;
		}

		onChange([...value, pending]);
		setInputValue('');
	}

	return (
		<Autocomplete<string, true, false, true>
			multiple
			freeSolo
			options={[]}
			value={value}
			inputValue={inputValue}
			onChange={(_, newValue) => {
				let sanitized = newValue.map(entry => FieldUtils.sanitizeFieldInput(entry, field)).filter(entry => entry.trim() !== '');
				onChange(sanitized);
			}}
			// reason is 'input' for actual typing - 'reset' (a chip was just added/removed) and
			// 'clear' fire too, but the text at that point is already whatever Autocomplete wants it
			// to be (typically empty), so sanitizing it further would just fight the component.
			onInputChange={(_, newInputValue, reason) => {
				setInputValue(reason === 'input' ? FieldUtils.sanitizeFieldInput(newInputValue, field) : newInputValue);
			}}
			renderInput={inputParams => (
				<TextField
					{...inputParams}
					label={label}
					helperText={buildFieldHelperText(field, inputValue)}
					slotProps={{
						...inputParams.slotProps,
						htmlInput: {
							...inputParams.slotProps.htmlInput,
							...(isCharacterList && field.length ? { maxLength: field.length } : {}),
							onBlur: (event: FocusEvent<HTMLInputElement>) => {
								inputParams.slotProps.htmlInput.onBlur?.(event);
								commitPending();
							}
						}
					}}
					inputRef={element => {
						inputRef?.(element);
					}}
				/>
			)}
		/>
	);
}
