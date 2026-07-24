// Leaf registry of live xterms — deliberately free of any `@xterm/*` import so
// the app shell (use-theme → refreshAllXtermThemes) can repaint terminals on a
// light/dark flip WITHOUT pulling xterm + its 9 addons into the boot chunk.
// The heavy `mountXterm` (xterm-mount.ts) is dynamic-imported on first terminal
// open and registers each mounted term here; this module stays tiny and eager.

/** Minimal shape the registry needs from a mounted terminal: re-read the CSS
 *  theme tokens and repaint. `MountedTerm` (xterm-mount.ts) is structurally
 *  assignable to this. */
export interface RefreshableXterm {
  refreshTheme(): void;
}

// Renderer-global set of every live terminal. Populated by mountXterm on mount
// and pruned on dispose so a light/dark flip can repaint every open terminal —
// both bottom-pane sessions and inline Code-pane runner rows — without each call
// site wiring its own subscription.
export const liveTerms = new Set<RefreshableXterm>();

/** Re-apply the current theme tokens to every live xterm, right now. Without
 *  this, terminals mounted before a theme change stay on the old palette until
 *  next attach. No-op (and cheap) before any terminal is opened, so it never
 *  forces the xterm chunk to load. Callers reacting to a *user-driven* theme
 *  change want {@link scheduleXtermThemeRefresh} instead. */
export function refreshAllXtermThemes(): void {
  for (const t of liveTerms) {
    try {
      t.refreshTheme();
    } catch {
      /* per-term failure shouldn't take down the rest */
    }
  }
}

/** Coalescing window for {@link scheduleXtermThemeRefresh}. Longer than a
 *  keyboard repeat interval, so holding an arrow key across the Settings theme
 *  cards collapses to one refresh; short enough that a single click reads as
 *  instant. */
const REFRESH_COALESCE_MS = 100;

let pendingRefresh: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-theme every live xterm once the caller stops asking. Trailing edge:
 * repeated calls inside the window collapse into one refresh, run
 * `REFRESH_COALESCE_MS` after the last of them.
 *
 * The Settings theme picker selects on arrow-key *move*, so a held arrow drove
 * one full `refreshAllXtermThemes()` per key repeat — and that pass costs a
 * `getComputedStyle(document.documentElement)` per live terminal (landing
 * immediately after `use-theme`'s sibling effect wrote `data-theme`, so it also
 * forces a synchronous style recalc) plus a theme reapply and repaint each.
 * With the handful of terminals a normal condash session has open, that blew
 * the repo's ≤ 16 ms interaction budget on every keystroke.
 *
 * Only the JS-side consumers wait. The CSS half of a theme change is untouched
 * and stays immediate — it is what makes the preview feel live.
 */
export function scheduleXtermThemeRefresh(): void {
  if (pendingRefresh !== null) clearTimeout(pendingRefresh);
  pendingRefresh = setTimeout(() => {
    pendingRefresh = null;
    refreshAllXtermThemes();
  }, REFRESH_COALESCE_MS);
}
