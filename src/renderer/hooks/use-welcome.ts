import { createSignal } from 'solid-js';
import type { HelpDoc } from '../help-modal';
import { getBootstrap } from '../bootstrap';

export interface UseWelcomeDeps {
  conceptionPath: () => string | null;
  projectsLoaded: () => boolean;
  projects: () => readonly unknown[];
  knowledgeIsEmpty: () => boolean;
  setHelpDoc: (doc: HelpDoc | null) => void;
}

export interface UseWelcome {
  welcomeDismissed: () => boolean;
  /** Welcome screen shows on a tree with no items and no knowledge
   *  entries, unless the user dismissed it. Once content lands, it
   *  stops appearing automatically; the dismiss is for users who
   *  never want to see it again. */
  shouldShowWelcome: () => boolean;
  handleWelcomeOpenTree: () => void;
  handleWelcomeTakeTour: () => void;
  handleWelcomeOpenDocs: () => void;
  handleWelcomeDismiss: () => void;
}

export function useWelcome(deps: UseWelcomeDeps): UseWelcome {
  const [welcomeDismissed, setWelcomeDismissed] = createSignal<boolean>(false);
  void getBootstrap()
    .then((boot) => setWelcomeDismissed(boot.welcomeDismissed))
    .catch((err) => console.error('hydration: getWelcomeDismissed failed', err));

  const shouldShowWelcome = (): boolean => {
    if (welcomeDismissed()) return false;
    if (!deps.conceptionPath()) return false;
    // Wait for the first projects load — otherwise the welcome screen
    // flashes for one frame on cold start before the IPC resolves.
    if (!deps.projectsLoaded()) return false;
    if (deps.projects().length > 0) return false;
    if (!deps.knowledgeIsEmpty()) return false;
    return true;
  };

  const handleWelcomeOpenTree = (): void => {
    void window.condash.openConceptionDirectory();
  };

  const handleWelcomeTakeTour = (): void => {
    deps.setHelpDoc('welcome');
  };

  const handleWelcomeOpenDocs = (): void => {
    void window.condash.openExternal('https://condash.vcoeur.com');
  };

  const handleWelcomeDismiss = (): void => {
    setWelcomeDismissed(true);
    void window.condash.setWelcomeDismissed(true);
  };

  return {
    welcomeDismissed,
    shouldShowWelcome,
    handleWelcomeOpenTree,
    handleWelcomeTakeTour,
    handleWelcomeOpenDocs,
    handleWelcomeDismiss,
  };
}
