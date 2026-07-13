import { createSignal } from 'solid-js';
import type { ProjectCardTitleFont } from '@shared/types';
import { DEFAULT_PROJECT_CARD_TITLE_FONT } from '@shared/types';
import { getBootstrap } from '../bootstrap';

/** The font-family stack each choice maps to. `default` is `null` — no CSS
 *  variable is set, so the project-card title falls through to the theme's
 *  editorial `--font-display` face (an unset preference changes nothing). The
 *  `sans`/`mono` stacks reference the existing font tokens so they never drift
 *  from `--font-ui` / `--font-mono`; `system` uses the platform UI face, which
 *  needs no bundling. */
export const PROJECT_CARD_TITLE_FONT_STACKS: Record<ProjectCardTitleFont, string | null> = {
  default: null,
  sans: 'var(--font-ui)',
  mono: 'var(--font-mono)',
  system: 'system-ui, -apple-system, "Segoe UI", "Liberation Sans", sans-serif',
};

/** Push the chosen project-card title font onto `:root` as
 *  `--project-card-title-font`. `projects-pane.css` reads it with a
 *  `var(--font-display)` fallback, so `default` (which removes the variable)
 *  restores the theme face exactly. A `data-project-card-title-font` attribute
 *  is set alongside so the stylesheet can drop the serif-tuned faux-weight
 *  (stroke + shadow) for the non-serif overrides. */
function applyProjectCardTitleFont(font: ProjectCardTitleFont): void {
  const root = document.documentElement;
  const stack = PROJECT_CARD_TITLE_FONT_STACKS[font];
  if (stack) {
    root.style.setProperty('--project-card-title-font', stack);
    root.dataset.projectCardTitleFont = font;
  } else {
    root.style.removeProperty('--project-card-title-font');
    delete root.dataset.projectCardTitleFont;
  }
}

export interface UseProjectCardTitleFont {
  projectCardTitleFont: () => ProjectCardTitleFont;
  /** Refresh the live `--project-card-title-font` variable. The Settings modal
   *  commits through here so card titles restyle without a reload; the modal
   *  itself persists via patchSettings, so this callback is UI-only (mirrors
   *  `handleCardMinWidthChange`). */
  handleProjectCardTitleFontChange: (font: ProjectCardTitleFont) => void;
}

export function useProjectCardTitleFont(): UseProjectCardTitleFont {
  const [projectCardTitleFont, setProjectCardTitleFont] = createSignal<ProjectCardTitleFont>(
    DEFAULT_PROJECT_CARD_TITLE_FONT,
  );
  applyProjectCardTitleFont(projectCardTitleFont());
  void getBootstrap()
    .then((boot) => {
      setProjectCardTitleFont(boot.projectCardTitleFont);
      applyProjectCardTitleFont(boot.projectCardTitleFont);
    })
    // A failed bootstrap must not leave an unhandled rejection: the default
    // applied above stays in effect. This hook has no toast channel, so log
    // for the console like use-card-min-width.
    .catch((err) => console.error('hydration: project card title font bootstrap failed', err));

  const handleProjectCardTitleFontChange = (font: ProjectCardTitleFont): void => {
    setProjectCardTitleFont(font);
    applyProjectCardTitleFont(font);
  };

  return { projectCardTitleFont, handleProjectCardTitleFontChange };
}
