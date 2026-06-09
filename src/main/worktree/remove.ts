/**
 * `remove` mutator — tears down per-repo worktrees for a branch, protecting
 * repos still claimed by other active items declaring the same branch.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { exec } from '../exec';
import { pathExists } from '../fs-helpers';
import {
  branchToDir,
  defaultWorktreesPath,
  findItemsDeclaringBranch,
  findWorktreeEntry,
  listWorktreeEntries,
  readConfig,
  repoLookupMap,
  resolveAppRepo,
  validateBranchName,
} from './shared';

export interface RemoveOptions {
  /** Optional explicit repo allow-list. */
  repos?: string[];
  /**
   * Pass `--force` to `git worktree remove`. Without this, git refuses any
   * worktree with modified or untracked files.
   */
  force?: boolean;
  /**
   * Implies `force`. After git deregisters the worktree, if the directory
   * still has files (typically rebuildable artifacts like `node_modules` or
   * build output blocking git's own rm), `fs.rm` it recursively. The repo is
   * then reported under `removed[]`.
   */
  forceRm?: boolean;
}

export interface RemoveResult {
  branch: string;
  /** Repos whose worktree we removed. */
  removed: { repo: string; path: string }[];
  /** Repos kept because another active item still claims them on this branch,
   *  or because `git worktree remove` failed *without* deregistering the
   *  worktree (registry still consistent with disk — caller can retry). */
  protected: { repo: string; reason: string }[];
  /** Repos whose git registry entry was removed but whose on-disk directory
   *  still has files. Caller decides whether to `rm -rf` (e.g. via
   *  `--force-rm`), resume manual cleanup, or leave the orphan for
   *  `worktrees check`. */
  partiallyRemoved: { repo: string; path: string; reason: string }[];
  /** Repos that had no worktree at this branch in the first place. */
  notPresent: string[];
  /** Directories at the expected worktree path that are NOT registered
   *  worktrees of the repo (manual clone, leftover from an earlier partial
   *  remove). Never deleted — even under `--force-rm` — because they may
   *  hold unpushed work git knows nothing about. `worktrees check` reports
   *  the same dirs under its orphan vocabulary. */
  orphaned: { repo: string; path: string; reason: string }[];
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
  const branchDir = branchToDir(branch);
  const reposByName = repoLookupMap(config);
  const force = options.force === true || options.forceRm === true;
  const forceRm = options.forceRm === true;

  // Resolve target repos: explicit list, or the union of Apps across items
  // declaring the branch. Then remove the protected set (repos still claimed
  // by *other active* items so we don't yank a worktree out from under them).
  // Resolve every token to its canonical repo directory name so a `#vcoeur`
  // handle and a literal `--repo vcoeur.com` both target the same worktree.
  const explicit = options.repos !== undefined && options.repos.length > 0;
  const declaringItems = await findItemsDeclaringBranch(conceptionPath, branch);
  const requested = explicit
    ? new Set(options.repos!.map((token) => resolveAppRepo(token, reposByName)?.name ?? token))
    : new Set(
        declaringItems
          .flatMap((i) => i.apps)
          .map((app) => resolveAppRepo(app, reposByName)?.name)
          .filter((name): name is string => Boolean(name)),
      );
  const protectedSet = new Set<string>();
  const protectedReasons = new Map<string, string>();
  if (explicit) {
    // Explicit mode: protect repos claimed by active items *that were not in
    // the override*. The skill is responsible for excluding the *closing*
    // item from `requested` so its repos are eligible for removal.
    for (const item of declaringItems) {
      if (item.status === 'done') continue;
      for (const app of item.apps) {
        const repo = resolveAppRepo(app, reposByName)?.name;
        if (repo && !requested.has(repo)) {
          protectedSet.add(repo);
          protectedReasons.set(repo, 'still claimed by another active item');
        }
      }
    }
  } else {
    // Implicit mode: `requested` is the union of every declaring item's
    // repos, so the explicit-mode rule above would be vacuously empty.
    // Protect a repo claimed by MORE THAN ONE active (now/review) item —
    // removing it on behalf of one item would yank the worktree out from
    // under the other. A repo claimed by a single active item is the user's
    // clear removal target and stays eligible.
    const activeClaims = new Map<string, number>();
    for (const item of declaringItems) {
      if (item.status !== 'now' && item.status !== 'review') continue;
      const repos = new Set(
        item.apps
          .map((app) => resolveAppRepo(app, reposByName)?.name)
          .filter((name): name is string => Boolean(name)),
      );
      for (const repo of repos) activeClaims.set(repo, (activeClaims.get(repo) ?? 0) + 1);
    }
    for (const [repo, claims] of activeClaims) {
      if (claims >= 2) {
        protectedSet.add(repo);
        protectedReasons.set(
          repo,
          `claimed by ${claims} active items on this branch — pass --repo to override`,
        );
      }
    }
  }

  const result: RemoveResult = {
    branch,
    removed: [],
    protected: [],
    partiallyRemoved: [],
    notPresent: [],
    orphaned: [],
    parentRemoved: false,
  };

