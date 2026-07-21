import { promises as fs } from 'node:fs';
import { isAbsolute, normalize, sep } from 'node:path';
import { readSettings } from './settings';
import { getEffectiveConceptionConfig } from './effective-config';
import { walkRepos, type ConfigShape } from './config-walk';
import { userScopeReadableDirs, userScopeReadableFiles } from './user-scope-paths';

/**
 * The one boundary primitive every path-bounding helper shares: is the
 * canonical `childReal` equal to, or nested under, the canonical `rootReal`?
 * Both arguments must already be realpath'd. A trailing separator is appended
 * before the prefix test so `/a/bc` is not treated as under `/a/b`.
 */
function isRealpathUnder(childReal: string, rootReal: string): boolean {
  const child = childReal.endsWith(sep) ? childReal : childReal + sep;
  const parent = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  return child === parent || child.startsWith(parent);
}

/**
 * Shape-check a renderer-supplied directory path relative to some root.
 * `''` (and `.`) mean the root itself. Rejects absolute paths and any `..`
 * traversal; `boundLabel` names the root in error messages ("the project
 * directory", "the pane root"). Shape-only — the realpath bound against the
 * actual root stays with the caller. The single copy shared by the project
 * create verbs (`files.ts`) and the tree-pane mutations
 * (`tree-mutations.ts`).
 */
export function cleanRelDirPath(dirRelPath: string, boundLabel: string): string {
  const cleaned = normalize(dirRelPath);
  if (cleaned === '' || cleaned === '.') return '';
  if (isAbsolute(cleaned)) {
    throw new Error(`dirRelPath must be relative to ${boundLabel}`);
  }
  // After `normalize`, only literal `..` segments survive a traversal
  // attempt; segment-match rather than `.includes('..')` so an innocent
  // `foo..bar` filename mid-path is not flagged.
  const segments = cleaned.split(/[\\/]/);
  if (segments.includes('..')) {
    throw new Error(`dirRelPath escapes ${boundLabel}`);
  }
  return cleaned;
}

/** Realpath `path`, throwing a uniform error when it doesn't resolve. */
async function realpathOrThrow(path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch {
    throw new Error(`path does not resolve: ${path}`);
  }
}

/** Realpath a candidate root, returning `null` (rather than throwing) when it
 * doesn't resolve — a configured root that doesn't exist is simply skipped. */
async function realpathOrNull(root: string): Promise<string | null> {
  try {
    return await fs.realpath(root);
  } catch {
    return null;
  }
}

/**
 * Resolve `path` and require it under at least one of `roots`. Returns the
 * realpath of the request so callers can stat/open the canonical path without
 * a second round-trip. Throws `outsideMessage` when it's under none. Roots
 * that don't resolve are skipped. Both the request and each root are
 * realpath'd, so a symlink under a root pointing outside it is rejected.
 */
async function resolveUnderAnyRoot(
  path: string,
  roots: readonly string[],
  outsideMessage: string,
): Promise<string> {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('path must be a non-empty string');
  }
  const real = await realpathOrThrow(path);
  const rootReals = await Promise.all(roots.map(realpathOrNull));
  for (const rootReal of rootReals) {
    if (rootReal !== null && isRealpathUnder(real, rootReal)) return real;
  }
  throw new Error(outsideMessage);
}

/**
 * Throw unless `path` resolves to a location under `root`.
 *
 * Both paths are realpathed (in parallel, to narrow the TOCTOU window
 * to what the Node fs queue allows — same shape as pass-3's pdfToFileUrl
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
 * addStep, etc. Pass-4..6 deferred; pass-7 lands.
 */
export async function requirePathUnder(path: string, root: string): Promise<string> {
  return resolveUnderAnyRoot(path, [root], 'path is outside the conception tree');
}

/**
 * Throw unless `path` resolves under any of: conceptionPath,
 * `workspace_path`, or `worktrees_path`. The latter two come from
 * `<conception>/condash.json` (workspace-scoped repos and their
 * worktrees). Used by IPC handlers that operate on paths outside the
 * conception tree itself — `getDirtyDetails`, `launchOpenWith`, plus the
 * shell-out verbs `openPath` / `showInFolder` (the latter two via
 * `requireOpenablePath` in ipc/system.ts, which adds one exact-file
 * exemption for the per-machine settings.json) — so a compromised renderer
 * can't drive `git status` against `~/.ssh/`, open `/etc/passwd` in the
 * user's IDE, or reveal arbitrary files in the OS file manager.
 *
 * `openInEditor` is the single handler deliberately NOT bounded by this
 * helper — it's the user's "open this file in `$EDITOR`" path and the
 * renderer hands it any path the user picked. The trust boundary is
 * documented at the call site.
 */
export async function requirePathUnderWorkspace(path: string): Promise<string> {
  const settings = await readSettings();
  const conceptionPath = settings.lastConceptionPath;
  if (!conceptionPath) {
    throw new Error('no conception path is set');
  }
  const candidates = [conceptionPath, ...(await readWorkspaceRoots(conceptionPath))];
  return resolveUnderAnyRoot(path, candidates, 'path is outside the workspace');
}

/**
 * Throw unless `path` resolves to a readable Skills-pane location: under
 * the active conception, OR under the user-scope skills root, OR equal to
 * the user-scope AGENTS.md. Returns the realpath.
 *
 * Read-only — the Skills pane surfaces both scopes but never writes them,
 * so this guards `readSkillFile` and nothing else. Narrow on purpose: only
 * the specific agedum-source paths, never their parents, so other
 * dotfiles in `~/.config/` stay unreachable through this path.
 */
export async function requireReadableSkillPath(path: string): Promise<string> {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('path must be a non-empty string');
  }
  const real = await realpathOrThrow(path);

  // First: under any readable skills directory (active conception + user-scope).
  const { lastConceptionPath } = await readSettings();
  const dirs = [...(lastConceptionPath ? [lastConceptionPath] : []), ...userScopeReadableDirs()];
  const dirReals = await Promise.all(dirs.map(realpathOrNull));
  for (const rootReal of dirReals) {
    if (rootReal !== null && isRealpathUnder(real, rootReal)) return real;
  }

  // Otherwise: an exact match of an allowlisted file. The user-scope AGENTS.md
  // lives directly under `~/.config/agents/`, a directory condash deliberately
  // doesn't expose wholesale — match it exactly by realpath instead.
  const fileReals = await Promise.all(userScopeReadableFiles().map(realpathOrNull));
  if (fileReals.includes(real)) return real;

  throw new Error('path is not a readable skills location');
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
  // Include configured repo paths so arbitrary directories are valid targets
  // for bounds-checked operations (Open in IDE, terminal spawn, etc.).
  const configShape = config as ConfigShape;
  if (configShape.repositories) {
    walkRepos(configShape, (entry) => {
      out.push(entry.cwd);
      return true; // keep walking
    });
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
