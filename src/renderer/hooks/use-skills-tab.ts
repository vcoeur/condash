import { createSignal } from 'solid-js';
import type { SkillNode, SkillTab } from '@shared/types';
import type { createTreeStore } from '../tree-store';

type SkillsStores = Record<SkillTab, ReturnType<typeof createTreeStore<SkillNode>>>;

export interface UseSkillsTabDeps {
  skillsStores: SkillsStores;
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export interface UseSkillsTab {
  /** Active Skills sub-tab. Defaults to `claude` to preserve pre-tabs
   *  behaviour; the hydrate-from-IPC `then` replaces it with the
   *  persisted value. */
  skillsActiveTab: () => SkillTab;
  handleSkillsTabSelect: (tab: SkillTab) => void;
  activeSkillsRoot: () => ReturnType<ReturnType<typeof createTreeStore<SkillNode>>['root']>;
}

export function useSkillsTab(deps: UseSkillsTabDeps): UseSkillsTab {
  const [skillsActiveTab, setSkillsActiveTab] = createSignal<SkillTab>('claude');
  void window.condash
    .getSkillsActiveTab()
    .then((tab) => setSkillsActiveTab(tab))
    .catch((err) =>
      deps.flashToast(`Could not load Skills tab: ${(err as Error).message}`, 'error'),
    );

  const handleSkillsTabSelect = (tab: SkillTab): void => {
    setSkillsActiveTab(tab);
    void window.condash.setSkillsActiveTab(tab).catch((err) => {
      deps.flashToast(`Could not persist Skills tab: ${(err as Error).message}`, 'error');
    });
  };

  const activeSkillsRoot = () => deps.skillsStores[skillsActiveTab()].root();

  return { skillsActiveTab, handleSkillsTabSelect, activeSkillsRoot };
}
