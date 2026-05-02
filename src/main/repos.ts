import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import type { RepoEntry, Worktree } from '../shared/types';
import { toPosix } from '../shared/path';
import { getDirtyCount, getUpstreamStatus } from './git-status-cache';
import { getCurrentBranch, listWorktrees } from './worktrees';
import { walkRepos, type ConfigShape, type RepoLookup } from './config-walk';

interface FlatRepo extends RepoLookup {
  kind: 'primary' | 'secondary';
}

async function readConfig(conceptionPath: string): Promise<ConfigShape> {
  const path = join(conceptionPath, 'configuration.json');
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw) as ConfigShape;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function flatRepos(config: ConfigShape): FlatRepo[] {
  const flat: FlatRepo[] = [];
  walkRepos(config, (entry, kind) => {
    flat.push({ ...entry, kind });
  });
  return flat;
}

/** Map every top-level repo to itself. Submodule entries are excluded;
 *  callers find them via `parent` lookups. */
function parentByNameMap(flat: FlatRepo[]): Map<string, FlatRepo> {
  const map = new Map<string, FlatRepo>();
  for (const entry of flat) {
    if (!entry.parent) map.set(entry.name, entry);
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
        out.set(parent.name, []);
        return;
      }
      out.set(parent.name, await listWorktrees(parent.cwd).catch(() => []));
    }),
  );
  return out;
}

async function buildEntry(
  entry: FlatRepo,
  parentByName: Map<string, FlatRepo>,
  parentWorktrees: Map<string, Worktree[]>,
): Promise<RepoEntry> {
  const exists = await pathExists(entry.cwd);
  const hasForceStop = !!entry.forceStop;
  const hasRun = !!entry.run;
  if (!exists) {
    return {
      name: entry.display,
      label: entry.label,
      path: toPosix(entry.cwd),
      kind: entry.kind,
      parent: entry.parent,
      dirty: null,
      missing: true,
      hasForceStop,
      hasRun,
    } satisfies RepoEntry;
  }
  const worktrees = entry.parent
    ? await deriveSubWorktrees(entry, parentByName, parentWorktrees)
    : await listWorktrees(entry.cwd).catch(() => []);
  // Submodule entries (those with a `parent`) often live inside the
  // parent repo's git tree — without `-- .` scoping, `git status` would
  // surface the parent repo's dirty entries on the submodule card.
  const dirtyOpts = entry.parent ? { scopeToSubtree: true } : {};
  const dirty = await getDirtyCount(entry.cwd, dirtyOpts);
  return {
    name: entry.display,
    label: entry.label,
    path: toPosix(entry.cwd),
    kind: entry.kind,
    parent: entry.parent,
    dirty,
    missing: false,
    hasForceStop,
    hasRun,
    worktrees: worktrees.length > 0 ? worktrees : undefined,
  } satisfies RepoEntry;
}

export async function listRepos(conceptionPath: string): Promise<RepoEntry[]> {
  const config = await readConfig(conceptionPath);
  const flat = flatRepos(config);
  const parentByName = parentByNameMap(flat);
  const parentWorktrees = await resolveParentWorktrees(parentByName.values());
  return Promise.all(flat.map((entry) => buildEntry(entry, parentByName, parentWorktrees)));
}

/**
 * Per-primary partial reload. Returns the primary's `RepoEntry` plus
 * every submodule child re-rooted on the primary's freshly-listed
 * worktrees. Empty array if the primary is no longer in
 * `configuration.json` (e.g. config was edited concurrently).
 *
 * Used by the structural FS watcher path: when a primary's
 * `.git/HEAD` or `.git/worktrees/` changes, the renderer asks for just
 * this one primary's data instead of re-reading the whole repo list,
 * so the rest of the panel doesn't need to re-paint.
 */
export async function listReposForPrimary(
  conceptionPath: string,
  primaryName: string,
): Promise<RepoEntry[]> {
  const config = await readConfig(conceptionPath);
  const flat = flatRepos(config);
  const primary = flat.find((e) => !e.parent && e.name === primaryName);
  if (!primary) return [];
  const parentByName = parentByNameMap(flat);
  const parentWorktrees = await resolveParentWorktrees([primary]);
  // The primary plus every submodule child of it (in flat-config order).
  const affected = flat.filter((e) => e === primary || e.parent === primaryName);
  return Promise.all(affected.map((e) => buildEntry(e, parentByName, parentWorktrees)));
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
  parentByName: Map<string, FlatRepo>,
  parentWorktrees: Map<string, Worktree[]>,
): Promise<Worktree[]> {
  const parent = entry.parent ? parentByName.get(entry.parent) : undefined;
  const parentList = entry.parent ? (parentWorktrees.get(entry.parent) ?? []) : [];
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
