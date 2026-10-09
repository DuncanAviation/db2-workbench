import * as esbuild from 'esbuild';
import * as fs from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const entryPoints = [
	'webviews/connections/index.tsx',
	'webviews/results/index.tsx',
	'webviews/formatting/index.tsx',
	'webviews/schemas/index.tsx',
	'webviews/diagram/index.tsx',
];

const problemMatcherPlugin = {
	name: 'problem-matcher',
	setup(build) {
		build.onStart(() => {
			console.log('[webviews] build started');
		});
		build.onEnd((result) => {
			for (const { text, location } of result.errors) {
				console.error(`> ${location?.file ?? ''}:${location?.line ?? 0}:${location?.column ?? 0}: error: ${text}`);
			}
			console.log('[webviews] build finished');
		});
	},
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints,
		bundle: true,
		format: 'esm',
		target: 'es2022',
		platform: 'browser',
		outdir: 'dist/webviews',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		metafile: true,
		logLevel: 'silent',
		plugins: [problemMatcherPlugin],
	});

	if (watch) {
		await ctx.watch();
	} else {
		let result = await ctx.rebuild();
		await ctx.dispose();

		// Read by third-party-notices.mjs to list the packages bundled into the output.
		fs.mkdirSync('out/metafiles', { recursive: true });
		fs.writeFileSync('out/metafiles/webviews.json', JSON.stringify(result.metafile));
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
