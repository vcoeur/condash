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
// Readiness is NOT inferred from proposeDimensions alone, because it CLAMPS
// rather than failing: `Math.max(MINIMUM_COLS = 2, …)` / `Math.max(MINIMUM_ROWS
// = 1, …)`. A `display:none` host yields NaN (correctly rejected), but a host
// that is *rendered and zero-height* — a tab strip wrapped onto three rows above
// a short pane, a pane mid-collapse, an absolutely-positioned host not yet laid
// out against its containing block — yields the perfectly finite pair
// `{cols: 2, rows: 1}`. Committing that resizes the pty to 2×1 (a real
// SIGWINCH: the program genuinely reformats for a two-column screen), spends the
// retry budget, and then trips `decideRefreshAction`'s `rows <= 1` skip — so the
// degenerate geometry passes the guard AND suppresses the repaint that would
// have repaired it. This module therefore checks the host box directly and
// treats the clamp floor as "not measured yet".
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

/** The terminal host's measured box — `clientWidth`/`clientHeight` of the
 *  element `FitAddon` sizes the grid from (the `.xterm-host` div, i.e.
 *  `term.element.parentElement`). `undefined` when there is no element to
 *  measure.
 *
 *  Note this is the *padding* box, while `proposeDimensions()` measures the
 *  computed *content* height — `.xterm-host` carries `padding: 4px 8px`, so the
 *  two readings differ by 8 px vertically. The check below is therefore not a
 *  superset of the grid-floor check: a 1–8 px tall host measures non-zero here
 *  and still clamps to `rows: 1`, and the grid floor is what rejects it. */
export type HostBox = { width: number; height: number } | undefined;

/** The grid `proposeDimensions()` clamps to when the host measures zero
 *  (`MINIMUM_COLS` / `MINIMUM_ROWS` in `@xterm/addon-fit`). A proposal at or
 *  below this pair is the clamp floor, not a measurement — see the header. */
const CLAMP_FLOOR_COLS = 2;
const CLAMP_FLOOR_ROWS = 1;

/** Whether the host has a box at all. A zero axis means "rendered but not laid
 *  out yet" — the case proposeDimensions papers over with its clamp. This is the
 *  cheaper, more direct signal, and it catches hosts whose *proposal* would look
 *  plausible (a stale render-service cell size against a collapsed box, or a
 *  `display:none` host with explicit dimensions); the grid floor below is what
 *  covers the sub-cell hosts this check lets through (see {@link HostBox}). */
function isHostMeasured(host: HostBox): boolean {
  return host !== undefined && host.width > 0 && host.height > 0;
}

/** Whether a proposal is a plausible terminal grid rather than a clamp floor or
 *  an unmeasurable axis. A 2×1 grid was never a usable terminal, so rejecting it
 *  costs nothing and keeps the pty off a size no program can draw into. */
function isPlausibleGrid(dims: ProposedDimensions): boolean {
  if (!dims) return false;
  if (!Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return false;
  return dims.cols > CLAMP_FLOOR_COLS && dims.rows > CLAMP_FLOOR_ROWS;
}

/** What a fit-on-show attempt should do this frame:
 *  - `fit` — proposeDimensions produced a real grid; run `fit()` now.
 *  - `retry` — it could not compute yet (unmeasured / not laid out) and attempts
 *    remain; schedule another frame.
 *  - `giveup` — still cannot compute and no attempts remain; stop. */
export type FitAction = 'fit' | 'retry' | 'giveup';

/**
 * Decide what a fit-on-show attempt should do, given this frame's proposed
 * dimensions, the host box they were measured from, and how many retries remain.
 * The host must measure non-zero on both axes AND the proposal must be a
 * plausible grid; either check failing means "not ready yet" — retry while
 * attempts remain, else give up. The grid floor is the load-bearing one for a
 * collapsed pane (a host a few px tall passes the box check and still clamps);
 * the box check covers the cases where the proposal itself cannot be trusted.
 * Neither subsumes the other — see {@link HostBox}.
 *
 * @param dims The result of `FitAddon.proposeDimensions()` for this frame.
 * @param attemptsLeft Retries remaining (this attempt included); 0 means last.
 * @param host The host element's measured box for this frame.
 * @returns The action for the controller to run.
 */
export function decideFit(
  dims: ProposedDimensions,
  attemptsLeft: number,
  host: HostBox,
): FitAction {
  if (isHostMeasured(host) && isPlausibleGrid(dims)) return 'fit';
  return attemptsLeft > 0 ? 'retry' : 'giveup';
}
