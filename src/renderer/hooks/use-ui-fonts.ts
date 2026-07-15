import { createSignal } from 'solid-js';
import type {
  ResolvedUiFonts,
  UiFont,
  UiFontCategory,
  UiFontPrefs,
  UiFontSize,
  UiFontWeight,
} from '@shared/types';
import { DEFAULT_UI_FONT_CATEGORY, UI_FONT_CATEGORIES } from '@shared/types';
import { getBootstrap } from '../bootstrap';

/** The font stack each family choice maps to. `default` is `null` — no CSS
 *  variable is set, so the category's elements fall through to their own base
 *  face. The three theme faces reference the `--font-*-base` brand tokens; the
 *  rest are cross-platform system stacks (no bundling), so each previews in its
 *  own face in the picker. */
export const UI_FONT_STACKS: Record<UiFont, string | null> = {
  default: null,
  sans: 'var(--font-sans-base)',
  serif: 'var(--font-serif-base)',
  mono: 'var(--font-mono-base)',
  system: 'var(--font-system-base)',
  georgia: 'Georgia, "Times New Roman", serif',
  times: '"Times New Roman", Times, serif',
  helvetica: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  verdana: 'Verdana, Geneva, sans-serif',
  trebuchet: '"Trebuchet MS", "Segoe UI", sans-serif',
  palatino: '"Palatino Linotype", "Book Antiqua", Palatino, serif',
  courier: '"Courier New", Courier, monospace',
};

/** The numeric `font-weight` each weight choice maps to. `default` is `null` —
 *  no variable is set, so the element keeps the weight its own stylesheet
 *  assigns. */
export const UI_FONT_WEIGHT_VALUES: Record<UiFontWeight, string | null> = {
  default: null,
  light: '300',
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
};

/** The scale factor each size choice maps to. `default` is `null` — no variable
 *  is set, so the element keeps its own size; the stylesheet multiplies the
 *  element's base size by the factor (`calc(base * scale)`). */
export const UI_FONT_SIZE_SCALES: Record<UiFontSize, string | null> = {
  default: null,
  xs: '0.85',
  sm: '0.92',
  lg: '1.12',
  xl: '1.28',
};

/** CSS slug per category. Config keys are camelCase; the CSS variables and data
 *  attributes they drive are kebab-case (`--ui-font-card-title`, etc.). */
const CATEGORY_CSS: Record<UiFontCategory, string> = {
  cardTitle: 'card-title',
  heading: 'heading',
  body: 'body',
  code: 'code',
  terminal: 'terminal',
};

/** Set (or clear) one `--ui-<prop>-<slug>` variable and its matching
 *  `data-ui-<prop>-<slug>` attribute on `:root`. A null value clears both, so
 *  the surface falls back to its own stylesheet value. */
function setVar(
  root: HTMLElement,
  cssVar: string,
  attr: string,
  value: string | null,
  choice: string,
): void {
  if (value) {
    root.style.setProperty(cssVar, value);
    root.setAttribute(attr, choice);
  } else {
    root.style.removeProperty(cssVar);
    root.removeAttribute(attr);
  }
}

/** Push each category's family/weight/size onto `:root`. `ui-fonts.css` reads
 *  the variables through `[data-ui-*]`-scoped rules, so an unset (default)
 *  field restores the element's own face/weight/size exactly. */
function applyUiFonts(fonts: ResolvedUiFonts): void {
  const root = document.documentElement;
  for (const category of UI_FONT_CATEGORIES) {
    const slug = CATEGORY_CSS[category];
    const { family, weight, size } = fonts[category];
    setVar(root, `--ui-font-${slug}`, `data-ui-font-${slug}`, UI_FONT_STACKS[family], family);
    setVar(
      root,
      `--ui-weight-${slug}`,
      `data-ui-weight-${slug}`,
      UI_FONT_WEIGHT_VALUES[weight],
      weight,
    );
    setVar(root, `--ui-size-${slug}`, `data-ui-size-${slug}`, UI_FONT_SIZE_SCALES[size], size);
  }
}

/** A fresh, mutable all-`default` record for the signal seed. */
function defaultFonts(): ResolvedUiFonts {
  return Object.fromEntries(
    UI_FONT_CATEGORIES.map((category) => [category, { ...DEFAULT_UI_FONT_CATEGORY }]),
  ) as ResolvedUiFonts;
}

export interface UseUiFonts {
  uiFonts: () => ResolvedUiFonts;
  /** Refresh the live `--ui-*` variables. The Settings modal commits through
   *  here so the UI restyles without a reload; the modal itself persists via
   *  patchSettings, so this callback is UI-only (mirrors
   *  `handleCardMinWidthChange`). Accepts a partial per-category patch. */
  handleUiFontsChange: (patch: UiFontPrefs) => void;
}

export function useUiFonts(): UseUiFonts {
  const [uiFonts, setUiFonts] = createSignal<ResolvedUiFonts>(defaultFonts());
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
    const current = uiFonts();
    const next: ResolvedUiFonts = { ...current };
    for (const category of UI_FONT_CATEGORIES) {
      const categoryPatch = patch[category];
      if (categoryPatch) next[category] = { ...current[category], ...categoryPatch };
    }
    setUiFonts(next);
    applyUiFonts(next);
  };

  return { uiFonts, handleUiFontsChange };
}
