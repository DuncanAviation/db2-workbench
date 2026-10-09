# Contributing to DB2 Workbench

## Prerequisites

- Node.js 22.17.0. `.npmrc` sets `engine-strict`, so `npm ci` refuses a Node version a dependency doesn't support.
- VS Code 1.120 or later.
- To run the extension against a real system: an IBM i host, the IBM i Access ODBC driver, and on Linux or macOS the unixODBC driver manager. None of these are needed for the test suites.

## Building and running

```
npm ci
npm run compile
```

Press F5 in VS Code ("Run Extension") to start an Extension Development Host with the extension loaded. It builds through the `watch` task, so edits recompile as you save.

## Tests

There are four suites. None of them needs a database: the integration suite runs against a fake driver backed by a fixture (`src/database/drivers/fake/`).

| Command | What it runs |
| --- | --- |
| `npm run test:unit` | Co-located `*.spec.ts` unit tests under `src/` (compile first). Most new tests belong here. |
| `npm test` | Integration tests in a real VS Code extension host, under `src/test/`. Compiles and lints first. |
| `npm run test:webviews` | Webview component tests (`webviews/**/*.spec.tsx`) in jsdom. |
| `npm run test:webviews:browser` | Webview tests that need real layout (`webviews/**/*.browser.spec.tsx`) in headless Chromium. Run `npx playwright install chromium` once first. |

Run `npm run lint` before sending a change.

## Packaging

```
npm run build-exe -- --target win32-x64
```

This produces a `.vsix` for one platform (`win32-x64`, `linux-x64`, `darwin-arm64` or `darwin-x64`). The `odbc` dependency is a native module, so a package only works on the platform it was built on: build each target on a machine of that kind.

Packaging bundles the extension host code with esbuild and generates `THIRD_PARTY_NOTICES.txt` from what was bundled. Generating it fails if a bundled package uses a license that hasn't been reviewed. See `third-party-notices.mjs`.

## Dependencies

Versions are pinned exactly. To add or update one, edit the version in `package.json` by hand, then run `npm install`. `npm install <package>@<version>` reformats `package.json`. Only `odbc` belongs in `dependencies`; everything that gets bundled goes in `devDependencies`.

## Code layout and conventions

[CLAUDE.md](CLAUDE.md) describes the architecture (the service locator in `src/extension.ts`, the event-driven connection lifecycle, the driver layer, the webviews) and the project's conventions.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
