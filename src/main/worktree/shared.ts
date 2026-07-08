/**
 * Shared internals for the per-branch worktree operations
 * (inspect / setup / remove). Types, the repo lookup, the README walker,
 * basic git probes, and config plumbing live here so each operation module
 * can stay focused on its own concern.
 */

import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { findProjectReadmes } from '../walk';
import { readHeader } from '../header-io';
import { exec } from '../exec';
import { isSectionMarker, walkRepos, type ConfigShape } from '../config-walk';
import { getEffectiveConceptionConfig } from '../effective-config';

export interface ConfigWithPaths extends ConfigShape {
  worktrees_path?: string;
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
    const lookup: RepoLookupExtended = { name: entry.name, cwd: entry.cwd };
    map.set(entry.name, lookup);
    // Also index by the canonical `#handle` and any configured aliases, so an
    // `apps:` token resolves even when the handle differs from the directory
    // name (e.g. `#vcoeur` → repo `vcoeur.com`). The directory name always
    // wins on collision (set first, and alias keys are skipped when taken),
    // so a handle/alias never shadows a real repo directory. Every key points
    // at the same lookup object, whose `.name` stays the canonical directory
    // name callers use for the worktree path.
    for (const key of [entry.handle, ...(entry.aliases ?? [])]) {
      if (key && !map.has(key)) map.set(key, lookup);
    }
  });
  // Re-walk the raw config to pick up `pinned_branch`, `install`, and `env`
  // (those aren't currently in the RepoLookup shape).
  for (const raw of config.repositories ?? []) {
    if (typeof raw === 'string') continue;
    if (isSectionMarker(raw)) continue;
    // Mirror config-walk: the directory name is `name`, or `basename(path)`
    // when only a path is configured.
    const dirName = raw.name ?? basename(raw.path ?? '');
    const lookup = map.get(dirName);
    if (!lookup) continue;
    if (typeof raw.pinned_branch === 'string') lookup.pinnedBranch = raw.pinned_branch;
    if (typeof raw.install === 'string') lookup.install = raw.install;
    if (Array.isArray(raw.env) && raw.env.length > 0) {
      lookup.env = raw.env.filter((s) => typeof s === 'string' && s.length > 0);
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
  // Normalise to canonical directory names so the worktree path is stable
  // regardless of which spelling (name, `#handle`, or alias) named the repo.
  if (override && override.length > 0) {
    // Unknown tokens pass through unchanged so the caller still reports them
    // as "not configured".
    return [
      ...new Set(override.map((token) => resolveAppRepo(token, reposByName)?.name ?? token)),
    ].sort();
  }
  const items = await findItemsDeclaringBranch(conceptionPath, branch);
  const set = new Set<string>();
  for (const item of items) {
    for (const app of item.apps) {
      const repo = resolveAppRepo(app, reposByName);
      if (repo) set.add(repo.name);
    }
  }
  return [...set].sort();
}

/**
 * Resolve an `apps:` token to its canonical top-level repo descriptor,
 * matching by directory name, `#handle`, or a configured alias. Returns null
 * when the token names no configured repo. The returned `.name` is the
 * canonical directory name — callers use it for the worktree path and labels
 * so `#vcoeur`, `#vcoeur.com`, and `--repo vcoeur.com` all map to one worktree.
 */
export function resolveAppRepo(
  app: string,
  repos: Map<string, RepoLookupExtended>,
): RepoLookupExtended | null {
  return repos.get(rootRepoFromApp(app)) ?? null;
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
  // Apps may be `condash`, `#condash`, `vcoeur.com`, or `condash/frontend`.
  // The `#` prefix is the conception's display convention (mirrors the Apps
  // table column) and is not part of the canonical repo name in
  // condash.json. The worktree is always at the top-level repo, so strip
  // both the `#` and the inner path.
  return app.replace(/^#/, '').split('/')[0];
}

/**
 * Hard-reject branch names that could let `join(worktreesRoot, branchToDir())`
 * escape the worktrees root. Git itself accepts a wide range of names; what
 * we care about here is that the result of `join(root, dir)` always lands
 * exactly one directory below `root`. NUL, empty, and the literal `.`/`..`
 * names are the remaining ways to break that invariant — slashes are
 * flattened by branchToDir() (issue #168).
 */
export function validateBranchName(branch: string): void {
  if (!branch) {
    throw new Error('Branch name must not be empty.');
  }
  if (branch === '.' || branch === '..') {
    throw new Error(`Branch name '${branch}' is a path component — refusing.`);
  }
  if (branch.includes('\0')) {
    throw new Error('Branch name contains NUL — refusing.');
  }
  const dir = branchToDir(branch);
  if (!dir || dir === '.' || dir === '..') {
    throw new Error(`Branch name '${branch}' sanitises to an unsafe directory name — refusing.`);
  }
}

/**
 * Map a git branch name to the directory key used under `<worktrees_path>/`.
 * Path separators (`/`, `\\`) are flattened to `-` so namespaced branches
 * like `feature/foo` or `chore/x` get a flat `feature-foo/` directory while
 * the underlying git ref keeps its real name. Closes #168.
 *
 * Collisions (e.g. `foo/bar` vs `foo-bar`) sanitise to the same key; the
 * second `git worktree add` will refuse the directory before this code
 * could trip on it.
 */
export function branchToDir(branch: string): string {
  return branch.replace(/[\\/]/g, '-');
}

/** One entry of `git worktree list --porcelain`: the on-disk path and the
 *  checked-out branch (null when detached). */
export interface WorktreeListEntry {
  path: string;
  branch: string | null;
}

/**
 * Snapshot the repo's registered worktrees via `git worktree list
 * --porcelain`. Returns null when the query itself failed (not a repo,
 * git missing) so callers can distinguish "no entries" from "couldn't ask".
 */
export async function listWorktreeEntries(repoCwd: string): Promise<WorktreeListEntry[] | null> {
  let stdout: string;
  try {
    ({ stdout } = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: repoCwd }));
  } catch {
    return null;
  }
  const entries: WorktreeListEntry[] = [];
  let current: { path?: string; branch: string | null } = { branch: null };
  const flush = () => {
    if (current.path) entries.push({ path: current.path, branch: current.branch });
    current = { branch: null };
  };
  for (const line of stdout.split('\n')) {
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line === 'detached') {
      current.branch = null;
    }
  }
  flush();
  return entries;
}

