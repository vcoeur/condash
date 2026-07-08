import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { HeaderFields } from '../shared/header';
import { toPosix } from '../shared/path';
import type { Project } from '../shared/types';
import { atomicWrite } from './atomic-write';
import { condashDir } from './condash-dir';
import { parseReadmeWithHeader } from './parse';

// Persistent, mtime-keyed README parse cache — the CLI counterpart to the
// process-wide in-memory memo in `parse-cache.ts` (review finding S2).
//
// The in-memory memo only helps the long-lived dashboard process: it survives
// for one boot and is repaid on the next reload. Every CLI invocation
// (`condash projects list`, the verb the `/projects` skill drives constantly)
// is a fresh Node process, so that memo always starts empty and re-reads +
// re-parses every project README from cold (~680 files, ~330-390 ms).
//
// This module persists parse output to `<conception>/.condash/cache/
// readme-parse.json` so a fresh CLI process turns each unchanged README into a
// single `stat`: on an mtime match the stored parse is returned without a
// readFile or the ~6-pass body parse. `.condash/` is gitignored, so the file is
// per-host, regenerable state with no commit-leak risk.
//
// Scope: the disk layer is deliberately CLI-only. `parseReadmeCached`
// (parse-cache.ts) — the memo the dashboard main process and its chokidar
// watcher share — is left untouched, so GUI cache-invalidation correctness
// cannot regress. The dashboard already warms its memo once per boot and keeps
// it warm for the process lifetime; the disk win is only meaningful for
// short-lived CLI processes.

/** Cached parse output for one README: the shared `Project` plus the raw
 *  header fields the CLI list/read paths need but the `Project` shape omits
 *  (`date`, `extra`). Both are plain JSON — no functions or `Date`s — so they
 *  round-trip through the on-disk file unchanged. */
export interface CachedParse {
  project: Project;
  header: HeaderFields;
}

interface DiskEntry extends CachedParse {
  mtimeMs: number;
  /** File size in bytes. Keyed alongside `mtimeMs` — matching the sibling
   *  in-memory memos in `settings.ts` / `effective-config.ts` — so an edit that
   *  changes content but lands on the same mtime tick (coarse-mtime filesystem,
   *  rapid rewrite) still invalidates the entry. */
  size: number;
}

interface CacheFile {
  version: number;
  entries: Record<string, DiskEntry>;
}

// Bump when the shape of `Project` or `HeaderFields` (or the parse logic that
// produces them) changes in a way a warm cache from an older build would
// serve wrongly. A version mismatch discards the whole file and re-parses
// cold — the mtime key catches content drift but not code drift, so this is
// the guard for the latter.
// v2: entries gained a `size` field (keyed alongside `mtimeMs`). Old v1 files
// carry no `size`, so bumping discards them wholesale for a clean cold re-parse.
export const PARSE_CACHE_VERSION = 2;

const CACHE_SUBDIR = 'cache';
const CACHE_FILENAME = 'readme-parse.json';

