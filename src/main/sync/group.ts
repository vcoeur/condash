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

import type { ChangedPath } from './git';

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

/** The two index trees the sweeper regenerates and commits independently. */
export type SyncTree = 'projects' | 'knowledge';

export type PathKind =
  /** A file inside `projects/<month>/<item>/`; `item` is the dated folder name. */
  | { kind: 'item'; item: string }
  /** A knowledge body file (any depth) that is not a generated index. */
  | { kind: 'knowledge' }
  /** A generated `index.md`, tagged with the tree it indexes. The tree is
   *  what lets the sweeper defer one tree's indexes without stalling the
   *  other's. */
  | { kind: 'index'; tree: SyncTree }
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
    return segments[segments.length - 1] === 'index.md'
      ? { kind: 'index', tree: 'knowledge' }
      : { kind: 'knowledge' };
  }

  if (root !== 'projects') return { kind: 'meta' };

  // projects/index.md
  if (segments.length === 2) {
    return segments[1] === 'index.md'
      ? { kind: 'index', tree: 'projects' }
      : { kind: 'unresolved' };
  }
  if (!MONTH_DIR.test(segments[1])) return { kind: 'unresolved' };

  // projects/<month>/index.md
  if (segments.length === 3) {
    return segments[2] === 'index.md'
      ? { kind: 'index', tree: 'projects' }
      : { kind: 'unresolved' };
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
 * `itemAliases` maps an old item folder name to the new one it was renamed
 * to (a detected {@link RenamePair}): paths of both sides land in ONE group
 * keyed by the new item, so git sees the delete+add pair in a single commit
 * and rename detection connects the history.
 *
 * @param paths repo-relative paths that passed the quiet-period filter
 * @param options.itemAliases old item folder → new item folder
 * @returns groups ordered items-first (by item name), then knowledge, then meta
 */
export function commitGroups(
  paths: readonly string[],
  options: { itemAliases?: ReadonlyMap<string, string> } = {},
): CommitGroup[] {
  const byKey = new Map<string, string[]>();
  for (const path of paths) {
    const cls = classifyPath(path);
    const key =
      cls.kind === 'item'
        ? (options.itemAliases?.get(cls.item) ?? cls.item)
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

// ---------------------------------------------------------------------------
// Rename pairing.
// ---------------------------------------------------------------------------

/** One detected item move: `oldItem`'s tracked files are all deleted, and
 *  `newItem`'s are all new to HEAD, with identical per-file shapes. The pair
 *  commits as one unit under the new item's subject. */
export interface RenamePair {
  oldItem: string;
  newItem: string;
  oldPaths: string[];
  newPaths: string[];
}

/**
 * Detect item moves in the `--no-renames` porcelain stream, before any
 * eligibility filtering.
 *
 * `readChangedPaths` deliberately keeps `--no-renames`, so a moved item
 * surfaces as one group of deleted paths (HEAD holds the blobs) plus one
 * group of new-to-HEAD paths. When an all-deleted item group and an
 * all-newToHead item group — both under `projects/` — carry identical
 * per-file suffix sets, they are one logical rename. Any other shape (a
 * modified path on either side, a conflict, two candidate targets, unequal
 * suffix sets) refuses to pair: those sweep exactly as they did before.
 *
 * Pure: porcelain codes in, pairs out — no disk access.
 */
export function detectRenamePairs(changed: readonly ChangedPath[]): RenamePair[] {
  interface Side {
    suffixes: Set<string>;
    paths: string[];
  }
  const deleted = new Map<string, Side>();
  const added = new Map<string, Side>();
  // Items with any path that is neither a clean deletion nor a clean
  // addition — a modified file, a conflict — are not pure moves on that side.
  const mixed = new Set<string>();

  for (const change of changed) {
    const cls = classifyPath(change.path);
    if (cls.kind !== 'item') continue;
    if (change.conflicted || change.deleted === change.newToHead) {
      mixed.add(cls.item);
      continue;
    }
    const side = change.deleted ? deleted : added;
    let bucket = side.get(cls.item);
    if (!bucket) {
      bucket = { suffixes: new Set(), paths: [] };
      side.set(cls.item, bucket);
    }
    bucket.suffixes.add(itemSuffix(change.path));
    bucket.paths.push(change.path);
  }

  const pairs: RenamePair[] = [];
  const consumed = new Set<string>();
  for (const [oldItem, oldSide] of [...deleted.entries()].sort()) {
    if (mixed.has(oldItem) || consumed.has(oldItem)) continue;
    const matches = [...added.entries()].filter(
      ([newItem, newSide]) =>
        newItem !== oldItem &&
        !consumed.has(newItem) &&
        !mixed.has(newItem) &&
        sameMembers(oldSide.suffixes, newSide.suffixes),
    );
    // Two candidates with identical shapes — refuse rather than guess.
    if (matches.length !== 1) continue;
    const [newItem, newSide] = matches[0];
    consumed.add(oldItem);
    consumed.add(newItem);
    pairs.push({
      oldItem,
      newItem,
      oldPaths: oldSide.paths.sort(),
      newPaths: newSide.paths.sort(),
    });
  }
  return pairs;
}

/** The path below `projects/<month>/<item>/` — the per-file shape a move
 *  preserves (`README.md`, `notes/01-plan.md`, …). */
function itemSuffix(path: string): string {
  return path.split('/').slice(3).join('/');
}

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}
