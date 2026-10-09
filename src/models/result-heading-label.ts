// The three values `db2-workbench.resultHeadingLabels` can hold, in its own module rather than inside
// Configurations' namespace (where they used to live) for one concrete reason: configurations.ts imports
// vscode, and anything that imports vscode can't be unit tested (see the .spec.ts/mocha convention).
// The diagram's pure column-label logic needs these same values, so they had to move somewhere pure.
// Configurations re-exports this as `Configurations.ResultHeadingLabels`, so every existing reference -
// and package.json's own enum for the setting - still reads the same.
export enum ResultHeadingLabel {
	SHORT_NAME = 'Short Name',
	LONG_NAME = 'Long Name',
	DESCRIPTION = 'Description'
}
