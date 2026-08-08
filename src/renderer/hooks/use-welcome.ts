import { createEffect, createSignal } from 'solid-js';
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
   *  never want to see it again. A template init additionally marks
   *  the welcome to show once even though the seeded tree has
   *  knowledge entries. */
  shouldShowWelcome: () => boolean;
  handleWelcomeOpenTree: () => void;
  handleWelcomeTakeTour: () => void;
  handleWelcomeOpenDocs: () => void;
  handleWelcomeDismiss: () => void;
  /** Called after a successful template init: marks the welcome to show
   *  once (this session and the next launch), so a freshly initialised
   *  tree still meets the orientation surface. */
  handleTemplateInit: () => void;
}

export function useWelcome(deps: UseWelcomeDeps): UseWelcome {
  const [welcomeDismissed, setWelcomeDismissed] = createSignal<boolean>(false);
  // Session-scoped one-shot marker: `true` once a template init has happened
  // and the welcome has not yet been displayed for it. Consumed only by
  // persisting `welcome.initShown = true` — the signal itself never flips, so
  // consuming can't unmount a welcome that is on screen.
  const [welcomeInitPending, setWelcomeInitPending] = createSignal<boolean>(false);
  void getBootstrap()
    .then((boot) => {
      setWelcomeDismissed(boot.welcomeDismissed);
      setWelcomeInitPending(!boot.welcomeInitShown);
    })
    .catch((err) => console.error('hydration: getWelcomeDismissed failed', err));

  // One-shot persistence: the moment the welcome renders after a template
  // init, write the "shown" marker so later launches skip it. Fire-and-forget
  // and idempotent — a welcome that remounts writes the same value again.
  createEffect(() => {
    if (welcomeInitPending() && shouldShowWelcome()) {
      void window.condash.setWelcomeInitShown(true);
    }
  });

  const shouldShowWelcome = (): boolean => {
    if (welcomeDismissed()) return false;
    if (!deps.conceptionPath()) return false;
    // Wait for the first projects load — otherwise the welcome screen
    // flashes for one frame on cold start before the IPC resolves.
    if (!deps.projectsLoaded()) return false;
    if (deps.projects().length > 0) return false;
    if (deps.knowledgeIsEmpty()) return true;
    // Template init seeds knowledge/, so the usual emptiness test would skip
    // the welcome on the primary new-user path. The one-shot marker shows it
    // once regardless.
    return welcomeInitPending();
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

  const handleTemplateInit = (): void => {
    setWelcomeInitPending(true);
    void window.condash.setWelcomeInitShown(false);
  };

  return {
    welcomeDismissed,
    shouldShowWelcome,
    handleWelcomeOpenTree,
    handleWelcomeTakeTour,
    handleWelcomeOpenDocs,
    handleWelcomeDismiss,
    handleTemplateInit,
  };
}
