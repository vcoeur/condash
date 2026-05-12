import { createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';

export interface BranchFilterStoreDeps {
  /** Surface a transient toast in the renderer (used for persist failures). */
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export interface BranchFilterStore {
  /** Branches pinned by the Code-pane top-of-pane filter. Empty set is
   *  the on-purpose first-load state (only primary worktrees visible). */
  selectedBranches: Accessor<ReadonlySet<string>>;
  /** Toggle a single branch in the pinned set and persist. Fire-and-forget. */
  toggleBranch: (branch: string) => void;
}

/**
 * Persistence layer for the Code-pane branch filter. The shape mirrors
 * `tree-expansion.ts` — hydrate from IPC on construction, keep an
 * in-memory signal as the source of truth for the session, and
 * fire-and-forget writes back to settings.json on every change. A write
 * failure surfaces as a toast but the in-memory state stays
 * authoritative so the UI never freezes against a flaky disk.
 */
export function createBranchFilterStore(deps: BranchFilterStoreDeps): BranchFilterStore {
  const [selectedBranches, setSelectedBranches] = createSignal<ReadonlySet<string>>(new Set());
  void window.condash.getSelectedBranches().then((list) => {
    setSelectedBranches(new Set(list));
  });

  const persist = (next: ReadonlySet<string>): void => {
    void window.condash.setSelectedBranches(Array.from(next)).catch((err) => {
      deps.flashToast(`Could not persist branch filter: ${(err as Error).message}`, 'error');
    });
  };

  const toggleBranch = (branch: string): void => {
    const next = new Set(selectedBranches());
    if (next.has(branch)) next.delete(branch);
    else next.add(branch);
    setSelectedBranches(next);
    persist(next);
  };

  return {
    selectedBranches,
    toggleBranch,
  };
}
