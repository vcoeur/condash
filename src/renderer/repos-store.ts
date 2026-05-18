import { createEffect, createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import type { SetStoreFunction } from 'solid-js/store';
import type { RepoEntry } from '@shared/types';
import { applyRepoEvents } from './repo-events';

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
 * Code-pane repos store + reloaders + structural-event wiring.
 *
 * Scalar repo events (`repo-dirty`, `repo-upstream`) flow through
 * `applyRepoEvents` directly into path-shaped `setRepos(...)` writes.
 * Set-membership events (`repo-worktrees-changed`) hand off to
 * `schedulePrimaryReload`, which debounces 250 ms and calls
 * `reloadPrimaryByPath` for the affected primary.
 *
 * Why a store and not `createResource`: scalar events can fire many
 * times per second from the watcher; the store + `reconcile` keyed on
 * `path` keeps row identity stable so any open dropdowns / popovers
 * survive the swap.
 */
export function createReposStore(deps: ReposStoreDeps): ReposStore {
  const [repos, setRepos] = createStore<RepoEntry[]>([]);
  const [reposLoaded, setReposLoaded] = createSignal(false);

  const reloadRepos = async (): Promise<void> => {
    const path = deps.conceptionPath();
    if (!path) {
      setRepos(reconcile([] as RepoEntry[], { key: 'path' }));
      setReposLoaded(false);
      return;
    }
    const list = await window.condash.listRepos();
    setRepos(reconcile(list, { key: 'path' }));
    setReposLoaded(true);
  };

  /** Per-primary partial reload. Looks up the primary entry by `path`
   *  in the current store, calls `listReposForPrimary`, and merges the
   *  result row-by-row keyed on `path`. Falls back to a full
   *  `reloadRepos()` if the primary isn't in the store (defensive — a
   *  structural event for an unknown primary is unexpected). */
  const reloadPrimaryByPath = async (repoPath: string): Promise<void> => {
    if (!deps.conceptionPath()) return;
    const primary = repos.find((r) => !r.parent && r.path === repoPath);
    if (!primary) {
      void reloadRepos();
      return;
    }
    const updated = await window.condash.listReposForPrimary(primary.name);
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

  // Load repos as soon as the conception path is known — not gated on
  // the Code pane being open. Two reasons:
  //   1. The first paint of the Code pane is instant instead of showing
  //      a "Loading…" flash while `listRepos()` fans out one `git
  //      status` per repo + worktree.
  //   2. Subsequent pane switches don't re-pay the cost — the cached
  //      store stays populated, and `onRepoEvents` keeps it fresh.
  // Clearing only happens when the conception path itself goes away
  // (e.g. the user picks a different conception), not on every pane
  // switch — that flash to the empty state was the bug fixed here.
  createEffect(() => {
    const path = deps.conceptionPath();
    if (!path) {
      setRepos(reconcile([] as RepoEntry[], { key: 'path' }));
      setReposLoaded(false);
      return;
    }
    void reloadRepos();
  });

  const offRepoEvents = window.condash.onRepoEvents((events) => {
    // Drop events that arrive after the user has cleared the conception
    // (e.g. switching to a folder picker). Stray events for a *different*
    // conception's repos can't be filtered by path-prefix — repos live at
    // arbitrary FS locations from `condash.json`, not under the conception
    // tree — so the main process is responsible for tearing down watchers
    // on conception change (which it already does).
    if (!deps.conceptionPath()) return;
    applyRepoEvents(events, {
      repos,
      setRepos,
      onWorktreesChanged: schedulePrimaryReload,
    });
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
