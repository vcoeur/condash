import { createSignal } from 'solid-js';
import type { UiFont, UiFontCategory, UiFontPrefs } from '@shared/types';
import { DEFAULT_UI_FONTS, UI_FONT_CATEGORIES } from '@shared/types';
import { getBootstrap } from '../bootstrap';

/** The base font stack each choice maps to. `default` is `null` — no CSS
 *  variable is set, so the category's elements fall through to their own base
 *  face (an unset preference changes nothing). The stacks reference the
 *  `--font-*-base` brand tokens (never the category-aware role tokens) so a
 *  choice can't feed back into itself; `system` uses the platform UI face,
 *  which needs no bundling. */
export const UI_FONT_STACKS: Record<UiFont, string | null> = {
  default: null,
  sans: 'var(--font-sans-base)',
  mono: 'var(--font-mono-base)',
  system: 'var(--font-system-base)',
};

/** CSS slug per category. Config keys are camelCase; the CSS variables and
 *  data attributes they drive are kebab-case (`--ui-font-card-title`,
 *  `data-ui-font-card-title`). */
const CATEGORY_CSS: Record<UiFontCategory, string> = {
  cardTitle: 'card-title',
  heading: 'heading',
  body: 'body',
  code: 'code',
  terminal: 'terminal',
};

/** Push each category's choice onto `:root` as `--ui-font-<category>`. The
 *  stylesheets read it with a base-face fallback, so `default` (which removes
 *  the variable) restores that surface's face exactly. A matching
 *  `data-ui-font-<category>` attribute is set alongside so the stylesheet can
 *  drop the serif-tuned faux-weight (stroke + shadow) on the display surfaces
 *  when a non-default face is chosen. */
function applyUiFonts(fonts: Required<UiFontPrefs>): void {
  const root = document.documentElement;
  for (const category of UI_FONT_CATEGORIES) {
    const slug = CATEGORY_CSS[category];
    const stack = UI_FONT_STACKS[fonts[category]];
    if (stack) {
      root.style.setProperty(`--ui-font-${slug}`, stack);
      root.setAttribute(`data-ui-font-${slug}`, fonts[category]);
    } else {
      root.style.removeProperty(`--ui-font-${slug}`);
      root.removeAttribute(`data-ui-font-${slug}`);
    }
  }
}

export interface UseUiFonts {
  uiFonts: () => Required<UiFontPrefs>;
  /** Refresh the live `--ui-font-*` variables. The Settings modal commits
   *  through here so the UI restyles without a reload; the modal itself
   *  persists via patchSettings, so this callback is UI-only (mirrors
   *  `handleCardMinWidthChange`). Accepts a partial patch and merges it. */
  handleUiFontsChange: (patch: UiFontPrefs) => void;
}

export function useUiFonts(): UseUiFonts {
  const [uiFonts, setUiFonts] = createSignal<Required<UiFontPrefs>>({ ...DEFAULT_UI_FONTS });
  applyUiFonts(uiFonts());
  void getBootstrap()
    .then((boot) => {
      setUiFonts(boot.uiFonts);
      applyUiFonts(boot.uiFonts);
    })
    // A failed bootstrap must not leave an unhandled rejection: the all-default
    // fonts applied above stay in effect. This hook has no toast channel, so
    // log for the console like use-card-min-width.
    .catch((err) => console.error('hydration: ui fonts bootstrap failed', err));

  const handleUiFontsChange = (patch: UiFontPrefs): void => {
    const next: Required<UiFontPrefs> = { ...uiFonts(), ...patch };
    setUiFonts(next);
    applyUiFonts(next);
  };

  return { uiFonts, handleUiFontsChange };
}
