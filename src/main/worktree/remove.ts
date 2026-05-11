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
  const force = options.force === true || options.forceRm === true;
  const forceRm = options.forceRm === true;

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
    partiallyRemoved: [],
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
      // half leaves the registry-vs-disk inconsistency users hit.
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
