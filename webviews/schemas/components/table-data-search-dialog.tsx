import { useEffect, useState } from 'react';
import {
	Autocomplete,
	Button,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	IconButton,
	MenuItem,
	Select,
	Stack,
	Tab,
	Tabs,
	TextField
} from '@mui/material';
import type { SystemColumn } from '../../../src/models/system-column';
import { ColumnNameUtils } from '../../../src/utils/column-name-utils';
import { FieldUtils } from '../../../src/utils/field-utils';
import { SearchCriteriaUtils } from '../../../src/utils/search-criteria-utils';
import { buildFieldHelperText, MultiValueInput } from '../../shared/components/multi-value-input';
import { SourceEditor } from '../../shared/components/source-editor';

export interface TableDataSearchRow {
	id: string;
	/** systemName of the chosen column - '' if not chosen yet. */
	column: string;
	operator: SearchCriteriaUtils.Operator;
	/** Used by every operator except IN (see `values`) and IS NULL/IS NOT NULL (no value needed). */
	value: string;
	/** Used only by the IN operator - one entry per chip. */
	values: string[];
}

export interface TableDataSearchState {
	activeTab: 'fields' | 'custom';
	fieldsRows: TableDataSearchRow[];
	customText: string;
}

// The pristine/cleared state - also what the Custom tab shows pre-filled with, so the user can
// start typing right after "where ".
export const EMPTY_TABLE_DATA_SEARCH: TableDataSearchState = { activeTab: 'fields', fieldsRows: [], customText: 'where ' };

let nextRowId = 0;

function newRow(): TableDataSearchRow {
	return { id: `search-row-${nextRowId++}`, column: '', operator: '=', value: '', values: [] };
}

// Whichever tab was active when Run was clicked is what's applied - see TableDataTab. The Custom
// tab's leading "where" is stripped (case-insensitively) since the host (DataQueries.listTableData)
// always adds it back itself - avoids a "where where ..." bug and keeps one owner of that keyword.
export function buildWhereClause(state: TableDataSearchState, columns: SystemColumn[]): string {
	if (state.activeTab === 'custom') {
		return state.customText.replace(/^\s*where\s+/i, '').trim();
	}

	let criteria: SearchCriteriaUtils.SearchCriterion[] = state.fieldsRows
		.filter(row => row.column)
		.map(row => ({
			systemName: row.column,
			dataType: columns.find(column => column.systemName === row.column)?.dataType,
			operator: row.operator,
			value: row.value,
			values: row.values
		}));

	return SearchCriteriaUtils.buildWhereClause(criteria);
}

interface Props {
	open: boolean;
	/** LOB columns already excluded by the caller - sorting/searching by a size placeholder isn't meaningful. */
	columns: SystemColumn[];
	columnLabels: Record<string, string[]>;
	initialState: TableDataSearchState;
	onCancel: () => void;
	onRun: (state: TableDataSearchState) => void;
}

