import { createEffect, createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { SetStoreFunction } from 'solid-js/store';
import type { RepoEntry } from '@shared/types';
import { applyRepoEvents } from './repo-events';
import { rendererPerf } from './perf-renderer';

export interface ReposStoreDeps {
  /** Read the current conception path. The store clears whenever this
   *  goes null; whenever it changes, a full `reloadRepos()` runs. */
  conceptionPath: Accessor<string | null>;
  /** Surface a transient toast in the renderer (currently unused; kept
   *  symmetric with the rest of the renderer factories so additional
   *  user-visible failures can be wired here without changing the
   *  caller). */
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export interface ReposStore {
  /** The Solid store proxy. Read-only for the caller; mutations flow
   *  through `setRepos` (also exported so the Code-pane wiring + the
   *  refresh handler can do path-shaped writes when needed). */
  repos: RepoEntry[];
  setRepos: SetStoreFunction<RepoEntry[]>;
  /** True once `listRepos()` has resolved at least once for the current
   *  conception. Lets the Code pane distinguish "still loading" (show
   *  spinner) from "loaded, genuinely empty" (show the add-repo CTA). */
  reposLoaded: Accessor<boolean>;
  reloadRepos: () => Promise<void>;
}

/**
 * Run `fn` once the renderer is idle — after the first paint — falling back to
 * a macrotask where `requestIdleCallback` is unavailable (non-browser test
 * envs). Returns a canceller. Used to keep the initial `listRepos()` git
 * fan-out off the critical path of the first projects paint.
 */
function scheduleWhenIdle(fn: () => void): () => void {
  const w = globalThis as typeof globalThis & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof w.requestIdleCallback === 'function') {
    const handle = w.requestIdleCallback(fn, { timeout: 500 });
    return () => w.cancelIdleCallback?.(handle);
  }
  const handle = setTimeout(fn, 0);
  return () => clearTimeout(handle);
}

/**
 * Code-pane repos store + reloaders + structural-event wiring.
 *
 * Scalar repo events (`repo-dirty`, `repo-upstream`) flow through
 * `applyRepoEvents` directly into path-shaped `setRepos(...)` writes.
 * Set-membership events (`repo-worktrees-changed`) hand off to
 * `schedulePrimaryReload`, which debounces 250 ms and calls
 * `reloadPrimaryByPath` for the affected primary.
 *
 * Reads carry local ownership: every full/family read takes a ticket and
 * captures the repo-event revision, a response commits only while it is
 * the latest-started read of its kind and no newer competing kind has
 * committed, and a response predating a newer repo event is discarded in
 * favour of one coalesced recovery read. See the ownership block inside
 * `createReposStore` and `docs/explanation/internals.md` § "Read
 * ownership".
 *
 * Why a store and not `createResource`: scalar events can fire many
 * times per second from the watcher; the store + `reconcile` keyed on
 * `path` keeps row identity stable so any open dropdowns / popovers
 * survive the swap.
 */
export function createReposStore(deps: ReposStoreDeps): ReposStore {
  const [repos, setRepos] = createStore<RepoEntry[]>([]);
  const [reposLoaded, setReposLoaded] = createSignal(false);

  // ── Read ownership ──────────────────────────────────────────────────
  // One monotonically increasing ticket per started read (full or family),
  // the repo-event revision each read captured, and the commit bookkeeping
  // the two response kinds check against each other:
  //
  //   latestFullSeq / latestFamilySeq   the newest read STARTED per kind
  //                                     — only a latest-started read may
  //                                     commit
  //   committedFullSeq / committedFamilySeq
  //                                     the newest read COMMITTED — a full
  //                                     result is ineligible once a
  //                                     later-started family committed,
  //                                     and a family result is ineligible
  //                                     once a later full committed; a
  //                                     committing full also makes every
  //                                     older-started in-flight response
  //                                     ineligible via these checks
  //   eventRev                          bumped on every repo-event batch;
  //                                     a response predating a newer
  //                                     event is discarded and triggers
  //                                     one coalesced recovery read
  //                                     (full for a full-list
  //                                     invalidation, family for a
  //                                     family-only one)
  //
  // No shared coordinator: the ticket bookkeeping is local to this store,
  // and `applyRepoEvents`' patch path stays authoritative over any held
  // read because those events bump `eventRev`.
  let disposed = false;
  let readSeq = 0;
  let eventRev = 0;
  let latestFullSeq = 0;
  let committedFullSeq = 0;
  let familyInFlight = 0;
  let fullRecoveryQueued = false;
  const latestFamilySeq = new Map<string, number>();
  const committedFamilySeq = new Map<string, number>();
  onCleanup(() => {
    // Disposal suppresses stale applies below; the debounced primary
    // timers, the repo-event subscription and the deferred initial load
    // each carry their own onCleanup release.
    disposed = true;
  });

  /** Latest family commit across all primaries (0 when none committed). */
  const latestCommittedFamilySeq = (): number => {
    let max = 0;
    for (const seq of committedFamilySeq.values()) if (seq > max) max = seq;
    return max;
  };

  /** One coalesced recovery full read per invalidation period: queued when
   *  a full result was discarded in favour of newer family/event state,
   *  and started once no family read is in flight, so it observes after
   *  the family work settled. */
  const queueFullRecovery = (): void => {
    fullRecoveryQueued = true;
    drainFullRecovery();
  };
  const drainFullRecovery = (): void => {
    if (disposed || !fullRecoveryQueued || familyInFlight > 0) return;
    fullRecoveryQueued = false;
    void reloadRepos();
  };

  const reloadRepos = async (): Promise<void> => {
    const span = rendererPerf.startSpan();
    try {
      const path = deps.conceptionPath();
      if (!path) {
        setRepos(reconcile([] as RepoEntry[], { key: 'path' }));
        setReposLoaded(false);
        return;
      }
      const seq = ++readSeq;
      latestFullSeq = seq;
      const rev = eventRev;
      const list = await window.condash.listRepos();
      if (disposed) return;
      // Discard a stale result if the conception changed while the fetch was
      // in flight — applying it would paint the previous conception's repos.
      if (deps.conceptionPath() !== path) return;
      if (rev !== eventRev) {
        // A repo event landed during the read; its patches already applied
        // to the store and this whole list predates them. One coalesced
        // recovery read re-reads the world after the event state.
        queueFullRecovery();
        return;
      }
      if (seq !== latestFullSeq) return; // a newer full read owns the outcome
      if (latestCommittedFamilySeq() > seq) {
        // A later-started family read already committed its authoritative
        // membership; splicing this older whole list around it would
        // resurrect removed rows. Discard the whole result — no partial
        // splice — and retry one full read after the family work.
        queueFullRecovery();
        return;
      }
      setRepos(reconcile(list, { key: 'path' }));
      setReposLoaded(true);
      committedFullSeq = seq;
    } finally {
      rendererPerf.endSpan('reposReload', span);
    }
  };

  /** Per-primary partial reload. Looks up the primary entry by `path`
   *  in the current store, calls `listReposForPrimary`, and merges the
   *  result row-by-row keyed on `path`. Falls back to a full
   *  `reloadRepos()` if the primary isn't in the store (defensive — a
   *  structural event for an unknown primary is unexpected). */
  const reloadPrimaryByPath = async (repoPath: string): Promise<void> => {
    const span = rendererPerf.startSpan();
    try {
      const conception = deps.conceptionPath();
      if (!conception) return;
      const primary = repos.find((r) => !r.parent && r.path === repoPath);
      if (!primary) {
        void reloadRepos();
        return;
      }
      const seq = ++readSeq;
      latestFamilySeq.set(repoPath, seq);
      const rev = eventRev;
      familyInFlight += 1;
      let updated: RepoEntry[];
      try {
        updated = await window.condash.listReposForPrimary(primary.name);
      } finally {
        familyInFlight -= 1;
      }
      if (disposed) return;
      // Same staleness guard as reloadRepos — the conception may have
      // switched while the per-primary fetch was in flight.
      if (deps.conceptionPath() !== conception) return;
      if (rev !== eventRev) {
        // A newer repo event owns this family — one coalesced (debounced)
        // recovery read for the family only.
        schedulePrimaryReload(repoPath);
        return;
      }
      if (seq !== latestFamilySeq.get(repoPath)) return; // newer family read owns it
      if (committedFullSeq > seq) return; // a newer full committed — its list is newer
      if (updated.length === 0) {
        // Primary disappeared from condash.json between the watcher
        // event and this fetch — reload everything to reconcile.
        void reloadRepos();
        return;
      }
      // Splice the freshly-fetched family back in at the primary's *current*
      // index. Reconcile keyed on `path` does the diff/merge, preserving row
      // identity for unaffected rows and any popovers anchored on them.
      setRepos(reconcile(spliceFamilyAt(repos, primary, updated), { key: 'path' }));
      committedFamilySeq.set(repoPath, seq);
    } finally {
      // This family read settled — a queued full recovery may proceed now
      // that no family read is in flight.
      drainFullRecovery();
      rendererPerf.endSpan('reposReloadPrimary', span);
    }
  };

  // Per-primary reload debouncer. Coalesces bursts of structural events
  // for the same primary (e.g. several FS writes during one `git
  // worktree add`). 250 ms is short enough to feel instant and long
  // enough to absorb the burst.
  const primaryReloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const schedulePrimaryReload = (repoPath: string): void => {
    const existing = primaryReloadTimers.get(repoPath);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      primaryReloadTimers.delete(repoPath);
      void reloadPrimaryByPath(repoPath);
    }, 250);
    primaryReloadTimers.set(repoPath, t);
  };
  onCleanup(() => {
    for (const t of primaryReloadTimers.values()) clearTimeout(t);
    primaryReloadTimers.clear();
  });

  // Load repos once the conception path is known, but **deferred off the first
  // paint**. The heavy `listRepos()` git fan-out — one `git status` per repo +
  // worktree, ~1 s on a multi-worktree conception — used to fire synchronously
  // here and contend with the `listProjects` fetch that paints the *default*
  // (Projects) pane, stretching time-to-first-row. The Code pane isn't the
  // first surface shown, so its load now yields to `scheduleWhenIdle`: it still
  // resolves within a frame or two of paint — well before the user switches to
  // Code — so the "no Loading… flash on first Code open" benefit holds for the
  // common path, while the projects pane paints ~1 s sooner. `onRepoEvents`
  // keeps the store fresh after the first load; clearing happens only when the
  // conception path itself goes away (a conception switch), not on pane
  // switches — that flash to the empty state was a bug fixed earlier.
  let cancelDeferredLoad: (() => void) | undefined;
  createEffect(() => {
    const path = deps.conceptionPath();
    cancelDeferredLoad?.();
    cancelDeferredLoad = undefined;
    if (!path) {
      setRepos(reconcile([] as RepoEntry[], { key: 'path' }));
      setReposLoaded(false);
      return;
    }
    cancelDeferredLoad = scheduleWhenIdle(() => {
      cancelDeferredLoad = undefined;
      void reloadRepos();
    });
  });
  onCleanup(() => cancelDeferredLoad?.());

  const offRepoEvents = window.condash.onRepoEvents((events) => {
    // Drop events that arrive after the user has cleared the conception
    // (e.g. switching to a folder picker). Stray events for a *different*
    // conception's repos can't be filtered by path-prefix — repos live at
    // arbitrary FS locations from `condash.json`, not under the conception
    // tree — so the main process is responsible for tearing down watchers
    // on conception change (which it already does).
    if (!deps.conceptionPath()) return;
    // Every repo event — scalar or structural — advances the revision any
    // in-flight read captured, so a read that predates the event cannot
    // commit over the event's own store updates.
    eventRev += 1;
    const span = rendererPerf.startSpan();
    try {
      applyRepoEvents(events, {
        repos,
        setRepos,
        onWorktreesChanged: schedulePrimaryReload,
      });
    } finally {
      rendererPerf.endSpan('reposApplyEvents', span);
    }
  });
  onCleanup(offRepoEvents);

  return { repos, setRepos, reposLoaded, reloadRepos };
}