/** Absolute path to `<conception>/.condash/cache/readme-parse.json`. */
export function parseCacheFilePath(conceptionRoot: string): string {
  return join(condashDir(conceptionRoot), CACHE_SUBDIR, CACHE_FILENAME);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Validate every field a list/read consumer dereferences unconditionally — not
// just that `project`/`header` are objects. A JSON entry with a thin `project`
// (e.g. only `slug`) would otherwise pass, be served on an mtime hit, and throw
// `RUNTIME` out to the CLI at the first `project.apps.length` /
// `project.title.slice` / `stepCounts` / `header.apps.length` deref (finding
// F1). A too-thin entry is skipped here instead, so the reader honours its
// "malformed entry → cold parse, never a throw" contract even against a
// hand-tampered file or a warm cache left by a build whose shape has since
// changed (see PARSE_CACHE_VERSION).
function isDiskEntry(value: unknown): value is DiskEntry {
  if (!isObject(value)) return false;
  if (typeof value.mtimeMs !== 'number') return false;
  if (typeof value.size !== 'number') return false;
  const project = value.project;
  if (!isObject(project)) return false;
  if (
    typeof project.slug !== 'string' ||
    typeof project.title !== 'string' ||
    !Array.isArray(project.apps) ||
    !isObject(project.stepCounts)
  ) {
    return false;
  }
  const header = value.header;
  if (!isObject(header)) return false;
  return Array.isArray(header.apps);
}

/**
 * Load the on-disk cache into a `path → entry` map. Tolerant of every failure
 * mode — a missing, unreadable, non-JSON, wrong-shape, or wrong-version file
 * yields an empty map (a full cold parse), never a throw. A single malformed
 * entry inside an otherwise valid file is skipped, not fatal.
 */
export async function loadParseCache(conceptionRoot: string): Promise<Map<string, DiskEntry>> {
  const empty = new Map<string, DiskEntry>();
  let raw: string;
  try {
    raw = await fs.readFile(parseCacheFilePath(conceptionRoot), 'utf8');
  } catch {
    return empty; // missing or unreadable — normal on first run
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty; // truncated / corrupt
  }
  if (typeof parsed !== 'object' || parsed === null) return empty;
  const file = parsed as Partial<CacheFile>;
  if (file.version !== PARSE_CACHE_VERSION) return empty;
  if (typeof file.entries !== 'object' || file.entries === null) return empty;
  const map = new Map<string, DiskEntry>();
  for (const [key, entry] of Object.entries(file.entries)) {
    if (isDiskEntry(entry)) map.set(key, entry);
  }
  return map;
}

/**
 * Atomically rewrite the cache file with exactly `entries` (tmp + rename via
 * {@link atomicWrite}, so two concurrent CLI writers can't tear the file —
 * last-write-wins, and any stale entry is caught by the reader's mtime check).
 * Callers pass only live-README entries, so writing the whole map is also the
 * prune: paths absent from the current tree simply aren't included.
 * Best-effort — a write failure (read-only fs, missing parent) is swallowed so
 * the cache never blocks the command it's accelerating.
 */
export async function writeParseCache(
  conceptionRoot: string,
  entries: Map<string, DiskEntry>,
): Promise<void> {
  const filePath = parseCacheFilePath(conceptionRoot);
  const file: CacheFile = {
    version: PARSE_CACHE_VERSION,
    entries: Object.fromEntries(entries),
  };
  try {
    await fs.mkdir(join(condashDir(conceptionRoot), CACHE_SUBDIR), { recursive: true });
    await atomicWrite(filePath, JSON.stringify(file) + '\n');
  } catch {
    // Best-effort persistence: the command already has its results.
  }
}

/**
 * Parse every README in `readmes`, reusing the on-disk cache for files whose
 * mtime is unchanged since the last run. Returns `{ project, header }` per
 * README in input order (matching `parseReadmeWithHeader`), so callers that
 * relied on the direct-parse array can swap this in unchanged.
 *
 * A fresh parse (miss or stale entry) refreshes that path's entry; the cache is
 * then rewritten with only the current live set (pruning vanished/renamed
 * READMEs) — but only when something actually changed, so an all-hit run pays a
 * single read and no write.
 *
 * @param conceptionRoot conception root that owns the `.condash/cache/` file
 * @param readmes absolute README paths, typically from `findProjectReadmes`
 */
export async function parseReadmesWithDiskCache(
  conceptionRoot: string,
  readmes: readonly string[],
): Promise<CachedParse[]> {
  const cache = await loadParseCache(conceptionRoot);
  let freshCount = 0;

  const resolved = await Promise.all(
    readmes.map(async (readme) => {
      const key = toPosix(readme);
      let mtimeMs: number;
      let size: number;
      try {
        const st = await fs.stat(readme);
        mtimeMs = st.mtimeMs;
        size = st.size;
      } catch {
        // Can't stat (vanished mid-scan) — parse directly and don't cache;
        // parseReadmeWithHeader throws the same ENOENT the old direct path did.
        const { project, header } = await parseReadmeWithHeader(readme);
        return { key, entry: null as DiskEntry | null, parsed: { project, header } };
      }
      const hit = cache.get(key);
      if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
        return { key, entry: hit, parsed: { project: hit.project, header: hit.header } };
      }
      const { project, header } = await parseReadmeWithHeader(readme);
      freshCount++;
      const entry: DiskEntry = { mtimeMs, size, project, header };
      return { key, entry, parsed: { project, header } };
    }),
  );

  const next = new Map<string, DiskEntry>();
  for (const item of resolved) {
    if (item.entry) next.set(item.key, item.entry);
  }
  // Rewrite only on a real change: a fresh/stale parse, or a prune (the live
  // set shrank below what the file held). An all-hit run skips the write.
  if (freshCount > 0 || next.size !== cache.size) {
    await writeParseCache(conceptionRoot, next);
  }

  return resolved.map((item) => item.parsed);
}
