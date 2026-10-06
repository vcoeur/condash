/**
 * Tests for the tree-store activation latch (B2a). The v4.31 latch deferred
 * only the *initial* fetch; `reload()` ran for every watcher batch whether or
 * not the pane had ever been opened — for the Resources pane that was a full
 * recursive walk with per-markdown head reads per batch while the pane sat
 * closed. `reload()` is now gated on the same latch: a no-op before first
 * open, unchanged after.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createRoot, createSignal } from 'solid-js';
import { createTreeStore } from './tree-store';
import { rendererPerf } from './perf-renderer';

interface Node {
  relPath: string;
  children?: Node[];
}

const TREE: Node = { relPath: '', children: [{ relPath: 'a.md' }] };

/** Solid effects are scheduled, not synchronous — let them run. */
const flushEffects = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeStore(opts: {
  gated: boolean;
  contextKey?: () => string;
  fetcher?: ReturnType<typeof vi.fn>;
}) {
  const [conceptionPath, setConceptionPath] = createSignal<string | null>('/c');
  const [active, setActive] = createSignal(false);
  // A caller-supplied fetcher must be installed BEFORE the store is created:
  // the conception effect fires synchronously inside createRoot, so only a
  // pre-installed mock can hold the boot read.
  const fetcher = opts.fetcher ?? vi.fn(async () => TREE);
  let store!: ReturnType<typeof createTreeStore<Node>>;
  const dispose = createRoot((disposeRoot) => {
    store = createTreeStore<Node>({
      conceptionPath,
      fetcher,
      key: 'relPath',
      ...(opts.gated ? { active } : {}),
      ...(opts.contextKey ? { contextKey: opts.contextKey } : {}),
    });
    return disposeRoot;
  });
  return { store, fetcher, setActive, setConceptionPath, dispose };
}

describe('createTreeStore — reload() is gated on first activation (B2a)', () => {
  it('a reload before first activation is a no-op', async () => {
    const { store, fetcher, dispose } = makeStore({ gated: true });
    await flushEffects();
    await store.reload();
    await store.reload();
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.root()).toBeNull();
    expect(store.loaded()).toBe(false);
    dispose();
  });

  it('first activation still fetches, and reloads work afterwards', async () => {
    const { store, fetcher, setActive, dispose } = makeStore({ gated: true });
    await flushEffects();
    expect(fetcher).not.toHaveBeenCalled();
    // Open the pane: the latch flips and the conception-path effect fetches.
    setActive(true);
    await flushEffects();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.root()).toEqual(TREE);
    expect(store.loaded()).toBe(true);
    // Watcher-driven reload after activation refetches as before.
    await store.reload();
    expect(fetcher).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('an ungated store reloads eagerly, unchanged from before', async () => {
    const { store, fetcher, dispose } = makeStore({ gated: false });
    await flushEffects();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await store.reload();
    expect(fetcher).toHaveBeenCalledTimes(2);
    dispose();
  });
});

