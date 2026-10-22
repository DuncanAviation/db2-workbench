# Changelog

All notable changes to DB2 Workbench are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/).

DB2 Workbench is in **beta**: settings and file formats may still change, and version numbers do not yet imply stability guarantees.

Odd minor versions (0.1.x, 0.3.x) are published to the Marketplace's pre-release channel and even minor versions (0.2.x, 0.4.x) as stable releases.

## [Unreleased]

### Added

- **Materialized query tables in the schema browser.** MQTs are listed under their own "Materialized Query Tables" node in each schema and open with the table tabs that apply to them (Columns, Indexes, Advised Indexes, Data), plus a Definition tab showing the select statement the MQT was created from. The Info tab shows how the MQT is maintained and refreshed, when it was last refreshed, and its isolation level.
- Materialized query tables are offered by content assist and resolved by View Table Details, the same as tables.
- **Column header tooltips.** Hovering a column header in the results grid or the schema browser's Data tab shows the column's short name, long name, description and type, plus whether it's an identity column or NOT NULL. Computed columns show the type the driver reports.
- **Copy column names from a header.** Right-clicking a column header in the results grid or the Data tab offers Copy Name, Copy Long Name and Copy Description.
- **Copy names from a diagram.** Right-clicking a table's header on a diagram offers Copy Name for the table; right-clicking one of its columns offers the same Copy Name, Copy Long Name and Copy Description as a grid header.
- **Duplicate Row.** In the Data tab's edit mode, a row's menu offers Duplicate Row, which adds a new row at the top of the grid with the same values. Identity and LOB columns are left out, as they are for Add Row.
- **Copy an error.** Database errors have a Copy error button next to their message, which copies the message together with every line of the driver's error detail. It appears on failed statements in the results panel's History tab and the Data tab's Run SQL panel, on the schema browser tabs' load errors, and in the SQL import steps.

### Changed

- The diagram's column tooltip now shows the column's type.
- Tooltips throughout the extension wait half a second before showing, like VS Code's own hovers, instead of appearing almost immediately.
- Data grids take their look from VS Code's own tables: the row stripes, header background and column lines use the same theme colors as the Keyboard Shortcuts editor, with no line between rows.
- The results grid and the Data tab are only as wide as their columns, instead of stretching the last column across the rest of the panel.
- Formatting SQL pasted from TypeScript, JavaScript, Java or C# now handles a query built up over several statements: `sql += ...`, `sql = sql + ...` and `StringBuilder.append(...)` lines are joined into one query, and a value appended after the last string is kept as a parameter. Before, the statement syntax between the strings came out as stray parameters.

### Fixed

- An unqualified table name now resolves to the first library on the connection's library list that has it, the same one DB2 runs the statement against, for column completion and result column headings. Before, the alphabetically first library won, and with a default table schema set on the connection, a table outside that schema got no columns at all.
- When a SQL import's statement failed, the Import Schema dialog showed only the summary message. It now shows the driver's full error detail too, like the rest of the extension.
- Calling an overloaded procedure, one name with several parameter lists such as `QSYS2.QCMDEXC`, no longer fails with "The number of parameters the procedure expects and and the number of passed parameters is not equal". DB2 picks the overload from the number of arguments. Output parameter values of an overloaded procedure can't be shown, and a warning says so when it has any.

## [0.1.0] - 2026-10-12

First Marketplace release, published as a pre-release.

### Added

- **Entity diagrams.** `DB2: New Diagram` creates a `.db2diagram` file that opens in a diagram editor: add tables from a searchable tree, see real foreign key relationships drawn with crow's-foot cardinality, filter the canvas, navigate with an overview map, and re-run automatic layout. Diagrams support undo/redo and hot exit through VS Code's own custom editor plumbing.
- **Diagram sync and repair.** Sync a diagram against the live catalog to pick up added, changed or dropped tables, with a summary of what changed and a prompt before anything is removed. Tables a relationship points at but the diagram is missing can be added in one step, several at a time.
- **Diagram export.** Export to `.drawio` (lossless — the same serializer that saves the file), DBML, or Frictionless Table Schema.
- **Schema import and export.** Export catalog metadata to DBML or Frictionless Table Schema, and import supplemental metadata from either format for environments where the DB2 catalog is incomplete.
- **SQL schema imports.** Import metadata from site-specific tables by supplying up to three statements — tables, columns and relationships — and mapping each statement's result columns onto the fields the extension understands. Saved imports live in `db2-workbench.sqlImports`, are attached to the connections that use them, and can be edited and refreshed in place.
- **Import visibility.** Imported tables and columns are badged in the schema tree and on diagrams so imported metadata is never mistaken for the real catalog. A View Imports dialog lists everything imported for a connection and can disable an import without deleting it.
- **Table Data tab.** Browse and search a table's data from the schema browser, with add, edit and delete row support and a panel that shows the generated SQL as it runs, statement by statement.
- **Advised Indexes tab.** DB2's own index advice from `QSYS2.SYSIXADV`, with generated `CREATE INDEX` DDL that can be run from the tab and a refresh that rechecks the live advice.
- **Columns, Table Keys, Foreign Keys and Indexes tabs** in the schema browser, backed by `QSYS2.SYSCOLUMNS2`, `SYSCST`, `SYSKEYCST`, `SYSREFCST` and the index catalog.
- Refresh and Export actions on every data table in the extension's webviews.

### Changed

- Catalog metadata is cached per **connection** rather than per editor session, so two SQL tabs, the schema browser and a diagram pointed at the same connection share one set of lookups instead of each re-querying.
- Per-table catalog lookups are batched: loading a diagram or a multi-table statement issues one chunked query instead of one query per table.
- The schema tree is virtualized and filter-driven, so large schemas stay responsive.
- The schema tree is now a single shared component used by both the schema browser (single-select) and the diagram table picker (multi-select).

### Fixed

- Reconnect handling after a dropped connection.
- Column name handling where a table's short (system) name and long (SQL) name differ.

## Earlier beta builds

- SQL and stored procedure execution over ODBC, with a paged results grid, per-file sessions, query and connection history, and results openable in an editor tab or separate window.
- Connection management with passwords held in VS Code secret storage.
- SQL autocomplete for schemas, tables and columns, and `F12` to open a table's definition.
- SQL formatting, including embedded host-language SQL, with configurable indentation, keyword case, wrapping and clause layout.
