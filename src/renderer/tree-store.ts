import { createEffect, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';

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
   *  kind, and View → Refresh fans it out alongside the other reloaders. */
  reload: () => Promise<void>;
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

  const applySnapshot = (next: T | null): void => {
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
  };

  const reload = async (): Promise<void> => {
    const path = deps.conceptionPath();
    if (!path) {
      applySnapshot(null);
      setLoaded(false);
      return;
    }
    const next = await deps.fetcher();
    // Discard a stale result if the conception changed while the fetch was
    // in flight — applying it would paint the previous conception's tree.
    if (deps.conceptionPath() !== path) return;
    applySnapshot(next);
    setLoaded(true);
  };

  // Clear on conception-path drop; reload on every non-null path once the
  // pane has been activated. With an `active` gate the first fetch waits
  // for first open, so the first switch to a tree pane pays one IPC and
  // every subsequent switch is paint-only (the store stays populated for
  // the active conception). Without a gate this is eager, as before.
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
  };
}
