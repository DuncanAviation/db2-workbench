import { useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import { Button, IconButton, Menu, MenuItem, ButtonGroup as MuiButtonGroup, Stack, Tooltip } from '@mui/material';

export interface ButtonGroupAction {
	label: string;
	icon?: ReactNode;
	onClick: () => void;
	disabled?: boolean;
	/** Shown as a tooltip only while disabled - e.g. explaining why "Add Row" is unavailable for a
	 * non-insertable view. Ignored while the action is enabled. */
	disabledReason?: string;
	/** Other ways of doing the same thing - e.g. "Add Row in Dialog" beside "Add Row". Turns the button
	 * into a split button whose arrow lists them; in a menu (the overflow menu, a right-click menu) they
	 * are plain items right after this one. */
	secondaryActions?: ButtonGroupAction[];
}

interface Props {
	actions: ButtonGroupAction[];
}

const MAX_BUTTONS = 5;

/** An action followed by its secondary actions, for a menu that lists every one as its own item. */
export function flattenActions(actions: ButtonGroupAction[]): ButtonGroupAction[] {
	return actions.flatMap(action => [action, ...(action.secondaryActions ?? [])]);
}

// Generic "a few buttons, the rest overflow into a menu" toolbar - not tied to tables. First use is
// DataTable's table actions, but this has no table/row knowledge of its own.
export function ButtonGroup({ actions }: Props) {
	const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

	if(actions.length === 0) {
		return null;
	}

	// A split button counts as one button - its secondary actions live in its own menu.
	const buttonActions = actions.slice(0, MAX_BUTTONS);
	const overflowActions = flattenActions(actions.slice(MAX_BUTTONS));

	function handleOverflowOpen(event: MouseEvent<HTMLElement>) {
		setAnchorEl(event.currentTarget);
	}

	function handleOverflowClose() {
		setAnchorEl(null);
	}

	return (
		<Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
			{buttonActions.map(action => (
				<Tooltip key={action.label} title={action.disabled ? action.disabledReason ?? '' : ''}>
					<span>
						{action.secondaryActions?.length
							? <SplitButton action={action} secondaryActions={action.secondaryActions} />
							: (
								<Button
									size="small"
									variant="outlined"
									startIcon={action.icon}
									disabled={action.disabled}
									onClick={action.onClick}
								>
									{action.label}
								</Button>
							)}
					</span>
				</Tooltip>
			))}

			{overflowActions.length > 0 && (
				<>
					<IconButton
						aria-label="More actions"
						onClick={handleOverflowOpen}
						sx={{ border: 1, borderColor: 'divider', borderRadius: 1 }}
					>
						⋮
					</IconButton>

					<Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={handleOverflowClose}>
						{overflowActions.map(action => (
							<MenuItem
								key={action.label}
								disabled={action.disabled}
								onClick={() => {
									handleOverflowClose();
									action.onClick();
								}}
							>
								{action.icon && <Stack sx={{ mr: 1 }}>{action.icon}</Stack>}
								{action.label}
							</MenuItem>
						))}
					</Menu>
				</>
			)}
		</Stack>
	);
}

// The main button runs the action itself; the arrow beside it opens a menu of the secondary actions.
// The arrow stays usable while only the main action is disabled, since a secondary one may not be.
function SplitButton({ action, secondaryActions }: { action: ButtonGroupAction; secondaryActions: ButtonGroupAction[] }) {
	const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
	const allDisabled = Boolean(action.disabled) && secondaryActions.every(secondary => secondary.disabled);

	function handleClose() {
		setAnchorEl(null);
	}

	return (
		<>
			<MuiButtonGroup size="small" variant="outlined">
				<Button startIcon={action.icon} disabled={action.disabled} onClick={action.onClick}>
					{action.label}
				</Button>
				<Button
					aria-label={`More ${action.label} options`}
					aria-haspopup="menu"
					aria-expanded={anchorEl ? 'true' : undefined}
					disabled={allDisabled}
					onClick={event => setAnchorEl(event.currentTarget)}
					sx={{ px: 0, minWidth: 28 }}
				>
					<ArrowDropDownIcon fontSize="small" />
				</Button>
			</MuiButtonGroup>

			<Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={handleClose}>
				{secondaryActions.map(secondary => (
					<MenuItem
						key={secondary.label}
						disabled={secondary.disabled}
						onClick={() => {
							handleClose();
							secondary.onClick();
						}}
					>
						{secondary.icon && <Stack sx={{ mr: 1 }}>{secondary.icon}</Stack>}
						{secondary.label}
					</MenuItem>
				))}
			</Menu>
		</>
	);
}
