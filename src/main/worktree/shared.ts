/**
 * Shared internals for the per-branch worktree operations
 * (inspect / setup / remove). Types, the repo lookup, the README walker,
 * basic git probes, and config plumbing live here so each operation module
 * can stay focused on its own concern.
 */

import { basename, join } from 'node:path';
import { findProjectReadmes } from '../walk';
import { readHeader } from '../header-io';
import { exec } from '../exec';
import { walkRepos, type ConfigShape } from '../config-walk';
import { getEffectiveConceptionConfig } from '../effective-config';

export interface ConfigWithPaths extends ConfigShape {
  worktrees_path?: string;
}

export interface RawRepoExtended {
  name: string;
  pinned_branch?: string;
  install?: string;
  /** Files to copy from the primary into a new worktree on setup. Applied
   *  unconditionally when present (no CLI flag needed). */
  env?: string[];
  submodules?: { name: string }[];
}

export interface RepoLookupExtended {
  name: string;
  cwd: string;
  install?: string;
  pinnedBranch?: string;
  env?: string[];
}

export function repoLookupMap(config: ConfigWithPaths): Map<string, RepoLookupExtended> {
  const map = new Map<string, RepoLookupExtended>();
  walkRepos(config, (entry) => {
    if (entry.parent) return; // ignore submodules — worktrees are per top-level repo
    map.set(entry.name, { name: entry.name, cwd: entry.cwd });
  });
  // Re-walk the raw config to pick up `pinned_branch`, `install`, and `env`
  // (those aren't currently in the RepoLookup shape).
  for (const raw of config.repositories ?? []) {
    if (typeof raw === 'string') continue;
    const lookup = map.get(raw.name);
    if (!lookup) continue;
    const ext = raw as unknown as RawRepoExtended;
    if (typeof ext.pinned_branch === 'string') lookup.pinnedBranch = ext.pinned_branch;
    if (typeof ext.install === 'string') lookup.install = ext.install;
    if (Array.isArray(ext.env) && ext.env.length > 0) {
      lookup.env = ext.env.filter((s) => typeof s === 'string' && s.length > 0);
    }
  }
  return map;
}

export async function resolveTargetRepos(
  conceptionPath: string,
  branch: string,
  override: string[] | undefined,
  reposByName: Map<string, RepoLookupExtended>,
): Promise<string[]> {
  if (override && override.length > 0) return override;
  const items = await findItemsDeclaringBranch(conceptionPath, branch);
  const set = new Set<string>();
  for (const item of items) {
    for (const app of item.apps) {
      const root = rootRepoFromApp(app);
      if (reposByName.has(root)) set.add(root);
    }
  }
  return [...set].sort();
}

export async function findItemsDeclaringBranch(
  conceptionPath: string,
  branch: string,
): Promise<
  { slug: string; readme: string; status: string; apps: string[]; base: string | null }[]
> {
  const out: {
    slug: string;
    readme: string;
    status: string;
    apps: string[];
    base: string | null;
  }[] = [];
  const readmes = await findProjectReadmes(conceptionPath);
  for (const readme of readmes) {
    const header = await readHeader(readme).catch(() => null);
    if (!header) continue;
    if (header.branch !== branch) continue;
    out.push({
      slug: basename(readme.replace(/\/README\.md$/, '')),
      readme,
      status: header.status ?? 'unknown',
      apps: header.apps,
      base: header.base,
    });
  }
  return out;
}

export function rootRepoFromApp(app: string): string {
  // Apps may be `condash`, `vcoeur.com`, or `condash/frontend`. The worktree
  // is always at the top-level repo, so strip the inner path.
  return app.split('/')[0];
}

/**
 * Hard-reject branch names that could let `join(worktreesRoot, branch)`
 * escape the worktrees root. Git itself accepts a wide range of names; what
 * we care about here is that the result of `join(root, branch)` always lands
 * exactly one directory below `root`. Path separators, `..`, and NUL are the
 * only ways to break that invariant on POSIX.
 */
export function validateBranchName(branch: string): void {
  if (!branch) {
    throw new Error('Branch name must not be empty.');
  }
  if (branch.includes('/') || branch.includes('\\')) {
    throw new Error(`Branch name '${branch}' contains a path separator — refusing.`);
  }
  if (branch === '.' || branch === '..') {
    throw new Error(`Branch name '${branch}' is a path component — refusing.`);
  }
  if (branch.includes('\0')) {
    throw new Error('Branch name contains NUL — refusing.');
  }
}

/** True when `ref` resolves in the repo — works for local branches,
 *  remote-tracking refs (`origin/foo`), tags, and short SHAs. */
export async function refExists(repo: string, ref: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repo });
    return true;
  } catch {
    return false;
  }
}

export async function currentBranch(repo: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: repo,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: repo,
    });
    return true;
  } catch {
    return false;
  }
}

export async function readConfig(conceptionPath: string): Promise<ConfigWithPaths> {
  return (await getEffectiveConceptionConfig(conceptionPath)) as ConfigWithPaths;
}

export function defaultWorktreesPath(): string {
  return join(process.env.HOME ?? '', 'src', 'worktrees');
}
