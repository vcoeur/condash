import { relative } from 'node:path';
import type { RepoEntry, Worktree } from '../shared/types';
import { toPosix } from '../shared/path';
import { getDirtyCount, getUpstreamStatus } from './git-status-cache';
import { getCurrentBranch, isGitRepo, listWorktrees } from './worktrees';
import { walkRepos, type ConfigShape, type RepoLookup } from './config-walk';
import { pathExists } from './fs-helpers';
import { getEffectiveConceptionConfig } from './effective-config';

type FlatRepo = RepoLookup;

async function readConfig(conceptionPath: string): Promise<ConfigShape> {
  return (await getEffectiveConceptionConfig(conceptionPath)) as ConfigShape;
}

function flatRepos(config: ConfigShape): FlatRepo[] {
  const flat: FlatRepo[] = [];
  walkRepos(config, (entry) => {
    flat.push(entry);
  });
  return flat;
}

/** Map every top-level repo by its resolved path. Submodule entries are
 * excluded; their `parentCwd` carries this stable identity. */
function parentByCwdMap(flat: FlatRepo[]): Map<string, FlatRepo> {
  const map = new Map<string, FlatRepo>();
  for (const entry of flat) {
    if (!entry.parent) map.set(toPosix(entry.cwd), entry);
  }
  return map;
}

/** Resolve worktree lists for a set of parent (top-level) repos in
 *  parallel. Empty array for missing parents — `buildEntry` then falls
 *  back to a synthesised primary row. */
async function resolveParentWorktrees(
  parents: Iterable<FlatRepo>,
): Promise<Map<string, Worktree[]>> {
  const out = new Map<string, Worktree[]>();
  await Promise.all(
    Array.from(parents).map(async (parent) => {
      const exists = await pathExists(parent.cwd);
      if (!exists) {
        out.set(toPosix(parent.cwd), []);
        return;
      }
      out.set(toPosix(parent.cwd), await listWorktrees(parent.cwd).catch(() => []));
    }),
  );
  return out;
}

/**
 * Worktrees for a TOP-LEVEL entry, reusing the list `resolveParentWorktrees`
 * already computed. That helper runs `git worktree list` for every top-level
 * repo before the fan-out starts, so listing again per entry spawned the
 * command a second time per parent — 16 of the ~90 spawns a refresh cost on the
 * 29-entry registry of #475. It swallows failures to `[]` exactly as a direct
 * call does, so the reuse is otherwise identical.
 *
 * The identity check is what makes it safe. Parent cwd is unique even when two
 * configured repos share a basename (`{path: 'a/docs'}` and `{path: 'b/docs'}`),
 * so every precomputed list remains attached to its own checkout. Anything the
 * map doesn't positively cover falls back to listing for itself.
 */
async function topLevelWorktrees(
  entry: FlatRepo,
  parentByCwd: Map<string, FlatRepo>,
  parentWorktrees: Map<string, Worktree[]>,
): Promise<Worktree[]> {
  const identity = toPosix(entry.cwd);
  if (parentByCwd.get(identity) === entry) {
    const precomputed = parentWorktrees.get(identity);
    if (precomputed) return precomputed;
  }
  return listWorktrees(entry.cwd).catch(() => []);
}

async function buildEntry(
  entry: FlatRepo,
  parentByCwd: Map<string, FlatRepo>,
  parentWorktrees: Map<string, Worktree[]>,
): Promise<RepoEntry> {
  const exists = await pathExists(entry.cwd);
  const hasForceStop = !!entry.forceStop;
  const hasRun = !!entry.run;
  if (!exists) {
    return {
      name: entry.display,
      handle: entry.handle,
      label: entry.label,
      path: toPosix(entry.cwd),
      parent: entry.parent,
      parentPath: entry.parentCwd ? toPosix(entry.parentCwd) : undefined,
      dirty: null,
      missing: true,
      hasForceStop,
      hasRun,
      section: entry.section,
    } satisfies RepoEntry;
  }
  const isGit = await isGitRepo(entry.cwd);
  let worktrees: Worktree[] | undefined;
  let dirty: number | null;
  if (isGit) {
    worktrees = entry.parent
      ? await deriveSubWorktrees(entry, parentByCwd, parentWorktrees)
      : await topLevelWorktrees(entry, parentByCwd, parentWorktrees);
    const dirtyOpts = entry.parent ? { scopeToSubtree: true } : {};
    dirty = await getDirtyCount(entry.cwd, dirtyOpts);
  } else {
    worktrees = undefined;
    dirty = null;
  }
  return {
    name: entry.display,
    handle: entry.handle,
    label: entry.label,
    path: toPosix(entry.cwd),
    parent: entry.parent,
    parentPath: entry.parentCwd ? toPosix(entry.parentCwd) : undefined,
    dirty,
    missing: false,
    isGit,
    hasForceStop,
    hasRun,
    worktrees: worktrees && worktrees.length > 0 ? worktrees : undefined,
    section: entry.section,
  } satisfies RepoEntry;
}

