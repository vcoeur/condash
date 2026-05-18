import { onCleanup } from 'solid-js';
import type { SkillNode, SkillTab, Project } from '@shared/types';
import { applyTreeEvents } from '../tree-events';
import type { createTreeStore } from '../tree-store';

type SkillsStores = Record<SkillTab, ReturnType<typeof createTreeStore<SkillNode>>>;

export interface UseTreeEventsDeps {
  mutateProjects: (mutator: (items: Project[]) => Project[]) => void;
  reloadProjects: () => Promise<void>;
  knowledgeStore: { reload: () => Promise<void> };
  resourcesStore: { reload: () => Promise<void> };
  skillsStores: SkillsStores;
  reloadConfig: () => Promise<void>;
  reloadRepos: () => Promise<void>;
}

/** Subscribe to the main-process tree-event stream and fan it out across
 *  the per-domain stores. The renderer can't know which Skills tab(s) a
 *  tree event affects without duplicating the path-routing logic in the
 *  main process, so all three skills trees reload on any skills event;
 *  each fetcher is cheap and operates against a small tree. */
export function useTreeEvents(deps: UseTreeEventsDeps): void {
  const unsubscribe = window.condash.onTreeEvents((events) => {
    void applyTreeEvents(events, {
      mutateProjects: deps.mutateProjects,
      reloadProjects: deps.reloadProjects,
      reloadKnowledge: deps.knowledgeStore.reload,
      reloadResources: deps.resourcesStore.reload,
      reloadSkills: () =>
        Promise.all([
          deps.skillsStores.generic.reload(),
          deps.skillsStores.claude.reload(),
          deps.skillsStores.kimi.reload(),
        ]).then(() => undefined),
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
