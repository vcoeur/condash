// Modules kept external to every esbuild bundle (main + preload + CLI).
//
// "External" here means esbuild does not inline the module; the runtime
// resolves it from `node_modules` at load time. Two reasons something lands
// here:
//
//   1. Native bindings (`.node` files): must live on disk so `electron-rebuild`
//      can match them to the Electron ABI. Inlining them breaks the loader.
//   2. Electron-internal modules (e.g. `original-fs`): only resolvable inside
//      the Electron runtime, never in plain Node — esbuild can't follow them.
//
// Per-target externals (e.g. an external that only matters to the CLI build
// because the main bundle imports it directly) stay in the per-script
// `EXTERNAL` array. This file is the intersection.

/** Shared external list — both the Electron build and the CLI build use it. */
export const SHARED_EXTERNALS = [
  // Electron itself: pulled in via `import { app, ... } from 'electron'`. The
  // CLI guards on `process.versions.electron` so the import is never evaluated
  // outside the Electron runtime, but esbuild still needs it external to
  // avoid following the import.
  'electron',
  // Native modules. New native deps should be appended here, not duplicated
  // per script.
  'node-pty',
  'fsevents',
  // electron-updater pulls in `lzma-native`, `7zip-bin`, and reaches for
  // `original-fs` (an Electron-internal module). Inlining the whole graph
  // explodes the bundle and breaks runtime loading; keep it external so it
  // resolves from node_modules at runtime.
  'electron-updater',
  'original-fs',
];