export async function listRepos(conceptionPath: string): Promise<RepoEntry[]> {
  const config = await readConfig(conceptionPath);
  const flat = flatRepos(config);
  const parentByCwd = parentByCwdMap(flat);
  const parentWorktrees = await resolveParentWorktrees(parentByCwd.values());
  return Promise.all(flat.map((entry) => buildEntry(entry, parentByCwd, parentWorktrees)));
}

// Boot prewarm handoff (review finding S1). The whenReady handler kicks off a
// listRepos before the window even exists, so the git-status fan-out (~460 ms
// measured at ~20 repos; seconds at the ~29-entry registry of #475, before the
// spawn cap and the two spawn removals landed) overlaps window creation instead
// of blocking the Code pane's first paint. A naive prewarm alone wouldn't help:
// the entries it warms are governed by the git-status cache TTL, so by the time
// the renderer's first listRepos runs (after the window loads and the renderer
// mounts) they could already have expired — re-running the whole fan-out.
// Instead we stash the boot scan's promise here and let the renderer's first
// listRepos *await the same promise*, which resolves once regardless of the
// underlying cache TTL. One-shot: the slot is consumed on first read, so later
// refreshes recompute fresh.
let bootReposPromise: Promise<RepoEntry[]> | null = null;
let bootReposPath: string | null = null;
/** Epoch ms the current boot slot was stashed — drives the TTL backstop. */
let bootReposAt = 0;

/** Max age of a stashed boot-prewarm slot before `listReposReusingBoot` refuses
 *  it and rescans (B5). The slot is meant for the renderer's first `listRepos`,
 *  which races boot by a second or two; `clearBootRepos` on a conception switch
 *  is the primary guard, and this is the belt-and-braces for a slot that was
 *  neither consumed nor cleared. Generous enough that a legitimately slow boot
 *  handoff is never discarded, tight enough that an "switch away, switch back
 *  hours later" never awaits a stale promise (wrong branches / dirty counts). */
const BOOT_REPOS_TTL_MS = 30_000;

/**
 * Kick off the boot repo scan for `conceptionPath` and stash its promise for the
 * renderer's first `listRepos` to reuse. Fire-and-forget from whenReady; the
 * returned promise is the stashed one so the caller can attach its own
 * error-swallowing `.catch`. Overwrites any prior prewarm (e.g. a fast
 * conception switch during boot) so the stashed path always matches the latest.
 *
 * @param conceptionPath active conception root
 * @returns the boot scan promise (also stored for {@link listReposReusingBoot})
 */
export function prewarmRepos(conceptionPath: string): Promise<RepoEntry[]> {
  bootReposPath = conceptionPath;
  bootReposAt = Date.now();
  bootReposPromise = listRepos(conceptionPath);
  return bootReposPromise;
}

/**
 * Drop any stashed boot-prewarm slot. Called at the conception-switch choke
 * point (index.ts `onConceptionPicked`) so a slot warmed for the old tree — or
 * for the new tree during a fast boot-time switch — can never be awaited by a
 * later `listReposReusingBoot` and hand back the wrong tree's repos (B5).
 */
export function clearBootRepos(): void {
  bootReposPromise = null;
  bootReposPath = null;
  bootReposAt = 0;
}

/**
 * `listRepos` for the renderer's first call: reuse the boot prewarm's in-flight
 * (or already-resolved) result when one is pending for the same conception and
 * still fresh, otherwise run a fresh scan. Falls back to a fresh scan if the
 * prewarm itself rejected. The boot slot is consumed one-shot, so every later
 * refresh recomputes.
 *
 * @param conceptionPath active conception root
 * @returns the repo entries
 */
