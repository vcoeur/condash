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
 * Decide which tabs to nudge when the active-id signal changes. Any column whose
 * active id becomes a *different* tab produces one target — including the first
 * activation of a column (previous null): that tab hydrates from a snapshot like
 * any other, and skipping it is what left a restored-on-boot tab, a
 * freshly-spawned one, and the tab promoted after a close showing a garbled
 * frame until the user hit Refresh. A no-op re-assert of the same id (previous
 * === next — e.g. a visibility flip re-firing the signal) still produces none,
 * which is what keeps a nudge from racing a visibility flip that didn't actually
 * change the active tab.
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
    if (next && next !== was) targets.push({ id: next, onlyIfAltBuffer });
  }
  return targets;
}

/** Claim-check over the sessions whose pty is being held one row short by a
 *  repaint nudge. Keyed by session id *and* the handle that owns the nudge: the
 *  live DOM Terminal for a session is destroyed and rebuilt on every switch, so
 *  an id-only claim let a stale timer both block a brand-new handle's fit (the
 *  new terminal was then never fitted by its promote) and clear a live nudge's
 *  guard (a chained fit restored the full size and collapsed the dip). Ownership
 *  makes both impossible: a claim only ever affects the handle that made it. */
export interface NudgeRegistry<Handle> {
  /** Record that `handle` is holding `id`'s pty one row short. */
  claim(id: string, handle: Handle): void;
  /** Whether `handle` — this exact terminal, not merely this session — is
   *  mid-nudge, and so must not be fitted. */
  isHeldBy(id: string, handle: Handle): boolean;
  /** Release `id`, but only if `handle` still owns it. A timer belonging to a
   *  handle that has since been replaced releases nothing. */
  release(id: string, handle: Handle): void;
}

/** Build an empty {@link NudgeRegistry}. Generic over the handle type so the
 *  module stays free of any xterm/DOM import. */
export function createNudgeRegistry<Handle>(): NudgeRegistry<Handle> {
  const held = new Map<string, Handle>();
  return {
    claim: (id, handle) => {
      held.set(id, handle);
    },
    isHeldBy: (id, handle) => held.get(id) === handle,
    release: (id, handle) => {
      if (held.get(id) === handle) held.delete(id);
    },
  };
}

/** What a scheduled refresh should do once its tab has hydrated:
 *  - `skip` — no live DOM Terminal (the tab was demoted, closed, or re-mounted
 *    mid-hydration): nothing to do.
 *  - `focus-only` — a live terminal that must not be nudged, either because the
 *    alt-buffer gate excluded it (`reason: 'altGate'`) or it is too short to
 *    give up a row (`reason: 'tooShort'`): the controller just refocuses it.
 *  - `nudge` — resize one row shorter and back to force a full repaint. */
export type RefreshAction =
  | { kind: 'skip' }
  | { kind: 'focus-only'; reason: 'altGate' | 'tooShort' }
  | { kind: 'nudge' };

/**
 * Decide what a scheduled refresh should do, given the hydrated terminal's
 * state. Mirrors the `refreshSession` gate: no handle → skip; the alt-buffer
 * opt-out excludes a normal-buffer tab; a ≤1-row terminal can't lose a row; all
 * else nudges. Checked *post-hydrate* so `bufferType` reflects the snapshot just
 * replayed.
 *
 * @param state Whether a live terminal exists, its `buffer.active.type`, its row
 *   count, and whether the nudge is alt-buffer-gated.
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
}): RefreshAction {
  if (!state.mounted) return { kind: 'skip' };
  if (state.onlyIfAltBuffer && state.bufferType !== 'alternate') {
    return { kind: 'focus-only', reason: 'altGate' };
  }
  if ((state.rows ?? 0) <= 1) return { kind: 'focus-only', reason: 'tooShort' };
  return { kind: 'nudge' };
}
