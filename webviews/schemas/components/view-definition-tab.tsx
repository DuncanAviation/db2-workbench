import { useEffect, useState } from 'react';
import { Stack, ToggleButton, ToggleButtonGroup } from '@mui/material';
import type { SchemasInboundMessage } from '../../../src/webview-messages/schemas-messages';
import type { DbErrorUtils } from '../../../src/utils/db-error-utils';
import { ButtonGroup } from '../../shared/components/button-group';
import { Loading } from '../../shared/components/loading';
import { SourceEditor } from '../../shared/components/source-editor';
import { SqlErrorDisplay } from '../../shared/components/sql-error-display';
import { schemasVsCodeApi } from '../vscode-api';

interface Props {
	view: { schema: string; name: string };
}

type DefinitionMode = 'formatted' | 'raw';

// A view's SQL, loaded when the tab opens (it isn't part of the tree's data - see
// LoadViewDefinitionMessage). The host sends both the text SYSVIEWS stores, which is usually one long
// line, and a copy run through the SQL formatter; formatted is the default, raw is a click away.
export function ViewDefinitionTab({ view }: Props) {
	const [definition, setDefinition] = useState<{ raw: string; formatted: string } | null>(null);
	const [error, setError] = useState<DbErrorUtils.SerializedError | null>(null);
	const [mode, setMode] = useState<DefinitionMode>('formatted');

	useEffect(() => {
		function onMessage(event: MessageEvent<SchemasInboundMessage>) {
			let message = event.data;

			if (message.schema !== view.schema || message.table !== view.name) {
				return;
			}

			if (message.command === 'viewDefinitionLoaded') {
				setDefinition({ raw: message.definition, formatted: message.formatted });
			} else if (message.command === 'viewDefinitionError') {
				setError(message.error);
			}
		}

		window.addEventListener('message', onMessage);
		schemasVsCodeApi.postMessage({ command: 'loadViewDefinition', schema: view.schema, table: view.name });
		return () => window.removeEventListener('message', onMessage);
	}, [view.schema, view.name]);

	function handleRefresh() {
		setDefinition(null);
		setError(null);
		schemasVsCodeApi.postMessage({ command: 'loadViewDefinition', schema: view.schema, table: view.name, forceRefresh: true });
	}

	if (error) {
		return (
			<Stack sx={{ p: 2 }}>
				<SqlErrorDisplay error={error} label="Failed to load the view definition" />
			</Stack>
		);
	}

	if (!definition) {
		return <Loading message="Loading definition..." />;
	}

	let text = mode === 'formatted' ? definition.formatted : definition.raw;

	return (
		<Stack spacing={1} sx={{ p: 2, height: '100%', minHeight: 0, boxSizing: 'border-box' }}>
			<Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
				<ToggleButtonGroup
					size="small"
					exclusive
					value={mode}
					onChange={(_, value: DefinitionMode | null) => value && setMode(value)}
					aria-label="Definition format"
				>
					<ToggleButton value="formatted">Formatted</ToggleButton>
					<ToggleButton value="raw">Raw</ToggleButton>
				</ToggleButtonGroup>

				<ButtonGroup actions={[{ label: 'Refresh', onClick: handleRefresh }]} />
			</Stack>

			<SourceEditor aria-label="View definition" value={text} readOnly copyable />
		</Stack>
	);
}