/**
 * Replace `primary`'s family rows in `current` with `updated`, keeping the
 * family anchored at the primary's current index. Appending the updated
 * family to the tail (the previous behaviour) would jump it to the bottom
 * of the list on every structural watcher event — visible to the user as
 * the Code panel reshuffling on every `git worktree add/remove` or
 * `.git/HEAD` write.
 *
 * `updated` is treated as authoritative for the family's membership: a
 * submodule absent from `updated` is genuinely gone (e.g. removed from
 * `condash.json`) and is not preserved from `current`. If `primary` isn't
 * in `current` (defensive: shouldn't happen because the caller already
 * resolves it from the store), the family is appended at the tail.
 */
export function spliceFamilyAt(
  current: readonly RepoEntry[],
  primary: Pick<RepoEntry, 'name' | 'path'>,
  updated: readonly RepoEntry[],
): RepoEntry[] {
  const updatedPaths = new Set(updated.map((e) => e.path));
  const isFamily = (r: RepoEntry): boolean =>
    updatedPaths.has(r.path) || r.parent === primary.name || r.path === primary.path;
  const primaryIdx = current.findIndex((r) => r.path === primary.path);
  if (primaryIdx === -1) {
    return [...current.filter((r) => !isFamily(r)), ...updated];
  }
  const before = current.slice(0, primaryIdx).filter((r) => !isFamily(r));
  const after = current.slice(primaryIdx + 1).filter((r) => !isFamily(r));
  return [...before, ...updated, ...after];
}
