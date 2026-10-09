import { useState } from 'react';
import { Box, Menu, MenuItem, Tab, Tabs, Typography } from '@mui/material';
import { tableKeyToString, TableKey } from '../table-key';

interface Props {
	openKeys: TableKey[];
	activeKey: TableKey | null;
	onSelect: (key: TableKey) => void;
	onClose: (key: TableKey) => void;
	onCloseOthers: (key: TableKey) => void;
	onCloseAll: () => void;
	// No table-editing feature exists yet, so nothing can call back to report a dirty table - this
	// defaults to "never dirty" and just leaves the dot/close-button swap below ready to wire up
	// once editing lands.
	isDirty?: (key: TableKey) => boolean;
	/** What a tab shows - defaults to the key's table name, which for a function is its specific name. */
	getLabel?: (key: TableKey) => string;
}

interface ContextMenuState {
	mouseX: number;
	mouseY: number;
	key: TableKey;
}

export function TableTabs({ openKeys, activeKey, onSelect, onClose, onCloseOthers, onCloseAll, isDirty = () => false, getLabel = key => key.table }: Props) {
	const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

	// MUI Tabs matches its value against each Tab's value via `===` - TableKey objects are rebuilt
	// on every render and wouldn't compare equal, so the string form is what Tabs actually compares,
	// and onChange maps that string back to the TableKey openKeys already holds.
	function handleChange(_: unknown, value: string) {
		let key = openKeys.find(openKey => tableKeyToString(openKey) === value);

		if (key) {
			onSelect(key);
		}
	}

	function handleContextMenu(event: React.MouseEvent, key: TableKey) {
		event.preventDefault();
		setContextMenu({ mouseX: event.clientX, mouseY: event.clientY, key });
	}

	function closeContextMenu() {
		setContextMenu(null);
	}

	return (
		<>
			<Tabs value={activeKey ? tableKeyToString(activeKey) : false} onChange={handleChange} variant="scrollable" scrollButtons="auto">
				{openKeys.map(key => {
					let keyString = tableKeyToString(key);
					let dirty = isDirty(key);

					return (
						<Tab
							key={keyString}
							value={keyString}
							onContextMenu={event => handleContextMenu(event, key)}
							// VS Code style: an inactive, unmodified tab shows neither icon at all; a dirty tab
							// shows the dot; hovering any tab swaps whatever's showing for the close button.
							sx={{
								'&:hover .tab-dirty-dot': { display: 'none' },
								'&:hover .tab-close-button': { opacity: 1 }
							}}
							label={
								// A close "button" nested inside Tab's own <button> would be invalid HTML (and
								// MUI ripple handling gets confused by it) - a plain clickable span with
								// stopPropagation avoids that while still keeping tab-select and close independent.
								<Box component="span" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
									<Typography component="span" variant="body2" noWrap sx={{ maxWidth: 160 }}>{getLabel(key)}</Typography>
									<Box component="span" sx={{ position: 'relative', width: 16, height: 16, flexShrink: 0 }}>
										{dirty && (
											<Box
												component="span"
												className="tab-dirty-dot"
												sx={{
													position: 'absolute',
													top: '50%',
													left: '50%',
													transform: 'translate(-50%, -50%)',
													width: 8,
													height: 8,
													borderRadius: '50%',
													bgcolor: 'text.secondary'
												}}
											/>
										)}
										<Box
											component="span"
											role="button"
											className="tab-close-button"
											aria-label={`Close ${getLabel(key)}`}
											onClick={event => {
												event.stopPropagation();
												onClose(key);
											}}
											sx={{
												position: 'absolute',
												inset: 0,
												display: 'flex',
												alignItems: 'center',
												justifyContent: 'center',
												borderRadius: '4px',
												cursor: 'pointer',
												opacity: 0,
												'&:hover': { bgcolor: 'action.hover' }
											}}
										>
											✕
										</Box>
									</Box>
								</Box>
							}
						/>
					);
				})}
			</Tabs>

			<Menu
				open={contextMenu !== null}
				onClose={closeContextMenu}
				anchorReference="anchorPosition"
				anchorPosition={contextMenu ? { top: contextMenu.mouseY, left: contextMenu.mouseX } : undefined}
			>
				<MenuItem
					onClick={() => {
						if (contextMenu) {
							onClose(contextMenu.key);
						}
						closeContextMenu();
					}}
				>
					Close
				</MenuItem>
				<MenuItem
					disabled={openKeys.length <= 1}
					onClick={() => {
						if (contextMenu) {
							onCloseOthers(contextMenu.key);
						}
						closeContextMenu();
					}}
				>
					Close Others
				</MenuItem>
				<MenuItem
					onClick={() => {
						onCloseAll();
						closeContextMenu();
					}}
				>
					Close All
				</MenuItem>
			</Menu>
		</>
	);
}
