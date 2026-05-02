/**
 * Apply per-repo FS-watcher events to the repos store. Mirror of
 * `tree-events.ts` but for the Code tab. Path-shaped `setRepos` writes
 * mean only the cells actually read by a component re-evaluate — the
 * top-level array reference and unaffected rows stay stable, so
 * whole-list readers (e.g. `repoGroups`) don't re-run on a single
 * dirty tick.
 */
import type { RepoEntry, RepoEvent, UpstreamStatus } from '@shared/types';
import type { SetStoreFunction } from 'solid-js/store';

export interface RepoEventsDeps {
  /** Current store proxy — read-only for the caller. Used to look up
   *  indices and skip writes when the value would not change. */
  repos: readonly RepoEntry[];
  /** Path-shaped store setter. */
  setRepos: SetStoreFunction<RepoEntry[]>;
}

/** Shallow equality for `UpstreamStatus` so we can short-circuit when the
 *  recompute returns the same value (very common — most ticks fire from
 *  worktree edits that don't change upstream). */
function sameUpstream(a: UpstreamStatus | null | undefined, b: UpstreamStatus | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a.ahead === b.ahead && a.upstreamRef === b.upstreamRef;
}

export function applyRepoEvents(events: RepoEvent[], deps: RepoEventsDeps): void {
  if (events.length === 0) return;
  const { repos, setRepos } = deps;

  for (const event of events) {
    if (event.kind === 'repo-dirty') {
      applyDirty(repos, setRepos, event.path, event.dirty);
    } else if (event.kind === 'repo-upstream') {
      applyUpstream(repos, setRepos, event.path, event.upstream);
    }
  }
}

function applyDirty(
  repos: readonly RepoEntry[],
  setRepos: SetStoreFunction<RepoEntry[]>,
  path: string,
  dirty: number | null,
): void {
  // Top-level repo path?
  const ri = repos.findIndex((r) => r.path === path);
  if (ri >= 0) {
    if (repos[ri].dirty !== dirty) setRepos(ri, 'dirty', dirty);
    return;
  }
  // Otherwise look for a worktree match. Linear scan is fine — repos.length
  // is single-digit-to-low-double-digits in practice.
  for (let i = 0; i < repos.length; i++) {
    const wts = repos[i].worktrees;
    if (!wts) continue;
    const wi = wts.findIndex((w) => w.path === path);
    if (wi < 0) continue;
    if (wts[wi].dirty !== dirty) setRepos(i, 'worktrees', wi, 'dirty', dirty);
    return;
  }
}

function applyUpstream(
  repos: readonly RepoEntry[],
  setRepos: SetStoreFunction<RepoEntry[]>,
  path: string,
  upstream: UpstreamStatus | null,
): void {
  for (let i = 0; i < repos.length; i++) {
    const wts = repos[i].worktrees;
    if (!wts) continue;
    const wi = wts.findIndex((w) => w.path === path);
    if (wi < 0) continue;
    if (!sameUpstream(wts[wi].upstream, upstream)) {
      setRepos(i, 'worktrees', wi, 'upstream', upstream);
    }
    return;
  }
}
