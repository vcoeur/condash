/**
 * Per-branch state inspector. Surveys what each repo's worktree state looks
 * like for a given branch and reports orphaned worktree dirs that no item
 * declares.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { pathExists } from '../fs-helpers';
import {
  branchExists,
  branchToDir,
  currentBranch,
  defaultWorktreesPath,
  findItemsDeclaringBranch,
  readConfig,
  repoLookupMap,
  resolveAppRepo,
} from './shared';

export interface BranchRepoState {
  /** Repo name (matches the canonical key under condash.json `repositories`). */
  name: string;
  /** Absolute path to the repo's primary working copy. */
  primaryPath: string;
  /** Absolute path the worktree would live at, even when missing. */
  expectedWorktree: string;
  /** Whether the worktree exists on disk. */
  worktreeExists: boolean;
  /** Whether the local branch exists in this repo. */
  localBranchExists: boolean;
  /** Whether the primary checkout currently has the branch checked out. */
  primaryOnBranch: boolean;
  /** Pin: when set, this repo is configured to stay on a fixed branch. */
  pinnedBranch?: string;
}

export interface BranchCheckResult {
  branch: string;
  /** Worktrees root from condash.json. */
  worktreesRoot: string;
  /** Items declaring this branch (status, slug, apps). */
  declaringItems: { slug: string; readme: string; status: string; apps: string[] }[];
  /** Per-repo state across the union of `**Apps**` from declaring items. */
  repos: BranchRepoState[];
  /** Repos that should have a worktree but don't. */
  missing: string[];
  /** Repos that have a worktree but no item references the branch. */
  orphan: string[];
}

export async function checkBranchState(
  conceptionPath: string,
  branch: string,
): Promise<BranchCheckResult> {
  const config = await readConfig(conceptionPath);
  const worktreesRoot = config.worktrees_path ?? defaultWorktreesPath();
  const branchDir = branchToDir(branch);
  const declaringItems = await findItemsDeclaringBranch(conceptionPath, branch);

  // Union of Apps from declaring items (active items only — done items don't
  // need worktrees but still surface their previous claims so the user can
  // see them). Each token resolves to its canonical repo directory name so a
  // `#vcoeur`-style handle (≠ the `vcoeur.com` directory) maps correctly.
  const reposByName = repoLookupMap(config);
  const wantedRepos = new Set<string>();
  for (const item of declaringItems) {
    for (const app of item.apps) {
      const repo = resolveAppRepo(app, reposByName);
      if (repo) wantedRepos.add(repo.name);
    }
  }

  const repos: BranchRepoState[] = [];
  for (const name of [...wantedRepos].sort()) {
    const lookup = reposByName.get(name);
    if (!lookup) continue;
    const expectedWorktree = join(worktreesRoot, branchDir, name);
    const worktreeExists = await pathExists(expectedWorktree);
    const localBranchExists = await branchExists(lookup.cwd, branch);
    const primaryOnBranch = (await currentBranch(lookup.cwd)) === branch;
    repos.push({
      name,
      primaryPath: lookup.cwd,
      expectedWorktree,
      worktreeExists,
      localBranchExists,
      primaryOnBranch,
      pinnedBranch: lookup.pinnedBranch,
    });
  }

  // Orphans: directories under <worktrees_path>/<branch>/ that aren't in our
  // wanted set.
  const orphan: string[] = [];
  const branchRoot = join(worktreesRoot, branchDir);
  if (await pathExists(branchRoot)) {
    const entries = await fs.readdir(branchRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!wantedRepos.has(entry.name)) orphan.push(entry.name);
    }
  }

  const missing = repos.filter((r) => !r.worktreeExists && !r.pinnedBranch).map((r) => r.name);

  return {
    branch,
    worktreesRoot,
    declaringItems,
    repos,
    missing,
    orphan,
  };
}
