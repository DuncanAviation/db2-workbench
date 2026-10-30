import { type ReactNode, useEffect, useState } from 'react';
import { Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material';
import { StringUtils } from '../../src/utils/string-utils.js';
import type { ConnectionEditorInboundMessage } from '../../src/webview-messages/connection-editor-messages';
import type { DbErrorUtils } from '../../src/utils/db-error-utils';
import { getInitialState } from './initial-state';
import { connectionEditorVsCodeApi } from './vscode-api';
import { DbErrorTable } from '../shared/components/db-error-table';

type TestConnectionStatus =
	| { state: 'idle' }
	| { state: 'testing' }
	| { state: 'done'; success: boolean; message: string; driverErrors?: DbErrorUtils.DbErrorDetail[] };

export function App() {
	const { config, defaultConnectionString, sqlImports } = getInitialState();

	const [name, setName] = useState(config.name);
	const [host, setHost] = useState(config.host);
	const [userName, setUserName] = useState(config.userName);
	const [defaultTableSchema, setDefaultTableSchema] = useState(config.defaultTableSchema);
	const [isConnectionStringCustomized, setIsConnectionStringCustomized] = useState(StringUtils.isNotBlank(config.connectionString));
	const [customConnectionString, setCustomConnectionString] = useState(config.connectionString ?? '');
	// The color input has to show some value, so it shows black when none is set - "cleared" is what
	// records that black is only a placeholder. Starting it false would save that placeholder as a real
	// color (a black border on every result) for any connection that never chose one.
	const [resultBorderColor, setResultBorderColor] = useState(config.resultBorderColor ?? '#000000');
	const [resultBorderColorCleared, setResultBorderColorCleared] = useState(StringUtils.isBlank(config.resultBorderColor));
	const [testStatus, setTestStatus] = useState<TestConnectionStatus>({ state: 'idle' });
	const [sqlImportIds, setSqlImportIds] = useState<string[]>(config.sqlImportIds ?? []);
	const [passwordSetMessage, setPasswordSetMessage] = useState<string>();

	const title = config.id ? 'Edit Connection' : 'New Connection';

	useEffect(() => {
		function onMessage(event: MessageEvent<ConnectionEditorInboundMessage>) {
			if (event.data.command === 'testConnectionResult') {
				setTestStatus({ state: 'done', success: event.data.success, message: event.data.message, driverErrors: event.data.driverErrors });
			} else if (event.data.command === 'passwordSet') {
				setPasswordSetMessage(event.data.message);
			}
		}

		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, []);

	function handleRemoveBorderColor() {
		setResultBorderColor('#000000');
		setResultBorderColorCleared(true);
	}

	// Both payloads start from the config this editor was opened with, so a field it has no control for
	// (driver, or anything added to ConnectionConfig later) goes back untouched. That matters for save in
	// particular: the host replaces the stored config with this payload, so a field left out is deleted.
	function handleSave() {
		connectionEditorVsCodeApi.postMessage({
			command: 'saveConnection',
			connection: {
				...config,
				name,
				host,
				userName,
				defaultTableSchema,
				connectionString: isConnectionStringCustomized ? customConnectionString : undefined,
				resultBorderColor: resultBorderColorCleared ? undefined : resultBorderColor,
				sqlImportIds
			}
		});
	}

	// Unchecking a saved import only unlinks it from this connection - the import itself, and any other
	// connection using it, are untouched. Deleting one outright is done from View Imports, not here.
	function handleToggleSqlImport(importId: string, linked: boolean) {
		setSqlImportIds(linked ? [...sqlImportIds, importId] : sqlImportIds.filter(id => id !== importId));
	}

	function handleToggleCustomizeConnectionString(customize: boolean) {
		setIsConnectionStringCustomized(customize);

		if (customize && StringUtils.isBlank(customConnectionString)) {
			setCustomConnectionString(defaultConnectionString);
		}
	}

	function handleCancel() {
		connectionEditorVsCodeApi.postMessage({ command: 'cancelEdit' });
	}

	function handleTestConnection() {
		setTestStatus({ state: 'testing' });
		connectionEditorVsCodeApi.postMessage({
			command: 'testConnection',
			connection: {
				...config,
				name,
				host,
				userName,
				defaultTableSchema,
				connectionString: isConnectionStringCustomized ? customConnectionString : undefined
			}
		});
	}

	// The host prompts for the password itself, so it never passes through this webview. Nothing is
	// changed until a new one is entered there.
	function handleSetPassword() {
		setPasswordSetMessage(undefined);
		connectionEditorVsCodeApi.postMessage({ command: 'setPassword', host, userName });
	}

	return (
		<Stack spacing={3} sx={{ p: 3, maxWidth: 640 }}>
			<Typography variant="h5">{title}</Typography>

			<Section title="Connection">
				<Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 2 }}>
					<TextField label="Name" value={name} onChange={e => setName(e.target.value)} required autoComplete="off" />
					<TextField label="Default Table Schema" value={defaultTableSchema} onChange={e => setDefaultTableSchema(e.target.value)} required autoComplete="off" />
					<TextField label="Host" value={host} onChange={e => setHost(e.target.value)} required autoComplete="off" />
					<TextField label="User Name" value={userName} onChange={e => setUserName(e.target.value)} required autoComplete="off" />
				</Box>
			</Section>

			<Section title="Sign-on">
				<Stack direction="row" spacing={1}>
					<Button
						variant="outlined"
						onClick={handleSetPassword}
						disabled={StringUtils.isBlank(host) || StringUtils.isBlank(userName)}
						sx={{ whiteSpace: 'nowrap' }}
					>
						Set Password
					</Button>
					<Button
						variant="outlined"
						onClick={handleTestConnection}
						disabled={testStatus.state === 'testing'}
						startIcon={testStatus.state === 'testing' ? <CircularProgress size={14} /> : undefined}
						sx={{ whiteSpace: 'nowrap' }}
					>
						Test Connection
					</Button>
				</Stack>

				{passwordSetMessage && <Alert severity="success">{passwordSetMessage}</Alert>}
				{testStatus.state === 'done' && (
					<Alert severity={testStatus.success ? 'success' : 'warning'}>{testStatus.message}</Alert>
				)}
				{testStatus.state === 'done' && testStatus.driverErrors && <DbErrorTable driverErrors={testStatus.driverErrors} />}
			</Section>

			<Section title="Connection String">
				<FormControlLabel
					control={(
						<Switch
							checked={isConnectionStringCustomized}
							onChange={e => handleToggleCustomizeConnectionString(e.target.checked)}
						/>
					)}
					label="Customize Connection String"
				/>
				<TextField
					label="Connection String"
					value={isConnectionStringCustomized ? customConnectionString : defaultConnectionString}
					onChange={e => setCustomConnectionString(e.target.value)}
					disabled={!isConnectionStringCustomized}
					multiline
					minRows={3}
				/>
			</Section>

			<Section title="Results">
				<Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
					<Typography variant="body2">Border Color</Typography>
					<input
						type="color"
						aria-label="Results Border Color"
						value={resultBorderColor}
						onChange={e => {
							setResultBorderColor(e.target.value);
							setResultBorderColorCleared(false);
						}}
						style={{ width: 40, height: 24 }}
					/>
					<Button variant="outlined" color="secondary" onClick={handleRemoveBorderColor}>Remove</Button>
				</Stack>
			</Section>

			{/* Hidden entirely when nothing is saved rather than shown empty: a user who has never made a SQL
			import has no reason to be told this control exists. */}
			{sqlImports.length > 0 && (
				<Section title="SQL Schema Imports">
					<Typography variant="caption" sx={{ color: 'text.secondary' }}>
						Run against this connection whenever it opens.
					</Typography>

					<Stack>
						{sqlImports.map(sqlImport => (
							<FormControlLabel
								key={sqlImport.id}
								control={(
									<Checkbox
										checked={sqlImportIds.includes(sqlImport.id)}
										onChange={e => handleToggleSqlImport(sqlImport.id, e.target.checked)}
									/>
								)}
								label={sqlImport.name}
							/>
						))}
					</Stack>
				</Section>
			)}

			<Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end', borderTop: 1, borderColor: 'divider', pt: 2 }}>
				<Button variant="outlined" color="secondary" onClick={handleCancel}>Cancel</Button>
				<Button variant="contained" color="primary" onClick={handleSave}>Save</Button>
			</Stack>
		</Stack>
	);
}

/** A titled group of fields, ruled off from the one above. */
function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<Stack spacing={1.5} component="section" aria-label={title}>
			<Typography variant="subtitle2" sx={{ color: 'text.secondary', borderBottom: 1, borderColor: 'divider', pb: 0.5 }}>
				{title}
			</Typography>
			{children}
		</Stack>
	);
}
