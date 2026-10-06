import { createEffect, createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { Project, TreeEvent } from '@shared/types';

/**
 * Mutator passed to `applyTreeEvents` for per-project patches (add /
 * change / delete). The callback receives the current list and returns
 * the next; reconcile then walks the diff keyed by `path` so unchanged
 * card rows keep their DOM identity. Same shape as the prior
 * `createResource`-backed `mutate`, retained so the tree-events handler
 * didn't need a second refactor pass.
 */
export type ProjectsMutator = (next: (items: Project[]) => Project[]) => void;

/**
 * Ownership ticket for one registered per-path watcher operation. The
 * ticket is minted by `registerBatch` for the *last* operation each path
 * carries in the batch; `settle` applies a lookup's result only while this
 * exact ticket is still the path's owner, so a later unlink (same batch or
 * a later one) defeats an already-held lookup.
 */
export interface ProjectPatchTicket {
  readonly path: string;
  readonly seq: number;
}

/**
 * Batch-arrival ownership shared by the tree-events dispatcher and this
 * store. `registerBatch` runs synchronously before the dispatcher's first
 * `await`, so every event in a received batch — including unlink
 * tombstones and membership invalidations — owns its path before any held
 * lookup can apply.
 */
export interface ProjectsOwnership {
  /** Pre-register a batch's project operations in original order. Bumps the
   *  list revision when the batch affects the projects list (per-path ops,
   *  `projects-reload`, `unknown`), records each path's last operation, and
   *  returns a ticket per add/change event that is still its path's final
   *  operation — the only lookups the dispatcher should issue. */
  registerBatch(events: TreeEvent[]): Map<TreeEvent, ProjectPatchTicket>;
  /** Settle a registered lookup: releases the pending gate, then applies
   *  `next` through the store's reconcile only while `ticket` still owns
   *  its path. A settled lookup that started the batch's owed trailing list
   *  read lets it start here. */
  settle(ticket: ProjectPatchTicket, next: (items: Project[]) => Project[]): void;
  /** Settle a *failed* lookup: releases the pending gate without applying.
   *  The dispatcher falls back to the existing unknown/full-reload path. */
  fail(ticket: ProjectPatchTicket): void;
}

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
  /** Re-fetch the list and reconcile against the current store. A read
   *  commits only while no batch registered after it started and no
   *  registered patch lookup is pending; otherwise it is discarded and one
   *  coalesced trailing read runs after the pending lookups settle. */
  reload: () => Promise<void>;
  /** Batch-arrival ownership handed to the tree-events dispatcher. */
  ownership: ProjectsOwnership;
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

  // ── Batch-arrival ownership ─────────────────────────────────────────
  // Every received watcher batch is registered synchronously — before the
  // dispatcher's first `await` — so a held `getProject` reply can never
  // apply over an operation the batch already delivered (the deletion that
  // resurrects a card). State:
  //
  //   listRev        bumped once per list-affecting batch; a `listProjects`
  //                  read captures it and commits only while it is still
  //                  current
  //   pathOps        per-path last operation (monotonic `opSeq`), including
  //                  unlink tombstones — a patch ticket applies only while
  //                  its seq is still the path's owner
  //   pendingLookups registered add/change lookups not settled yet; a list
  //                  read never commits while any are pending
  //   listDirty      a list read was discarded and one trailing read is owed
  //                  once the pending lookups settle
  let listRev = 0;
  let opSeq = 0;
  let pendingLookups = 0;
  let listDirty = false;
  let disposed = false;
  const pathOps = new Map<string, { seq: number; conception: string }>();

  onCleanup(() => {
    // Disposal suppresses both stale applies and trailing-read scheduling;
    // Solid runs onCleanup once per root disposal and a repeated dispose is
    // a no-op there, so the release happens exactly once.
    disposed = true;
    pathOps.clear();
    pendingLookups = 0;
    listDirty = false;
  });

  const ownership: ProjectsOwnership = {
    registerBatch(events) {
      const tickets = new Map<TreeEvent, ProjectPatchTicket>();
      const lastProjectEvent = new Map<string, Extract<TreeEvent, { kind: 'project' }>>();
      let listAffecting = false;
      for (const event of events) {
        if (event.kind === 'project') {
          lastProjectEvent.set(event.path, event);
          listAffecting = true;
        } else if (event.kind === 'projects-reload' || event.kind === 'unknown') {
          listAffecting = true;
        }
      }
      if (!listAffecting) return tickets;
      // One revision per batch: any list read that started before this
      // registration is stale for every path the batch touches.
      listRev += 1;
      const conception = deps.conceptionPath() ?? '';
      for (const [path, event] of lastProjectEvent) {
        const seq = ++opSeq;
        pathOps.set(path, { seq, conception });
        if (event.op === 'unlink') continue; // tombstone — no lookup, no ticket
        tickets.set(event, { path, seq });
        pendingLookups += 1;
      }
      return tickets;
    },

    settle(ticket, next) {
      finishLookup();
      const owner = pathOps.get(ticket.path);
      if (disposed) return;
      // Owned by this exact last operation, for the conception it was
      // registered under — a later unlink, a later batch, or a conception
      // switch each defeat the held reply here.
      if (!owner || owner.seq !== ticket.seq) return;
      if (deps.conceptionPath() !== owner.conception) return;
      mutate(next);
    },

    fail(ticket) {
      // Last-good list retained; the dispatcher raises its unknown fan-out.
      void ticket;
      finishLookup();
    },
  };

  /** Release one pending lookup gate; when the last one settles and a list
   *  read was discarded meanwhile, start the one owed trailing read. */
  const finishLookup = (): void => {
    pendingLookups -= 1;
    if (pendingLookups <= 0 && listDirty) {
      listDirty = false;
      if (!disposed) void reload();
    }
  };

  const reload = async (): Promise<void> => {
    const path = deps.conceptionPath();
    if (!path) {
      setBox('list', reconcile([] as Project[], { key: 'path' }));
      setLoaded(false);
      return;
    }
    const rev = listRev;
    const list = await window.condash.listProjects();
    if (disposed) return;
    // Discard a stale result if the conception changed while the fetch was
    // in flight — applying it would paint the previous conception's list.
    if (deps.conceptionPath() !== path) return;
    // A batch registered after this read started owns the list now; so do
    // any still-pending registered lookups. Discard and owe exactly one
    // coalesced trailing read — started once the pending lookups have
    // settled, so it observes after their patches applied.
    if (rev !== listRev || pendingLookups > 0) {
      listDirty = true;
      if (pendingLookups <= 0 && !disposed) {
        listDirty = false;
        void reload();
      }
      return;
    }
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
    ownership,
  };
}
