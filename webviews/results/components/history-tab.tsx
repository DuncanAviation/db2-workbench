import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, Checkbox, IconButton, InputAdornment, ListItemText, MenuItem, Select, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import type { SelectChangeEvent } from '@mui/material';
import { StringUtils } from '../../../src/utils/string-utils.js';
import type { ResultsSessionDetail, ResultsSqlHistory } from '../../../src/webview-messages/results-messages';
import { DbErrorUtils } from '../../../src/utils/db-error-utils';
import { FieldUtils } from '../../../src/utils/field-utils';
import { resultsVsCodeApi } from '../vscode-api';
import { CopyIconButton } from '../../shared/components/copy-icon-button';
import { DbErrorTable } from '../../shared/components/db-error-table';
import { SqlStatementBlock } from '../../shared/components/sql-statement-block';

export type HistoryCategory = 'message' | 'userStatement' | 'internalStatement';

// A metadata-only session's History tab only ever logs internal (worker-connection) lookups - there's
// no editor to run a user statement from - so 'userStatement' is dropped from its available categories
// entirely, and the default selection is 'internalStatement' instead. Tested as "not an editor" rather
// than against each kind by name (see ResultsSessionDetail.sessionKind): the schema browser and the
// diagram editor both qualify, and any future metadata panel gets the right behavior for free.
function isMetadataOnlySession(sessionKind: ResultsSessionDetail['sessionKind']): boolean {
	return sessionKind !== 'editor';
}

export function getDefaultHistoryCategories(sessionKind: ResultsSessionDetail['sessionKind']): HistoryCategory[] {
	return isMetadataOnlySession(sessionKind) ? ['internalStatement'] : ['userStatement'];
}

export function getAvailableHistoryCategories(sessionKind: ResultsSessionDetail['sessionKind']): HistoryCategory[] {
	return isMetadataOnlySession(sessionKind) ? ALL_CATEGORIES.filter(category => category !== 'userStatement') : ALL_CATEGORIES;
}

interface Props {
	session: ResultsSessionDetail;
	searchText: string;
	onSearchTextChange: (value: string) => void;
	selectedCategories: HistoryCategory[];
	onSelectedCategoriesChange: (categories: HistoryCategory[]) => void;
}

type SqlDisplayMode = 'markers' | 'values';

const CATEGORY_LABELS: Record<HistoryCategory, string> = {
	message: 'Messages',
	userStatement: 'User statements',
	internalStatement: 'Internal statements'
};

const ALL_CATEGORIES: HistoryCategory[] = ['message', 'userStatement', 'internalStatement'];

function getHistoryCategory(history: ResultsSqlHistory): HistoryCategory {
	if(history.type === 'connection') {
		return 'message';
	}

	return history.isInternal ? 'internalStatement' : 'userStatement';
}

// Builds the "Values" rendering of a history entry's SQL: "?" markers are replaced positionally
// (in source order, expanding a multi-value parameter's array into one literal per "?" it produced
// via substituteMarkers), while ":name" markers (CALL statements, which are never "?"-substituted)
// are replaced by name instead. A statement can only be in one of these two forms, never both.
function buildValuesSql(history: ResultsSqlHistory): string {
	let sql = history.sql ?? '';
	let params = history.parameters;

	if(!params || params.length === 0) {
		return sql;
	}

	if(sql.includes('?')) {
		let literals: string[] = [];

		for(let param of params) {
			let values = Array.isArray(param.value) ? param.value : [param.value];

			for(let value of(values.length > 0 ? values : [''])) {
				literals.push(FieldUtils.formatValueLiteral(param.dataType, value));
			}
		}

		let index = 0;
		return sql.replace(/\?/g, () => literals[index++] ?? '?');
	}

	let result = sql;

	for(let param of params) {
		let value = Array.isArray(param.value) ? param.value[0] ?? '' : param.value;
		let literal = FieldUtils.formatValueLiteral(param.dataType, value);
		result = result.replace(new RegExp(`:${param.name}\\b`, 'gi'), literal);
	}

	return result;
}

function formatDuration(duration?: number): string {
	let ms = duration ?? 0;
	const hours = Math.floor(ms / (1000 * 60 * 60));
	const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
	const seconds = Math.floor((ms % (1000 * 60)) / 1000);
	const milliseconds = Math.floor(ms % 1000);

	return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
}

function getStatusMessage(session: ResultsSessionDetail, history: ResultsSqlHistory): string {
	if(history.type === 'connection') {
		return `Connected to ${session.connectionName}`;
	}

	if(history.type === 'error') {
		return history.error?.message ?? 'Error';
	}

	if(history.rowCount) {
		return `${history.rowCount.toLocaleString('en-us')} row${StringUtils.getPlural(history.rowCount)}`;
	}

	return 'Success';
}

function renderCategorySelectValue(selected: HistoryCategory[], availableCategories: HistoryCategory[]): string {
	if(selected.length === availableCategories.length) {
		return 'All types';
	}

	if(selected.length === 0) {
		return 'No types selected';
	}

	return selected.map(category => CATEGORY_LABELS[category]).join(', ');
}