/**
 * Find the snapshot entry registered at `target`, comparing both the raw
 * path and the realpath (symlinked worktrees roots are common). Returns
 * null when no entry matches — the directory at `target` is not a
 * registered worktree of this repo.
 */
export async function findWorktreeEntry(
  entries: readonly WorktreeListEntry[],
  target: string,
): Promise<WorktreeListEntry | null> {
  const targetReal = await fs.realpath(target).catch(() => target);
  for (const entry of entries) {
    if (entry.path === target) return entry;
    const real = await fs.realpath(entry.path).catch(() => entry.path);
    if (real === targetReal) return entry;
  }
  return null;
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

/**
 * Glob match a branch name against a pattern. Supports `*` (any sequence) and
 * `?` (single character). Escapes all other regex metacharacters so branch
 * names like `release/1.0` or `hotfix-2.3` match literally.
 */
export function matchBranchGlob(pattern: string, branch: string): boolean {
  let regexStr = '';
  for (const char of pattern) {
    if (char === '*') {
      regexStr += '.*';
    } else if (char === '?') {
      regexStr += '.';
    } else {
      regexStr += escapeRegexChar(char);
    }
  }
  return new RegExp(`^${regexStr}$`).test(branch);
}

function escapeRegexChar(char: string): string {
  return /[-[\]{}()*+\\^$|#]/g.test(char) ? '\\' + char : char;
}

/** Default branch names that `condash worktrees remove` must never delete. */
export const DEFAULT_LONG_LIVED_BRANCHES: readonly string[] = ['main', 'master'];

/**
 * Return whether `branch` matches any of the configured `long_lived_branches`
 * patterns. When no patterns are configured, falls back to
 * {@link DEFAULT_LONG_LIVED_BRANCHES}.
 */
export function isLongLivedBranch(
  branch: string,
  patterns: string[] | undefined,
): { longLived: boolean; matched?: string } {
  const effectivePatterns = patterns ?? [...DEFAULT_LONG_LIVED_BRANCHES];
  for (const pattern of effectivePatterns) {
    if (matchBranchGlob(pattern, branch)) {
      return { longLived: true, matched: pattern };
    }
  }
  return { longLived: false };
}
