import { createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { getBootstrap } from './bootstrap';

export interface BranchFilterStoreDeps {
  /** Surface a transient toast in the renderer (used for persist failures). */
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export interface BranchFilterStore {
  /** Branches pinned by the Code-pane top-of-pane filter. With `stickyAll`
   *  on, this set is shadowed — every branch is shown regardless. With
   *  `stickyAll` off and the set empty, only the primary row is visible. */
  selectedBranches: Accessor<ReadonlySet<string>>;
  /** True when the popover is in "All (sticky)" mode: every branch is
   *  shown and new ones auto-track in. Issue #169. */
  stickyAll: Accessor<boolean>;
  /** Toggle a single branch. Implicitly switches to custom mode (turns
   *  `stickyAll` off) — otherwise the tick would have no visible effect. */
  toggleBranch: (branch: string) => void;
  /** Switch into All (sticky) mode. Does not touch the stored set so the
   *  user's prior custom selection is preserved if they switch back. */
  setAllSticky: () => void;
  /** Switch into "only main" mode: clear the set and turn off sticky-all. */
  setNone: () => void;
}

/**
 * Persistence layer for the Code-pane branch filter. The shape mirrors
 * `tree-expansion.ts` — hydrate from IPC on construction, keep an
 * in-memory signal as the source of truth for the session, and
 * fire-and-forget writes back to settings.json on every change. A write
 * failure surfaces as a toast but the in-memory state stays
 * authoritative so the UI never freezes against a flaky disk.
 *
 * Three persisted modes (issue #169):
 *   - All (sticky)     stickyAll=true               every branch shown
 *   - Custom           stickyAll=false, set non-∅   primary + ticked
 *   - None / only main stickyAll=false, set ∅       primary only
 */
export function createBranchFilterStore(deps: BranchFilterStoreDeps): BranchFilterStore {
  const [selectedBranches, setSelectedBranches] = createSignal<ReadonlySet<string>>(new Set());
  const [stickyAll, setStickyAllSignal] = createSignal<boolean>(true);

  // Hydrate from the one-shot boot bundle (both values arrive together). The
  // sticky-all default is computed in main (true when the user had no explicit
  // selection) so the first paint matches the old "show every branch" behaviour
  // for upgrading installs.
  void getBootstrap()
    .then((boot) => {
      setSelectedBranches(new Set(boot.selectedBranches));
      setStickyAllSignal(boot.branchFilterStickyAll);
    })
    // A failed bootstrap must not leave an unhandled rejection: keep the
    // defaults (empty set + sticky-all "show every branch") and toast (B2).
    .catch((err) =>
      deps.flashToast(`Could not load branch filter: ${(err as Error).message}`, 'error'),
    );

  const persistSet = (next: ReadonlySet<string>): void => {
    void window.condash.setSelectedBranches(Array.from(next)).catch((err) => {
      deps.flashToast(`Could not persist branch filter: ${(err as Error).message}`, 'error');
    });
  };

  const persistSticky = (value: boolean): void => {
    void window.condash.setBranchFilterStickyAll(value).catch((err) => {
      deps.flashToast(`Could not persist branch filter mode: ${(err as Error).message}`, 'error');
    });
  };

  const toggleBranch = (branch: string): void => {
    // Ticking a branch always means "I'm customising the set" — drop
    // sticky-all so the tick takes visible effect.
    if (stickyAll()) {
      setStickyAllSignal(false);
      persistSticky(false);
    }
    const next = new Set(selectedBranches());
    if (next.has(branch)) next.delete(branch);
    else next.add(branch);
    setSelectedBranches(next);
    persistSet(next);
  };

  const setAllSticky = (): void => {
    setStickyAllSignal(true);
    persistSticky(true);
  };

  const setNone = (): void => {
    if (stickyAll()) {
      setStickyAllSignal(false);
      persistSticky(false);
    }
    if (selectedBranches().size > 0) {
      const empty: ReadonlySet<string> = new Set<string>();
      setSelectedBranches(empty);
      persistSet(empty);
    }
  };

  return {
    selectedBranches,
    stickyAll,
    toggleBranch,
    setAllSticky,
    setNone,
  };
}
