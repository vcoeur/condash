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

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const watchMode = process.argv.includes('--watch');
const devMode = watchMode || process.argv.includes('--dev');

/** Modules that must NOT be bundled — they need to live in node_modules at
 *  runtime (Electron-internal wiring or native bindings). */
const EXTERNAL = [
  'electron',
  // Native modules — kept here for future-proofing; bundle skips them and they
  // resolve from node_modules. Add new native deps to this list.
  'node-pty',
  'fsevents',
  'better-sqlite3',
  // electron-updater pulls in `lzma-native`, `7zip-bin`, and reaches for
  // `original-fs` (an Electron-internal module). Inlining the whole graph
  // explodes the bundle and breaks runtime loading; keep it external so it
  // resolves from node_modules at runtime.
  'electron-updater',
  'original-fs',
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
