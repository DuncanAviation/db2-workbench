import { createRequire } from 'node:module';
import type { PostgreSQL } from 'dt-sql-parser';

// dt-sql-parser must be loaded through a pre-bundled CJS file rather than a normal import -- its
// published dist has an unresolved directory import that throws under real Node ESM resolution.
// See esbuild-dt-sql-parser.mjs (the bundling step) and tmp/dt-sql-parser-spike/README.md (why).
//
// This module sits at the root of src/ on purpose. The require below resolves against this file's
// own location, and the root of out/ is where that is in both builds: out/dt-sql-parser.js as tsc
// output, and out/extension.js once esbuild-extension.mjs folds it into the packaged bundle. So
// './vendor/' finds out/vendor/ either way, which a module in a subfolder could not. Keep it reached
// only through static imports: anything loaded by a dynamic import() may land in a code-split chunk
// under out/chunks/, and from there './vendor/' would miss. It is named
// requireCjs because the bundle's banner already declares a top-level `require`.
const requireCjs = createRequire(import.meta.url);

export const DtSqlParser = <{ PostgreSQL: new () => PostgreSQL; EntityContextType: Record<string, string> }>
	requireCjs('./vendor/dt-sql-parser-bundle.cjs');
