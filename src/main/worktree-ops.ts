/**
 * Worktree mutators (setup / remove) and a per-branch state inspector.
 *
 * Both mutators are multi-app aware: the canonical input is a branch name,
 * the union of `**Apps**` across items declaring that branch defines which
 * repos get a worktree. Pinned repos (those carrying `pinned_branch:` in
 * `configuration.json`) are excluded from setup since they track a different
 * axis. Removal is protected-set aware: repos still claimed by *other* active
 * items on the same branch keep their worktree.
 *
 * The mutators do not delete local branches — that stays in skill prose
 * because the safety-net is "interactive `git branch -d` refuse must surface
 * to the user". Removal of the *worktree* is in scope; removal of the local
 * branch is not.
 */

import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { findProjectReadmes } from './walk';
import { readHeader } from './header-fs';
import { walkRepos, type ConfigShape } from './config-walk';

const exec = promisify(execFile);

interface ConfigWithPaths extends ConfigShape {
  worktrees_path?: string;
}

interface RawRepoExtended {
  name: string;
  pinned_branch?: string;
  install?: string;
  submodules?: { name: string }[];
}

export interface BranchRepoState {
  /** Repo name (matches the canonical key under configuration.json `repositories`). */
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
  /** Worktrees root from configuration.json. */
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

export interface SetupOptions {
  /** Optional explicit repo allow-list (overrides Apps-derivation). */
  repos?: string[];
  /** Copy `.env` / `.env.local` from the primary into the new worktree. */
  copyEnv?: boolean;
  /** Run the optional `install:` from configuration.json after creation. */
  install?: boolean;
}

export interface SetupResult {
  branch: string;
  /** Repos we actually created worktrees for (skipping ones that already existed). */
  created: { repo: string; path: string }[];
  /** Repos we skipped because the worktree already existed. */
  alreadyPresent: { repo: string; path: string }[];
  /** Repos we couldn't set up — primary checkout already on the branch, etc. */
  blocked: { repo: string; reason: string }[];
  /** `.env` files copied (relative to the worktree root). */
  envCopied: { repo: string; files: string[] }[];
  /** Install commands run. */
  installRan: { repo: string; command: string; ok: boolean }[];
}

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

// ---------------------------------------------------------------------------
// Inspector.
// ---------------------------------------------------------------------------

export async function checkBranchState(
  conceptionPath: string,
  branch: string,
): Promise<BranchCheckResult> {
  const config = await readConfig(conceptionPath);
  const worktreesRoot = config.worktrees_path ?? defaultWorktreesPath();
  const declaringItems = await findItemsDeclaringBranch(conceptionPath, branch);

  // Union of Apps from declaring items (active items only — done items don't
  // need worktrees but still surface their previous claims so the user can
  // see them).
  const wantedRepos = new Set<string>();
  for (const item of declaringItems) {
    for (const app of item.apps) wantedRepos.add(rootRepoFromApp(app));
  }
  const reposByName = repoLookupMap(config);

  const repos: BranchRepoState[] = [];
  for (const name of [...wantedRepos].sort()) {
    const lookup = reposByName.get(name);
    if (!lookup) continue;
    const expectedWorktree = join(worktreesRoot, branch, name);
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
  const branchRoot = join(worktreesRoot, branch);
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

// ---------------------------------------------------------------------------
// Setup.
// ---------------------------------------------------------------------------

export async function setupBranchWorktrees(
  conceptionPath: string,
  branch: string,
  options: SetupOptions = {},
): Promise<SetupResult> {
  const config = await readConfig(conceptionPath);
  const worktreesRoot = config.worktrees_path ?? defaultWorktreesPath();
  const reposByName = repoLookupMap(config);
  const wanted = await resolveTargetRepos(conceptionPath, branch, options.repos, reposByName);

  const result: SetupResult = {
    branch,
    created: [],
    alreadyPresent: [],
    blocked: [],
    envCopied: [],
    installRan: [],
  };

  await fs.mkdir(join(worktreesRoot, branch), { recursive: true });

  for (const name of wanted) {
    const lookup = reposByName.get(name);
    if (!lookup) {
      result.blocked.push({ repo: name, reason: `not configured in configuration.json` });
      continue;
    }
    if (lookup.pinnedBranch) {
      result.blocked.push({
        repo: name,
        reason: `pinned to '${lookup.pinnedBranch}' (skipped per pinned_branch:)`,
      });
      continue;
    }
    const target = join(worktreesRoot, branch, name);
    if (await pathExists(target)) {
      result.alreadyPresent.push({ repo: name, path: target });
      continue;
    }
    const primaryBranch = await currentBranch(lookup.cwd);
    if (primaryBranch === branch) {
      result.blocked.push({
        repo: name,
        reason: `primary checkout at ${lookup.cwd} is currently on '${branch}' — switch it first`,
      });
      continue;
    }
    const branchOk = await branchExists(lookup.cwd, branch);
    try {
      const args = ['worktree', 'add'];
      if (!branchOk) args.push('-b', branch);
      args.push(target);
      if (branchOk) args.push(branch);
      await exec('git', args, { cwd: lookup.cwd });
      result.created.push({ repo: name, path: target });
    } catch (err) {
      result.blocked.push({
        repo: name,
        reason: `git worktree add failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if (options.copyEnv) {
      const copied = await copyEnvFiles(lookup.cwd, target);
      if (copied.length > 0) result.envCopied.push({ repo: name, files: copied });
    }
    if (options.install && lookup.install) {
      const ok = await runInstall(target, lookup.install);
      result.installRan.push({ repo: name, command: lookup.install, ok });
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Remove.
// ---------------------------------------------------------------------------

export async function removeBranchWorktrees(
  conceptionPath: string,
  branch: string,
  options: RemoveOptions = {},
): Promise<RemoveResult> {
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

  // If the parent dir is now empty, rmdir it.
  const branchRoot = join(worktreesRoot, branch);
  try {
    const remaining = await fs.readdir(branchRoot);
    if (remaining.length === 0) {
      await fs.rmdir(branchRoot);
      result.parentRemoved = true;
    }
  } catch {
    // ENOENT after the per-repo removals is fine.
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

interface RepoLookupExtended {
  name: string;
  cwd: string;
  install?: string;
  pinnedBranch?: string;
}

function repoLookupMap(config: ConfigWithPaths): Map<string, RepoLookupExtended> {
  const map = new Map<string, RepoLookupExtended>();
  walkRepos(config, (entry) => {
    if (entry.parent) return; // ignore submodules — worktrees are per top-level repo
    map.set(entry.name, { name: entry.name, cwd: entry.cwd });
  });
  // Re-walk the raw config to pick up `pinned_branch` and `install` (those
  // aren't currently in the RepoLookup shape).
  const primary = config.repositories?.primary ?? [];
  const secondary = config.repositories?.secondary ?? [];
  for (const raw of [...primary, ...secondary]) {
    if (typeof raw === 'string') continue;
    const lookup = map.get(raw.name);
    if (!lookup) continue;
    const ext = raw as unknown as RawRepoExtended;
    if (typeof ext.pinned_branch === 'string') lookup.pinnedBranch = ext.pinned_branch;
    if (typeof ext.install === 'string') lookup.install = ext.install;
  }
  return map;
}

async function resolveTargetRepos(
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

async function findItemsDeclaringBranch(
  conceptionPath: string,
  branch: string,
): Promise<{ slug: string; readme: string; status: string; apps: string[] }[]> {
  const out: { slug: string; readme: string; status: string; apps: string[] }[] = [];
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
    });
  }
  return out;
}

function rootRepoFromApp(app: string): string {
  // Apps may be `condash`, `vcoeur.com`, or `condash/frontend`. The worktree
  // is always at the top-level repo, so strip the inner path.
  return app.split('/')[0];
}

async function copyEnvFiles(source: string, target: string): Promise<string[]> {
  const out: string[] = [];
  for (const candidate of ['.env', '.env.local']) {
    const src = join(source, candidate);
    if (!(await pathExists(src))) continue;
    try {
      await fs.copyFile(src, join(target, candidate));
      out.push(candidate);
    } catch {
      // best-effort
    }
  }
  return out;
}

async function runInstall(cwd: string, command: string): Promise<boolean> {
  try {
    await exec(process.platform === 'win32' ? 'cmd.exe' : 'sh', shellArgs(command), {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

function shellArgs(command: string): string[] {
  if (process.platform === 'win32') return ['/d', '/s', '/c', command];
  return ['-lc', command];
}

async function readConfig(conceptionPath: string): Promise<ConfigWithPaths> {
  const path = join(conceptionPath, 'configuration.json');
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw) as ConfigWithPaths;
  } catch {
    return {};
  }
}

function defaultWorktreesPath(): string {
  return join(process.env.HOME ?? '', 'src', 'worktrees');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function currentBranch(repo: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: repo,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: repo,
    });
    return true;
  } catch {
    return false;
  }
}
