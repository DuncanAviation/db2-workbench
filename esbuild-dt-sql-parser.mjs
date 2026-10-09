import * as esbuild from 'esbuild';
import * as fs from 'node:fs';

// dt-sql-parser's published dist (4.5.0 / 4.5.1-beta.3, checked 2026-08) has an unresolved
// directory import ("export ... from './parser'" with no package.json "exports" map), which
// throws ERR_UNSUPPORTED_DIR_IMPORT under real Node ESM resolution -- see
// tmp/dt-sql-parser-spike/README.md. Pre-bundling it into one self-contained CJS file sidesteps
// the broken resolution; src/content-assist/cte-assist.ts requires this output instead of the
// raw package.
async function main() {
	let result = await esbuild.build({
		stdin: {
			contents: `export { PostgreSQL, EntityContextType } from 'dt-sql-parser';`,
			resolveDir: process.cwd(),
			loader: 'js',
		},
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node18',
		outfile: 'out/vendor/dt-sql-parser-bundle.cjs',
		metafile: true,
		logLevel: 'info',
	});

	// Read by third-party-notices.mjs to list the packages bundled into the output.
	fs.mkdirSync('out/metafiles', { recursive: true });
	fs.writeFileSync('out/metafiles/dt-sql-parser.json', JSON.stringify(result.metafile));
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