export function TableDataSearchDialog({ open, columns, columnLabels, initialState, onCancel, onRun }: Props) {
	const [state, setState] = useState<TableDataSearchState>(initialState);

	// Re-seeds the dialog's own draft from whatever was last applied every time it's opened - not
	// tied to `initialState`'s identity, only to the open transition, so an unrelated parent
	// re-render while the dialog is open can't clobber in-progress edits. Always shows at least one
	// row to edit, even when nothing's been applied yet.
	useEffect(() => {
		if (open) {
			setState({
				...initialState,
				fieldsRows: initialState.fieldsRows.length > 0 ? initialState.fieldsRows : [newRow()]
			});
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	function updateRow(id: string, changes: Partial<TableDataSearchRow>) {
		setState(current => ({
			...current,
			fieldsRows: current.fieldsRows.map(row => row.id === id ? { ...row, ...changes } : row)
		}));
	}

	// Keeps the operator and entered value when the new column is the same type category as the old
	// one (e.g. switching between two character columns) - every operator available on the old
	// column is still available on the new one, and the value's still meaningful. Resets both only
	// when the category actually changes (e.g. character -> numeric), since neither the operator
	// list nor a typed-out value necessarily carries over.
	function handleColumnChange(row: TableDataSearchRow, column: SystemColumn | null) {
		let previousColumn = columns.find(c => c.systemName === row.column) ?? null;
		let sameCategory = SearchCriteriaUtils.getTypeCategory(previousColumn?.dataType) === SearchCriteriaUtils.getTypeCategory(column?.dataType);

		if(sameCategory) {
			updateRow(row.id, { column: column?.systemName ?? '' });
			return;
		}

		let availableOperators = SearchCriteriaUtils.getAvailableOperators(column?.dataType);
		updateRow(row.id, { column: column?.systemName ?? '', operator: availableOperators[0], value: '', values: [] });
	}

	function handleAddRow() {
		setState(current => ({ ...current, fieldsRows: [...current.fieldsRows, newRow()] }));
	}

	function handleDeleteRow(id: string) {
		setState(current => ({ ...current, fieldsRows: current.fieldsRows.filter(row => row.id !== id) }));
	}

	// Resets the dialog's own draft back to the pristine default (both tabs, and which tab's active)
	// - doesn't close the dialog or apply anything, same as Cancel doesn't; Run still has to be
	// clicked to actually apply the now-empty search.
	function handleClear() {
		setState({ ...EMPTY_TABLE_DATA_SEARCH, fieldsRows: [newRow()] });
	}

	function columnLabel(column: SystemColumn): string {
		// columnLabels is keyed by systemName here, not sqlName - see SchemasProvider.postTableData.
		return ColumnNameUtils.labelsForKey(columnLabels, column.systemName).join(' / ');
	}

	return (
		<Dialog open={open} onClose={onCancel} maxWidth="md" fullWidth>
			<DialogTitle>Edit Search</DialogTitle>
			<DialogContent>
				<Tabs value={state.activeTab} onChange={(_, value: 'fields' | 'custom') => setState(current => ({ ...current, activeTab: value }))} sx={{ mb: 2 }}>
					<Tab label="Fields" value="fields" />
					<Tab label="Custom" value="custom" />
				</Tabs>

				{state.activeTab === 'fields' && (
					<Stack spacing={2}>
						{state.fieldsRows.map(row => {
							let column = columns.find(c => c.systemName === row.column) ?? null;
							let availableOperators = SearchCriteriaUtils.getAvailableOperators(column?.dataType);
							let field: FieldUtils.SizedField = column ?? {};

							return (
								<Stack key={row.id} direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
									<Autocomplete<SystemColumn>
										options={columns}
										getOptionLabel={columnLabel}
										isOptionEqualToValue={(a, b) => a.systemName === b.systemName}
										value={column}
										onChange={(_, newValue) => handleColumnChange(row, newValue)}
										sx={{ width: 260 }}
										renderInput={inputParams => <TextField {...inputParams} label="Column" />}
									/>

									<Select
										value={row.operator}
										// value/values are deliberately left untouched here - each operator only ever
										// reads the one it actually uses (see TableDataSearchRow), so switching between
										// e.g. "=" and "<" keeps what was typed, and switching away from/back to IN
										// keeps its chips too, without the two interfering with each other.
										onChange={event => updateRow(row.id, { operator: event.target.value as SearchCriteriaUtils.Operator })}
										sx={{ width: 200 }}
									>
										{availableOperators.map(operator => (
											<MenuItem key={operator} value={operator}>{SearchCriteriaUtils.OPERATOR_LABELS[operator]}</MenuItem>
										))}
									</Select>

									{row.operator !== 'IS NULL' && row.operator !== 'IS NOT NULL' && (
										row.operator === 'IN' ? (
											<Stack sx={{ flexGrow: 1 }}>
												<MultiValueInput
													label="Values"
													field={field}
													value={row.values}
													onChange={values => updateRow(row.id, { values })}
												/>
											</Stack>
										) : (
											<TextField
												label="Value"
												value={row.value}
												helperText={buildFieldHelperText(field, row.value)}
												onChange={event => updateRow(row.id, { value: FieldUtils.sanitizeFieldInput(event.target.value, field) })}
												slotProps={FieldUtils.isCharacterType(field.dataType) && field.length ? { htmlInput: { maxLength: field.length } } : undefined}
												sx={{ flexGrow: 1 }}
											/>
										)
									)}

									<IconButton aria-label="Delete condition" onClick={() => handleDeleteRow(row.id)} sx={{ mt: 0.5 }}>
										✕
									</IconButton>
								</Stack>
							);
						})}

						<Button onClick={handleAddRow} sx={{ alignSelf: 'flex-start' }}>Add condition</Button>
					</Stack>
				)}

				{state.activeTab === 'custom' && (
					<SourceEditor
						aria-label="Custom WHERE clause"
						minRows={6}
						value={state.customText}
						onChange={customText => setState(current => ({ ...current, customText }))}
					/>
				)}
			</DialogContent>
			<DialogActions>
				<Button onClick={onCancel}>Cancel</Button>
				<Button onClick={handleClear}>Clear</Button>
				<Button variant="contained" onClick={() => onRun(state)}>Run</Button>
			</DialogActions>
		</Dialog>
	);
}
