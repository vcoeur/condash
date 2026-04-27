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

import { simpleGit } from 'simple-git';

interface CacheEntry {
  dirty: number | null;
  capturedAt: number;
}

const TTL_MS = 3_000;
const cache = new Map<string, CacheEntry>();

/** Look up dirty count for a working tree. Reads from cache when fresh,
 * otherwise runs `git status` and stores the result. Returns null when git
 * couldn't run (path missing, not a repo, etc). */
export async function getDirtyCount(path: string): Promise<number | null> {
  const now = Date.now();
  const cached = cache.get(path);
  if (cached && now - cached.capturedAt < TTL_MS) return cached.dirty;
  try {
    const status = await simpleGit({ baseDir: path }).status();
    const dirty = status.files.length;
    cache.set(path, { dirty, capturedAt: now });
    return dirty;
  } catch {
    cache.set(path, { dirty: null, capturedAt: now });
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
 * so we drop any cache entry that's a prefix of the changed path. */
export function invalidateForPath(path: string): void {
  for (const wt of [...cache.keys()]) {
    if (path === wt || path.startsWith(`${wt}/`)) cache.delete(wt);
  }
}
