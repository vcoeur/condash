// Pure decision logic for the terminal-pane demote/hydrate visibility machine.
//
// The controller keeps only the active tab(s) as live DOM Terminals; every other
// open tab is owned by a headless `@xterm/headless` Terminal in a Web Worker
// (internals §14 / §terminal-worker). `syncVisibility` decides, on every
// active-id / open / view change, which tabs to hydrate into the DOM (promote),
// which to serialize back into the worker (demote), and which mounted terminal
// is CSS-visible (which in turn drives the WebGL context pool via
// `MountedTerm.setVisible`). Those decisions were closure state in
// `controller.ts`, reachable only through Playwright; this module carves them
// out as pure functions — the controller keeps the effects (the async
// serialize/mount round-trip, the worker RPCs, the DOM mutation).
//
// The module is free of any Solid / xterm / DOM import so it unit-tests under
// the node vitest env, mirroring the webgl-pool / prompt-decorations split.

import type { Column } from './types';

/** The active tab id per column — the shape of the controller's `activeIds`
 *  signal. The column's active tab is the one that should be a live DOM
 *  Terminal. */
export type ActiveByColumn = Record<Column, string | null>;

/**
 * The set of tab ids that should be live DOM Terminals: each column's active
 * tab. The pane-closed / dashboard-shown case (hide every terminal without
 * disposing) is handled by the caller and never reaches here.
 *
 * @param active The active id per column.
 * @returns Desired-visible ids, left column before right (mount order).
 */
export function desiredDomIds(active: ActiveByColumn): Set<string> {
  const ids = new Set<string>();
  for (const col of ['left', 'right'] as Column[]) {
    const id = active[col];
    if (id) ids.add(id);
  }
  return ids;
}

/** Which tabs to hydrate into DOM Terminals and which to serialize back into the
 *  worker, computed from the desired-visible / currently-mounted / mid-transition
 *  sets. */
export interface VisibilityPlan {
  /** Worker-owned (or never-mounted) tabs to hydrate into DOM Terminals. */
  toPromote: string[];
  /** Live DOM Terminals to serialize back into the worker. */
  toDemote: string[];
}

/**
 * Decide the promote/demote plan for one visibility sync. A tab that is already
 * mounted, or mid-transition, is never re-promoted; a tab that is desired-visible
 * or mid-transition is never demoted. Iteration order is preserved from the
 * inputs (`desired` for promotes, `mounted` for demotes) so the controller's
 * awaited round-trips run in the same order as before the split.
 *
 * @param input `desired` (from {@link desiredDomIds}), `mounted` (the live
 *   DOM-Terminal ids, in mount order), and the `transitioning` guard set.
 * @returns The tabs to promote and to demote.
 */
export function planVisibility(input: {
  desired: Iterable<string>;
  mounted: Iterable<string>;
  transitioning: ReadonlySet<string>;
}): VisibilityPlan {
  const desiredList = [...input.desired];
  const desiredSet = new Set(desiredList);
  const mountedList = [...input.mounted];
  const mountedSet = new Set(mountedList);
  const { transitioning } = input;
  const toPromote = desiredList.filter((id) => !mountedSet.has(id) && !transitioning.has(id));
  const toDemote = mountedList.filter((id) => !desiredSet.has(id) && !transitioning.has(id));
  return { toPromote, toDemote };
}

/** A mounted DOM Terminal's identity for the CSS-visibility decision. */
export interface MountedTab {
  id: string;
  column: Column;
}

/**
 * Decide which mounted DOM Terminals are visible (`display: flex` +
 * `setVisible(true)`, which protects their WebGL context in the pool) vs hidden.
 * A tab is visible iff it is its own column's active tab.
 *
 * @param mounted The live DOM Terminals with their current column.
 * @param active The active id per column.
 * @returns id → visible, one entry per mounted tab (input order).
 */
export function domVisibility(
  mounted: Iterable<MountedTab>,
  active: ActiveByColumn,
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const { id, column } of mounted) out.set(id, id === active[column]);
  return out;
}

/**
 * Whether a `focusin` / `mousedown` inside a tab's xterm should promote it to
 * its column's active tab. Focus churn during an in-flight visibility transition
 * in the SAME column must be ignored: a demote/mount moves DOM focus
 * programmatically, firing `focusin` on a terminal the user did not pick, and
 * honouring it would revert the in-flight switch. Gating on the per-column count
 * (not the global transition set) still lets a genuine click in an idle column
 * through while the other column is mid-transition or stuck (R1).
 *
 * @param transitioningInColumn In-flight visibility transitions in the tab's column.
 * @returns True when the focus should promote the tab.
 */
export function shouldPromoteOnFocus(transitioningInColumn: number): boolean {
  return transitioningInColumn === 0;
}
