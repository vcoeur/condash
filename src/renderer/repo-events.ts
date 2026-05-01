/**
 * Apply per-repo FS-watcher events to the repos resource. Mirror of
 * `tree-events.ts` but for the Code tab. The point is to update one
 * field of one entry in place — the Solid `<For>` reconciler keeps the
 * RepoRow component instance, so its open dropdowns / popovers / focus
 * state survive the update. This is the direct fix for the disruption
 * the periodic 15 s `refreshKey` bump caused (commit 0c36e2b).
 */
import type { RepoEntry, RepoEvent, Worktree } from '@shared/types';

type Mutator = (next: (items: RepoEntry[] | undefined) => RepoEntry[]) => void;

export interface RepoEventsDeps {
  /** SolidJS resource mutator for the repos list. */
  mutateRepos: Mutator;
}

export function applyRepoEvents(events: RepoEvent[], deps: RepoEventsDeps): void {
  if (events.length === 0) return;
  const dirtyByPath = new Map<string, number | null>();
  for (const event of events) {
    if (event.kind !== 'repo-dirty') continue;
    dirtyByPath.set(event.path, event.dirty);
  }
  if (dirtyByPath.size === 0) return;

  deps.mutateRepos((items) => {
    const list = items ?? [];
    let listChanged = false;
    const next = list.map((repo) => {
      const repoDirty = dirtyByPath.get(repo.path);
      let entry = repo;
      let entryChanged = false;
      if (repoDirty !== undefined && repoDirty !== repo.dirty) {
        entry = { ...entry, dirty: repoDirty };
        entryChanged = true;
      }
      if (entry.worktrees) {
        let wtChanged = false;
        const nextWorktrees: Worktree[] = entry.worktrees.map((wt) => {
          const wtDirty = dirtyByPath.get(wt.path);
          if (wtDirty === undefined || wtDirty === wt.dirty) return wt;
          wtChanged = true;
          return { ...wt, dirty: wtDirty };
        });
        if (wtChanged) {
          entry = { ...entry, worktrees: nextWorktrees };
          entryChanged = true;
        }
      }
      if (entryChanged) listChanged = true;
      return entry;
    });
    return listChanged ? next : list;
  });
}
