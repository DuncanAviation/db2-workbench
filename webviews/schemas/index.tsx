import { createRoot } from 'react-dom/client';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { App } from './app';
import { VsCodeThemeProvider } from '../shared/theme/vscode-theme-provider';

const container = document.getElementById('root');

if (container) {
	createRoot(container).render(
		<VsCodeThemeProvider>
			{/* Backs FieldInput's date/time picker (Add/Edit Row dialog, inline grid editing) - DateCalendar/
				MultiSectionDigitalClock need this ancestor to operate, even though the actual committed
				value is always formatted by hand rather than through the adapter - see field-date-time-picker.tsx. */}
			<LocalizationProvider dateAdapter={AdapterDayjs}>
				<App />
			</LocalizationProvider>
		</VsCodeThemeProvider>
	);
}
