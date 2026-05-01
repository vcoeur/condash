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
 *   2. $CONDASH_CONCEPTION env var.
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
    tried.push(`--conception ${flagValue} (no configuration.json)`);
  }

  const envOverride = process.env.CONDASH_CONCEPTION;
  if (envOverride) {
    const abs = absolutise(envOverride);
    if (await looksLikeConception(abs)) return { path: abs, source: 'env' };
    tried.push(`$CONDASH_CONCEPTION=${envOverride} (no configuration.json)`);
  }

  const skillDir = process.env.CLAUDE_PROJECT_DIR;
  if (skillDir) {
    const abs = absolutise(skillDir);
    if (await looksLikeConception(abs)) {
      return { path: abs, source: 'CLAUDE_PROJECT_DIR' };
    }
    tried.push(`$CLAUDE_PROJECT_DIR=${skillDir} (no configuration.json)`);
  }

  const walked = await walkUpForConception(process.cwd());
  if (walked) return { path: walked, source: 'cwd-walk' };
  tried.push(`cwd-walk from ${process.cwd()} (no configuration.json found)`);

  const settings = await readSettings();
  if (settings.conceptionPath && (await looksLikeConception(settings.conceptionPath))) {
    return { path: settings.conceptionPath, source: 'settings' };
  }
  if (settings.conceptionPath) {
    tried.push(`settings.conceptionPath=${settings.conceptionPath} (no configuration.json)`);
  } else {
    tried.push('settings.conceptionPath is unset');
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
  return existsSync(`${path}/configuration.json`);
}

async function walkUpForConception(start: string): Promise<string | null> {
  let dir = absolutise(start);
  while (true) {
    if (existsSync(`${dir}/configuration.json`)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function absolutise(value: string): string {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}
