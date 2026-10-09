import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, CircularProgress, FormControlLabel, Stack, Switch, TextField, Typography } from '@mui/material';
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

	const title = config.id ? 'Edit Connection' : 'New Connection';

	useEffect(() => {
		function onMessage(event: MessageEvent<ConnectionEditorInboundMessage>) {
			if (event.data.command === 'testConnectionResult') {
				setTestStatus({ state: 'done', success: event.data.success, message: event.data.message, driverErrors: event.data.driverErrors });
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

	return (
		<Stack spacing={2} sx={{ p: 3, maxWidth: 480 }}>
			<Typography variant="h5">{title}</Typography>

			<TextField label="Name" value={name} onChange={e => setName(e.target.value)} required autoComplete="off" />
			<TextField label="Host" value={host} onChange={e => setHost(e.target.value)} required autoComplete="off" />
			<TextField label="User Name" value={userName} onChange={e => setUserName(e.target.value)} required autoComplete="off" />
			<TextField label="Default Table Schema" value={defaultTableSchema} onChange={e => setDefaultTableSchema(e.target.value)} required autoComplete="off" />

			<Stack spacing={0.5}>
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
			</Stack>

			<Stack spacing={1}>
				<Typography variant="body2">Results Border Color</Typography>
				<Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
					<input
						type="color"
						value={resultBorderColor}
						onChange={e => {
							setResultBorderColor(e.target.value);
							setResultBorderColorCleared(false);
						}}
						style={{ width: 50, height: 30 }}
					/>
					<Button variant="outlined" color="secondary" onClick={handleRemoveBorderColor}>Remove</Button>
				</Stack>
			</Stack>

			{/* Hidden entirely when nothing is saved rather than shown empty: a user who has never made a SQL
			import has no reason to be told this control exists. */}
			{sqlImports.length > 0 && (
				<Stack spacing={0.5}>
					<Typography variant="body2">SQL Schema Imports</Typography>
					<Typography variant="caption" sx={{ color: 'text.secondary' }}>
						Run against this connection whenever it opens.
					</Typography>

					{sqlImports.map(sqlImport => (
						<FormControlLabel
							key={sqlImport.id}
							control={(
								<Checkbox
									size="small"
									checked={sqlImportIds.includes(sqlImport.id)}
									onChange={e => handleToggleSqlImport(sqlImport.id, e.target.checked)}
								/>
							)}
							label={sqlImport.name}
						/>
					))}
				</Stack>
			)}

			<Stack direction="row" spacing={1} sx={{ mt: 2, alignItems: 'center' }}>
				<Button
					variant="outlined"
					onClick={handleTestConnection}
					disabled={testStatus.state === 'testing'}
					startIcon={testStatus.state === 'testing' ? <CircularProgress size={16} /> : undefined}
				>
					Test Connection
				</Button>
				<Stack direction="row" spacing={1} sx={{ flexGrow: 1, justifyContent: 'flex-end' }}>
					<Button variant="outlined" color="secondary" onClick={handleCancel}>Cancel</Button>
					<Button variant="contained" color="primary" onClick={handleSave}>Save</Button>
				</Stack>
			</Stack>

			{testStatus.state === 'done' && (
				<Alert severity={testStatus.success ? 'success' : 'warning'}>{testStatus.message}</Alert>
			)}
			{testStatus.state === 'done' && testStatus.driverErrors && <DbErrorTable driverErrors={testStatus.driverErrors} />}
		</Stack>
	);
}
