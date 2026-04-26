import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
  return out;
}
