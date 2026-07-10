/**
 * Git plumbing for `condash sync`.
 *
 * Everything here runs against the conception checkout itself (not a repo
 * worktree), under the sync lock. Reads use porcelain; writes use the normal
 * index because `sync` is the checkout's only committer — see the design note
 * on why a scratch `GIT_INDEX_FILE` is worse, not better, for this shape.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { exec } from '../exec';

/** `git add` argv is chunked so a very large sweep can't hit ARG_MAX. */
const ADD_CHUNK = 100;

export interface ChangedPath {
  /** Repo-relative, POSIX separators. */
  path: string;
  conflicted: boolean;
}

/** Error carrying git's own stderr, so callers can pattern-match on it. */
interface ExecError {
  stdout?: string;
  stderr?: string;
  message?: string;
}

/**
 * Absolute git dir for `cwd`. Not `join(root, '.git')`: in a linked worktree
 * `.git` is a *file* pointing elsewhere, and the lock must live in the real dir.
 *
 * @param cwd any path inside the repo
 */
export async function resolveGitDir(cwd: string): Promise<string> {
  const { stdout } = await exec('git', ['rev-parse', '--absolute-git-dir'], { cwd });
  return stdout.trim();
}

/**
 * Name the in-progress git operation blocking a sync, or `null` when the tree
 * is operable. Committing during a merge or rebase would either abort the
 * operation or record a half-resolved tree.
 *
 * @param gitDir absolute git dir
 */
export async function inProgressOperation(gitDir: string): Promise<string | null> {
  const probes: [string, string][] = [
    ['MERGE_HEAD', 'a merge'],
    ['CHERRY_PICK_HEAD', 'a cherry-pick'],
    ['REVERT_HEAD', 'a revert'],
    ['rebase-merge', 'a rebase'],
    ['rebase-apply', 'a rebase'],
  ];
  for (const [entry, label] of probes) {
    if (await exists(join(gitDir, entry))) return label;
  }
  return null;
}

/**
 * Every path git considers changed, including untracked files.
 *
 * `--no-renames` collapses a rename into a delete plus an untracked add, which
 * removes the paired-record parse from `-z` porcelain output. `-uall` lists
 * untracked *files* rather than their parent directory, so per-file mtime
 * filtering works. Gitignored paths never appear.
 *
 * @param cwd conception root
 */
export async function readChangedPaths(cwd: string): Promise<ChangedPath[]> {
  const { stdout } = await exec(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    { cwd },
  );
  const out: ChangedPath[] = [];
  for (const entry of stdout.split('\0')) {
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    out.push({ path: entry.slice(3), conflicted: isConflict(x, y) });
  }
  return out;
}

/** Porcelain v1 conflict codes: either side unmerged, or both-added/both-deleted. */
function isConflict(x: string, y: string): boolean {
  return x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
}

/**
 * Stage and commit exactly `paths`, leaving any foreign staged content staged.
 *
 * `git add -A` first because `git commit --only` refuses a pathspec that
 * matches nothing git knows about (i.e. an untracked file). `--only` then
 * commits those paths alone, disregarding whatever else sits in the index —
 * the property that keeps a stray session `git add` out of this commit.
 *
 * @param cwd conception root
 * @param paths repo-relative paths, non-empty
 * @param subject commit subject line
 * @returns the new commit sha, or `null` when git found nothing to record
 */
export async function commitPaths(
  cwd: string,
  paths: readonly string[],
  subject: string,
): Promise<string | null> {
  if (paths.length === 0) return null;

  for (let i = 0; i < paths.length; i += ADD_CHUNK) {
    await exec('git', ['add', '-A', '--', ...paths.slice(i, i + ADD_CHUNK)], { cwd });
  }

  try {
    await exec('git', ['commit', '--only', '--message', subject, '--', ...paths], { cwd });
  } catch (err) {
    const combined = `${(err as ExecError).stdout ?? ''}${(err as ExecError).stderr ?? ''}`;
    if (/nothing to commit|no changes added to commit/i.test(combined)) return null;
    throw err;
  }

  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd });
  return stdout.trim();
}

/**
 * Commits on HEAD that the upstream branch doesn't have.
 *
 * @param cwd conception root
 * @returns the count, or `null` when the branch has no upstream configured
 */
export async function upstreamAhead(cwd: string): Promise<number | null> {
  try {
    const { stdout } = await exec('git', ['rev-list', '--count', '@{upstream}..HEAD'], { cwd });
    const count = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

/**
 * Push HEAD to its upstream. Never rebases or force-pushes: a rejected push is
 * reported and the commits stay local for the next tick to retry.
 *
 * @param cwd conception root
 */
export async function push(cwd: string): Promise<void> {
  await exec('git', ['push'], { cwd });
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}
