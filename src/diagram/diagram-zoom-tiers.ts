// Pure zoom-threshold logic for the main canvas's "Google Maps" level-of-detail behavior - kept here
// (not in webviews/diagram/) specifically so it's unit-testable through this project's existing
// .spec.ts/mocha convention, which only compiles src/. The webview imports these functions directly
// (esbuild bundles across that boundary fine - see the diagram feature's design notes on why constants
// are duplicated but logic like this is shared instead).

export type DiagramZoomTier = 'cluster' | 'collapsed' | 'expanded';

// Below this, tables are hidden entirely and their schema shows as a summary box instead.
const CLUSTER_ZOOM_THRESHOLD = 0.15;
// Below this (but at/above cluster), tables show collapsed (header only); at/above it, tables expand to
// show their full column list.
const EXPANDED_ZOOM_THRESHOLD = 0.55;
// Below this - i.e. zoomed out even further than the cluster threshold - a schema's summary box drops
// its table count and shows only the schema name, per the "if it doesn't fit, just show the name" spec.
const SCHEMA_NAME_ONLY_ZOOM_THRESHOLD = 0.05;

export function tierForZoom(zoom: number): DiagramZoomTier {
	if(zoom < CLUSTER_ZOOM_THRESHOLD) {
		return 'cluster';
	}

	if(zoom < EXPANDED_ZOOM_THRESHOLD) {
		return 'collapsed';
	}

	return 'expanded';
}

export function shouldShowSchemaTableCount(zoom: number): boolean {
	return zoom >= SCHEMA_NAME_ONLY_ZOOM_THRESHOLD;
}
