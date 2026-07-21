import type { TermDeath, TermSide } from '@shared/types';

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
  /** Window title the running program announced via OSC 0 / OSC 2 — e.g. a
   *  harness summary like Claude Code's "Ask about the weather", status glyph
   *  stripped (see `xterm-mount`). Renderer-only ephemeral state pushed by the
   *  live `onTitleChange` subscription; never persisted. Sits below the cwd
   *  basename but above the spawn `label`, so a pinned agent tab — where cwd is
   *  suppressed — shows what the harness is doing. */
  termTitle?: string;
  /** Whether the running program is reporting itself busy via OSC 9;4 progress
   *  (e.g. a harness mid-task). Renderer-only ephemeral state from the live
   *  `onProgressChange` subscription; drives the tab's busy dot. */
  busy?: boolean;
  /** Palette slot (0..19) assigned at creation and frozen for the tab's
   *  lifetime — the button colour, drawn from the shared app-pill wheel.
   *  Stable across closes / reorders / restarts. */
  colorSlot?: number;
  /** Process exit code; the tab can still be cleared via close. */
  exited?: number;
  /** Why the session ended. Present on an abnormally-exited tab, whose row is
   *  deliberately kept on screen so the verdict is readable and the session can
   *  be restarted; a clean exit still auto-closes and never renders this. */
  death?: TermDeath;
  /** Live cgroup-scope memory usage (bytes) for a memory-scoped tab; undefined
   *  for unscoped tabs. Broadcast by main's per-tab sampler. Drives the tab's
   *  memory meter. */
  memBytes?: number;
  /** The tab scope's hard memory cap (bytes); the meter warns as `memBytes`
   *  approaches it. Undefined when the tab is unscoped or the cap is
   *  non-numeric. */
  memMaxBytes?: number;
  /** Few-word summary the dashboard engine derived from recent output (when
   *  the Dashboard feature is enabled). Renderer-only ephemeral state pushed by
   *  `onDashboardTabSummaries`; never persisted. Outranks the cwd basename / OSC
   *  title for display so the tab reflects what it's actually doing. */
  llmTitle?: string;
  /** Few-line "current context" from the dashboard engine — shown in the tab's
   *  hover popover. Renderer-only ephemeral state; never persisted. */
  contextLines?: string[];
  /** One-line "what is happening now" from the dashboard engine — shown in the
   *  hover popover. Renderer-only ephemeral state; never persisted. */
  currentAction?: string;
}

/** Display name for a tab. A user rename always wins; then the dashboard's
 *  LLM-derived title (when the feature is on), so the tab reflects what it is
 *  actually doing; then the cwd basename if the shell emitted OSC 7 and the tab
 *  isn't pinned; then the window title the running program announced via OSC 0/2
 *  (e.g. a harness summary) — which also surfaces on pinned tabs, where cwd is
 *  suppressed; otherwise the spawn label. */
export function displayName(tab: Tab): string {
  if (tab.customName) return tab.customName;
  if (tab.llmTitle) return tab.llmTitle;
  if (!tab.pinned && tab.cwd) {
    const basename = tab.cwd.split('/').filter(Boolean).pop();
    if (basename) return basename;
  }
  if (tab.termTitle) return tab.termTitle;
  return tab.label;
}

/**
 * Element-wise equality of two optional string lists. Both undefined → equal;
 * exactly one undefined → not equal; otherwise same length and same elements in
 * order. Lets the dashboard-summary reconcile skip reallocating a Tab when a
 * pushed summary's `contextLines` are unchanged, so the reference-keyed tab-row
 * `<For>` doesn't tear down and rebuild an unchanged row (review finding T7).
 */
export function sameStringList(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
