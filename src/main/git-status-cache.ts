// Tiny in-memory cache for `git status` results keyed by working-tree path.
//
// listRepos() ends up running `git status` once per repo + once per worktree
// every time the Code tab refreshes. With ~10 repos and ~2 worktrees apiece
// that's 30 git invocations on every render — fast on its own but adds up
// when the user mashes Refresh or chokidar fires.
//
// Strategy: cache for a short TTL. Dirty counts can lag a few seconds — the
// user is the one editing files in those repos, so any change they care
// about is followed by a click on Refresh (which invalidates) or a chokidar
// event (which we hook here too).
//
// Not an LRU — the working-set is small. We keep entries forever and rely on
// `invalidate()` / `invalidatePath()` to drop them.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';

interface CacheEntry {
  dirty: number | null;
  capturedAt: number;
}

interface DirtyCountOptions {
  /** When true, scope `git status` to the cwd subtree (`-- .`). Used for
   * subrepo entries that aren't their own .git but live inside a parent
   * repo, so the parent's dirty entries don't bleed into the subrepo card. */
  scopeToSubtree?: boolean;
}

const TTL_MS = 3_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(path: string, opts: DirtyCountOptions): string {
  return opts.scopeToSubtree ? `${path}::scope=subtree` : path;
}

/**
 * `git status --porcelain` line shape: two status chars, a space, then the
 * filename (with a `-> newname` rename suffix when applicable). Untracked
 * files use `?? ` as the status prefix; renames use `R `, modifications
 * `M `, etc. We only need to filter zero-byte untracked files (sandbox
 * runtime artifacts), so just look for the `??` prefix.
 */
async function isZeroByteUntracked(line: string, cwd: string): Promise<boolean> {
  if (!line.startsWith('?? ')) return false;
  const rel = line.slice(3).trim();
  if (!rel) return false;
  try {
    const stat = await fs.stat(join(cwd, rel));
    return stat.isFile() && stat.size === 0;
  } catch {
    return false;
  }
}

/** Look up dirty count for a working tree. Reads from cache when fresh,
 * otherwise runs `git status` and stores the result. Returns null when git
 * couldn't run (path missing, not a repo, etc).
 *
 * Filters out zero-byte untracked files — those are typically sandbox
 * runtime artifacts (scratch logs, empty placeholder files) that the user
 * doesn't want surfacing as "dirty" on the Code tab. */
export async function getDirtyCount(
  path: string,
  opts: DirtyCountOptions = {},
): Promise<number | null> {
  const now = Date.now();
  const key = cacheKey(path, opts);
  const cached = cache.get(key);
  if (cached && now - cached.capturedAt < TTL_MS) return cached.dirty;
  try {
    const git = simpleGit({ baseDir: path });
    // Use the raw porcelain output so we can filter on the status prefix
    // without re-parsing simple-git's already-parsed shape. `-- .` scopes
    // the report to the current subtree when `scopeToSubtree` is set —
    // critical for subrepo entries that share a .git with their parent.
    const args = ['status', '--porcelain=v1'];
    if (opts.scopeToSubtree) args.push('--', '.');
    const out = await git.raw(args);
    const lines = out.split('\n').filter((l) => l.length > 0);

    let count = 0;
    for (const line of lines) {
      if (await isZeroByteUntracked(line, path)) continue;
      count++;
    }
    cache.set(key, { dirty: count, capturedAt: now });
    return count;
  } catch {
    cache.set(key, { dirty: null, capturedAt: now });
    return null;
  }
}

/** Drop every cached entry. Called from the Refresh button and any other
 * explicit "I want fresh data" path. */
export function invalidateAll(): void {
  cache.clear();
}

/** Drop the entry whose working tree contains `path`. Useful when the
 * file watcher reports a write — we don't know which repo it belongs to,
 * so we drop any cache entry that's a prefix of the changed path.
 *
 * Cache keys are the working tree path (optionally suffixed with a
 * scope marker). Strip the suffix before doing prefix comparisons. */
export function invalidateForPath(path: string): void {
  for (const key of [...cache.keys()]) {
    const wt = key.split('::')[0];
    if (path === wt || path.startsWith(`${wt}/`)) cache.delete(key);
  }
}
