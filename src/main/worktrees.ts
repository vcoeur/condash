import { exec } from './exec';
import { getDirtyCount, getUpstreamStatus } from './git-status-cache';
import { toPosix } from '../shared/path';
import type { Worktree } from '../shared/types';

/**
 * Current branch for a checkout, or null when HEAD is genuinely detached
 * (or the path is not inside a git repo). Used for sub-repos and other
 * checkouts that aren't queried via `git worktree list`.
 */
export async function getCurrentBranch(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: repoPath,
    });
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Probe whether `repoPath` is inside a git repository.
 * Returns false when the path doesn't exist or isn't a git repo.
 */
export async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--git-dir'], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

/**
 * `git worktree list --porcelain` parser. Returns an empty list when the path
 * is not a git repository. Each worktree block looks like:
 *
 *   worktree /abs/path
 *   HEAD <sha>
 *   branch refs/heads/<name>
 *   (or `detached`)
 *
 * blocks are separated by blank lines.
 *
 * Per-worktree dirty counts are filled in via a fan-out `git status` call so
 * the Code-pane UI can show "main CLEAN" alongside "parity-batch-5 74 dirty"
 * without the user clicking through each branch.
 */
export async function listWorktrees(repoPath: string): Promise<Worktree[]> {
  let stdout = '';
  try {
    const result = await exec('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
      maxBuffer: 1024 * 1024,
    });
    stdout = result.stdout;
  } catch {
    return [];
  }

  const out: Worktree[] = [];
  let current: Partial<Worktree> = {};
  for (const line of stdout.split('\n')) {
    if (line.length === 0) {
      if (current.path) {
        out.push({
          path: current.path,
          branch: current.branch ?? null,
          primary: out.length === 0,
        });
      }
      current = {};
      continue;
    }
    if (line.startsWith('worktree ')) {
      // git porcelain reports POSIX `/` even on Windows. Keep that shape
      // throughout: cache keys (`getDirtyCount` / `getUpstreamStatus`),
      // watcher keys, and the IPC boundary all need to agree, otherwise
      // a Windows checkout silently doubles every cache entry. Anywhere
      // we touch the local filesystem, `path.join`/`path.resolve` accept
      // mixed separators on Windows.
      current.path = toPosix(line.slice('worktree '.length));
    } else if (line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line === 'detached') {
      current.branch = null;
    }
  }
  if (current.path) {
    out.push({
      path: current.path,
      branch: current.branch ?? null,
      primary: out.length === 0,
    });
  }

  // Fan out per-worktree dirty + upstream lookups through the shared
  // caches, so rapid re-renders (Refresh button + chokidar tree-event +
  // tab switch) don't each fire ~30 git invocations.
  await Promise.all(
    out.map(async (wt) => {
      const [dirty, upstream] = await Promise.all([
        getDirtyCount(wt.path),
        getUpstreamStatus(wt.path),
      ]);
      wt.dirty = dirty;
      wt.upstream = upstream;
    }),
  );
  return out;
}
