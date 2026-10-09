import { useEffect, useRef, useState } from 'react';
import { Box, Button, Checkbox, FormControlLabel, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { SourceEditor } from '../shared/components/source-editor';
import { getInitialState } from './initial-state';
import { formattingEditorVsCodeApi } from './vscode-api';
import type { PreviewResultMessage } from '../../src/webview-messages/formatting-editor-messages.js';

type KeywordCase = 'upper' | 'lower' | 'preserve';
type SelectFieldWrapping = 'oneColumnPerLine' | 'wrapToWidth';
type ClauseLayout = 'expanded' | 'compact';

export function App() {
	const { options: initialOptions, initialSql, sourceSql } = getInitialState();

	const [tabWidth, setTabWidth] = useState(initialOptions.tabWidth);
	const [useTabs, setUseTabs] = useState(initialOptions.useTabs);
	const [keywordCase, setKeywordCase] = useState<KeywordCase>(initialOptions.keywordCase);
	const [denseOperators, setDenseOperators] = useState(initialOptions.denseOperators);
	const [removeComments, setRemoveComments] = useState(initialOptions.removeComments);
	const [linesBetweenQueries, setLinesBetweenQueries] = useState(initialOptions.linesBetweenQueries);
	const [expressionMaxWidth, setExpressionMaxWidth] = useState(initialOptions.expressionMaxWidth);
	const [selectFieldWrapping, setSelectFieldWrapping] = useState<SelectFieldWrapping>(initialOptions.selectFieldWrapping);
	const [clauseLayout, setClauseLayout] = useState<ClauseLayout>(initialOptions.clauseLayout);
	const [indentJoins, setIndentJoins] = useState(initialOptions.indentJoins);
	const [indentWhere, setIndentWhere] = useState(initialOptions.indentWhere);

	const [sqlText, setSqlText] = useState(initialSql);
	const sqlFieldRef = useRef<HTMLTextAreaElement | null>(null);
	const isFirstRender = useRef(true);
	// Every preview formats sourceRef (the text the user last wrote or pasted), never the box's own
	// formatted output, so toggling a lossy option back restores what it took away. The box only
	// becomes the new source once it differs from the last formatted result -- i.e. the user edited
	// it -- and from then on their edit wins, even if it was made while comments were removed.
	const sourceRef = useRef(sourceSql);
	const lastFormattedRef = useRef(initialSql);

	function currentOptions() {
		return { tabWidth, useTabs, keywordCase, denseOperators, removeComments, linesBetweenQueries, expressionMaxWidth, selectFieldWrapping, clauseLayout, indentJoins, indentWhere };
	}

	function requestPreview() {
		let boxText = sqlFieldRef.current?.value ?? sqlText;

		if (boxText !== lastFormattedRef.current) {
			sourceRef.current = boxText;
		}

		formattingEditorVsCodeApi.postMessage({ command: 'previewFormat', sql: sourceRef.current, options: currentOptions() });
	}

	// Listens for the extension host's formatted response to any 'previewFormat' request (fired
	// either by an option change or by a paste into the SQL box below) and writes it back into the
	// box in place -- there's no separate readonly output, the box itself becomes the formatted result.
	useEffect(() => {
		function handleMessage(event: MessageEvent<PreviewResultMessage>) {
			if (event.data.command === 'previewResult') {
				lastFormattedRef.current = event.data.text;
				setSqlText(event.data.text);
			}
		}

		window.addEventListener('message', handleMessage);
		return () => window.removeEventListener('message', handleMessage);
	}, []);

	// Reformats the box's current contents whenever an option changes, skipping the initial mount
	// since the extension host already formatted the seed SQL with these same options before opening.
	useEffect(() => {
		if (isFirstRender.current) {
			isFirstRender.current = false;
			return;
		}

		const timeout = setTimeout(requestPreview, 250);
		return () => clearTimeout(timeout);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [tabWidth, useTabs, keywordCase, denseOperators, removeComments, linesBetweenQueries, expressionMaxWidth, selectFieldWrapping, clauseLayout, indentJoins, indentWhere]);

	// Only paste (not every keystroke) triggers a reformat, so the user can freely type/edit without
	// the box fighting them. The native paste applies to the DOM synchronously before this timeout
	// runs, so reading the ref's value here reflects the pasted-in text.
	function handlePaste() {
		setTimeout(requestPreview, 0);
	}

	function handleSave() {
		formattingEditorVsCodeApi.postMessage({ command: 'saveFormatting', options: currentOptions() });
	}

	function handleCancel() {
		formattingEditorVsCodeApi.postMessage({ command: 'cancelEdit' });
	}

	return (
		<Stack spacing={2} sx={{ height: '100vh', minHeight: 0, overflow: 'hidden', p: 3, boxSizing: 'border-box' }}>
			<Stack direction="row" spacing={3} sx={{ flexGrow: 1, minHeight: 0, overflow: 'hidden' }}>
				<Stack sx={{ width: 340, flexShrink: 0, minHeight: 0, overflow: 'hidden' }}>
					<Typography variant="subtitle1" sx={{ flexShrink: 0, pb: 1 }}>Options</Typography>

					<Box sx={{ flexGrow: 1, minHeight: 0, overflow: 'auto' }}>
						<Stack spacing={2} sx={{ pr: 1, pt: 1 }}>
							<Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
								<FormControlLabel control={<Checkbox checked={useTabs} onChange={e => setUseTabs(e.target.checked)} />} label="Use Tabs" />
								<TextField
									label="Tab Width"
									type="number"
									value={tabWidth}
									onChange={e => setTabWidth(Number(e.target.value))}
									disabled={useTabs}
									sx={{ flex: 1 }}
								/>
							</Stack>

							<TextField select label="Keyword Case" value={keywordCase} onChange={e => setKeywordCase(e.target.value as KeywordCase)}>
								<MenuItem value="preserve">Preserve</MenuItem>
								<MenuItem value="upper">Upper</MenuItem>
								<MenuItem value="lower">Lower</MenuItem>
							</TextField>

							<TextField select label="Clause Layout" value={clauseLayout} onChange={e => setClauseLayout(e.target.value as ClauseLayout)}>
								<MenuItem value="compact">Compact</MenuItem>
								<MenuItem value="expanded">Expanded</MenuItem>
							</TextField>

							<TextField
								select
								label="Select Field Wrapping"
								value={selectFieldWrapping}
								onChange={e => setSelectFieldWrapping(e.target.value as SelectFieldWrapping)}
							>
								<MenuItem value="wrapToWidth">Wrap To Width</MenuItem>
								<MenuItem value="oneColumnPerLine">One Column Per Line</MenuItem>
							</TextField>

							<FormControlLabel
								control={<Checkbox checked={indentJoins} onChange={e => setIndentJoins(e.target.checked)} />}
								label="Indent Joins"
							/>

							<FormControlLabel
								control={<Checkbox checked={indentWhere} onChange={e => setIndentWhere(e.target.checked)} />}
								label="Indent Where"
							/>

							<FormControlLabel
								control={<Checkbox checked={denseOperators} onChange={e => setDenseOperators(e.target.checked)} />}
								label="Dense Operators"
							/>

							<FormControlLabel
								control={<Checkbox checked={removeComments} onChange={e => setRemoveComments(e.target.checked)} />}
								label="Remove Comments"
							/>

							<TextField
								label="Max Width"
								type="number"
								value={expressionMaxWidth}
								onChange={e => setExpressionMaxWidth(Number(e.target.value))}
							/>

							<TextField
								label="Lines Between Queries"
								type="number"
								value={linesBetweenQueries}
								onChange={e => setLinesBetweenQueries(Number(e.target.value))}
							/>
						</Stack>
					</Box>
				</Stack>

				<Stack sx={{ flexGrow: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
					<SourceEditor
						aria-label="SQL"
						value={sqlText}
						onChange={setSqlText}
						onPaste={handlePaste}
						inputRef={sqlFieldRef}
					/>
				</Stack>
			</Stack>

			<Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
				<Button variant="outlined" color="secondary" onClick={handleCancel}>Cancel</Button>
				<Button variant="contained" color="primary" onClick={handleSave}>Save</Button>
			</Stack>
		</Stack>
	);
}
