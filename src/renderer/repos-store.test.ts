import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import type { RepoEntry, RepoEvent } from '../shared/types';
import { createReposStore, spliceFamilyAt } from './repos-store';
import { rendererPerf } from './perf-renderer';

function entry(name: string, parent?: string): RepoEntry {
  return {
    name: parent ? `${parent}/${name}` : name,
    handle: name,
    path: `/r/${parent ? `${parent}/${name}` : name}`,
    parent,
    dirty: 0,
    missing: false,
    hasForceStop: false,
    hasRun: false,
  } satisfies RepoEntry;
}

describe('spliceFamilyAt', () => {
  it('keeps the primary at its original index after a structural reload', () => {
    // Three top-level repos in declaration order, with a worktree event
    // touching only the middle one.
    const current: RepoEntry[] = [entry('alpha'), entry('beta'), entry('gamma')];
    const updated: RepoEntry[] = [{ ...entry('beta'), dirty: 7 }];

    const next = spliceFamilyAt(current, { name: 'beta', path: '/r/beta' }, updated);

    expect(next.map((r) => r.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(next[1].dirty).toBe(7);
  });

  it('preserves order when the primary is at the head or tail of the list', () => {
    const current: RepoEntry[] = [entry('alpha'), entry('beta'), entry('gamma')];

    const headNext = spliceFamilyAt(current, { name: 'alpha', path: '/r/alpha' }, [
      { ...entry('alpha'), dirty: 1 },
    ]);
    expect(headNext.map((r) => r.name)).toEqual(['alpha', 'beta', 'gamma']);

    const tailNext = spliceFamilyAt(current, { name: 'gamma', path: '/r/gamma' }, [
      { ...entry('gamma'), dirty: 1 },
    ]);
    expect(tailNext.map((r) => r.name)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('replaces a parent + its submodules in place, in declaration order', () => {
    const current: RepoEntry[] = [
      entry('alpha'),
      entry('beta'),
      entry('child1', 'beta'),
      entry('child2', 'beta'),
      entry('gamma'),
    ];
    // Watcher event: beta gained a child3 and dropped child1.
    const updated: RepoEntry[] = [entry('beta'), entry('child2', 'beta'), entry('child3', 'beta')];

    const next = spliceFamilyAt(current, { name: 'beta', path: '/r/beta' }, updated);

    expect(next.map((r) => r.name)).toEqual([
      'alpha',
      'beta',
      'beta/child2',
      'beta/child3',
      'gamma',
    ]);
  });

  it('does not jump the family to the bottom (regression for the append bug)', () => {
    // The pre-fix behaviour did `[...survivors, ...updated]`, which would
    // place the reloaded family after `gamma` here. The fix anchors it
    // at the primary's original index instead.
    const current: RepoEntry[] = [entry('alpha'), entry('beta'), entry('gamma')];
    const updated: RepoEntry[] = [entry('beta')];

    const next = spliceFamilyAt(current, { name: 'beta', path: '/r/beta' }, updated);

    expect(next.indexOf(next.find((r) => r.name === 'beta')!)).toBe(1);
    expect(next[next.length - 1].name).toBe('gamma');
  });

  it('appends when the primary is not in the current list (defensive)', () => {
    const current: RepoEntry[] = [entry('alpha'), entry('gamma')];
    const updated: RepoEntry[] = [entry('beta'), entry('child', 'beta')];

    const next = spliceFamilyAt(current, { name: 'beta', path: '/r/beta' }, updated);

    expect(next.map((r) => r.name)).toEqual(['alpha', 'gamma', 'beta', 'beta/child']);
  });

  it('treats `updated` as authoritative for family membership', () => {
    // A submodule absent from `updated` is genuinely gone — preserving
    // it would resurrect rows that the user removed from condash.json.
    const current: RepoEntry[] = [
      entry('beta'),
      entry('removed', 'beta'),
      entry('kept', 'beta'),
      entry('gamma'),
    ];
    const updated: RepoEntry[] = [entry('beta'), entry('kept', 'beta')];

    const next = spliceFamilyAt(current, { name: 'beta', path: '/r/beta' }, updated);

    expect(next.map((r) => r.name)).toEqual(['beta', 'beta/kept', 'gamma']);
  });
});

describe('createReposStore — perf spans', () => {
  const listRepos = vi.fn(async (): Promise<RepoEntry[]> => [entry('alpha')]);
  const listReposForPrimary = vi.fn(
    async (): Promise<RepoEntry[]> => [{ ...entry('alpha'), dirty: 3 }],
  );
  let repoEventsCb: ((events: RepoEvent[]) => void) | undefined;

  function makeStore() {
    repoEventsCb = undefined;
    vi.stubGlobal('window', {
      condash: {
        listRepos,
        listReposForPrimary,
        onRepoEvents: (cb: (events: RepoEvent[]) => void) => {
          repoEventsCb = cb;
          return () => {
            repoEventsCb = undefined;
          };
        },
      },
    });
    const [conceptionPath] = createSignal<string | null>('/c');
    let store!: ReturnType<typeof createReposStore>;
    const dispose = createRoot((disposeRoot) => {
      store = createReposStore({ conceptionPath, flashToast: () => undefined });
      return disposeRoot;
    });
    return { store, dispose };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    rendererPerf.setEnabled(false);
  });

  it('records reposReload while recording is enabled', async () => {
    rendererPerf.setEnabled(true);
    const { store, dispose } = makeStore();
    await store.reloadRepos();
    expect(rendererPerf.takeReport()?.spans?.reposReload?.n).toBe(1);
    dispose();
  });

  it('records reposApplyEvents synchronously per event batch', async () => {
    rendererPerf.setEnabled(true);
    const { store, dispose } = makeStore();
    await store.reloadRepos();
    repoEventsCb!([{ kind: 'repo-dirty', path: '/r/alpha', dirty: 2 }]);
    const spans = rendererPerf.takeReport()?.spans;
    expect(spans?.reposApplyEvents?.n).toBe(1);
    expect(spans?.reposReload?.n).toBe(1);
    dispose();
  });

  it('records reposReloadPrimary when a structural event triggers the debounced reload', async () => {
    rendererPerf.setEnabled(true);
    const { store, dispose } = makeStore();
    await store.reloadRepos();
    rendererPerf.takeReport(); // drain the initial reload's span

    vi.useFakeTimers();
    repoEventsCb!([{ kind: 'repo-worktrees-changed', repoPath: '/r/alpha' }]);
    await vi.advanceTimersByTimeAsync(250);

    expect(listReposForPrimary).toHaveBeenCalledWith('alpha');
    expect(rendererPerf.takeReport()?.spans?.reposReloadPrimary?.n).toBe(1);
    dispose();
  });

  it('records nothing while recording is disabled', async () => {
    const { store, dispose } = makeStore();
    await store.reloadRepos();
    repoEventsCb!([{ kind: 'repo-dirty', path: '/r/alpha', dirty: 2 }]);
    expect(rendererPerf.takeReport()).toBeUndefined();
    dispose();
  });
});
