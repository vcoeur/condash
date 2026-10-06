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

/**
 * Race-safe freshness: full-list and per-primary reads carry local tickets
 * plus the repo-event revision; a reply commits only while it is the
 * latest-started read of its kind and no newer competing kind has
 * committed. Each test asserts final state AND request counts.
 */
describe('createReposStore — read ownership (race-safe freshness)', () => {
  interface ReadHandle {
    resolve: (value: RepoEntry[]) => void;
    reject: (err: Error) => void;
  }

  /** Boot flush + read queues, all under fake timers. The boot effect's
   *  deferred initial load consumes full-read slot 0. */
  async function makeHarness(seed?: RepoEntry[]) {
    const listRepos = vi.fn(async (): Promise<RepoEntry[]> => [entry('alpha')]);
    const listReposForPrimary = vi.fn(async (): Promise<RepoEntry[]> => [entry('alpha')]);
    if (seed) listRepos.mockResolvedValueOnce(seed);
    let repoEventsCb: ((events: RepoEvent[]) => void) | undefined;
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
    // Fire the faked deferred boot load so the store is seeded and the
    // call counts below start from a known state.
    await vi.advanceTimersByTimeAsync(10);
    expect(listRepos).toHaveBeenCalledTimes(1);

    const holdFullReads = (): ReadHandle[] => {
      const handles: ReadHandle[] = [];
      listRepos.mockImplementation(
        () =>
          new Promise<RepoEntry[]>((resolve, reject) => {
            handles.push({ resolve, reject });
          }),
      );
      return handles;
    };
    const holdFamilyReads = (): ReadHandle[] => {
      const handles: ReadHandle[] = [];
      listReposForPrimary.mockImplementation(
        () =>
          new Promise<RepoEntry[]>((resolve, reject) => {
            handles.push({ resolve, reject });
          }),
      );
      return handles;
    };
    /** Fire the debounced per-primary reload for `name`. */
    const startFamilyRead = async (name: string): Promise<void> => {
      repoEventsCb!([{ kind: 'repo-worktrees-changed', repoPath: `/r/${name}` }]);
      await vi.advanceTimersByTimeAsync(250);
    };
    return {
      store,
      get repos(): RepoEntry[] {
        return store.repos;
      },
      listRepos,
      listReposForPrimary,
      holdFullReads,
      holdFamilyReads,
      startFamilyRead,
      pushEvents: (events: RepoEvent[]) => repoEventsCb!(events),
      dispose,
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('a later-started family read commits after a successful whole', async () => {
    vi.useFakeTimers();
    const h = await makeHarness();
    expect(h.repos.map((r) => r.name)).toEqual(['alpha']);

    const full = h.holdFullReads();
    const pending = h.store.reloadRepos(); // read 2, held
    full[0]!.resolve([entry('alpha'), entry('beta'), entry('gamma')]);
    await pending;
    expect(h.repos.map((r) => r.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(h.listRepos).toHaveBeenCalledTimes(2);

    // Family read for beta starts and commits AFTER the whole committed.
    const family = h.holdFamilyReads();
    await h.startFamilyRead('beta');
    expect(h.listReposForPrimary).toHaveBeenCalledTimes(1);
    family[0]!.resolve([{ ...entry('beta'), dirty: 7 }]);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.repos.map((r) => [r.name, r.dirty])).toEqual([
      ['alpha', 0],
      ['beta', 7],
      ['gamma', 0],
    ]);
    // No recovery read: the family simply committed.
    expect(h.listRepos).toHaveBeenCalledTimes(2);
    h.dispose();
  });

  it('an older-started family read is ineligible once a newer whole has committed', async () => {
    vi.useFakeTimers();
    const h = await makeHarness([entry('alpha'), entry('beta'), entry('gamma')]);

    // Family read for beta starts (held), THEN a full read starts.
    const family = h.holdFamilyReads();
    await h.startFamilyRead('beta');
    expect(h.listReposForPrimary).toHaveBeenCalledTimes(1);

    const full = h.holdFullReads();
    const pending = h.store.reloadRepos(); // read 2, started after the family
    full[0]!.resolve([entry('alpha'), { ...entry('beta'), dirty: 3 }, entry('gamma')]);
    await pending;
    // The whole committed first; it is newer than the family read.
    expect(h.repos.map((r) => r.dirty)).toEqual([0, 3, 0]);

    // The older-started family reply resolves with stale data — discarded.
    family[0]!.resolve([{ ...entry('beta'), dirty: 99 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.repos.map((r) => r.dirty)).toEqual([0, 3, 0]);
    // No extra reads: the discard needs no recovery.
    expect(h.listRepos).toHaveBeenCalledTimes(2);
    expect(h.listReposForPrimary).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it('an older whole finishing after a committed family is discarded whole; one full read is retried and the removed submodule stays gone', async () => {
    vi.useFakeTimers();
    const withRemoved = [entry('alpha'), entry('beta'), entry('removed', 'beta'), entry('gamma')];
    const h = await makeHarness(withRemoved);
    expect(h.repos.map((r) => r.name)).toEqual(['alpha', 'beta', 'beta/removed', 'gamma']);

    // A held full read (read 2) captured the list WITH the submodule.
    const full = h.holdFullReads();
    const pendingFull = h.store.reloadRepos();

    // A family read for beta starts later and commits first — authoritative
    // membership: the removed submodule is gone.
    const family = h.holdFamilyReads();
    await h.startFamilyRead('beta');
    family[0]!.resolve([entry('beta'), entry('kept', 'beta')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.repos.map((r) => r.name)).toEqual(['alpha', 'beta', 'beta/kept', 'gamma']);

    // The older whole resolves with the submodule present — discarded whole
    // (no partial splice) and one recovery full read starts (read 3).
    full[0]!.resolve(withRemoved);
    await pendingFull;
    expect(h.repos.map((r) => r.name)).toEqual(['alpha', 'beta', 'beta/kept', 'gamma']);
    expect(h.listRepos).toHaveBeenCalledTimes(3);

    // The recovery read observes after the family work and commits.
    full[1]!.resolve([
      entry('alpha'),
      { ...entry('beta'), dirty: 5 },
      entry('kept', 'beta'),
      entry('gamma'),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.repos.map((r) => [r.name, r.dirty])).toEqual([
      ['alpha', 0],
      ['beta', 5],
      ['beta/kept', 0],
      ['gamma', 0],
    ]);
    expect(h.listRepos).toHaveBeenCalledTimes(3); // exactly one recovery read
    h.dispose();
  });

  it('the latest whole failing retains last-good and never falls back to the older held whole', async () => {
    vi.useFakeTimers();
    const h = await makeHarness([entry('alpha')]);

    const full = h.holdFullReads();
    void h.store.reloadRepos().catch(() => undefined); // older whole (read 2), held
    void h.store.reloadRepos().catch(() => undefined); // latest whole (read 3), held
    expect(h.listRepos).toHaveBeenCalledTimes(3);

    // The latest whole FAILS — last-good retained.
    full[1]!.reject(new Error('boom'));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.repos.map((r) => r.name)).toEqual(['alpha']);

    // The older whole resolves with data the latest already superseded —
    // discarded, no fallback.
    full[0]!.resolve([entry('alpha'), entry('beta')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.repos.map((r) => r.name)).toEqual(['alpha']);
    expect(h.listRepos).toHaveBeenCalledTimes(3); // no fallback read
    h.dispose();
  });

  it('an overlapping older whole resolving first is discarded; the newer whole commits', async () => {
    vi.useFakeTimers();
    const h = await makeHarness([entry('alpha')]);

    const full = h.holdFullReads();
    void h.store.reloadRepos(); // older whole (read 2)
    void h.store.reloadRepos(); // newer whole (read 3)

    full[0]!.resolve([entry('alpha'), entry('old', 'alpha')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.repos.map((r) => r.name)).toEqual(['alpha']); // older discarded

    full[1]!.resolve([entry('alpha'), { ...entry('beta'), dirty: 2 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.repos.map((r) => [r.name, r.dirty])).toEqual([
      ['alpha', 0],
      ['beta', 2],
    ]);
    expect(h.listRepos).toHaveBeenCalledTimes(3);
    h.dispose();
  });

  it('a newer repo event invalidates a held full read; one coalesced recovery read follows', async () => {
    vi.useFakeTimers();
    const h = await makeHarness([entry('alpha')]);

    const full = h.holdFullReads();
    const pending = h.store.reloadRepos(); // read 2, held

    // A repo event lands during the read; its scalar patch applies directly.
    h.pushEvents([{ kind: 'repo-dirty', path: '/r/alpha', dirty: 4 }]);
    expect(h.repos.map((r) => r.dirty)).toEqual([4]);

    // The held reply predates the event — discarded, one recovery (read 3).
    full[0]!.resolve([entry('alpha'), entry('stale', 'alpha')]);
    await pending;
    expect(h.repos.map((r) => r.name)).toEqual(['alpha']); // stale row not applied
    expect(h.repos.map((r) => r.dirty)).toEqual([4]); // event patch retained
    expect(h.listRepos).toHaveBeenCalledTimes(3);

    full[1]!.resolve([{ ...entry('alpha'), dirty: 4 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.repos.map((r) => [r.name, r.dirty])).toEqual([['alpha', 4]]);
    expect(h.listRepos).toHaveBeenCalledTimes(3); // exactly one recovery read
    h.dispose();
  });

  it('a newer repo event invalidates a held family read; one debounced family recovery follows', async () => {
    vi.useFakeTimers();
    const h = await makeHarness([entry('alpha')]);

    const family = h.holdFamilyReads();
    await h.startFamilyRead('alpha'); // family read 1, held
    expect(h.listReposForPrimary).toHaveBeenCalledTimes(1);

    h.pushEvents([{ kind: 'repo-upstream', path: '/r/alpha', upstream: null }]);

    family[0]!.resolve([{ ...entry('alpha'), dirty: 42 }]);
    await vi.advanceTimersByTimeAsync(0);
    // Stale reply discarded; the event's own state is untouched.
    expect(h.repos.map((r) => r.dirty)).toEqual([0]);
    // Exactly one debounced family recovery (read 2), no full read.
    await vi.advanceTimersByTimeAsync(250);
    expect(h.listReposForPrimary).toHaveBeenCalledTimes(2);
    expect(h.listRepos).toHaveBeenCalledTimes(1);

    family[1]!.resolve([{ ...entry('alpha'), dirty: 9 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.repos.map((r) => r.dirty)).toEqual([9]);
    h.dispose();
  });

  it('a family commit preserves unrelated row identity and order', async () => {
    vi.useFakeTimers();
    const h = await makeHarness([entry('alpha'), entry('beta'), entry('gamma')]);
    const alphaBefore = h.repos[0];
    const gammaBefore = h.repos[2];

    const family = h.holdFamilyReads();
    await h.startFamilyRead('beta');
    family[0]!.resolve([{ ...entry('beta'), dirty: 1 }]);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.repos.map((r) => r.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(h.repos[0]).toBe(alphaBefore);
    expect(h.repos[2]).toBe(gammaBefore);
    h.dispose();
  });

  it('cleanup suppresses a stale apply after disposal; repeated dispose is tolerated', async () => {
    vi.useFakeTimers();
    const h = await makeHarness([entry('alpha')]);

    const full = h.holdFullReads();
    const pending = h.store.reloadRepos(); // held
    h.dispose();
    h.dispose(); // repeated cleanup tolerated

    full[0]!.resolve([entry('alpha'), entry('post-dispose', 'alpha')]);
    await pending;
    expect(h.repos.map((r) => r.name)).toEqual(['alpha']);
  });
});
