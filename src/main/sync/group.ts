/**
 * Pure path → commit-group classification for `condash sync`.
 *
 * The sweeper commits one commit per item so that a shared conception
 * checkout still produces per-item history. Grouping is decided purely by
 * path shape — no disk access — so it unit-tests without a fixture tree.
 *
 * Segment count is what separates a tree index from an item's own files:
 * `projects/<month>/index.md` is three segments and belongs to the index
 * commit, while `projects/<month>/<item>/index.md` is four and belongs to
 * the item.
 */

/** `2026-07`. Exported for the create-verb bound in `files.ts`, which must
 * agree with the sweeper on what an item path looks like. */
export const MONTH_DIR = /^\d{4}-\d{2}$/;
/** `2026-07-10-some-slug`. Exported alongside {@link MONTH_DIR}. */
export const ITEM_DIR = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;

/** Subject of the single commit carrying every regenerated `index.md`. */
export const INDEX_COMMIT_SUBJECT = 'indexes: sync';

/**
 * Subject of the single commit carrying every tracked non-tree change —
 * `AGENTS.md`, `.agents/**`, config files, `resources/`, `tasks/`, …
 */
export const META_COMMIT_SUBJECT = 'meta: sync';

export type PathKind =
  /** A file inside `projects/<month>/<item>/`; `item` is the dated folder name. */
  | { kind: 'item'; item: string }
  /** A knowledge body file (any depth) that is not a generated index. */
  | { kind: 'knowledge' }
  /** A generated `index.md` in either tree. */
  | { kind: 'index' }
  /** Any tracked path outside both trees — root files, config, `resources/`, `tasks/`. */
  | { kind: 'meta' }
  /** Under `projects/` or `knowledge/` but matching no known shape. */
  | { kind: 'unresolved' };

export interface CommitGroup {
  /** Stable identity: the item folder name, or `knowledge`. */
  key: string;
  /** Commit subject line. */
  subject: string;
  /** Repo-relative paths, sorted. */
  paths: string[];
}

/**
 * Classify one repo-relative, POSIX-separated path.
 *
 * The sweeper only ever sees paths `git status` surfaced, and git status omits
 * gitignored paths — so the compiled per-harness views (`.claude/*`, `.pi/*`,
 * `CLAUDE.md`, …) never reach here to begin with. That is what lets the
 * non-tree branch be a **catch-all** rather than an allowlist: every tracked,
 * non-ignored file outside `projects/`/`knowledge/` is `meta`, so no file the
 * single-writer rule strands is left without a committer. A malformed path
 * *inside* a tree stays `unresolved` — a file misplaced under `projects/` is a
 * mistake worth reporting, not silently sweeping.
 *
 * @param relPath path as git reports it (forward slashes, no quoting)
 * @returns the group the path belongs to
 */
export function classifyPath(relPath: string): PathKind {
  const segments = relPath.split('/');
  const [root] = segments;

  if (root === 'knowledge') {
    if (segments.length < 2) return { kind: 'unresolved' };
    return segments[segments.length - 1] === 'index.md' ? { kind: 'index' } : { kind: 'knowledge' };
  }

  if (root !== 'projects') return { kind: 'meta' };

  // projects/index.md
  if (segments.length === 2) {
    return segments[1] === 'index.md' ? { kind: 'index' } : { kind: 'unresolved' };
  }
  if (!MONTH_DIR.test(segments[1])) return { kind: 'unresolved' };

  // projects/<month>/index.md
  if (segments.length === 3) {
    return segments[2] === 'index.md' ? { kind: 'index' } : { kind: 'unresolved' };
  }

  // projects/<month>/<item>/...
  return ITEM_DIR.test(segments[2]) ? { kind: 'item', item: segments[2] } : { kind: 'unresolved' };
}

/** Non-item keys, in the order they trail the per-item commits. */
const TRAILING_KEYS = ['knowledge', 'meta'];

/**
 * Bucket eligible paths into per-item commits plus one knowledge and one meta
 * commit.
 *
 * `index` / `unresolved` paths are dropped: the caller filters them out
 * beforehand (indexes get their own commit after regeneration, unresolved
 * paths are reported and never committed).
 *
 * @param paths repo-relative paths that passed the quiet-period filter
 * @returns groups ordered items-first (by item name), then knowledge, then meta
 */
export function commitGroups(paths: readonly string[]): CommitGroup[] {
  const byKey = new Map<string, string[]>();
  for (const path of paths) {
    const cls = classifyPath(path);
    const key =
      cls.kind === 'item'
        ? cls.item
        : cls.kind === 'knowledge'
          ? 'knowledge'
          : cls.kind === 'meta'
            ? 'meta'
            : null;
    if (key === null) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(path);
    else byKey.set(key, [path]);
  }

  const items = [...byKey.keys()].filter((key) => !TRAILING_KEYS.includes(key)).sort();
  const ordered = [...items, ...TRAILING_KEYS.filter((key) => byKey.has(key))];

  return ordered.map((key) => ({
    key,
    subject: `${key}: sync`,
    paths: (byKey.get(key) as string[]).sort(),
  }));
}
