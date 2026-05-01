/**
 * Apply per-repo FS-watcher events to the repos resource. Mirror of
 * `tree-events.ts` but for the Code tab. The point is to update one
 * field of one entry in place — the Solid `<For>` reconciler keeps the
 * RepoRow component instance, so its open dropdowns / popovers / focus
 * state survive the update. This is the direct fix for the disruption
 * the periodic 15 s `refreshKey` bump caused (commit 0c36e2b).
 */
import type { RepoEntry, RepoEvent, UpstreamStatus, Worktree } from '@shared/types';

type Mutator = (next: (items: RepoEntry[] | undefined) => RepoEntry[]) => void;

export interface RepoEventsDeps {
  /** SolidJS resource mutator for the repos list. */
  mutateRepos: Mutator;
}

/** Shallow equality for `UpstreamStatus` so we can short-circuit when the
 *  recompute returns the same value (very common — most ticks fire from
 *  worktree edits that don't change upstream). Avoids a needless object
 *  reallocation that would invalidate Solid's structural sharing. */
function sameUpstream(a: UpstreamStatus | null | undefined, b: UpstreamStatus | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a.ahead === b.ahead && a.upstreamRef === b.upstreamRef;
}

export function applyRepoEvents(events: RepoEvent[], deps: RepoEventsDeps): void {
  if (events.length === 0) return;
  const dirtyByPath = new Map<string, number | null>();
  const upstreamByPath = new Map<string, UpstreamStatus | null>();
  for (const event of events) {
    if (event.kind === 'repo-dirty') {
      dirtyByPath.set(event.path, event.dirty);
    } else if (event.kind === 'repo-upstream') {
      upstreamByPath.set(event.path, event.upstream);
    }
  }
  if (dirtyByPath.size === 0 && upstreamByPath.size === 0) return;

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
          const wtUpstream = upstreamByPath.get(wt.path);
          const dirtyChanged = wtDirty !== undefined && wtDirty !== wt.dirty;
          const upstreamChanged =
            wtUpstream !== undefined && !sameUpstream(wt.upstream, wtUpstream);
          if (!dirtyChanged && !upstreamChanged) return wt;
          wtChanged = true;
          const patch: Partial<Worktree> = {};
          if (dirtyChanged) patch.dirty = wtDirty;
          if (upstreamChanged) patch.upstream = wtUpstream;
          return { ...wt, ...patch };
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
