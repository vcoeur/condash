#!/usr/bin/env node
// esbuild-driven build for the Electron main + preload bundles.
//
// We bundle (rather than tsc-compile-per-file) so that ESM-only dependencies
// (chokidar 4, future ESM libs in the main-process tree) are inlined as CJS in
// the output. Native modules listed in EXTERNAL stay external — they have to
// load from node_modules at runtime so electron-rebuild can reach them.
//
// Typechecking is handled separately by `npm run typecheck` (tsc --noEmit).

import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';
import { SHARED_EXTERNALS } from './shared/externals.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const watchMode = process.argv.includes('--watch');
const devMode = watchMode || process.argv.includes('--dev');

/** Modules that must NOT be bundled — they need to live in node_modules at
 *  runtime (Electron-internal wiring or native bindings). The shared list
 *  lives in `scripts/shared/externals.mjs`; per-target additions go here. */
const EXTERNAL = [
  ...SHARED_EXTERNALS,
  // The dashboard summarizer dynamically imports this ESM-only coding-agent
  // SDK (only the main process touches it — see src/main/dashboard/). esbuild
  // bundling it into the CJS main bundle corrupts the package's lazy ESM init
  // (the `__esm` ordering leaves `AuthStorage` undefined → the Settings "Test
  // connection" button crashed with "Cannot read properties of undefined
  // (reading 'inMemory')"). Keep it external so `import()` resolves it as real
  // ESM from node_modules at runtime — Electron 33 loads ESM from inside
  // app.asar, so packaged builds work without asarUnpack. Bonus: drops the
  // main bundle from ~8 MB back to ~0.8 MB.
  '@earendil-works/pi-coding-agent',
];

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: EXTERNAL,
  sourcemap: devMode ? 'inline' : false,
  minify: !devMode,
  logLevel: 'info',
  absWorkingDir: root,
};

/** @type {import('esbuild').BuildOptions[]} */
const targets = [
  {
    ...shared,
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist-electron/main/index.js',
  },
  {
    ...shared,
    entryPoints: ['src/preload/index.ts'],
    outfile: 'dist-electron/preload/index.js',
  },
];

await rm(resolve(root, 'dist-electron'), { recursive: true, force: true });

if (watchMode) {
  const ctxs = await Promise.all(targets.map((t) => context(t)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[esbuild] watching main + preload');
  // Keep the process alive so concurrently doesn't think we exited.
  await new Promise(() => {});
} else {
  await Promise.all(targets.map((t) => build(t)));
  console.log('[esbuild] main + preload built');
}
