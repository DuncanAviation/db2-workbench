import * as esbuild from 'esbuild';
import * as fs from 'node:fs';

// Bundles the extension host code for packaging only. Development, debugging and every test suite run
// the multi-file tsc output in out/, and this overwrites out/extension.js (package.json's "main") with
// the bundle just before vsce collects the package. .vscodeignore then leaves the rest of
// out/ behind. The overwrite, rather than a separate output path, is what keeps the integration tests
// honest: they import the `extension` singleton from out/extension.js, so the host must activate that
// same module, never a bundled copy holding a second instance. The build-exe script's postbuild-exe
// step reruns tsc afterwards to put the multi-file out/extension.js back.
//
// odbc stays external: it loads a native binary at run time, so it ships in node_modules as the
// package's one runtime dependency. dt-sql-parser is not in the bundle either; it stays in its own
// pre-bundled out/vendor/ file, which src/dt-sql-parser.ts loads relative to the out/ root.
//
// Code splitting moves whatever is only reached through a dynamic import() into its own file under
// out/chunks/, so activation doesn't read or parse it. That is how @dbml/core (most of the bundle by
// size, needed only to import a DBML file) stays out of out/extension.js. The folder is emptied first:
// chunk names carry a content hash, so an old build's chunks would otherwise ship alongside the new.
async function main() {
	fs.rmSync('out/chunks', { recursive: true, force: true });

	let result = await esbuild.build({
		entryPoints: ['src/extension.ts'],
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node22',
		outdir: 'out',
		entryNames: '[name]',
		chunkNames: 'chunks/[name]-[hash]',
		splitting: true,
		allowOverwrite: true,
		// web-worker is an optional package elkjs only requires when given a workerUrl, which
		// diagram-layout.ts never passes. It isn't installed, so it can't be bundled.
		external: ['vscode', 'odbc', 'web-worker'],
		minify: true,
		// Minifying would otherwise rename classes, and error messages and logs print their names.
		keepNames: true,
		// CommonJS dependencies folded into an ESM bundle still call require() for Node builtins, which
		// ESM doesn't define. The banner opens every output file, chunks included.
		banner: {
			js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
		},
		metafile: true,
		logLevel: 'info',
	});

	// Read by third-party-notices.mjs to list the packages bundled into the output.
	fs.mkdirSync('out/metafiles', { recursive: true });
	fs.writeFileSync('out/metafiles/extension.json', JSON.stringify(result.metafile));
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
