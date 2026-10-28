#!/usr/bin/env node
// Bundles the extension and the SDK into one file, out/extension.js, so VS Code loads one module
// rather than several hundred. `vscode` stays external: VS Code provides it at runtime.
//
//   node esbuild.mjs           # one build
//   node esbuild.mjs --watch   # rebuild on change (what F5 uses)
//
// out/usageLog.js is built alongside for the test suite, which checks the CSV export directly.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const context = await esbuild.context({
	entryPoints: ['src/extension.ts', 'src/usageLog.ts'],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node22',
	external: ['vscode'],
	outdir: 'out',
	sourcemap: true,
	// Keep names and whitespace: a readable stack trace is worth more than a few kilobytes.
	minify: false,
	legalComments: 'none',
	logLevel: 'info',
});

if (watch) {
	await context.watch();
} else {
	await context.rebuild();
	await context.dispose();
}