export async function listReposReusingBoot(conceptionPath: string): Promise<RepoEntry[]> {
  const fresh = Date.now() - bootReposAt <= BOOT_REPOS_TTL_MS;
  if (bootReposPromise && bootReposPath === conceptionPath && fresh) {
    const pending = bootReposPromise;
    clearBootRepos();
    try {
      return await pending;
    } catch {
      // The boot prewarm failed — fall through to a fresh scan.
    }
  } else if (bootReposPromise) {
    // A slot for another tree, or one that outlived its TTL, must never be
    // reused — drop it so it can't be awaited by a later call.
    clearBootRepos();
  }
  return listRepos(conceptionPath);
}

/**
 * Per-primary partial reload. Returns the primary's `RepoEntry` plus
 * every submodule child re-rooted on the primary's freshly-listed
 * worktrees. Empty array if the primary is no longer in
 * `condash.json` (e.g. config was edited concurrently).
 *
 * Used by the structural FS watcher path: when a primary's
 * `.git/HEAD` or `.git/worktrees/` changes, the renderer asks for just
 * this one primary's data instead of re-reading the whole repo list,
 * so the rest of the panel doesn't need to re-paint.
 */
export async function listReposForPrimary(
  conceptionPath: string,
  primaryPath: string,
): Promise<RepoEntry[]> {
  const config = await readConfig(conceptionPath);
  const flat = flatRepos(config);
  const primary = flat.find((entry) => !entry.parent && toPosix(entry.cwd) === primaryPath);
  if (!primary) return [];
  const parentByCwd = parentByCwdMap(flat);
  const parentWorktrees = await resolveParentWorktrees([primary]);
  // The primary plus every submodule child of it (in flat-config order).
  const primaryIdentity = toPosix(primary.cwd);
  const affected = flat.filter(
    (entry) => entry === primary || toPosix(entry.parentCwd ?? '') === primaryIdentity,
  );
  return Promise.all(affected.map((entry) => buildEntry(entry, parentByCwd, parentWorktrees)));
}

/**
 * Build the worktree list for a SUB entry by re-rooting its parent's
 * worktrees onto the submodule's relative subpath. For each parent worktree
 * at `<parent_wt>/`, the SUB checkout lives at `<parent_wt>/<sub_relative>`;
 * dirty counts are queried subtree-scoped because the SUB shares its git
 * directory with the parent's worktree.
 *
 * Falls back to a single synthetic row (the SUB's primary cwd + current
 * branch) when the parent has no listable worktrees — e.g. the parent is
 * missing or `git worktree list` failed.
 */
async function deriveSubWorktrees(
  entry: FlatRepo,
  parentByCwd: Map<string, FlatRepo>,
  parentWorktrees: Map<string, Worktree[]>,
): Promise<Worktree[]> {
  const parentIdentity = entry.parentCwd ? toPosix(entry.parentCwd) : undefined;
  const parent = parentIdentity ? parentByCwd.get(parentIdentity) : undefined;
  const parentList = parentIdentity ? (parentWorktrees.get(parentIdentity) ?? []) : [];
  if (!parent || parentList.length === 0) {
    const branch = await getCurrentBranch(entry.cwd).catch(() => null);
    return [{ path: toPosix(entry.cwd), branch, primary: true }];
  }
  // `wt.path` already comes from `listWorktrees` in POSIX form (see
  // worktrees.ts), and `entry.cwd` was resolved via `path.join` so on
  // Windows it would carry `\` separators. Normalise the relative
  // computation in POSIX-space to avoid mixing separators.
  const subRelative = toPosix(relative(parent.cwd, entry.cwd));
  const rerooted: Worktree[] = parentList.map((wt) => ({
    path: subRelative ? `${wt.path}/${subRelative}` : wt.path,
    branch: wt.branch,
    primary: wt.primary,
  }));
  await Promise.all(
    rerooted.map(async (wt) => {
      const [dirty, upstream] = await Promise.all([
        getDirtyCount(wt.path, { scopeToSubtree: true }),
        getUpstreamStatus(wt.path),
      ]);
      wt.dirty = dirty;
      wt.upstream = upstream;
    }),
  );
  return rerooted;
}
