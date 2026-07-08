// "Pull branch" action behind the Code-pane per-branch actions menu.
//
// Runs `git pull --ff-only` in a worktree's working directory, but refuses
// when the tree is dirty — committing or stashing is the user's call, not
// ours. The fast-forward-only flag means a diverged branch is reported, never
// force-merged: issue #337's "don't silently swallow a non-ff failure".
//
// Output classification is split into two pure helpers so the updated /
// up-to-date / diverged decision is unit-tested without a live git (mirrors
// the parsePorcelain / parseNumstat split in git-details.ts).

import type { PullBranchResult } from '../shared/types';
import { getDirtyCount } from './git-status-cache';

/** Classify a *successful* `git pull --ff-only` stdout. Git prints "Already
 *  up to date." when there was nothing to apply; any other output means
 *  commits were fast-forwarded in. Pure; exported for tests. */
export function classifyPullSuccess(stdout: string): PullBranchResult {
  if (/already up[ -]to[ -]date/i.test(stdout)) {
    return { status: 'up-to-date', message: 'Already up to date' };
  }
  const range = stdout.match(/Updating\s+([0-9a-f]+\.\.[0-9a-f]+)/i);
  return {
    status: 'updated',
    message: range ? `Fast-forwarded (${range[1]})` : 'Fast-forwarded to upstream',
  };
}

/** Map a *failed* `git pull --ff-only` error message to a result, or null
 *  when the failure isn't a recognised non-fast-forward and should bubble up
 *  as a thrown error (no upstream configured, network down, not a repo).
 *  Pure; exported for tests. */
export function classifyPullFailure(message: string): PullBranchResult | null {
  if (/not possible to fast-forward|non-fast-forward|diverg/i.test(message)) {
    return {
      status: 'diverged',
      message: 'Branch has diverged from upstream — fast-forward not possible',
    };
  }
  return null;
}

/**
 * Fast-forward a worktree to its upstream. Returns a `dirty` result (no git
 * run) when the working tree has uncommitted changes; otherwise runs
 * `git pull --ff-only` and classifies the outcome. Throws on an unexpected
 * git failure the user can't resolve from the card (no upstream configured,
 * network failure, path not a repo) so the renderer surfaces it as an error.
 *
 * @param path Absolute path to the worktree working directory.
 * @returns The classified pull outcome.
 */
export async function pullBranch(path: string): Promise<PullBranchResult> {
  const dirty = await getDirtyCount(path);
  if (dirty && dirty > 0) {
    return {
      status: 'dirty',
      message: `Worktree has ${dirty} uncommitted change${dirty === 1 ? '' : 's'} — commit or stash before pulling`,
    };
  }
  // Lazy so importing this module (reachable on the pre-window boot path via
  // `ipc/repos`) doesn't pull simple-git's graph before first paint — it loads
  // only on this post-window "Pull branch" action.
  const { simpleGit } = await import('simple-git');
  const git = simpleGit({ baseDir: path });
  try {
    const stdout = await git.raw(['pull', '--ff-only']);
    return classifyPullSuccess(stdout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const classified = classifyPullFailure(message);
    if (classified) return classified;
    throw new Error(firstLine(message) || 'git pull failed');
  }
}

/** First non-empty line of a multi-line error, trimmed — keeps a thrown
 *  message toast-sized. */
function firstLine(message: string): string {
  for (const line of message.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}
