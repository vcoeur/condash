import { describe, expect, it } from 'vitest';
import type { RepoEntry, Worktree } from '../../../shared/types';
import { collectFilterableBranches, filterWorktrees, groupRepos, orderedRepos } from './data';

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

  it('All-sticky mode shows every worktree regardless of the selection', () => {
    const out = filterWorktrees([primary, foo, bar], new Set(), true);
    expect(out).toEqual([primary, foo, bar]);
  });

  it('All-sticky includes detached non-primary rows too', () => {
    const out = filterWorktrees([primary, foo, detached], new Set(), true);
    expect(out).toEqual([primary, foo, detached]);
  });

  it('None mode (sticky=false, empty set) returns only the primary row (issue #169)', () => {
    const out = filterWorktrees([primary, foo, bar], new Set(), false);
    expect(out).toEqual([primary]);
  });

  it('Custom mode keeps the primary plus any selected non-primary branches', () => {
    const out = filterWorktrees([primary, foo, bar], new Set(['feature-foo']), false);
    expect(out).toEqual([primary, foo]);
  });

  it('Custom mode drops detached / no-branch worktrees', () => {
    const out = filterWorktrees([primary, foo, detached], new Set(['feature-foo']), false);
    expect(out).toEqual([primary, foo]);
  });

  it('Custom mode returns just the primary when no non-primary branches match', () => {
    const out = filterWorktrees([primary, foo], new Set(['feature-missing']), false);
    expect(out).toEqual([primary]);
  });

  it('keeps a synthetic-primary (null branch) under an active filter', () => {
    // ensureWorktrees emits `{ branch: null, primary: true }` when the
    // data layer couldn't list real worktrees. That row must survive
    // even when the filter is active and the primary has no branch name.
    const detachedPrimary = wt(null, true);
    const out = filterWorktrees([detachedPrimary, foo], new Set(['feature-foo']), false);
    expect(out).toEqual([detachedPrimary, foo]);
  });

  it('preserves the input order (does not re-sort)', () => {
    const out = filterWorktrees(
      [bar, primary, foo],
      new Set(['feature-foo', 'feature-bar']),
      false,
    );
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

describe('groupRepos', () => {
  function r(name: string, section?: string, parent?: string): RepoEntry {
    return {
      name,
      path: `/r/${name}`,
      dirty: 0,
      missing: false,
      hasForceStop: false,
      hasRun: false,
      section,
      parent,
    };
  }

  it('returns one default-bucket group when no repo has a section', () => {
    const groups = groupRepos([r('alpha'), r('beta')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].section).toBeNull();
    expect(groups[0].key).toBe('__default__');
    expect(groups[0].repos.map((p) => p.name)).toEqual(['alpha', 'beta']);
  });

  it('splits repos by section in declaration order, keeping submodules in their parent group', () => {
    // orderedRepos puts submodules right after their parent; groupRepos is
    // called on that flat list. Submodules inherit their parent's section at
    // walk time (see config-walk.ts), so they stay in the same group as the
    // parent without any special-case logic here.
    const ordered = orderedRepos([
      r('alicepeintures.com', 'Sites'),
      r('condash', 'Tools'),
      r('frontend', 'Tools', 'condash'),
    ]);
    const groups = groupRepos(ordered);
    expect(groups.map((g) => g.section)).toEqual(['Sites', 'Tools']);
    expect(groups[0].repos.map((p) => p.name)).toEqual(['alicepeintures.com']);
    expect(groups[1].repos.map((p) => p.name)).toEqual(['condash', 'frontend']);
  });

  it('emits a leading default-bucket group before the first section', () => {
    const groups = groupRepos([r('standalone'), r('grouped', 'Later')]);
    expect(groups.map((g) => [g.section, g.key, g.repos.length])).toEqual([
      [null, '__default__', 1],
      ['Later', 'Later', 1],
    ]);
  });
});
