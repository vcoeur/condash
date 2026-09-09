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

function makeStore(opts: { gated: boolean }) {
  const [conceptionPath] = createSignal<string | null>('/c');
  const [active, setActive] = createSignal(false);
  const fetcher = vi.fn(async () => TREE);
  let store!: ReturnType<typeof createTreeStore<Node>>;
  const dispose = createRoot((disposeRoot) => {
    store = createTreeStore<Node>({
      conceptionPath,
      fetcher,
      key: 'relPath',
      ...(opts.gated ? { active } : {}),
    });
    return disposeRoot;
  });
  return { store, fetcher, setActive, dispose };
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
