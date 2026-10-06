import { createEffect, createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { rendererPerf } from './perf-renderer';

/**
 * Generic in-place store for the three tree panes (Knowledge, Resources,
 * Skills). Each pane reads its root through a Solid store whose contents
 * are reconciled by a stable identity key (`relPath` for every supported
 * node type), so refresh reuses prior node objects when their `relPath`
 * matches. That keeps `<For>` row identity stable across refetches and
 * any DOM nodes / popovers anchored on them survive the swap — same shape
 * `repos-store.ts` already uses for the Code pane.
 *
 * Returning a tree rather than a list means `reconcile` walks every level
 * and matches children by the same key. SolidJS reconcile docs: when the
 * same key string is provided, nested arrays are diffed by that key
 * throughout — so the directory-tree shape Just Works as long as every
 * node carries the identity field.
 */
export interface TreeStore<T> {
  /** Reactive accessor returning the current tree root, or null when the
   *  pane has no data (no conception selected, or the on-disk root is
   *  missing). */
  root: Accessor<T | null>;
  /** True once the first fetcher call has resolved for the active
   *  conception. Stays true across subsequent refreshes — flips back to
   *  false only when the conception path goes null. Lets panes
   *  distinguish "still loading first paint" from "loaded, genuinely
   *  empty / absent". */
  loaded: Accessor<boolean>;
  /** Re-fetch the tree from disk and reconcile into the store. The
   *  conception-path effect already calls this on conception switch; the
   *  tree-events handler calls it on chokidar events for this pane's
   *  kind, and View → Refresh fans it out alongside the other reloaders.
   *  Gated on the activation latch: a pane that was never opened holds no
   *  data, so reloading it is pure churn — its first open fetches through
   *  the conception-path effect instead. Once the pane has activated the
   *  latch stays true and every reload runs as before.
   *
   *  A reload may paint only while its flight owns the store: requests are
   *  keyed by active conception + effective context, a context switch
   *  invalidates the prior flight permanently, and invalidations landing
   *  during a flight coalesce into exactly one trailing read. */
  reload: () => Promise<void>;
  /** Load a gated tree for a contextual action without selecting its pane. */
  loadForContext: () => Promise<void>;
}

export interface TreeStoreDeps<T> {
  /** Read-only accessor for the active conception path. The store clears
   *  whenever this goes null and re-fetches whenever it changes. */
  conceptionPath: Accessor<string | null>;
  /** IPC fetcher returning the tree root for the active conception
   *  (`window.condash.readKnowledgeTree`, `readResourcesTree`,
   *  `readSkillsTree`). Returns `null` when the on-disk root is missing
   *  — surfaced as `root() === null` so the pane can show its empty
   *  state without flickering the rest of the UI. */
  fetcher: () => Promise<T | null>;
  /** Identity field reconcile uses at every level of the tree. Must be
   *  a property name shared by every node type in the tree (`relPath`
   *  for KnowledgeNode / ResourceNode / SkillNode). */
  key: keyof T & string;
  /** Optional activation gate: defer the first fetch until this returns
   *  true (typically "this pane is the visible working surface"). Once it
   *  has fired true the store behaves exactly as before — it keeps
   *  reloading on conception change and on explicit `reload()`. Omit to
   *  fetch eagerly. Used to keep the hidden Knowledge / Resources / Skills
   *  panes off the startup IPC burst until first opened. */
  active?: Accessor<boolean>;
  /** Optional extra context that partitions request ownership on top of the
   *  conception path — the Skills pane passes its effective scope
   *  ('conception' | 'user'). A change makes every in-flight response from
   *  the prior key permanently ineligible, even though the conception path
   *  is unchanged, and even if the context later returns to the original
   *  key. Omit for panes whose requests are keyed by the conception path
   *  alone. */
  contextKey?: Accessor<string>;
}

export function createTreeStore<T extends object>(deps: TreeStoreDeps<T>): TreeStore<T> {
  // Box the nullable tree inside a store so the consumer reads
  // `box.value` (a reactive store path) instead of a top-level signal.
  // Solid stores require an object target; wrapping is the conventional
  // way to make the value itself nullable.
  const [box, setBox] = createStore<{ value: T | null }>({ value: null });
  const [loaded, setLoaded] = createSignal(false);

  // Latch that flips true the first time the pane is activated — or
  // immediately when no `active` gate is supplied (eager, prior behaviour).
  // Until it flips, the conception-path effect below holds off the first
  // fetch, so a never-opened tree pane costs no startup IPC.
  const [activated, setActivated] = createSignal(deps.active === undefined);
  if (deps.active) {
    createEffect(() => {
      if (deps.active!()) setActivated(true);
    });
  }

  // ── Read ownership ──────────────────────────────────────────────────
  // A read may apply only while its flight owns the store. Ownership is
  // lost permanently on any context switch (conception or Skills scope) —
  // checked by identity, not by comparing the current key, so leaving and
  // returning to the same key never revives a departed flight. A same-key
  // reload while a flight is in flight shares it and marks it dirty; the
  // settlement then coalesces every invalidation the flight covered into
  // exactly one trailing read. Changes during the trailing read open one
  // further dirty period — reads stay bounded, one per dirty period.
  interface Flight {
    key: string;
    dirty: boolean;
    promise: Promise<void>;
  }
  let owner: Flight | null = null;
  let disposed = false;
  onCleanup(() => {
    // Disposal suppresses both stale applies and trailing-read scheduling.
    // Solid runs onCleanup once per root disposal; a repeated dispose is a
    // no-op there, so the release happens exactly once.
    disposed = true;
    owner = null;
  });

  /** Requests are keyed by the active conception plus the effective context
   *  (Skills scope); null when there is no conception to read for. */
  const requestKey = (): string | null => {
    const path = deps.conceptionPath();
    if (!path) return null;
    const context = deps.contextKey?.() ?? '';
    return context ? `${path}\n${context}` : path;
  };

  const applySnapshot = (next: T | null): void => {
    const span = rendererPerf.startSpan();
    try {
      if (next === null) {
        // Drop the prior tree wholesale. Reconcile against null is not
        // well-defined when the store had a value — direct assignment
        // releases the old references cleanly.
        setBox('value', null);
        return;
      }
      if (box.value === null) {
        // First non-null snapshot — nothing to reconcile against.
        setBox('value', next);
        return;
      }
      setBox('value', reconcile(next, { key: deps.key }));
    } finally {
      rendererPerf.endSpan('treeApplySnapshot', span);
    }
  };

  const startFlight = (key: string): Flight => {
    const flight: Flight = { key, dirty: false, promise: Promise.resolve() };
    owner = flight;
    let requested: Promise<T | null>;
    try {
      requested = deps.fetcher();
    } catch (err) {
      owner = null;
      requested = Promise.reject(err);
    }
    flight.promise = requested.then(
      (next) => {
        // Ownership, not key equality: only the flight that still owns the
        // store may apply, and ownership never survives a context switch.
        if (disposed || owner !== flight) return;
        owner = null;
        applySnapshot(next);
        setLoaded(true);
        // One trailing read per in-flight dirty period.
        if (flight.dirty && !disposed) {
          void startFlight(key).promise.catch(() => undefined);
        }
      },
      (err) => {
        // Failure retains the last-good tree and releases ownership so the
        // next explicit invalidation reads again. The dirty period is
        // dropped, not retried — no unbounded retry.
        if (owner === flight) owner = null;
        throw err;
      },
    );
    return flight;
  };

  const reload = (): Promise<void> => {
    // Watcher-driven and View→Refresh reloads alike: before the pane has
    // ever activated there is no data to refresh, and the resources tree in
    // particular is a full recursive walk with per-markdown head reads —
    // reloading it on every watcher batch while the pane stays closed was
    // the 2026-08-30 storm (B2a). The latch stays true after first open, so
    // explicit reloads from a live pane are unaffected.
    if (!activated()) return Promise.resolve();
    const key = requestKey();
    if (!key) {
      // Departure: clear the tree and invalidate any in-flight flight
      // permanently — returning to this key later starts a fresh read.
      owner = null;
      applySnapshot(null);
      setLoaded(false);
      return Promise.resolve();
    }
    if (owner) {
      if (owner.key === key) {
        // Same-key invalidation during flight: share the flight and
        // coalesce the events it covers into one trailing read.
        owner.dirty = true;
        return owner.promise;
      }
      owner = null; // Context switch — the old response is ineligible.
    }
    return startFlight(key).promise;
  };

  const loadForContext = (): Promise<void> => {
    if (!activated()) setActivated(true);
    return reload();
  };

  // Clear on conception-path drop; reload on every non-null path once the
  // pane has been activated. With an `active` gate the first fetch waits
  // for first open, so the first switch to a tree pane pays one IPC and
  // every subsequent switch is paint-only (the store stays populated for
  // the active conception). Without a gate this is eager, as before.
  // Reads `contextKey` transitively through `reload()`, so a Skills scope
  // flip re-runs this effect and supersedes the prior scope's flight.
  createEffect(() => {
    const path = deps.conceptionPath();
    if (!path) {
      applySnapshot(null);
      setLoaded(false);
      return;
    }
    if (!activated()) return;
    void reload();
  });

  return {
    root: () => box.value,
    loaded,
    reload,
    loadForContext,
  };
}
