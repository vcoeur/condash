import { createSignal } from 'solid-js';
import type { CardMinWidthPrefs } from '@shared/types';
import { DEFAULT_CARD_MIN_WIDTH } from '@shared/types';
import { getBootstrap } from '../bootstrap';

/** Push the user-configured card grid min-widths onto `:root` as CSS
 *  pixels. The pane stylesheets read
 *  `--card-min-{projects,code,knowledge,resources,skills,logs,tasks,deliverables}`
 *  with a literal fallback that matches DEFAULT_CARD_MIN_WIDTH, so a
 *  partial prefs object falls back per-key automatically. */
function applyCardMinWidth(prefs: Required<CardMinWidthPrefs>): void {
  const root = document.documentElement;
  // Clamp to the documented [120, 2400] range — guards against a hand-edited
  // settings.json with out-of-range values reaching the CSS variables and
  // breaking the grid (e.g. `{ projects: 10 }` → unreadable).
  const clamp = (n: number, fallback: number): number => {
    if (!Number.isFinite(n)) return fallback;
    if (n < 120) return 120;
    if (n > 2400) return 2400;
    return n;
  };
  root.style.setProperty('--card-min-projects', `${clamp(prefs.projects, 650)}px`);
  root.style.setProperty('--card-min-code', `${clamp(prefs.code, 650)}px`);
  root.style.setProperty('--card-min-knowledge', `${clamp(prefs.knowledge, 520)}px`);
  root.style.setProperty('--card-min-resources', `${clamp(prefs.resources, 280)}px`);
  root.style.setProperty('--card-min-skills', `${clamp(prefs.skills, 280)}px`);
  root.style.setProperty('--card-min-logs', `${clamp(prefs.logs, 400)}px`);
  root.style.setProperty('--card-min-tasks', `${clamp(prefs.tasks, 340)}px`);
  root.style.setProperty('--card-min-deliverables', `${clamp(prefs.deliverables, 340)}px`);
}

export interface UseCardMinWidth {
  cardMinWidth: () => Required<CardMinWidthPrefs>;
  /** Refresh the live card-min-width CSS variables. Settings modal commits
   *  go through here on blur so grids resize without a reload. The modal
   *  itself persists via patchSettings / patchConfig, so this callback is
   *  UI-only — calling setCardMinWidth in the modal would queue a second
   *  write that races the CAS baseline. */
  handleCardMinWidthChange: (patch: CardMinWidthPrefs) => void;
}

export function useCardMinWidth(): UseCardMinWidth {
  // Card min-widths drive the n→n+1 reflow on the three pane grids.
  // Track them in a signal so the settings modal can publish updates back
  // through `setCardMinWidth` and the CSS variables react in the same frame.
  const [cardMinWidth, setCardMinWidth] = createSignal<Required<CardMinWidthPrefs>>({
    ...DEFAULT_CARD_MIN_WIDTH,
  });
  applyCardMinWidth(cardMinWidth());
  void getBootstrap().then((boot) => {
    setCardMinWidth(boot.cardMinWidth);
    applyCardMinWidth(boot.cardMinWidth);
  });

  const handleCardMinWidthChange = (patch: CardMinWidthPrefs): void => {
    const next: Required<CardMinWidthPrefs> = { ...cardMinWidth(), ...patch };
    setCardMinWidth(next);
    applyCardMinWidth(next);
  };

  return { cardMinWidth, handleCardMinWidthChange };
}