describe('createTreeStore — contextual loading', () => {
  it('deduplicates concurrent context loads without selecting the pane', async () => {
    let resolveFetch!: (value: Node) => void;
    const { store, fetcher, dispose } = makeStore({ gated: true });
    fetcher.mockImplementation(
      () =>
        new Promise<Node>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const first = store.loadForContext();
    const second = store.loadForContext();
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolveFetch(TREE);
    await Promise.all([first, second]);
    expect(store.root()).toEqual(TREE);
    dispose();
  });

  it('discards a context result from a conception that changed mid-fetch and loads the new tree', async () => {
    const resolves: ((value: Node) => void)[] = [];
    const { store, fetcher, setConceptionPath, dispose } = makeStore({ gated: true });
    fetcher.mockImplementation(
      () =>
        new Promise<Node>((resolve) => {
          resolves.push(resolve);
        }),
    );
    const pending = store.loadForContext();
    setConceptionPath('/next');
    await flushEffects();
    expect(fetcher).toHaveBeenCalledTimes(2);
    resolves[0](TREE);
    await pending;
    expect(store.root()).toBeNull();
    resolves[1]({ relPath: '', children: [{ relPath: 'next.md' }] });
    await flushEffects();
    expect(store.root()).toEqual({ relPath: '', children: [{ relPath: 'next.md' }] });
    expect(store.loaded()).toBe(true);
    dispose();
  });
});

describe('createTreeStore — perf span (treeApplySnapshot)', () => {
  afterEach(() => {
    rendererPerf.setEnabled(false);
  });

  it('records a treeApplySnapshot span per applied snapshot while enabled', async () => {
    rendererPerf.setEnabled(true);
    // Ungated: the conception-path effect applies the first snapshot, the
    // explicit reload the second — both are reconcile/first-set work.
    const { store, dispose } = makeStore({ gated: false });
    await flushEffects();
    await store.reload();
    const span = rendererPerf.takeReport()?.spans?.treeApplySnapshot;
    expect(span?.n).toBeGreaterThanOrEqual(2);
    dispose();
  });

  it('records nothing while recording is disabled', async () => {
    const { store, dispose } = makeStore({ gated: false });
    await flushEffects();
    await store.reload();
    expect(rendererPerf.takeReport()).toBeUndefined();
    dispose();
  });
});

/**
 * Race-safe freshness: a read applies only while its flight owns the store.
 * Requests are keyed by conception + Skills scope; a context switch
 * invalidates the prior flight permanently; invalidations landing during a
 * flight coalesce into exactly one trailing read.
 */
describe('createTreeStore — read ownership (race-safe freshness)', () => {
  /** Deferred fetcher installed before store creation, so the boot read is
   *  held: each fetch call pushes one resolver (boot = resolutions[0]). */
  function deferredFetcher() {
    const resolutions: ((value: Node) => void)[] = [];
    const fetcher = vi.fn(
      () =>
        new Promise<Node>((resolve) => {
          resolutions.push(resolve);
        }),
    );
    return { fetcher, resolutions };
  }

  it('a held read invalidated by a file change coalesces into one trailing read that paints the current content', async () => {
    const { fetcher, resolutions } = deferredFetcher();
    const { store, dispose } = makeStore({ gated: false, fetcher });
    await flushEffects();
    expect(fetcher).toHaveBeenCalledTimes(1); // boot read, still held

    // Watcher events → reloads share the boot flight and mark it dirty.
    void store.reload();
    void store.reload();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // The held reply resolves with the pre-change content.
    resolutions[0]({ relPath: '', children: [{ relPath: 'old.md' }] });
    await flushEffects();
    // It applied (it owned the store), and exactly one trailing read fired
    // for the whole dirty period — no further watcher event needed.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(store.root()).toEqual({ relPath: '', children: [{ relPath: 'old.md' }] });

    // The trailing read carries the current on-disk content.
    resolutions[1]({ relPath: '', children: [{ relPath: 'new.md' }] });
    await flushEffects();
    expect(store.root()).toEqual({ relPath: '', children: [{ relPath: 'new.md' }] });

    // Quiet interval: no idle churn.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetcher).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('a Skills scope switch makes the prior scope\u2019s response permanently ineligible (same conception)', async () => {
    const [scope, setScope] = createSignal('conception');
    const { fetcher, resolutions } = deferredFetcher();
    const { store, dispose } = makeStore({ gated: false, contextKey: scope, fetcher });
    await flushEffects();
    expect(fetcher).toHaveBeenCalledTimes(1); // conception-scope read, held

    // Scope flips to user while the conception-scope read is still held.
    setScope('user');
    await flushEffects();
    expect(fetcher).toHaveBeenCalledTimes(2); // new flight for the new key

    // The old-scope reply resolves — it must not paint under User.
    resolutions[0]({ relPath: '', children: [{ relPath: 'conception-skill.md' }] });
    await flushEffects();
    expect(store.root()).toBeNull();

    // The user-scope reply paints.
    resolutions[1]({ relPath: '', children: [{ relPath: 'user-skill.md' }] });
    await flushEffects();
    expect(store.root()).toEqual({ relPath: '', children: [{ relPath: 'user-skill.md' }] });
    dispose();
  });

  it('leaving and returning to the same key never revives the original flight', async () => {
    const [scope, setScope] = createSignal('conception');
    const { fetcher, resolutions } = deferredFetcher();
    const { store, dispose } = makeStore({ gated: false, contextKey: scope, fetcher });
    await flushEffects();
    expect(fetcher).toHaveBeenCalledTimes(1); // flight for conception scope, held

    // Leave to user scope: the first flight is invalidated permanently.
    setScope('user');
    await flushEffects();
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Return to conception scope: a fresh flight, not the original one.
    setScope('conception');
    await flushEffects();
    expect(fetcher).toHaveBeenCalledTimes(3);

    // The ORIGINAL conception-scope reply resolves last — it must not paint.
    resolutions[0]({ relPath: '', children: [{ relPath: 'stale-original.md' }] });
    await flushEffects();
    expect(store.root()).toBeNull();

    // The fresh conception-scope reply paints.
    resolutions[2]({ relPath: '', children: [{ relPath: 'fresh.md' }] });
    await flushEffects();
    expect(store.root()).toEqual({ relPath: '', children: [{ relPath: 'fresh.md' }] });
    dispose();
  });

  it('errors retain last-good data and a later explicit invalidation recovers', async () => {
    const { store, fetcher, dispose } = makeStore({ gated: false });
    await flushEffects();
    expect(store.root()).toEqual(TREE);

    fetcher.mockRejectedValueOnce(new Error('boom'));
    await store.reload().catch(() => undefined);
    expect(store.root()).toEqual(TREE); // last-good retained
    expect(store.loaded()).toBe(true);

    // The next explicit invalidation reads again and applies.
    fetcher.mockResolvedValueOnce({ relPath: '', children: [{ relPath: 'recovered.md' }] });
    await store.reload();
    expect(store.root()).toEqual({ relPath: '', children: [{ relPath: 'recovered.md' }] });
    dispose();
  });

  it('a finite invalidation burst stays bounded: one flight plus one trailing read', async () => {
    const { fetcher, resolutions } = deferredFetcher();
    const { store, dispose } = makeStore({ gated: false, fetcher });
    await flushEffects();
    // Five watcher events during one flight — each shares it and marks dirty.
    for (let i = 0; i < 5; i++) void store.reload();
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolutions[0](TREE);
    await flushEffects();
    expect(fetcher).toHaveBeenCalledTimes(2); // one trailing read, not five
    resolutions[1]({ relPath: '', children: [{ relPath: 'settled.md' }] });
    await flushEffects();
    expect(store.root()).toEqual({ relPath: '', children: [{ relPath: 'settled.md' }] });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetcher).toHaveBeenCalledTimes(2); // no idle churn
    dispose();
  });

  it('cleanup suppresses stale applies and trailing-read scheduling; repeated dispose is tolerated', async () => {
    const { fetcher, resolutions } = deferredFetcher();
    const { store, dispose } = makeStore({ gated: false, fetcher });
    await flushEffects();

    void store.reload(); // shared flight marked dirty
    dispose();
    dispose(); // repeated cleanup tolerated

    resolutions[0](TREE);
    await flushEffects();
    // The stale apply is suppressed and no trailing read was scheduled.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.root()).toBeNull();
  });
});
