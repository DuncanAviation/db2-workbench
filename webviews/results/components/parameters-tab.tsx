import { useEffect, useRef, useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';
import type { ResultsSessionDetail, ResultsSqlParameter } from '../../../src/webview-messages/results-messages';
import { FieldInput } from '../../shared/components/field-input';
import { MultiValueInput } from '../../shared/components/multi-value-input';
import { resultsVsCodeApi } from '../vscode-api';

type ParameterValue = string | string[];

interface Props {
	session: ResultsSessionDetail;
}

function toScalar(value: ParameterValue | undefined): string {
	return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function toList(value: ParameterValue | undefined): string[] {
	return Array.isArray(value) ? value : value ? [value] : [];
}

function valuesEqual(a: ParameterValue | undefined, b: ParameterValue | undefined): boolean {
	let listA = toList(a);
	let listB = toList(b);
	return listA.length === listB.length && listA.every((entry, index) => entry === listB[index]);
}

export function ParametersTab({ session }: Props) {
	const [values, setValues] = useState<Record<string, ParameterValue>>(session.parameterValues);
	const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
	// Tracks the last parameterFocusRequest.nonce actually applied - session.parameterFocusRequest
	// is a new object reference on every session update, so without this guard a repeat check
	// against a request that's already been satisfied would re-focus the field on every unrelated
	// later update. Left unset (not advanced) if the target key isn't in `session.parameters` yet,
	// so it keeps retrying on subsequent updates until the field actually exists to focus.
	const appliedFocusNonceRef = useRef<number | undefined>(undefined);

	// Merge in newly-appeared/removed keys without clobbering an in-progress local edit that
	// hasn't been posted back yet (a plain replace here would stomp on that as sessionsState
	// messages arrive from unrelated activity elsewhere in the session).
	useEffect(() => {
		setValues(current => ({ ...session.parameterValues, ...current }));
	}, [session.parameterValues]);

	useEffect(() => {
		let request = session.parameterFocusRequest;

		if (!request?.parameterKey || appliedFocusNonceRef.current === request.nonce) {
			return;
		}

		let input = inputRefs.current[request.parameterKey];

		if (input) {
			input.focus();
			appliedFocusNonceRef.current = request.nonce;
		}
	}, [session.parameterFocusRequest]);

	if (session.parameters.length === 0) {
		return <Typography sx={{ p: 2 }}>There are no parameters found in this SQL file. Once you add a parameter, you can provide values here. Ex: field = :field</Typography>;
	}

	function commit(key: string, value: ParameterValue) {
		resultsVsCodeApi.postMessage({ command: 'setParameterValue', key, value });
	}

	// FieldInput has already sanitized (and, for a DATE/TIME/TIMESTAMP parameter, already formatted if
	// it came from a picker selection) before calling this.
	function handleChange(param: ResultsSqlParameter, value: string) {
		setValues(current => ({ ...current, [param.key]: value }));
	}

	// MultiValueInput has already sanitized/filtered newList before calling this.
	function handleListChange(param: ResultsSqlParameter, newList: string[]) {
		setValues(current => ({ ...current, [param.key]: newList }));
		commit(param.key, newList);
	}

	function handleExecute() {
		// Normally the field the user was just in already committed on blur before this button
		// could receive focus/a click - but commit defensively for every changed value first anyway,
		// so there's no dependency on that ordering holding in every possible interaction path.
		for (let param of session.parameters) {
			let value = values[param.key];

			if (!valuesEqual(value, session.parameterValues[param.key])) {
				commit(param.key, value ?? (param.allowMultiple ? [] : ''));
			}
		}

		resultsVsCodeApi.postMessage({ command: 'executeSql' });
	}

	return (
		<Box sx={{ p: 2 }}>
			<Stack spacing={2} sx={{ maxWidth: 480 }}>
				{session.parameters.map(param => {
					if (param.allowMultiple) {
						return (
							<MultiValueInput
								key={param.key}
								label={param.label}
								field={param}
								value={toList(values[param.key])}
								onChange={newList => handleListChange(param, newList)}
								inputRef={element => {
									inputRefs.current[param.key] = element;
								}}
							/>
						);
					}

					let value = toScalar(values[param.key]);

					return (
						<FieldInput
							key={param.key}
							field={param}
							label={param.label}
							value={value}
							onChange={newValue => handleChange(param, newValue)}
							onBlur={newValue => commit(param.key, newValue)}
							inputRef={(element: HTMLInputElement | null) => {
								inputRefs.current[param.key] = element;
							}}
						/>
					);
				})}

				<Button variant="contained" color="primary" onClick={handleExecute} sx={{ alignSelf: 'flex-start' }}>
					Execute
				</Button>
			</Stack>
		</Box>
	);
}
