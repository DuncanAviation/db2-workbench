import { useEffect, useState } from 'react';
import { Button, Divider, Popover, Stack, TextField } from '@mui/material';
import { DateCalendar } from '@mui/x-date-pickers/DateCalendar';
import { MultiSectionDigitalClock } from '@mui/x-date-pickers/MultiSectionDigitalClock';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';

export type TemporalCategory = 'date' | 'time' | 'timestamp';

// DateCalendar's own root is a fixed 336px tall (MUI X's internal VIEW_HEIGHT constant), but each of
// MultiSectionDigitalClock's hour/minute/second columns defaults to a shorter 232px
// (DIGITAL_CLOCK_VIEW_HEIGHT) - side by side for a timestamp, that reads as the clock being cut off
// short next to the calendar. Neither constant is part of the package's public API, so this is
// reproduced by hand rather than imported, to stretch the clock's columns up to the calendar's own
// height instead.
const CALENDAR_VIEW_HEIGHT = 336;

interface Props {
	category: TemporalCategory;
	anchorEl: HTMLElement | null;
	open: boolean;
	/** The field's current raw text - re-seeds the calendar/clock every time the popover opens, and
	 * (for a timestamp) supplies the fractional-seconds suffix that survives a pick untouched. */
	value: string;
	onClose: () => void;
	onApply: (newValue: string) => void;
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

// Splits a timestamp's text the same way FieldUtils.formatTimestampLiteral does (first space or "T"),
// so the seed/re-attached fraction here agree with how the rest of this app already parses these.
function splitTimestampText(value: string): { datePart: string; timePart: string } {
	let [datePart = '', timePart = ''] = value.trim().split(/[T ]/);
	return { datePart: datePart, timePart: timePart };
}

// Best-effort seed for the calendar/clock widgets from whatever the field currently holds - an
// unparseable or blank value just opens the picker at today/midnight instead of erroring; the typed
// text itself is never touched by a failed parse (only ever read here, never written back until
// Apply/a date pick).
function parseSeed(value: string, category: TemporalCategory): Dayjs {
	let now = dayjs();
	let { datePart, timePart } = category === 'timestamp'
		? splitTimestampText(value)
		: { datePart: category === 'date' ? value.trim() : '', timePart: category === 'time' ? value.trim() : '' };

	let dateMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(datePart);
	let timeMatch = /^(\d{2}):(\d{2}):(\d{2})/.exec(timePart);

	return now
		.year(dateMatch ? Number(dateMatch[1]) : now.year())
		.month(dateMatch ? Number(dateMatch[2]) - 1 : now.month())
		.date(dateMatch ? Number(dateMatch[3]) : now.date())
		.hour(timeMatch ? Number(timeMatch[1]) : (category === 'date' ? 0 : now.hour()))
		.minute(timeMatch ? Number(timeMatch[2]) : (category === 'date' ? 0 : now.minute()))
		.second(timeMatch ? Number(timeMatch[3]) : (category === 'date' ? 0 : now.second()));
}

// Whatever fractional-seconds suffix (".NNNNNN") the current value already has - seeds the
// microseconds field below every time the popover opens. TIME values never carry one in DB2, so this
// is only ever consulted for the timestamp category.
function extractFraction(value: string): string {
	let match = /:\d{2}\.(\d+)/.exec(value);
	return match ? match[1] : '';
}

// Digits only, capped at 6 (DB2 TIMESTAMP's microsecond precision) - no sign, no decimal point, so
// there's no way to type a negative value in the first place.
function sanitizeFraction(raw: string): string {
	return raw.replace(/\D/g, '').slice(0, 6);
}

// Read left-to-right as significant digits with trailing zeros implied (typing "5" means 500000
// microseconds, not 5) - the same convention FieldUtils.formatTimestampLiteral already uses when
// parsing a typed timestamp's fractional part.
function padFraction(fraction: string): string {
	return fraction.padEnd(6, '0').slice(0, 6);
}

function formatResult(picked: Dayjs, category: TemporalCategory, fraction: string): string {
	let datePart = `${picked.year()}-${pad(picked.month() + 1)}-${pad(picked.date())}`;
	let timePart = `${pad(picked.hour())}:${pad(picked.minute())}:${pad(picked.second())}`;

	if(category === 'date') {
		return datePart;
	}

	if(category === 'time') {
		return timePart;
	}

	return `${datePart} ${timePart}.${padFraction(fraction)}`;
}

// Deliberately built from the *pure* calendar/clock sub-components (DateCalendar/
// MultiSectionDigitalClock) rather than MUI X's own DatePicker/TimePicker/DateTimePicker field
// components - those own their text field's formatting via dayjs, which only supports millisecond
// (3-digit) fractional seconds, and would silently truncate a DB2 TIMESTAMP's microsecond (6-digit)
// precision. FieldInput's own plain TextField stays the sole source of truth for the string; this
// popover only ever produces a fully-formed replacement value (by hand, never via dayjs.format()) for
// FieldInput to hand to onChange, exactly like a normal typed edit.
export function FieldDateTimePicker({ category, anchorEl, open, value, onClose, onApply }: Props) {
	const [draft, setDraft] = useState<Dayjs>(() => parseSeed(value, category));
	const [fractionDraft, setFractionDraft] = useState<string>(() => extractFraction(value));

	// Re-seeds the draft (and, for a timestamp, the microseconds field) from the field's current value
	// every time the popover opens - not tied to value's identity, only to the open transition, so a
	// stale draft from a previous open doesn't leak into this one.
	useEffect(() => {
		if(open) {
			setDraft(parseSeed(value, category));
			setFractionDraft(extractFraction(value));
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	function handleDatePick(picked: Dayjs | null) {
		if(!picked) {
			return;
		}

		if(category === 'date') {
			// A single unambiguous action - commit and close immediately, matching ordinary
			// calendar-picker UX (no further selection needed once a day is chosen).
			onApply(formatResult(picked, category, fractionDraft));
			onClose();
			return;
		}

		setDraft(picked);
	}

	function handleTimePick(picked: Dayjs | null) {
		if(picked) {
			setDraft(picked);
		}
	}

	function handleApply() {
		onApply(formatResult(draft, category, fractionDraft));
		onClose();
	}

	return (
		<Popover open={open} anchorEl={anchorEl} onClose={onClose} anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}>
			<Stack>
				{/* timestamp: calendar and clock side by side (matching MUI X's own DesktopDateTimePicker
					layout) with a vertical divider between them, rather than stacked - date/time alone only
					ever render one widget, so direction doesn't matter for those. */}
				<Stack direction="row">
					{category !== 'time' && (
						<DateCalendar
							value={draft}
							onChange={handleDatePick}
							views={['year', 'month', 'day']}
						/>
					)}
					{category === 'timestamp' && <Divider orientation="vertical" flexItem />}
					{category !== 'date' && (
						<MultiSectionDigitalClock
							value={draft}
							onChange={handleTimePick}
							views={['hours', 'minutes', 'seconds']}
							ampm={false}
							// Defaults to { hours: 1, minutes: 5, seconds: 5 } - every DB2 minute/second value is
							// valid, so stepping by 5 would make most of them unreachable from the clock alone.
							timeSteps={{ hours: 1, minutes: 1, seconds: 1 }}
							// width: 'auto' overrides MuiMultiSectionDigitalClock-root's own hardcoded
							// width: '100%' - unconstrained, that stretches it to fill whatever space this flex
							// row leaves available, well past its actual 3-column (hours/minutes/seconds)
							// content width, leaving a gap between the seconds column and the popover's edge.
							sx={{ width: 'auto', '& .MuiMultiSectionDigitalClockSection-root': { maxHeight: CALENDAR_VIEW_HEIGHT } }}
						/>
					)}

					{category === 'timestamp' && (
						<>
							<Divider orientation="vertical" flexItem />
							<Stack sx={{ justifyContent: 'center', px: 2 }}>
								<TextField
									label="Microseconds"
									value={fractionDraft}
									onChange={event => setFractionDraft(sanitizeFraction(event.target.value))}
									slotProps={{ htmlInput: { maxLength: 6, inputMode: 'numeric', pattern: '[0-9]*' } }}
									sx={{ width: 110 }}
								/>
							</Stack>
						</>
					)}
				</Stack>

				{category !== 'date' && (
					// hour/minute/second are picked as three separate clicks, so (unlike a single day pick)
					// closing on the first one would be premature - Apply commits the whole draft.
					<Stack direction="row" spacing={1} sx={{ p: 1, justifyContent: 'flex-end' }}>
						<Button onClick={onClose}>Cancel</Button>
						<Button variant="contained" onClick={handleApply}>Apply</Button>
					</Stack>
				)}
			</Stack>
		</Popover>
	);
}
