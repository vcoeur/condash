import type { TermSide } from '@shared/types';

/** A column inside the bottom pane — the right column only materialises
 *  when at least one tab lives in it. */
export type Column = 'left' | 'right';

/** A tab in the bottom terminal pane. The structure is broadcast-driven
 *  (`onTermSessions` from main is the only source for adds/removes); the
 *  Tab object carries renderer-only state (column, custom rename, OSC 7
 *  cwd) on top of what main reports. */
export interface Tab {
  id: string;
  /** Server-side `my` for tabs in this pane (code-side sessions live on the
   * Code pane). Kept on the Tab object so the structure stays mirror-able. */
  side: TermSide;
  /** Renderer-only column choice within the bottom pane. */
  column: Column;
  /** Default label (auto-derived from spawn — e.g. repo name or shell). */
  label: string;
  /** User-renamed label, if any. Persisted by id in localStorage. */
  customName?: string;
  /** Most recent cwd reported via OSC 7 (`file://host/path`). Used for the
   *  display label when the user hasn't supplied a custom name and the tab
   *  isn't `pinned`. */
  cwd?: string;
  /** When true, OSC 7 cwd is ignored for display — `label` stays the title
   *  until the user manually renames. Set at spawn time for sources that
   *  carry a deliberate title (lambda launcher, code-card "open in term"). */
  pinned?: boolean;
  /** Auto-derived title applied from `.condash/term-titles.json` by a
   *  scheduled/adopted task (capability 3). Sparse-merged in by the
   *  `termAutoTitles` event — sits just below `customName` in `displayName`
   *  so a user rename always wins. condash holds no title state; this is
   *  ephemeral renderer state re-applied on each file change. */
  autoTitle?: string;
  /** Process exit code; the tab can still be cleared via close. */
  exited?: number;
}

/** Display name for a tab. Custom rename wins; then an auto-title applied from
 *  `.condash/term-titles.json`; then the cwd basename if the shell emitted
 *  OSC 7 (and the tab isn't pinned); otherwise the spawn-time label. */
export function displayName(tab: Tab): string {
  if (tab.customName) return tab.customName;
  if (tab.autoTitle) return tab.autoTitle;
  if (!tab.pinned && tab.cwd) {
    const basename = tab.cwd.split('/').filter(Boolean).pop();
    if (basename) return basename;
  }
  return tab.label;
}
