import { useEffect, useState } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, MenuItem, Stack, Tab, Tabs, TextField, Tooltip, Typography } from '@mui/material';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import type { RowValue } from '../../../src/utils/row-edit-utils';
import type { DataEditSettings } from '../../../src/utils/data-edit-defaults';
import { DataEditDefaults } from '../../../src/utils/data-edit-defaults';
import { FieldInput } from '../../shared/components/field-input';

interface Props {
	open: boolean;
	/** What the dialog opens with - the settings as they stand. */
	settings: DataEditSettings;
	onCancel: () => void;
	/** The edited settings, with any type's value that's back to the app default dropped. */
	onSave: (settings: DataEditSettings) => void;
}

type SettingsTab = 'defaultValues';

// The Data tab's Settings... (db2-workbench.dataEdit.*). One tab today, Default Values: the value each
// column type starts with on Add Row, and which columns get those defaults at all. Nothing is written
// until Save - the edits are a draft until then.
export function DataEditSettingsDialog({ open, settings, onCancel, onSave }: Props) {
	const [tab, setTab] = useState<SettingsTab>('defaultValues');
	const [draft, setDraft] = useState<DataEditSettings>(settings);

	// Re-seeded only as the dialog opens, so a settings change arriving while it's open can't wipe an
	// edit in progress.
	useEffect(() => {
		if (open) {
			setDraft(settings);
			setTab('defaultValues');
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	function setTypeDefault(type: string, value: RowValue) {
		setDraft(current => ({ ...current, defaultValues: { ...current.defaultValues, [type]: value } }));
	}

	function resetTypeDefault(type: string) {
		setDraft(current => {
			let { [type]: _removed, ...rest } = current.defaultValues;
			return { ...current, defaultValues: rest };
		});
	}

	function handleSave() {
		onSave({ ...draft, defaultValues: DataEditDefaults.withoutAppDefaults(draft.defaultValues) });
	}

	return (
		<Dialog open={open} onClose={onCancel} maxWidth="sm" fullWidth>
			<DialogTitle>Data Edit Settings</DialogTitle>
			<DialogContent>
				<Tabs value={tab} onChange={(_event, value: SettingsTab) => setTab(value)} sx={{ mb: 2 }}>
					<Tab label="Default Values" value="defaultValues" />
				</Tabs>

				{tab === 'defaultValues' && (
					<Stack spacing={2}>
						<Typography variant="body2" sx={{ color: 'text.secondary' }}>
							The value a new row's fields start with on Add Row. A NOT NULL column without a table default always starts with its type's default.
						</Typography>

						{/* em, not px, for the same reason as RowEditDialog's field stack: a shrunk label floats up by an amount that scales with the font size. */}
						<Stack direction="row" spacing={2} sx={{ pt: '0.5em' }}>
							<TextField
								select
								size="small"
								fullWidth
								label="Columns with a table default"
								value={draft.columnsWithTableDefault}
								onChange={event => setDraft(current => ({ ...current, columnsWithTableDefault: event.target.value as DataEditSettings['columnsWithTableDefault'] }))}
							>
								<MenuItem value="tableDefault">Table Default</MenuItem>
								<MenuItem value="appDefault">App Default</MenuItem>
							</TextField>
							<TextField
								select
								size="small"
								fullWidth
								label="Nullable columns"
								value={draft.nullableColumns}
								onChange={event => setDraft(current => ({ ...current, nullableColumns: event.target.value as DataEditSettings['nullableColumns'] }))}
							>
								<MenuItem value="null">&lt;null&gt;</MenuItem>
								<MenuItem value="appDefault">App Default</MenuItem>
							</TextField>
						</Stack>

						{/* A form, not data - laid out on a grid rather than a DataTable, whose Refresh/Export wouldn't mean anything here. */}
						<Box role="list" aria-label="Default values by type" sx={{ display: 'grid', gridTemplateColumns: 'max-content 1fr 2.5em', columnGap: 2, rowGap: 0.5, alignItems: 'center' }}>
							{DataEditDefaults.APP_DEFAULTS.map(({ type, appDefault }) => {
								let value = DataEditDefaults.resolve(type, draft.defaultValues) ?? null;
								let isOwn = type in draft.defaultValues && draft.defaultValues[type] !== appDefault;

								return (
									<Box key={type} role="listitem" aria-label={type} sx={{ display: 'contents' }}>
										<Stack>
											<Typography variant="body2">{type}</Typography>
											{!isOwn && <Typography variant="caption" sx={{ color: 'text.secondary' }}>App default</Typography>}
										</Stack>
										<FieldInput
											field={{ dataType: type }}
											variant="standard"
											size="small"
											fullWidth
											hideHelperText
											value={value}
											onChange={newValue => setTypeDefault(type, newValue)}
											onSetNull={() => setTypeDefault(type, null)}
										/>
										{/* Only once there's something to reset - hidden rather than disabled. */}
										<Box>
											{isOwn && (
												<Tooltip title="Reset to App Default">
													<IconButton size="small" aria-label={`Reset ${type} to App Default`} onClick={() => resetTypeDefault(type)}>
														<RestartAltIcon fontSize="small" />
													</IconButton>
												</Tooltip>
											)}
										</Box>
									</Box>
								);
							})}
						</Box>
					</Stack>
				)}
			</DialogContent>
			<DialogActions>
				<Button onClick={onCancel}>Cancel</Button>
				<Button variant="contained" onClick={handleSave}>Save</Button>
			</DialogActions>
		</Dialog>
	);
}
