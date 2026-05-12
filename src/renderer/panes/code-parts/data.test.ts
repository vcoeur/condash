import { describe, expect, it } from 'vitest';
import type { RepoEntry, Worktree } from '../../../shared/types';
import { collectFilterableBranches, filterWorktrees } from './data';

function wt(branch: string | null, primary = false): Worktree {
  return {
    path: branch ? `/r/wt/${branch}` : '/r/wt/detached',
    branch,
    primary,
    dirty: 0,
  };
}

function repo(name: string, worktrees: Worktree[]): RepoEntry {
  return {
    name,
    path: `/r/${name}`,
    dirty: 0,
    missing: false,
    hasForceStop: false,
    hasRun: false,
    worktrees,
  } satisfies RepoEntry;
}

describe('filterWorktrees', () => {
  const primary = wt('main', true);
  const foo = wt('feature-foo');
  const bar = wt('feature-bar');
  const detached = wt(null);

  it('keeps every worktree when the selection is empty', () => {
    const out = filterWorktrees([primary, foo, bar], new Set());
    expect(out).toEqual([primary, foo, bar]);
  });

  it('includes detached worktrees in the empty-selection passthrough', () => {
    // Empty selection = unfiltered. Detached non-primary rows survive
    // here even though they would be dropped by an active filter.
    const out = filterWorktrees([primary, foo, detached], new Set());
    expect(out).toEqual([primary, foo, detached]);
  });

  it('keeps the primary plus any selected non-primary branches', () => {
    const out = filterWorktrees([primary, foo, bar], new Set(['feature-foo']));
    expect(out).toEqual([primary, foo]);
  });

  it('drops detached / no-branch worktrees when the filter is active', () => {
    // Detached has no name to pin — once the selection is non-empty it
    // falls out of the visible set. Acceptable: rare edge case.
    const out = filterWorktrees([primary, foo, detached], new Set(['feature-foo']));
    expect(out).toEqual([primary, foo]);
  });

  it('returns just the primary when none of its non-primary branches match', () => {
    const out = filterWorktrees([primary, foo], new Set(['feature-missing']));
    expect(out).toEqual([primary]);
  });

  it('keeps a synthetic-primary (null branch) under an active filter', () => {
    // ensureWorktrees emits `{ branch: null, primary: true }` when the
    // data layer couldn't list real worktrees. That row must survive
    // even when the filter is active and the primary has no branch name.
    const detachedPrimary = wt(null, true);
    const out = filterWorktrees([detachedPrimary, foo], new Set(['feature-foo']));
    expect(out).toEqual([detachedPrimary, foo]);
  });

  it('preserves the input order (does not re-sort)', () => {
    const out = filterWorktrees([bar, primary, foo], new Set(['feature-foo', 'feature-bar']));
    expect(out.map((w) => w.branch)).toEqual(['feature-bar', 'main', 'feature-foo']);
  });
});

describe('collectFilterableBranches', () => {
  it('returns the deduped sorted union of non-primary branch names', () => {
    const repos = [
      repo('alpha', [wt('main', true), wt('feature-foo'), wt('feature-bar')]),
      repo('beta', [wt('main', true), wt('feature-foo')]),
    ];
    expect(collectFilterableBranches(repos)).toEqual(['feature-bar', 'feature-foo']);
  });

  it('skips the primary worktree and any detached / no-branch entries', () => {
    const repos = [repo('alpha', [wt('main', true), wt(null), wt('feature-foo')])];
    expect(collectFilterableBranches(repos)).toEqual(['feature-foo']);
  });

  it('handles repos with a missing worktrees array', () => {
    const repos: RepoEntry[] = [
      {
        name: 'alpha',
        path: '/r/alpha',
        dirty: 0,
        missing: false,
        hasForceStop: false,
        hasRun: false,
      },
    ];
    expect(collectFilterableBranches(repos)).toEqual([]);
  });
});
