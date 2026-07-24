// Shared constant for the hidden-tab serialize/hydrate round-trip.
//
// A leaf module with no imports because the two serialize sites live in
// different bundles — the demote in the renderer's terminal-pane controller, the
// promote in the terminal Web Worker — and the number must not drift between
// them.

/** Scrollback rows a hidden-tab snapshot carries (`SerializeAddon.serialize`).
 *
 *  Both serialize calls used to walk the terminal's full scrollback (5000 rows
 *  by default), and that walk is on the switch path: the demote blocks the
 *  visibility chain and the promote is awaited behind a 10 s watchdog. Capping
 *  it bounds that cost.
 *
 *  What is lost is scrollback beyond this depth on a tab that has been hidden —
 *  a bounded, predictable truncation replacing an unbounded one, since the
 *  existing watchdog fallback already drops the *entire* scrollback silently
 *  when a serialize times out. The visible screen is never affected: it is a
 *  fraction of this depth on any real pane, and an alternate-screen frame has no
 *  scrollback at all. */
export const SNAPSHOT_SCROLLBACK_ROWS = 1000;
