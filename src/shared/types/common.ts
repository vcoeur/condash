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

/** Font choices for project-card titles (Settings → Appearance). Each value
 *  maps to a font-family stack in the renderer's
 *  `use-project-card-title-font` hook. `default` leaves the theme's editorial
 *  display face (`--font-display`) in place, so an unset preference changes
 *  nothing. */
export const PROJECT_CARD_TITLE_FONTS = ['default', 'sans', 'mono', 'system'] as const;
export type ProjectCardTitleFont = (typeof PROJECT_CARD_TITLE_FONTS)[number];
/** Built-in default: the theme's editorial display face. */
export const DEFAULT_PROJECT_CARD_TITLE_FONT: ProjectCardTitleFont = 'default';
