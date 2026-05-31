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
  /** Palette slot (0..19) assigned at creation and frozen for the tab's
   *  lifetime — the button colour, drawn from the shared app-pill wheel.
   *  Stable across closes / reorders / restarts. */
  colorSlot?: number;
  /** Process exit code; the tab can still be cleared via close. */
  exited?: number;
}

/** Display name for a tab. Custom rename wins; otherwise the cwd basename if
 *  the shell emitted OSC 7 (and the tab isn't pinned); otherwise the
 *  spawn-time label. */
export function displayName(tab: Tab): string {
  if (tab.customName) return tab.customName;
  if (!tab.pinned && tab.cwd) {
    const basename = tab.cwd.split('/').filter(Boolean).pop();
    if (basename) return basename;
  }
  return tab.label;
}
