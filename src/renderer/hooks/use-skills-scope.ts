import { createSignal } from 'solid-js';
import type { SkillScope } from '@shared/types';

export interface UseSkillsScopeDeps {
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export interface UseSkillsScope {
  /** Active Skills scope. Defaults to `local` (conception); the
   *  hydrate-from-IPC `then` replaces it with the persisted value. */
  skillsActiveScope: () => SkillScope;
  handleSkillsScopeSelect: (scope: SkillScope) => void;
}

/**
 * Local/global scope toggle for the Skills pane. Mirrors `useSkillsTab` but
 * for the scope axis. Kept separate (and created before the skills stores)
 * because the stores' fetchers read `skillsActiveScope()` — reading it inside
 * the fetcher is what makes each store reload when the scope flips.
 */
export function useSkillsScope(deps: UseSkillsScopeDeps): UseSkillsScope {
  const [skillsActiveScope, setSkillsActiveScope] = createSignal<SkillScope>('local');
  void window.condash
    .getSkillsActiveScope()
    .then((scope) => setSkillsActiveScope(scope))
    .catch((err) =>
      deps.flashToast(`Could not load Skills scope: ${(err as Error).message}`, 'error'),
    );

  const handleSkillsScopeSelect = (scope: SkillScope): void => {
    setSkillsActiveScope(scope);
    void window.condash.setSkillsActiveScope(scope).catch((err) => {
      deps.flashToast(`Could not persist Skills scope: ${(err as Error).message}`, 'error');
    });
  };

  return { skillsActiveScope, handleSkillsScopeSelect };
}
