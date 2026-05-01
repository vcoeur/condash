import type { Project, TreeEvent } from '@shared/types';
import type { Resource } from 'solid-js';

type Mutator = (next: (items: Project[] | undefined) => Project[]) => void;

export interface TreeEventsDeps {
  /** SolidJS resource mutator for the projects list. */
  mutate: Mutator;
  /** Bump the renderer's `refreshKey` to force a full re-fetch of the
   *  resources still keyed on it (knowledge, openWithSlots, terminalPrefs). */
  bumpRefreshKey: () => void;
  /** Trigger a refetch of the repos resource. Repos dropped their
   *  `refreshKey` dependency in v2.8.0 (in-place updates flow through
   *  `repo-events` instead) so config / unknown events that may have
   *  changed the repo list need an explicit nudge. */
  refetchRepos: () => void;
}

/** Apply chokidar-driven tree events to the projects resource. Handles
 *  per-project patch, deletes, and falls through to a full refresh when
 *  knowledge / config changed or an unknown event arrived. */
export async function applyTreeEvents(events: TreeEvent[], deps: TreeEventsDeps): Promise<void> {
  let knowledgeOrConfigDirty = false;
  let unknownSeen = false;

  for (const event of events) {
    if (event.kind === 'unknown') {
      unknownSeen = true;
      break;
    }
    if (event.kind === 'config' || event.kind === 'knowledge') {
      knowledgeOrConfigDirty = true;
      continue;
    }
    // Per-project patch.
    try {
      if (event.op === 'unlink') {
        deps.mutate((items) => (items ?? []).filter((p) => p.path !== event.path));
        continue;
      }
      const project = await window.condash.getProject(event.path);
      if (!project) {
        deps.mutate((items) => (items ?? []).filter((p) => p.path !== event.path));
        continue;
      }
      deps.mutate((items) => {
        const list = items ?? [];
        const idx = list.findIndex((p) => p.path === project.path);
        if (idx === -1) return [...list, project];
        const next = list.slice();
        next[idx] = project;
        return next;
      });
    } catch {
      unknownSeen = true;
    }
  }

  if (unknownSeen || knowledgeOrConfigDirty) {
    deps.bumpRefreshKey();
    deps.refetchRepos();
  }
}

// `Resource` is re-exported here only so callers don't need a second import
// when they already type their resources from this module.
export type { Resource };
