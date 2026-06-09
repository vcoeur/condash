#!/usr/bin/env node
// esbuild build for the CLI bundle. Same shape as scripts/build-electron.mjs
// but with one entry, a different outfile, and a small inline shebang banner.
//
// The CLI re-imports modules from src/main/, but those modules occasionally
// reach for `electron` (settings.ts used to; we extracted user-data-dir.ts to
// avoid that — and v2.27.0 added a second offender: search/match.ts started
// importing `splitContent` from ipc/logs.ts, which top-level-imports
// `electron`. Fixed in v2.29.1 by extracting `splitContent` and friends into
// logs-format.ts). Anything still listed here is kept external on purpose:
//
// - `electron` — must remain external because import-time evaluation only
//   succeeds inside the Electron runtime; the CLI never resolves it (the
//   user-data-dir helper guards on `process.versions.electron`).
// - `node-pty`, `fsevents`, `original-fs`, `electron-updater` — pulled in
//   transitively by some src/main/ modules we don't import from the CLI.
//   Keeping them external means esbuild won't try to follow into native
//   modules; the CLI command graph never reaches them at runtime.

import { execSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { SHARED_EXTERNALS } from './shared/externals.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

// The committed version is a placeholder 0.0.0 — the real version is the git
// tag, injected by CI via `npm pkg set version` before building. A source
// build would otherwise bake `condash 0.0.0` into the define below (making the
// runtime `?? 'dev'` fallback unreachable), so derive something useful from
// git instead, falling back to the literal 'dev' when git is unavailable.
function resolveCliVersion() {
  if (pkg.version !== '0.0.0') return pkg.version;
  try {
    const described = execSync('git describe --tags', {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (described) return described;
  } catch {
    // No git / no tags — fall through.
  }
  return 'dev';
}

const cliVersion = resolveCliVersion();

const watchMode = process.argv.includes('--watch');
const devMode = watchMode || process.argv.includes('--dev');

// CLI-only externals (none today) get appended here. Shared entries live in
// `scripts/shared/externals.mjs`.
const EXTERNAL = [...SHARED_EXTERNALS];

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
    js: `#!/usr/bin/env node\n// condash CLI ${cliVersion} — built ${new Date().toISOString()}\n`,
  },
  define: {
    'process.env.CONDASH_CLI_VERSION': JSON.stringify(cliVersion),
  },
  logLevel: 'info',
  absWorkingDir: root,
});

import { chmodSync } from 'node:fs';
chmodSync(outfile, 0o755);

console.log(`[esbuild] cli built → ${outfile}`);
