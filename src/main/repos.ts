import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import type { RepoEntry, Worktree } from '../shared/types';
import { toPosix } from '../shared/path';
import { getDirtyCount } from './git-status-cache';
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

export async function listRepos(conceptionPath: string): Promise<RepoEntry[]> {
  const config = await readConfig(conceptionPath);

  const flat: FlatRepo[] = [];
  walkRepos(config, (entry, kind) => {
    flat.push({ ...entry, kind });
  });

  // Resolve every parent (top-level) entry's worktree list once. Submodule
  // entries inherit this list — each parent worktree carries its own checkout
  // of the submodule at `<parent_wt>/<sub_relative>`, so the SUB card lists
  // the same branch set as its REPO card with paths re-rooted.
  const parentByName = new Map<string, FlatRepo>();
  for (const entry of flat) {
    if (!entry.parent) parentByName.set(entry.name, entry);
  }
  const parentWorktrees = new Map<string, Worktree[]>();
  await Promise.all(
    Array.from(parentByName.entries()).map(async ([name, parent]) => {
      const exists = await pathExists(parent.cwd);
      if (!exists) {
        parentWorktrees.set(name, []);
        return;
      }
      parentWorktrees.set(name, await listWorktrees(parent.cwd).catch(() => []));
    }),
  );

  return Promise.all(
    flat.map(async (entry) => {
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
    }),
  );
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
      wt.dirty = await getDirtyCount(wt.path, { scopeToSubtree: true });
    }),
  );
  return rerooted;
}
