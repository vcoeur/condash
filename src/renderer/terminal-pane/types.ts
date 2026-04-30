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
   * Code tab). Kept on the Tab object so the structure stays mirror-able. */
  side: TermSide;
  /** Renderer-only column choice within the bottom pane. */
  column: Column;
  /** Default label (auto-derived from spawn — e.g. repo name or shell). */
  label: string;
  /** User-renamed label, if any. Persisted by id in localStorage. */
  customName?: string;
  /** Most recent cwd reported via OSC 7 (`file://host/path`). Used for the
   *  display label when the user hasn't supplied a custom name. */
  cwd?: string;
  /** Process exit code; the tab can still be cleared via close. */
  exited?: number;
}

/** Display name for a tab. Custom rename wins; otherwise the cwd basename if
 *  the shell emitted OSC 7; otherwise the spawn-time label. */
export function displayName(tab: Tab): string {
  if (tab.customName) return tab.customName;
  if (tab.cwd) {
    const basename = tab.cwd.split('/').filter(Boolean).pop();
    if (basename) return basename;
  }
  return tab.label;
}
