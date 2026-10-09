import { createContext, useContext } from 'react';
import type { DataEditSettings } from '../../src/utils/data-edit-defaults';
import { DataEditDefaults } from '../../src/utils/data-edit-defaults';

// The Data tab's edit settings (db2-workbench.dataEdit.*), app-wide: App owns them - seeded from the
// initial state, replaced by dataEditSettingsChanged - and every table's Data tab reads them for Add Row
// and its Settings dialog. A context rather than props, since they'd otherwise be threaded through
// TableDetail and ViewDetail only to reach the Data tab.
export interface DataEditSettingsContextValue {
	settings: DataEditSettings;
	/** Writes them to the user's settings, and applies them here straight away. */
	save: (settings: DataEditSettings) => void;
}

export const DataEditSettingsContext = createContext<DataEditSettingsContextValue>({
	settings: DataEditDefaults.DEFAULT_SETTINGS,
	save: () => undefined
});

export function useDataEditSettings(): DataEditSettingsContextValue {
	return useContext(DataEditSettingsContext);
}
