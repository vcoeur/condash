// Cross-cutting primitives shared by every domain: OS platform, item kind,
// help-doc names, and the colour theme. These have no home in any single
// domain module, so they live together here.

/** Subset of `NodeJS.Platform` we actually care about. The renderer doesn't
 *  link `@types/node` so it can't reach the full union — we mirror the three
 *  values that influence per-OS behaviour and leave a string fallback for
 *  the rare exotic (`freebsd`, `aix`, ...). */
export type Platform = 'linux' | 'darwin' | 'win32' | (string & {});

export type ItemKind = 'project' | 'incident' | 'document' | 'unknown';

/**
 * Names of the bundled help docs the renderer can request via `readHelpDoc`.
 * Lifted to `shared/` so the IPC contract (`shared/api.ts`) and the main
 * loader's `PATHS` allowlist (`main/help.ts`) reference one canonical union —
 * additions/renames touch one file instead of two.
 */
export type HelpDocName =
  | 'welcome'
  | 'quick-start'
  | 'shortcuts'
  | 'configuration'
  | 'cli'
  | 'why-markdown';

/** Re-exported so `@shared/types` stays the one import site for the union while
 *  the theme registry (`shared/themes.ts`) stays its single source of truth —
 *  adding a theme there widens this automatically. */
export type { Theme } from '../themes';

/** Font-family choices offered per UI font category (Settings → Appearance).
 *  Each value maps to a font stack in the renderer's `use-ui-fonts` hook.
 *  `default` sets no CSS variable, so the category's elements keep the theme's
 *  face for that surface and an unset preference changes nothing. The named
 *  families beyond the three theme faces are cross-platform system fonts (no
 *  bundling), so the option renders in its own face in the picker. */
export const UI_FONTS = [
  'default',
  'sans',
  'serif',
  'mono',
  'system',
  'georgia',
  'times',
  'helvetica',
  'verdana',
  'trebuchet',
  'palatino',
  'courier',
] as const;
export type UiFont = (typeof UI_FONTS)[number];

/** Font-weight choices offered per category. `default` sets no CSS variable, so
 *  each element keeps the weight its own stylesheet assigns; the rest map to a
 *  numeric `font-weight` in `use-ui-fonts`. */
export const UI_FONT_WEIGHTS = [
  'default',
  'light',
  'regular',
  'medium',
  'semibold',
  'bold',
] as const;
export type UiFontWeight = (typeof UI_FONT_WEIGHTS)[number];

/** Relative font-size choices offered per category. `default` sets no CSS
 *  variable (the element keeps its own size); the rest map to a scale factor
 *  the stylesheet multiplies the element's base size by (`calc(base * scale)`)
 *  in `use-ui-fonts`. */
export const UI_FONT_SIZES = ['default', 'xs', 'sm', 'lg', 'xl'] as const;
export type UiFontSize = (typeof UI_FONT_SIZES)[number];
