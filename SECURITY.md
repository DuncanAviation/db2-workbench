# Security Policy

## Supported versions

DB2 Workbench is in beta. Security fixes are made only in the latest release, so update to it before you report a problem.

## Reporting a vulnerability

Do not report security problems in public issues or Discussions.

Report them privately through GitHub: open the [Security tab](https://github.com/DuncanAviation/db2-workbench/security) and choose **Report a vulnerability**, or go straight to [the private report form](https://github.com/DuncanAviation/db2-workbench/security/advisories/new). Only the maintainers can see the report.

Include as much of this as you can:

- The extension version, VS Code version and operating system.
- What an attacker can do, and what they need first (for example, a crafted table name in the catalog, a malicious `.db2diagram` file, or a connection to a hostile server).
- Steps to reproduce, with the statement, file or settings involved. Remove real host names, user names and data.

## What happens next

We acknowledge a report once we have read it, keep you informed while we investigate, and tell you when a fix is released. If the report is accepted, we publish a GitHub security advisory with the release that fixes it and credit you, unless you prefer not to be named.

## Scope

In scope: problems in this extension's own code and in the packages it ships. Examples:

- How the extension handles passwords. They are kept in VS Code's secret storage, never in settings, and cleared when the extension deactivates.
- SQL the extension generates (row edits, generated DDL, catalog lookups) that a crafted identifier or value could change.
- Script injection in the extension's webviews (results grid, schema browser, diagrams, connection editor) from database content, imported metadata or opened files.
- Files the extension reads or writes, such as `.db2diagram` files and schema imports.

Out of scope, so report them to their owners instead:

- IBM i, DB2 for i, and the IBM i Access ODBC driver.
- VS Code itself.
- SQL you write and run yourself. It runs with the authority of the user profile you connect as, which is the intended behavior.

The extension sends no telemetry and makes no network connections other than to the database hosts you configure.
