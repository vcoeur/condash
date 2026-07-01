import { promises as fs } from 'node:fs';
import { toPosix } from '../shared/path';
import type { Project } from '../shared/types';
import { parseReadme } from './parse';

// Process-wide memo for parseReadme, keyed on the README path + its mtime.
//
// `listProjects` re-parses every project README on each call — an unconditional
// readFile + ~6-pass parse per file. On a large tree (hundreds of READMEs) a
// dashboard reload re-pays that whole cost even when nothing changed (review
// finding R2). This memo turns an unchanged README into a single `stat`: on a
// cache hit (mtime unchanged since the last parse) it returns the stored
// Project without re-reading or re-parsing; on a miss or stale entry it parses
// and stores. The chokidar watcher drops an entry when its README changes or is
// removed (`invalidateReadmeCache`), and the whole memo is cleared on a
// conception switch (`clearReadmeCache`).
//
// Only the long-lived dashboard main process benefits — each CLI invocation is
// a fresh process, so its cache starts empty and simply falls through to
// parseReadme (no behaviour change, no persistence needed).
//
// The returned Project is shared: callers must treat it as read-only. The
// dashboard's callers (listProjects, getProject) only sort the array or
// structured-clone the object across IPC, so none mutate it.

interface CacheEntry {
  mtimeMs: number;
  project: Project;
}

const cache = new Map<string, CacheEntry>();

/** Normalise so a path from `findProjectReadmes` (native `join`) and one from a
 *  chokidar event key the same entry on every platform. */
function keyFor(path: string): string {
  return toPosix(path);
}

/**
 * {@link parseReadme} with a process-wide mtime-keyed memo. Returns the cached
 * Project when the file is unchanged since the last parse, otherwise parses and
 * caches. The returned object is shared — treat it as read-only.
 */
export async function parseReadmeCached(path: string): Promise<Project> {
  const key = keyFor(path);
  const stat = await fs.stat(path);
  const cached = cache.get(key);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.project;
  const project = await parseReadme(path);
  cache.set(key, { mtimeMs: stat.mtimeMs, project });
  return project;
}

/** Drop the memo for one README (chokidar `change` / `unlink`). No-op for a
 *  path that was never cached. */
export function invalidateReadmeCache(path: string): void {
  cache.delete(keyFor(path));
}

/** Clear the entire memo (conception switch). */
export function clearReadmeCache(): void {
  cache.clear();
}

/** Number of cached entries — for tests and diagnostics. */
export function readmeCacheSize(): number {
  return cache.size;
}
