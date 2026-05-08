import { promises as fs } from 'node:fs';
import { sep } from 'node:path';
import { readSettings } from './settings';
import { getEffectiveConceptionConfig } from './effective-config';

/**
 * Throw unless `path` resolves to a location under `root`.
 *
 * Both paths are realpathed (in parallel, to narrow the TOCTOU window
 * to what the Node fs queue allows — same shape as pass-3's pdf.toFileUrl
 * fix). Symlinks are followed; the comparison is on canonical paths so
 * a symlink under conception pointing at /etc/passwd is rejected.
 *
 * Returns the realpath of the request, so callers that downstream stat
 * or open it can do so on the canonical path (avoiding a second realpath
 * round-trip and any further TOCTOU between bounds-check and use).
 *
 * Used by IPC handlers that accept arbitrary `path` from the renderer
 * — defence-in-depth: the renderer is trusted today, but a compromised
 * renderer can otherwise reach `/etc/passwd` via getProject, readNote,
 * step.add, etc. Pass-4..6 deferred; pass-7 lands.
 */
export async function requirePathUnder(path: string, root: string): Promise<string> {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('path must be a non-empty string');
  }
  let real: string;
  let rootReal: string;
  try {
    [real, rootReal] = await Promise.all([fs.realpath(path), fs.realpath(root)]);
  } catch {
    throw new Error(`path does not resolve: ${path}`);
  }
  const child = real.endsWith(sep) ? real : real + sep;
  const parent = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (!(child === parent || child.startsWith(parent))) {
    throw new Error('path is outside the conception tree');
  }
  return real;
}

/**
 * Throw unless `path` resolves under any of: conceptionPath,
 * `workspace_path`, or `worktrees_path`. The latter two come from
 * `<conception>/configuration.json` (workspace-scoped repos and their
 * worktrees). Used by IPC handlers that operate on git worktrees outside
 * the conception tree itself — `getDirtyDetails`, `launchOpenWith` — so a
 * compromised renderer can't drive `git status` against `~/.ssh/` or open
 * `/etc/passwd` in the user's IDE.
 *
 * `openInEditor` is deliberately NOT bounded by this helper — that handler
 * is the user's "open this file in `$EDITOR`" path and the renderer hands
 * it any path the user picked. Pass-9 documents the trust boundary at the
 * call site.
 */
export async function requirePathUnderWorkspace(path: string): Promise<string> {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('path must be a non-empty string');
  }
  const settings = await readSettings();
  const conceptionPath = settings.lastConceptionPath;
  if (!conceptionPath) {
    throw new Error('no conception path is set');
  }
  const config = await readWorkspaceRoots(conceptionPath);
  const candidates = [conceptionPath, ...config];
  let real: string;
  try {
    real = await fs.realpath(path);
  } catch {
    throw new Error(`path does not resolve: ${path}`);
  }
  const child = real.endsWith(sep) ? real : real + sep;
  const reals = await Promise.all(
    candidates.map(async (root) => {
      try {
        const rootReal = await fs.realpath(root);
        return rootReal.endsWith(sep) ? rootReal : rootReal + sep;
      } catch {
        return null;
      }
    }),
  );
  for (const parent of reals) {
    if (parent === null) continue;
    if (child === parent || child.startsWith(parent)) return real;
  }
  throw new Error('path is outside the workspace');
}

async function readWorkspaceRoots(conceptionPath: string): Promise<string[]> {
  // Effective config: settings.json's workspace_path/worktrees_path are valid
  // global defaults; the conception's condash.json (or legacy
  // configuration.json) overrides at top level. Conception wins.
  const config = await getEffectiveConceptionConfig(conceptionPath);
  const out: string[] = [];
  if (typeof config.workspace_path === 'string' && config.workspace_path.length > 0) {
    out.push(config.workspace_path);
  }
  if (typeof config.worktrees_path === 'string' && config.worktrees_path.length > 0) {
    out.push(config.worktrees_path);
  }
  return out;
}

/**
 * Throw unless `dir` matches the configured `terminal.screenshot_dir` (in
 * `settings.json`). The renderer always passes the configured value back —
 * this handler exists to surface the freshest file in that directory — so
 * any other input is either a misuse or a compromised-renderer attempt to
 * stat arbitrary directories.
 */
export async function requireScreenshotDir(dir: string): Promise<string> {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new Error('dir must be a non-empty string');
  }
  const settings = await readSettings();
  const configured = settings.terminal?.screenshot_dir;
  if (!configured) {
    throw new Error('no terminal.screenshot_dir is configured');
  }
  let real: string;
  let configuredReal: string;
  try {
    [real, configuredReal] = await Promise.all([fs.realpath(dir), fs.realpath(configured)]);
  } catch {
    throw new Error('dir does not resolve');
  }
  if (real !== configuredReal) {
    throw new Error('dir does not match the configured screenshot directory');
  }
  return real;
}
