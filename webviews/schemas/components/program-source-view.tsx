import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Alert, Stack, Tab, Tabs, Typography } from '@mui/material';
import type { SchemasProgramSource } from '../../../src/webview-messages/schemas-messages';
import { SourceEditor } from '../../shared/components/source-editor';
import { SqlErrorDisplay } from '../../shared/components/sql-error-display';

interface Props {
	/** At least one - the host says why when there are none, and the caller shows that instead. */
	sources: SchemasProgramSource[];
	/** Names the editor for assistive tech - "Trigger source", "Routine source". */
	editorLabel: string;
	/** Shown on the location's line, before it - what the source belongs to, so a host needs no line of its own for it. */
	locationPrefix?: ReactNode;
	/** Shown at the far end of the location's line - e.g. a Refresh button. */
	locationActions?: ReactNode;
	/** A tab's label - the module, or the location for a source with none, unless the host says otherwise. */
	tabLabel?: (source: SchemasProgramSource) => string;
}

// The sources a native program was compiled from, as the trigger View Source dialog and a routine's
// Program Source tab both show them: one tab per ILE module (none for a single source), the location it
// was read from, then its text - or why it couldn't be read. Fills its parent's height, so the editor is
// the one thing that scrolls and the tabs and location stay in view.
// It opens on the first source - a host that knows which one matters most puts it there.
export function ProgramSourceView({ sources, editorLabel, locationPrefix, locationActions, tabLabel }: Props) {
	const [selected, setSelected] = useState(0);

	useEffect(() => {
		setSelected(0);
	}, [sources]);

	let currentIndex = sources[selected] ? selected : 0;
	let current = sources[currentIndex];

	return (
		<Stack spacing={1} sx={{ flexGrow: 1, minHeight: 0 }}>
			{sources.length > 1 && (
				<Tabs value={selected} onChange={(_, value: number) => setSelected(value)} variant="scrollable" scrollButtons="auto" aria-label="Modules">
					{sources.map((source, index) => <Tab key={`${source.module}-${index}`} label={tabLabel?.(source) ?? source.module ?? source.location} value={index} />)}
				</Tabs>
			)}

			<Stack direction="row" sx={{ alignItems: 'center', gap: 1, flexShrink: 0 }}>
				{locationPrefix}
				<Typography variant="body2" color="text.secondary" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>{current?.location}</Typography>
				{locationActions}
			</Stack>

			{current?.notice && <Alert severity={current.notice.severity} sx={{ flexShrink: 0 }}>{current.notice.text}</Alert>}

			{current?.unavailable
				? <Typography>{current.unavailable}</Typography>
				: current?.error
					? <SqlErrorDisplay error={current.error} label="Failed to read this source" />
					: <SourceEditor aria-label={editorLabel} value={current?.text ?? ''} readOnly copyable />}
		</Stack>
	);
}
