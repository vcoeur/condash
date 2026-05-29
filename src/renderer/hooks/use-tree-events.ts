import { onCleanup } from 'solid-js';
import type { SkillNode, Project } from '@shared/types';
import { applyTreeEvents } from '../tree-events';
import type { createTreeStore } from '../tree-store';

export interface UseTreeEventsDeps {
  mutateProjects: (mutator: (items: Project[]) => Project[]) => void;
  reloadProjects: () => Promise<void>;
  knowledgeStore: { reload: () => Promise<void> };
  resourcesStore: { reload: () => Promise<void> };
  skillsStore: ReturnType<typeof createTreeStore<SkillNode>>;
  reloadConfig: () => Promise<void>;
  reloadRepos: () => Promise<void>;
}

/** Subscribe to the main-process tree-event stream and fan it out across
 *  the per-domain stores. The single skills store reloads on any skills
 *  event — the fetcher is cheap and the tree is small. */
export function useTreeEvents(deps: UseTreeEventsDeps): void {
  const unsubscribe = window.condash.onTreeEvents((events) => {
    void applyTreeEvents(events, {
      mutateProjects: deps.mutateProjects,
      reloadProjects: deps.reloadProjects,
      reloadKnowledge: deps.knowledgeStore.reload,
      reloadResources: deps.resourcesStore.reload,
      reloadSkills: () => deps.skillsStore.reload(),
      reloadConfig: deps.reloadConfig,
      // Repos do not subscribe to tree events directly — repo-events
      // covers scalar / structural updates; `config` is the only path
      // through which the repo list itself can change.
      refetchRepos: () => {
        void deps.reloadRepos();
      },
    });
  });
  onCleanup(unsubscribe);
}