  for (const name of [...requested].sort()) {
    if (protectedSet.has(name)) {
      result.protected.push({
        repo: name,
        reason: protectedReasons.get(name) ?? 'still claimed by another active item',
      });
      continue;
    }
    const lookup = reposByName.get(name);
    if (!lookup) {
      result.notPresent.push(name);
      continue;
    }
    const target = join(worktreesRoot, branchDir, name);
    if (!(await pathExists(target))) {
      result.notPresent.push(name);
      continue;
    }
    // Snapshot the registry BEFORE attempting removal. Two guards hang off
    // this snapshot:
    //   1. A directory at the expected path that is NOT a registered
    //      worktree (manual clone, leftover) must never enter the force-rm
    //      path — `rm -rf` would erase work git knows nothing about.
    //   2. `branchToDir` flattens slashes, so `foo/bar` and `foo-bar` share
    //      a directory key. The registered entry must actually be on OUR
    //      branch; otherwise we'd remove the other branch's worktree.
    const snapshot = await listWorktreeEntries(lookup.cwd);
    if (snapshot === null) {
      // Can't query the registry — refuse rather than guess.
      result.protected.push({
        repo: name,
        reason: `could not query \`git worktree list\` in ${lookup.cwd} — refusing to remove`,
      });
      continue;
    }
    const registered = await findWorktreeEntry(snapshot, target);
    if (!registered) {
      result.orphaned.push({
        repo: name,
        path: target,
        reason: `directory exists but is not a registered worktree of ${lookup.cwd} — not removing (see \`worktrees check ${branch}\`)`,
      });
      continue;
    }
    if (registered.branch !== branch) {
      result.protected.push({
        repo: name,
        reason: `worktree at ${target} is on branch '${registered.branch ?? '(detached)'}', not '${branch}' (flattened-path collision) — not removing`,
      });
      continue;
    }
    const args = force ? ['worktree', 'remove', '--force', target] : ['worktree', 'remove', target];
    try {
      await exec('git', args, { cwd: lookup.cwd });
      result.removed.push({ repo: name, path: target });
    } catch (err) {
      const reason = `git worktree remove failed: ${err instanceof Error ? err.message : String(err)}`;
      // Disambiguate: did git deregister the worktree before failing on the
      // rm step (partial remove — disk dirty, registry clean), or did it
      // refuse outright (genuinely protected)? `--force` removes the registry
      // entry first, then tries to delete the dir; a failure on the second
      // half leaves the registry-vs-disk inconsistency users hit. The
      // pre-removal snapshot above already proved the target WAS a
      // registered worktree on this branch, so the force-rm path below can
      // only fire on that partial-remove state.
      const stillRegistered = await isStillRegistered(lookup.cwd, target);
      if (stillRegistered) {
        result.protected.push({ repo: name, reason });
        continue;
      }
      if (forceRm && (await pathExists(target))) {
        try {
          await rmrfWithChmodFallback(target);
          result.removed.push({ repo: name, path: target });
          continue;
        } catch (rmErr) {
          result.partiallyRemoved.push({
            repo: name,
            path: target,
            reason: `${reason}; --force-rm cleanup also failed: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`,
          });
          continue;
        }
      }
      result.partiallyRemoved.push({ repo: name, path: target, reason });
    }
  }

  // If the parent dir is now empty, rmdir it. We only ever rmdir
  // `<worktreesRoot>/<branchDir>` — slashes in branch names are flattened
  // (#168) so this is always one level below `worktreesRoot`, and a realpath
  // check below ensures we don't follow a symlink out of the worktrees root
  // onto an unrelated directory. Issue #84 reported a sibling branch dir
  // vanishing after `worktrees remove`; the path check makes that impossible
  // by construction.
  const branchRoot = join(worktreesRoot, branchDir);
  try {
    const expected = await fs.realpath(branchRoot).catch(() => branchRoot);
    const expectedParent = await fs.realpath(worktreesRoot).catch(() => worktreesRoot);
    const expectedChild = join(expectedParent, branchDir);
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

/**
 * `fs.rm(target, { recursive: true, force: true })`, with a chmod-walk
 * fallback on EACCES / EPERM. Node's `force: true` only swallows ENOENT —
 * read-only files and read-only parent dirs still throw. The common
 * `--force-rm` use case is rebuildable artifacts (`node_modules`, build
 * output) that are usually writable, but stray read-only files do happen
 * (npm caches, vendored dependencies); making the flag pay off when it
 * matters is worth the second pass.
 */
async function rmrfWithChmodFallback(target: string): Promise<void> {
  try {
    await fs.rm(target, { recursive: true, force: true });
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') throw err;
  }
  await chmodWritableRecursive(target);
  await fs.rm(target, { recursive: true, force: true });
}

async function chmodWritableRecursive(target: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  // u+rwx on dirs (need x to traverse), u+rw on files. We only fix the owner
  // bits — anything else is the caller's problem and we shouldn't be silently
  // promoting visibility.
  await fs
    .chmod(target, stat.isDirectory() ? 0o700 | (stat.mode & 0o077) : 0o600 | (stat.mode & 0o077))
    .catch(() => {});
  if (stat.isDirectory()) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(target, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      await chmodWritableRecursive(join(target, entry.name));
    }
  }
}

/**
 * True if `git worktree list --porcelain` (run in `cwd`) still lists the
 * worktree at `target`. Used after a failed `git worktree remove` to tell
 * "git refused" (registry intact) from "git deregistered then failed on rm"
 * (partial remove).
 */
async function isStillRegistered(cwd: string, target: string): Promise<boolean> {
  let stdout: string;
  try {
    ({ stdout } = await exec('git', ['worktree', 'list', '--porcelain'], { cwd }));
  } catch {
    // If we can't query the registry, default to the safer assumption: the
    // failure was a plain refusal and the caller should retry rather than
    // see a phantom partial-removed entry.
    return true;
  }
  const targetReal = await fs.realpath(target).catch(() => target);
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const path = line.slice('worktree '.length).trim();
    if (path === target) return true;
    const real = await fs.realpath(path).catch(() => path);
    if (real === targetReal) return true;
  }
  return false;
}
