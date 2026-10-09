import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import type { SchemasInboundMessage, SchemasProgramSource, SchemasTrigger, SchemasTriggerHandler } from '../../../src/webview-messages/schemas-messages';
import type { DbErrorUtils } from '../../../src/utils/db-error-utils';
import { Loading } from '../../shared/components/loading';
import { SqlErrorDisplay } from '../../shared/components/sql-error-display';
import { schemasVsCodeApi } from '../vscode-api';
import { ProgramSourceView } from './program-source-view';

interface Props {
	table: { schema: string; name: string };
	/** The trigger whose source to show - the dialog is open while this is set. */
	trigger: SchemasTrigger | null;
	onClose: () => void;
}

// The Triggers tab's View Source, for either kind of trigger. An SQL trigger's body came with the trigger
// list, so it shows straight away. An external trigger runs a program, so its source is asked of the host
// when the dialog opens: one tab per ILE module (a single one for an OPM program), each showing that
// module's source member or IFS file, or why it couldn't be read.
//
// When the program dispatches - looks up the program that really handles this table in a routing table,
// the way Trigger Mediator does - the handlers' sources come first, since that is the code the trigger
// runs for this table, and the dispatcher's own modules follow. Every tab is then labelled with the
// program it belongs to.
export function TriggerSourceDialog({ table, trigger, onClose }: Props) {
	const [sources, setSources] = useState<SchemasProgramSource[] | null>(null);
	const [handlers, setHandlers] = useState<SchemasTriggerHandler[]>([]);
	const [error, setError] = useState<DbErrorUtils.SerializedError | null>(null);

	const triggerName = trigger?.triggerName;
	const sqlBody = trigger?.actionStatement;
	const program = trigger ? [trigger.programLibrary, trigger.programName].filter(Boolean).join('/') : '';

	useEffect(() => {
		setSources(null);
		setHandlers([]);
		setError(null);

		if (!trigger) {
			return;
		}

		if (sqlBody) {
			setSources([{ location: 'SQL trigger body', text: sqlBody }]);
			return;
		}

		function onMessage(event: MessageEvent<SchemasInboundMessage>) {
			let message = event.data;

			if (message.schema !== table.schema || message.table !== table.name) {
				return;
			}

			if (message.command === 'triggerSourceLoaded' && message.triggerName === triggerName) {
				setSources(message.sources);
				setHandlers(message.handlers ?? []);
			} else if (message.command === 'triggerSourceError' && message.triggerName === triggerName) {
				setError(message.error);
			}
		}

		window.addEventListener('message', onMessage);
		schemasVsCodeApi.postMessage({
			command: 'loadTriggerSource',
			schema: table.schema,
			table: table.name,
			triggerName: trigger.triggerName,
			programLibrary: trigger.programLibrary,
			programName: trigger.programName
		});
		return () => window.removeEventListener('message', onMessage);
		// Keyed on the trigger's identity, not the object, so a list refresh behind an open dialog doesn't re-read.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [table.schema, table.name, triggerName, sqlBody]);

	// Memoized so the tab selection survives a re-render - ProgramSourceView starts over on a new array.
	const shown = useMemo(() => {
		if (!sources || handlers.length === 0) {
			return { sources: sources, labels: undefined };
		}

		let labels = new Map<SchemasProgramSource, string>();
		let label = (object: string, source: SchemasProgramSource) => source.module == null || source.module === object ? object : `${object}: ${source.module}`;

		for (let handler of handlers) {
			handler.sources.forEach(source => labels.set(source, label(handler.object, source)));
		}

		sources.forEach(source => labels.set(source, label(trigger?.programName ?? '', source)));

		return { sources: [...handlers.flatMap(handler => handler.sources), ...sources], labels: labels };
	}, [sources, handlers, trigger?.programName]);

	function renderBody() {
		if (error) {
			return <SqlErrorDisplay error={error} label="Failed to find the trigger program's source" />;
		}

		if (!shown.sources) {
			return <Loading message="Loading source..." />;
		}

		if (shown.sources.length === 0) {
			return <Typography>No source location is recorded for program {program}.</Typography>;
		}

		let labels = shown.labels;
		return <ProgramSourceView sources={shown.sources} editorLabel="Trigger source" tabLabel={labels && (source => labels.get(source) ?? source.module ?? source.location)} />;
	}

	return (
		// A fixed height rather than one that follows the content: the editor fills whatever the tabs and
		// location line leave, which needs a bounded parent to fill.
		<Dialog open={Boolean(trigger)} onClose={onClose} maxWidth="md" fullWidth slotProps={{ paper: { sx: { height: '80vh' } } }}>
			<DialogTitle>
				{trigger?.triggerSchema}.{trigger?.triggerName}
				{/* A span: DialogTitle is an h2, which a p may not sit inside. */}
				{!sqlBody && program && <Typography component="span" variant="body2" color="text.secondary" sx={{ display: 'block' }}>Program {program}</Typography>}
				{handlers.map(handler => (
					<Typography key={handler.program} component="span" variant="body2" color="text.secondary" sx={{ display: 'block' }}>
						Calls {handler.program}{handler.entry && <> procedure {handler.entry}</>} for this table, through {handler.via}
					</Typography>
				))}
			</DialogTitle>
			<DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1, overflow: 'hidden' }}>
				{/* The dispatcher's own SQL skips this handler's routing row, so it is shown but not called today -
				    styled like a source's "changed since compile" notice, and above the tabs since it applies to all of them. */}
				{handlers.filter(handler => handler.unselected).map(handler => (
					<Alert key={handler.program} severity="warning" sx={{ flexShrink: 0 }}>
						Inactive: {handler.unselected?.column} is '{handler.unselected?.actual}' for {handler.object} in {handler.via}, and {trigger?.programName} only reads rows where {handler.unselected?.column} = '{handler.unselected?.value}'
					</Alert>
				))}
				{trigger && renderBody()}
			</DialogContent>
			<DialogActions>
				<Button onClick={onClose}>Close</Button>
			</DialogActions>
		</Dialog>
	);
}
