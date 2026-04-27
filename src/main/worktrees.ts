import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { simpleGit } from 'simple-git';
import type { Worktree } from '../shared/types';

const exec = promisify(execFile);

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
 * the Code-tab UI can show "main CLEAN" alongside "parity-batch-5 74 dirty"
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
      current.path = line.slice('worktree '.length);
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

  // Fan out a per-worktree git status. We swallow individual failures so a
  // single broken worktree doesn't blank out the whole list.
  await Promise.all(
    out.map(async (wt) => {
      try {
        const status = await simpleGit({ baseDir: wt.path }).status();
        wt.dirty = status.files.length;
      } catch {
        wt.dirty = null;
      }
    }),
  );
  return out;
}
