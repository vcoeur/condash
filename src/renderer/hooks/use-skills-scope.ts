import { createSignal } from 'solid-js';
import type { SkillScope } from '@shared/types';
import { getBootstrap } from '../bootstrap';

export interface UseSkillsScopeDeps {
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export interface UseSkillsScope {
  /** Active Skills scope. Defaults to `conception`; the
   *  hydrate-from-IPC `then` replaces it with the persisted value. */
  skillsActiveScope: () => SkillScope;
  handleSkillsScopeSelect: (scope: SkillScope) => void;
}

/**
 * Conception/user scope toggle for the Skills pane. Created before the
 * skills store because the store's fetcher reads `skillsActiveScope()`
 * — reading it inside the fetcher is what makes the store reload when
 * the scope flips.
 */
export function useSkillsScope(deps: UseSkillsScopeDeps): UseSkillsScope {
  const [skillsActiveScope, setSkillsActiveScope] = createSignal<SkillScope>('conception');
  void getBootstrap()
    .then((boot) => setSkillsActiveScope(boot.skillsActiveScope))
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
