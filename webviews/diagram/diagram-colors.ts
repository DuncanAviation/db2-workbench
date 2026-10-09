// Shared visual constants used by more than one diagram component - kept separate from
// layout-constants.ts, which is specifically the geometry numbers mirrored from src/diagram/diagram-xml.ts.

// Re-exported so every diagram file reaches this diagram's own colors through this one module, the same
// as HIGHLIGHT_COLOR/COLUMN_ICON_COLOR below - it just happens to be DEFINED in webviews/shared, since
// the schema browser's Imported/Enhanced/New badges need the exact same color (see IMPORT_COLOR's own
// comment there for why).
export { IMPORT_COLOR } from '../shared/components/import-badge';

// Used for a selected table, a selected/highlighted column row, and the relationship line(s) touching
// that selection, so a selection reads as one connected, colored path rather than three unrelated
// visual treatments.
//
// A fixed hex rather than a `var(--vscode-*)` token deliberately: --vscode-charts-orange still looked
// dim/translucent in real testing - some themes define that specific token with its own alpha channel
// baked into the color (meant for overlaying same-colored chart series), which no amount of strokeWidth/
// strokeOpacity on our end can compensate for. A highlight color needs to be reliably solid in every
// theme, which only a color we own outright can guarantee.
export const HIGHLIGHT_COLOR = '#ff8c00';

// Shared icon color for a column's identity/key iconography (primary key, foreign key, identity column)
// - deliberately one color for all three rather than three different ones, so they read as one family
// of "this column is special" markers instead of implying an importance ranking between them.
export const COLUMN_ICON_COLOR = 'info.main';

// The cluster-tier schema-to-schema link line (see diagram-schema-links.ts) - deliberately neutral/muted
// rather than either schema's own color, since it connects two differently-colored boxes and picking one
// side's color would misleadingly suggest the relationship "belongs" to that schema.
export const SCHEMA_LINK_COLOR = 'var(--vscode-descriptionForeground, #9d9d9d)';
