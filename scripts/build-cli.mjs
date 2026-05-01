#!/usr/bin/env node
// esbuild build for the CLI bundle. Same shape as scripts/build-electron.mjs
// but with one entry, a different outfile, and a small inline shebang banner.
//
// The CLI re-imports modules from src/main/, but those modules occasionally
// reach for `electron` (settings.ts used to; we extracted user-data-dir.ts to
// avoid that). Anything still listed here is kept external on purpose:
//
// - `electron` — must remain external because import-time evaluation only
//   succeeds inside the Electron runtime; the CLI never resolves it (the
//   user-data-dir helper guards on `process.versions.electron`).
// - `node-pty`, `fsevents`, `original-fs`, `electron-updater` — pulled in
//   transitively by some src/main/ modules we don't import from the CLI.
//   Keeping them external means esbuild won't try to follow into native
//   modules; the CLI command graph never reaches them at runtime.

import { readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

const watchMode = process.argv.includes('--watch');
const devMode = watchMode || process.argv.includes('--dev');

const EXTERNAL = [
  'electron',
  'node-pty',
  'fsevents',
  'better-sqlite3',
  'electron-updater',
  'original-fs',
];

const outfile = resolve(root, 'dist-cli/condash.cjs');
rmSync(resolve(root, 'dist-cli'), { recursive: true, force: true });

await build({
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  entryPoints: [resolve(root, 'src/cli/index.ts')],
  outfile,
  external: EXTERNAL,
  sourcemap: devMode ? 'inline' : false,
  minify: !devMode,
  banner: {
    js: `#!/usr/bin/env node\n// condash CLI ${pkg.version} — built ${new Date().toISOString()}\n`,
  },
  define: {
    'process.env.CONDASH_CLI_VERSION': JSON.stringify(pkg.version),
  },
  logLevel: 'info',
  absWorkingDir: root,
});

import { chmodSync } from 'node:fs';
chmodSync(outfile, 0o755);

console.log(`[esbuild] cli built → ${outfile}`);
