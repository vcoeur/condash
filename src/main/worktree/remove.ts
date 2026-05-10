/**
 * `remove` mutator — tears down per-repo worktrees for a branch, protecting
 * repos still claimed by other active items declaring the same branch.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { exec } from '../exec';
import { pathExists } from '../fs-helpers';
import {
  defaultWorktreesPath,
  findItemsDeclaringBranch,
  readConfig,
  repoLookupMap,
  rootRepoFromApp,
  validateBranchName,
} from './shared';

export interface RemoveOptions {
  /** Optional explicit repo allow-list. */
  repos?: string[];
}

export interface RemoveResult {
  branch: string;
  /** Repos whose worktree we removed. */
  removed: { repo: string; path: string }[];
  /** Repos kept because another active item still claims them on this branch. */
  protected: { repo: string; reason: string }[];
  /** Repos that had no worktree at this branch in the first place. */
  notPresent: string[];
  /** Whether `<worktrees_path>/<branch>/` was rmdir'd (only if empty after). */
  parentRemoved: boolean;
}

export async function removeBranchWorktrees(
  conceptionPath: string,
  branch: string,
  options: RemoveOptions = {},
): Promise<RemoveResult> {
  validateBranchName(branch);
  const config = await readConfig(conceptionPath);
  const worktreesRoot = config.worktrees_path ?? defaultWorktreesPath();
  const reposByName = repoLookupMap(config);

  // Resolve target repos: explicit list, or the union of Apps across items
  // declaring the branch. Then remove the protected set (repos still claimed
  // by *other active* items so we don't yank a worktree out from under them).
  const requested =
    options.repos && options.repos.length > 0
      ? new Set(options.repos)
      : new Set(
          (await findItemsDeclaringBranch(conceptionPath, branch))
            .flatMap((i) => i.apps)
            .map(rootRepoFromApp),
        );
  // Compute the protected set from active items declaring this branch *that
  // were not in the explicit override*. The skill is responsible for excluding
  // the *closing* item from `requested` so its repos are eligible for removal.
  const protectedSet = new Set<string>();
  for (const item of await findItemsDeclaringBranch(conceptionPath, branch)) {
    if (item.status === 'done') continue;
    for (const app of item.apps) {
      const repo = rootRepoFromApp(app);
      if (!requested.has(repo)) protectedSet.add(repo);
    }
  }

  const result: RemoveResult = {
    branch,
    removed: [],
    protected: [],
    notPresent: [],
    parentRemoved: false,
  };

  for (const name of [...requested].sort()) {
    if (protectedSet.has(name)) {
      result.protected.push({ repo: name, reason: `still claimed by another active item` });
      continue;
    }
    const lookup = reposByName.get(name);
    if (!lookup) {
      result.notPresent.push(name);
      continue;
    }
    const target = join(worktreesRoot, branch, name);
    if (!(await pathExists(target))) {
      result.notPresent.push(name);
      continue;
    }
    try {
      await exec('git', ['worktree', 'remove', target], { cwd: lookup.cwd });
      result.removed.push({ repo: name, path: target });
    } catch (err) {
      result.protected.push({
        repo: name,
        reason: `git worktree remove failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // If the parent dir is now empty, rmdir it. We only ever rmdir
  // `<worktreesRoot>/<branch>` — branch names with path separators are
  // rejected upfront by validateBranchName, and a realpath check below
  // ensures we don't follow a symlink out of the worktrees root onto an
  // unrelated directory. Issue #84 reported a sibling branch dir vanishing
  // after `worktrees remove`; the path check makes that impossible by
  // construction.
  const branchRoot = join(worktreesRoot, branch);
  try {
    const expected = await fs.realpath(branchRoot).catch(() => branchRoot);
    const expectedParent = await fs.realpath(worktreesRoot).catch(() => worktreesRoot);
    const expectedChild = join(expectedParent, branch);
    if (expected !== expectedChild) {
      // Don't rmdir something the user pointed elsewhere via a symlink.
      // Surface this rather than silently skip — it's a config oddity worth
      // knowing about.
      result.parentRemoved = false;
    } else {
      const remaining = await fs.readdir(branchRoot);
      if (remaining.length === 0) {
        await fs.rmdir(branchRoot);
        result.parentRemoved = true;
      }
    }
  } catch {
    // ENOENT after the per-repo removals is fine.
  }

  return result;
}
