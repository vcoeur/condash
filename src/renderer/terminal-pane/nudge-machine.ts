// Pure decision logic for the terminal-pane refresh-nudge state machine.
//
// The "nudge" is the repaint escape-hatch for a hidden→visible tab: a live
// full-screen TUI (opencode, Claude Code, any Ink/ncurses app) hydrates from
// the worker's `SerializeAddon` snapshot into a garbled frame, so the controller
// resizes its pty one row shorter and back to force the program to redraw
// (internals §14 / §terminal-worker). Deciding *whether* and *what kind* of
// nudge to run was closure state buried in `controller.ts`, reachable only by
// driving the whole pane in Playwright — this module carves the decisions out
// as pure functions so the edges ("tab closed mid-hydration", a no-op re-assert
// racing a visibility flip) are unit-testable. The controller keeps the
// effects: the timers, the DOM `term.resize` / `fit`, and the worker calls.
//
// The module is free of any Solid / xterm / DOM import so it unit-tests under
// the node vitest env, mirroring the webgl-pool / prompt-decorations split.

import type { Column } from './types';

/** How long the controller holds the intermediate (rows-1) size before restoring
 *  it. This MUST exceed the running program's own resize debounce, or the
 *  program never samples the smaller size and the nudge collapses to a no-op:
 *  opencode (Bubbletea) coalesces resizes for ~100 ms, so at the old 80 ms hold
 *  it emitted nothing and the tab stayed on its garbled hydrated frame. 160 ms
 *  clears that debounce with margin while staying imperceptible. */
export const REPAINT_NUDGE_MS = 160;

/** The active tab id per column — the shape of the controller's `activeIds`
 *  signal, snapshotted for the pure switch-detection below. */
export type ActiveByColumn = Record<Column, string | null>;

/** A single tab-switch that warrants a repaint nudge: the tab that became its
 *  column's active tab, plus whether the nudge is gated on that tab being on the
 *  alternate screen buffer (a live full-screen TUI). */
export interface NudgeTarget {
  id: string;
  onlyIfAltBuffer: boolean;
}

/**
 * Decide which tabs to nudge when the active-id signal changes. A genuine switch
 * to a *different* tab in a column produces one target; first-open (previous
 * null) and a no-op re-assert of the same id (previous === next — e.g. a
 * visibility flip re-firing the signal) produce none, which is what keeps a
 * nudge from racing a visibility flip that didn't actually change the active tab.
 *
 * `autoRefreshOnTabSwitch === false` restricts every target to alt-buffer tabs
 * (`onlyIfAltBuffer: true`); `true` or `undefined` (the default) nudges every
 * switched-to tab unconditionally.
 *
 * @param previous The active ids captured on the last signal fire.
 * @param current The active ids on this signal fire.
 * @param autoRefreshOnTabSwitch The `terminal.autoRefreshOnTabSwitch` pref.
 * @returns One target per column that switched to a genuinely different tab.
 */
export function refreshOnSwitchTargets(
  previous: ActiveByColumn,
  current: ActiveByColumn,
  autoRefreshOnTabSwitch: boolean | undefined,
): NudgeTarget[] {
  const onlyIfAltBuffer = autoRefreshOnTabSwitch === false;
  const targets: NudgeTarget[] = [];
  for (const col of ['left', 'right'] as Column[]) {
    const next = current[col];
    const was = previous[col];
    if (next && was && next !== was) targets.push({ id: next, onlyIfAltBuffer });
  }
  return targets;
}

/** What a scheduled refresh should do once its tab has hydrated:
 *  - `skip` — no live DOM Terminal (the tab was demoted, closed, or re-mounted
 *    mid-hydration): nothing to do.
 *  - `focus-only` — a live terminal that must not be nudged: the alt-buffer gate
 *    excluded it (`reason: 'altGate'`), it is too short to give up a row
 *    (`reason: 'tooShort'`), or its frame is already exactly the pty's screen
 *    (`reason: 'frameExact'`): the controller just refocuses it.
 *  - `nudge` — resize one row shorter and back to force a full repaint. */
export type RefreshAction =
  | { kind: 'skip' }
  | { kind: 'focus-only'; reason: 'altGate' | 'tooShort' | 'frameExact' }
  | { kind: 'nudge' };

/**
 * Decide what a scheduled refresh should do, given the hydrated terminal's
 * state. Mirrors the `refreshSession` gate: no handle → skip; the alt-buffer
 * opt-out excludes a normal-buffer tab; an already-exact frame needs no repaint
 * (automatic refresh only); a ≤1-row terminal can't lose a row; all else nudges.
 * Checked *post-hydrate* so `bufferType` reflects the snapshot just replayed.
 *
 * The `frameIsExact` gate exists because the nudge is not free: it resizes the
 * grid a row shorter and back, and on the alternate buffer — which never reflows
 * — xterm services that by popping the bottom line and pushing a fresh blank one
 * (`Buffer.resize`). For a program that does not repaint on SIGWINCH, that
 * *shears the bottom row off a frame that was correct*. Before terminals were
 * hydrated at the pty's geometry the trade was still worth it, because the
 * hydrated frame was wrong anyway; now that the frame can be provably right,
 * nudging it can only do damage. Manual Refresh never sets `allowExactSkip` —
 * the user pressing it IS the signal that something is wrong on screen, whatever
 * the geometry says.
 *
 * @param state Whether a live terminal exists, its `buffer.active.type`, its row
 *   count, whether the nudge is alt-buffer-gated, and whether its frame is known
 *   to be exact (with permission to act on that).
 * @returns The action for the controller to run.
 */
export function decideRefreshAction(state: {
  /** Whether a live DOM Terminal for the tab still exists post-hydrate. */
  mounted: boolean;
  /** The hydrated terminal's active buffer type (`term.buffer.active.type`). */
  bufferType?: 'normal' | 'alternate';
  /** The hydrated terminal's row count. */
  rows?: number;
  /** Restrict the nudge to alt-buffer tabs (live full-screen TUIs). */
  onlyIfAltBuffer: boolean;
  /** The visible grid is provably the pty's own screen: the snapshot's geometry,
   *  the pty's geometry and the grid it was built at all agreed, and nothing has
   *  resized it since. */
  frameIsExact?: boolean;
  /** Whether this caller may act on `frameIsExact`. Only the automatic
   *  on-switch refresh does; manual Refresh stays unconditional. */
  allowExactSkip?: boolean;
}): RefreshAction {
  if (!state.mounted) return { kind: 'skip' };
  if (state.onlyIfAltBuffer && state.bufferType !== 'alternate') {
    return { kind: 'focus-only', reason: 'altGate' };
  }
  if (state.allowExactSkip && state.frameIsExact) {
    return { kind: 'focus-only', reason: 'frameExact' };
  }
  if ((state.rows ?? 0) <= 1) return { kind: 'focus-only', reason: 'tooShort' };
  return { kind: 'nudge' };
}
