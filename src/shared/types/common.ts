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

export type Theme = 'light' | 'dark' | 'system';

/** Font choices offered per UI font category (Settings → Appearance). Each
 *  value maps to a base font stack in the renderer's `use-ui-fonts` hook.
 *  `default` sets no CSS variable, so the category's elements keep the theme's
 *  face for that surface and an unset preference changes nothing. */
export const UI_FONTS = ['default', 'sans', 'mono', 'system'] as const;
export type UiFont = (typeof UI_FONTS)[number];
