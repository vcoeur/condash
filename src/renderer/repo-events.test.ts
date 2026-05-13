import { createStore } from 'solid-js/store';
import { describe, expect, it } from 'vitest';
import type { RepoEntry, RepoEvent } from '../shared/types';
import { applyRepoEvents } from './repo-events';

function primary(name: string, dirty: number, withWorktree = true): RepoEntry {
  const path = `/r/${name}`;
  return {
    name,
    path,
    dirty,
    missing: false,
    hasForceStop: false,
    hasRun: false,
    worktrees: withWorktree ? [{ path, branch: 'main', primary: true, dirty }] : undefined,
  } satisfies RepoEntry;
}

describe('applyRepoEvents → applyDirty', () => {
  it('patches the primary worktree when the event path is the top-level repo path', () => {
    // Regression: the card chip reads from `worktrees[*].dirty`, not from
    // `repo.dirty`. When the watcher emits a `repo-dirty` event for the
    // primary repo path, both cells must be patched — otherwise the chip
    // stays stuck at its initial value (observed after commit/push:
    // tooltip refreshes via a fresh git call, chip stays stale).
    const [repos, setRepos] = createStore<RepoEntry[]>([primary('conception', 6)]);
    const events: RepoEvent[] = [{ kind: 'repo-dirty', path: '/r/conception', dirty: 0 }];

    applyRepoEvents(events, { repos, setRepos, onWorktreesChanged: () => undefined });

    expect(repos[0].dirty).toBe(0);
    expect(repos[0].worktrees?.[0].dirty).toBe(0);
  });

  it('patches a non-primary worktree when the event path matches one', () => {
    const wtPath = '/r/condash/wt/feature';
    const [repos, setRepos] = createStore<RepoEntry[]>([
      {
        ...primary('condash', 1),
        worktrees: [
          { path: '/r/condash', branch: 'main', primary: true, dirty: 1 },
          { path: wtPath, branch: 'feature', primary: false, dirty: 4 },
        ],
      },
    ]);
    const events: RepoEvent[] = [{ kind: 'repo-dirty', path: wtPath, dirty: 0 }];

    applyRepoEvents(events, { repos, setRepos, onWorktreesChanged: () => undefined });

    expect(repos[0].dirty).toBe(1); // primary repo entry untouched
    expect(repos[0].worktrees?.[0].dirty).toBe(1); // primary worktree untouched
    expect(repos[0].worktrees?.[1].dirty).toBe(0); // the non-primary patched
  });

  it('still updates `repo.dirty` when the repo has no worktrees array (synthesised fallback)', () => {
    // `ensureWorktrees` (in panes/code-parts/data.ts) synthesises a primary
    // row from `repo.dirty` when `worktrees` is missing — so the top-level
    // write still has to happen.
    const [repos, setRepos] = createStore<RepoEntry[]>([primary('missing-repo', 3, false)]);
    const events: RepoEvent[] = [{ kind: 'repo-dirty', path: '/r/missing-repo', dirty: 0 }];

    applyRepoEvents(events, { repos, setRepos, onWorktreesChanged: () => undefined });

    expect(repos[0].dirty).toBe(0);
  });
});
