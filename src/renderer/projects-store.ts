import { createEffect, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { Project } from '@shared/types';

/**
 * Mutator passed to `applyTreeEvents` for per-project patches (add /
 * change / delete). The callback receives the current list and returns
 * the next; reconcile then walks the diff keyed by `path` so unchanged
 * card rows keep their DOM identity. Same shape as the prior
 * `createResource`-backed `mutate`, retained so the tree-events handler
 * didn't need a second refactor pass.
 */
export type ProjectsMutator = (next: (items: Project[]) => Project[]) => void;

export interface ProjectsStore {
  /** Reactive accessor returning the current project list. Always
   *  defined — empty array when no conception is selected or the
   *  fetcher hasn't resolved yet. Consumers should check `loaded()` to
   *  tell "still loading" from "loaded, empty". */
  projects: Accessor<Project[]>;
  /** True once the first `listProjects()` call has resolved for the
   *  active conception. Flips back to false on conception-path drop. */
  loaded: Accessor<boolean>;
  /** Apply a path-shaped patch to the list. Used by the chokidar event
   *  handler so a single README save patches one card instead of
   *  refetching the whole list. */
  mutate: ProjectsMutator;
  /** Re-fetch the list and reconcile against the current store. */
  reload: () => Promise<void>;
}

export interface ProjectsStoreDeps {
  /** Read-only accessor for the active conception path. */
  conceptionPath: Accessor<string | null>;
}

/**
 * Projects-pane list store. Mirrors `repos-store.ts` — a Solid store
 * fed by an explicit `reload()` that applies `reconcile({ key: 'path' })`
 * — so per-event patches (`mutate`) and full reloads both preserve
 * `Project` reference identity, keeping `<For>` row mounts stable and
 * any per-card popover state alive across refresh.
 *
 * Lives outside the resource graph on purpose: a chokidar burst can
 * fire many tree events per second, and a `createResource` source
 * change cascades a Suspense transition on every bump. The store path
 * stays synchronous on the read side.
 */
export function createProjectsStore(deps: ProjectsStoreDeps): ProjectsStore {
  const [box, setBox] = createStore<{ list: Project[] }>({ list: [] });
  const [loaded, setLoaded] = createSignal(false);

  const reload = async (): Promise<void> => {
    if (!deps.conceptionPath()) {
      setBox('list', reconcile([] as Project[], { key: 'path' }));
      setLoaded(false);
      return;
    }
    const list = await window.condash.listProjects();
    setBox('list', reconcile(list, { key: 'path' }));
    setLoaded(true);
  };

  const mutate: ProjectsMutator = (fn) => {
    const next = fn(box.list);
    setBox('list', reconcile(next, { key: 'path' }));
  };

  // Same eager-load pattern as the repos store — first paint of the
  // Projects pane is instant because the list has already been fetched
  // by the time the user looks at it.
  createEffect(() => {
    const path = deps.conceptionPath();
    if (!path) {
      setBox('list', reconcile([] as Project[], { key: 'path' }));
      setLoaded(false);
      return;
    }
    void reload();
  });

  return {
    projects: () => box.list,
    loaded,
    mutate,
    reload,
  };
}
