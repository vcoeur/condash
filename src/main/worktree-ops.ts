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
  /** Explicit base branch override; takes precedence over README `**Base**`. */
  base?: string;
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
  /** Base ref new branches were created from (null when no base was resolved
   *  and the repo's default tip was used). */
  base: string | null;
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
  validateBranchName(branch);
  const config = await readConfig(conceptionPath);
  const worktreesRoot = config.worktrees_path ?? defaultWorktreesPath();
  const reposByName = repoLookupMap(config);
  const wanted = await resolveTargetRepos(conceptionPath, branch, options.repos, reposByName);

  // Resolve the base ref: explicit --base wins; otherwise read **Base** from
  // every item declaring this branch and require unanimity. Disagreement is a
  // hard error — silently picking one would mask the misconfiguration.
  const declaring = await findItemsDeclaringBranch(conceptionPath, branch);
  const base = resolveBase(branch, options.base, declaring);

  const result: SetupResult = {
    branch,
    created: [],
    alreadyPresent: [],
    blocked: [],
    envCopied: [],
    installRan: [],
    base: base ?? null,
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
    if (!branchOk && base) {
      // New branch + base specified: the base must exist as a ref in this
      // repo. Fail loudly rather than fall back to the repo default — that's
      // exactly the silent-wrong-base behaviour issue #81 is about.
      if (!(await refExists(lookup.cwd, base))) {
        result.blocked.push({
          repo: name,
          reason: `base ref '${base}' not found in ${lookup.cwd} — run \`git fetch\` or create it locally first`,
        });
        continue;
      }
    }
    try {
      const args = ['worktree', 'add'];
      if (!branchOk) args.push('-b', branch);
      args.push(target);
      if (branchOk) args.push(branch);
      else if (base) args.push(base);
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

/**
 * Pick the base ref. Explicit `--base` wins. Otherwise collect every distinct
 * `**Base**` value across declaring items: 0 → null (current behaviour), 1 →
 * use it, ≥2 → throw with the disagreeing items so the user can reconcile.
 */
function resolveBase(
  branch: string,
  explicit: string | undefined,
  items: { slug: string; base: string | null }[],
): string | undefined {
  if (explicit) return explicit;
  const byBase = new Map<string, string[]>();
  for (const item of items) {
    if (!item.base) continue;
    const list = byBase.get(item.base) ?? [];
    list.push(item.slug);
    byBase.set(item.base, list);
  }
  if (byBase.size === 0) return undefined;
  if (byBase.size === 1) return [...byBase.keys()][0];
  const summary = [...byBase.entries()]
    .map(([base, slugs]) => `${base} (${slugs.join(', ')})`)
    .join('; ');
  throw new Error(
    `Items declaring branch '${branch}' disagree on **Base**: ${summary}. ` +
      `Reconcile the headers or pass --base explicitly.`,
  );
}

// ---------------------------------------------------------------------------
// Remove.
// ---------------------------------------------------------------------------

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

/**
 * Hard-reject branch names that could let `join(worktreesRoot, branch)`
 * escape the worktrees root. Git itself accepts a wide range of names; what
 * we care about here is that the result of `join(root, branch)` always lands
 * exactly one directory below `root`. Path separators, `..`, and NUL are the
 * only ways to break that invariant on POSIX.
 */
function validateBranchName(branch: string): void {
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
async function refExists(repo: string, ref: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repo });
    return true;
  } catch {
    return false;
  }
}
