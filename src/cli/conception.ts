import { existsSync, promises as fs } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { readSettings } from '../main/settings';
import { noConception } from './output';

export interface Resolved {
  path: string;
  source: 'flag' | 'env' | 'CLAUDE_PROJECT_DIR' | 'cwd-walk' | 'settings';
}

/**
 * Resolve the conception root for this invocation. Order:
 *   1. --conception <path> flag.
 *   2. $CONDASH_CONCEPTION_PATH env var (legacy $CONDASH_CONCEPTION still
 *      honoured — see the reconcile note in `src/main/settings.ts`).
 *   3. $CLAUDE_PROJECT_DIR — the env var skill hooks set when running on
 *      behalf of a /projects skill. Trusted only when the directory carries
 *      a `configuration.json` (so a stray export from a sibling project
 *      doesn't silently retarget us).
 *   4. Walk up from cwd looking for a `configuration.json`.
 *   5. Settings.json (the same file the Electron app writes when the user
 *      picks a folder via "Open conception directory").
 *   6. Throw NO_CONCEPTION (exit 5) listing every source we tried — the
 *      skill / shell can read the list and explain why nothing matched.
 */
export async function resolveConception(flagValue: string | undefined): Promise<Resolved> {
  const tried: string[] = [];

  if (flagValue) {
    const abs = absolutise(flagValue);
    if (await looksLikeConception(abs)) return { path: abs, source: 'flag' };
    tried.push(`--conception ${flagValue} (no condash.json or configuration.json)`);
  }

  // `_PATH` is the canonical name (matches main/settings.ts); the
  // legacy `CONDASH_CONCEPTION` is still honoured so existing skill
  // hooks don't break, but new docs should reference `_PATH`.
  const envOverride = process.env.CONDASH_CONCEPTION_PATH ?? process.env.CONDASH_CONCEPTION;
  const envName = process.env.CONDASH_CONCEPTION_PATH
    ? 'CONDASH_CONCEPTION_PATH'
    : 'CONDASH_CONCEPTION';
  if (envOverride) {
    const abs = absolutise(envOverride);
    if (await looksLikeConception(abs)) return { path: abs, source: 'env' };
    tried.push(`$${envName}=${envOverride} (no condash.json or configuration.json)`);
  }

  const skillDir = process.env.CLAUDE_PROJECT_DIR;
  if (skillDir) {
    const abs = absolutise(skillDir);
    if (await looksLikeConception(abs)) {
      return { path: abs, source: 'CLAUDE_PROJECT_DIR' };
    }
    tried.push(`$CLAUDE_PROJECT_DIR=${skillDir} (no condash.json or configuration.json)`);
  }

  const walked = await walkUpForConception(process.cwd());
  if (walked) return { path: walked, source: 'cwd-walk' };
  tried.push(`cwd-walk from ${process.cwd()} (no condash.json or configuration.json found)`);

  const settings = await readSettings();
  if (settings.lastConceptionPath && (await looksLikeConception(settings.lastConceptionPath))) {
    return { path: settings.lastConceptionPath, source: 'settings' };
  }
  if (settings.lastConceptionPath) {
    tried.push(
      `settings.lastConceptionPath=${settings.lastConceptionPath} (not a conception tree)`,
    );
  } else {
    tried.push('settings.lastConceptionPath is unset');
  }

  noConception(tried);
}

async function looksLikeConception(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }
  // Both a config file and a `projects/` directory are required: any folder
  // with a stray config file (e.g. a webpack/babel config in an unrelated
  // repo) used to silently retarget the CLI. `condash.json` is the canonical
  // filename; `configuration.json` is the legacy fallback kept indefinitely.
  if (!existsSync(`${path}/condash.json`) && !existsSync(`${path}/configuration.json`)) {
    return false;
  }
  try {
    const projects = await fs.stat(`${path}/projects`);
    return projects.isDirectory();
  } catch {
    return false;
  }
}

// Defensive cap: walking up from a deeply nested directory inside a
// container or pathological symlink loop used to spin until cwd hit `/`.
// Sixteen levels covers every realistic project layout we ship and keeps
// the worst case bounded.
const MAX_WALK_UP_DEPTH = 16;

async function walkUpForConception(start: string): Promise<string | null> {
  let dir = absolutise(start);
  for (let depth = 0; depth < MAX_WALK_UP_DEPTH; depth++) {
    if (await looksLikeConception(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function absolutise(value: string): string {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}
