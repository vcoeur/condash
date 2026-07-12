// Pure decision logic for the fit-on-show retry loop.
//
// `FitAddon.proposeDimensions()` sizes the grid from the terminal host's
// computed width/height. When a fit runs before that host is laid out at its
// real size — a freshly-mounted tab whose flex box has not resolved, a host
// still `display:none` / 0-sized from a visibility transition, a dashboard→
// terminal view flip whose CSS has not reflowed — proposeDimensions returns
// `undefined` (no laid-out parent) or a NaN axis, so `fit()` is a no-op and the
// grid is stranded at the constructor default (80×24) inside a much larger pane:
// the "terminal renders into a small box" bug. Nothing re-fits once the host
// settles, so the strand persists. The controller closes that by retrying the
// fit across animation frames until proposeDimensions can resolve a real grid;
// this module is the pure per-frame decision so the "retry while not-ready, then
// fit, then give up" edge cases are unit-testable without a DOM. (The controller
// also runs a ResizeObserver on each host so a size change after the fits have
// run refits too — see `controller.ts`.) The controller keeps the effects: the
// proposeDimensions read, the rAF, and the nudging / live-handle guards.
//
// Free of any Solid / xterm / DOM import so it unit-tests under the node vitest
// env, mirroring the nudge-machine / visibility-plan split.

/** How many animation frames a fit-on-show retries before giving up. ~12 frames
 *  (~200 ms at 60 fps) comfortably outlasts a slow first layout / a late reflow
 *  without spinning indefinitely if a terminal is somehow never laid out. */
export const MAX_FIT_ATTEMPTS = 12;

/** The proposed grid `FitAddon.proposeDimensions()` returns — or `undefined`
 *  when it cannot compute yet (no laid-out parent element). */
export type ProposedDimensions = { cols: number; rows: number } | undefined;

/** What a fit-on-show attempt should do this frame:
 *  - `fit` — proposeDimensions produced a real grid; run `fit()` now.
 *  - `retry` — it could not compute yet (unmeasured / not laid out) and attempts
 *    remain; schedule another frame.
 *  - `giveup` — still cannot compute and no attempts remain; stop. */
export type FitAction = 'fit' | 'retry' | 'giveup';

/**
 * Decide what a fit-on-show attempt should do, given this frame's proposed
 * dimensions and how many retries remain. A finite cols/rows pair means the host
 * is laid out at a real size, so it is safe to fit; anything else (`undefined`,
 * or a NaN/Infinity axis) means "not ready yet" — retry while attempts remain,
 * else give up.
 *
 * @param dims The result of `FitAddon.proposeDimensions()` for this frame.
 * @param attemptsLeft Retries remaining (this attempt included); 0 means last.
 * @returns The action for the controller to run.
 */
export function decideFit(dims: ProposedDimensions, attemptsLeft: number): FitAction {
  if (dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows)) return 'fit';
  return attemptsLeft > 0 ? 'retry' : 'giveup';
}
