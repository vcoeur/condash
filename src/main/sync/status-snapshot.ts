/**
 * Lightweight sync snapshot of the conception checkout for the status-bar
 * auto-sync indicator: the uncommitted-file count, the unpushed-commit count,
 * and the most recent commits (each marked pushed/unpushed).
 *
 * This is read-only observation, disjoint from the sweeper (`run.ts`) — it
 * never takes the sync lock and never mutates the tree. Every git failure
 * degrades to a zero/empty field rather than throwing, so a transient git
 * hiccup can never break the status bar.
 */
import { getDirtyCount, getUpstreamStatus } from '../git-status-cache';
import type { SyncCommit, SyncStatusSnapshot } from '../../shared/types';

/** How many recent commits the popover shows. */
const RECENT_LIMIT = 12;
/** Field separator inside the `git log --pretty` format — a control char that
 *  can't appear in a commit subject, so the split is unambiguous. */
export const LOG_FIELD_SEP = '\x1f';
/** The `--pretty` format that {@link parseRecentCommits} consumes. */
export const LOG_PRETTY = `%h${LOG_FIELD_SEP}%s${LOG_FIELD_SEP}%cr`;

/**
 * Parse `git log --pretty=<LOG_PRETTY>` output into commits, marking the newest
 * `ahead` commits as unpushed. git log is newest-first and `@{u}..HEAD` is
 * exactly its leading slice, so the first `ahead` rows are the unpushed ones.
 * Pure; exported for unit testing.
 */
export function parseRecentCommits(out: string, ahead: number): SyncCommit[] {
  const lines = out.split('\n').filter((line) => line.length > 0);
  return lines.map((line, index) => {
    const parts = line.split(LOG_FIELD_SEP);
    return {
      sha: parts[0] ?? line,
      subject: parts[1] ?? '',
      relativeTime: parts[2] ?? '',
      pushed: index >= ahead,
    };
  });
}

/**
 * Read the sync snapshot for `conceptionPath`. Runs the dirty-count and
 * upstream lookups (both TTL-cached, shared with the Code pane) in parallel,
 * then a single `git log` for the recent commits.
 */
export async function getSyncStatusSnapshot(conceptionPath: string): Promise<SyncStatusSnapshot> {
  const [pendingCount, upstream] = await Promise.all([
    getDirtyCount(conceptionPath),
    getUpstreamStatus(conceptionPath),
  ]);
  const ahead = upstream?.ahead ?? 0;
  return {
    pendingCount: pendingCount ?? 0,
    ahead,
    hasUpstream: upstream !== null,
    recentCommits: await readRecentCommits(conceptionPath, ahead),
  };
}

async function readRecentCommits(path: string, ahead: number): Promise<SyncCommit[]> {
  try {
    // Lazy import so this module stays off simple-git's graph until first read
    // (mirrors git-status-cache / git-details).
    const { simpleGit } = await import('simple-git');
    const git = simpleGit({ baseDir: path });
    const out = await git.raw(['log', `--max-count=${RECENT_LIMIT}`, `--pretty=${LOG_PRETTY}`]);
    return parseRecentCommits(out, ahead);
  } catch {
    return [];
  }
}
