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

/** Re-apply the current theme tokens to every live xterm. Called by use-theme
 *  when the user toggles light/dark; without this, terminals mounted before the
 *  flip stay on the old palette until next attach. No-op (and cheap) before any
 *  terminal is opened, so it never forces the xterm chunk to load. */
export function refreshAllXtermThemes(): void {
  for (const t of liveTerms) {
    try {
      t.refreshTheme();
    } catch {
      /* per-term failure shouldn't take down the rest */
    }
  }
}