export function HistoryTab({ session, searchText, onSearchTextChange, selectedCategories, onSelectedCategoriesChange }: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [displayModes, setDisplayModes] = useState<Record<number, SqlDisplayMode>>({});
	const availableCategories = useMemo(() => getAvailableHistoryCategories(session.sessionKind), [session.sessionKind]);

	const filteredHistories = useMemo(() => {
		let search = searchText.trim().toLowerCase();

		return session.histories
			.map((history, index) => ({ history, index }))
			.filter(({ history }) => selectedCategories.includes(getHistoryCategory(history)))
			.filter(({ history }) => {
				if(!search) {
					return true;
				}

				let haystack = `${history.sql ?? ''} ${getStatusMessage(session, history)}`.toLowerCase();
				return haystack.includes(search);
			});
	}, [session, searchText, selectedCategories]);

	useEffect(() => {
		let container = containerRef.current;

		if(container) {
			container.scrollTop = container.scrollHeight;
		}
	}, [filteredHistories.length]);

	function handleCategoryChange(event: SelectChangeEvent<HistoryCategory[]>) {
		let value = event.target.value;
		onSelectedCategoriesChange(typeof value === 'string' ? value.split(',') as HistoryCategory[] : value);
	}

	return (
		<Stack sx={{ height: '100%', minHeight: 0 }}>
			<Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexShrink: 0, p: 1 }}>
				<TextField
					size="small"
					placeholder="Filter..."
					value={searchText}
					onChange={event => onSearchTextChange(event.target.value)}
					sx={{ maxWidth: 400, width: 1 }}
					slotProps={{
						input: {
							endAdornment: searchText && (
								<InputAdornment position="end">
									<IconButton size="small" aria-label="Clear filter" onClick={() => onSearchTextChange('')}>
										✕
									</IconButton>
								</InputAdornment>
							)
						}
					}}
				/>

				<Select
					multiple
					size="small"
					value={selectedCategories}
					onChange={handleCategoryChange}
					renderValue={selected => renderCategorySelectValue(selected, availableCategories)}
					sx={{ minWidth: 220 }}
				>
					{availableCategories.map(category => (
						<MenuItem key={category} value={category}>
							<Checkbox size="small" checked={selectedCategories.includes(category)} />
							<ListItemText primary={CATEGORY_LABELS[category]} />
						</MenuItem>
					))}
				</Select>
			</Stack>

			<Box ref={containerRef} sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto', p: 2, pt: 0 }}>
				{session.histories.length === 0 && <Typography sx={{ p: 2 }}>No history yet</Typography>}
				{session.histories.length > 0 && filteredHistories.length === 0 && <Typography sx={{ p: 2 }}>No history matches the current filters</Typography>}

				<Stack spacing={2}>
					{filteredHistories.map(({ history, index }) => {
						let hasParameters = !!history.parameters && history.parameters.length > 0;
						let mode: SqlDisplayMode = displayModes[index] ?? 'markers';
						let displayedSql = hasParameters && mode === 'values' ? buildValuesSql(history) : history.sql;

						return (
							<Stack key={index} spacing={1}>
								<Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
									<Stack direction="row" sx={{ alignItems: 'center', minWidth: 0 }}>
										<Typography variant="body2">
											{formatDuration(history.duration)} - <Box component="span" sx={{ color: history.error ? 'error.main' : 'success.main' }}>{getStatusMessage(session, history)}</Box>
										</Typography>
										{history.error && <CopyIconButton text={DbErrorUtils.toText(history.error)} label="Copy error" sx={{ ml: 0.5 }} />}
									</Stack>
									<Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
										{hasParameters && (
											<ToggleButtonGroup
												size="small"
												exclusive
												value={mode}
												onChange={(_, newMode: SqlDisplayMode | null) => {
													if(newMode) {
														setDisplayModes(current => ({ ...current, [index]: newMode }));
													}
												}}
											>
												<ToggleButton value="markers">Markers</ToggleButton>
												<ToggleButton value="values">Values</ToggleButton>
											</ToggleButtonGroup>
										)}
										<Typography variant="body2" color="text.secondary">{history.date}</Typography>
									</Stack>
								</Stack>

								{displayedSql && <SqlStatementBlock sql={displayedSql} />}

								{history.error?.isSetupError && (
									<Alert
										severity="warning"
										action={(
											<Button color="inherit" size="small" onClick={() => resultsVsCodeApi.postMessage({ command: 'checkDriverSetup' })}>
												Show Setup Options
											</Button>
										)}
									>
										This looks like a database driver that is not set up on this machine, not a SQL problem.
									</Alert>
								)}

								{history.error?.driverErrors && <DbErrorTable driverErrors={history.error.driverErrors} />}
							</Stack>
						);
					})}
				</Stack>
			</Box>
		</Stack>
	);
}
