// Renderer view-state: which panes are visible and how the composite window
// is arranged. This is conceptually the renderer's UI state, peeled out of the
// general IPC-contract grab-bag into its own module. It stays under `shared/`
// (rather than `renderer/`) because the layout is persisted through the
// settings IPC contract — `getLayout` / `setLayout` in `shared/api.ts`, the
// `layout` field on `Settings`, and the native menu's checkbox sync in
// `main/menu.ts` all reference these shapes — so the main process and the
// renderer must agree on one definition.

/** The persisted working surface. The rail selects exactly one right-pane
 * surface at a time and the choice survives a restart; the full working union
 * is Code, Knowledge, Resources, Skills, Automations, and Logs. `null` is not
 * part of the type — the right pane is always showing something (the rail is
 * the complete navigation; there is no "hide the working surface" state). (The
 * Dashboard is not a working surface — it lives in the bottom band next to
 * Terminal.) */
export type WorkingSurface = 'code' | 'knowledge' | 'resources' | 'skills' | 'automations' | 'logs';

/** Composite-layout state. The unified window has a top band (Projects on
 * the left, always visible; the working surface on the right, exactly one of
 * the six rail-selected surfaces) and a bottom band (Terminal). Sizes are
 * persisted alongside visibility so re-showing the terminal restores its
 * previous dimensions. */
export interface LayoutState {
  /** Always `true` — the left band is fixed Projects. Kept so a legacy
   * persisted layout keeps parsing; no writer ever sets it `false`. */
  projects: boolean;
  /** Code / Knowledge / Resources / Skills / Automations / Logs — single
   * right-slot surface, chosen directly by rail click and persisted. */
  working: WorkingSurface;
  terminal: boolean;
  /** Where the Projects ↔ working-surface splitter sits, as a **fraction of the
   * band width** (0–1), when both panes are visible. A fraction rather than CSS
   * pixels so the split holds its proportions when the window is resized — a
   * stored pixel width silently pushed the splitter (and the whole working
   * surface) off the right edge of a narrowed window, where it could not be
   * dragged back. The renderer clamps it so neither pane can be squeezed below
   * a usable minimum. */
  projectsSplit: number;
}

/**
 * Bounds for `projectsSplit`. Deliberately far wider than any position the UI
 * can produce: the *real* constraint is the renderer's px clamp (a 200px floor
 * on each pane), and these exist only so a hand-edited settings.json can't
 * store something absurd. Keeping them loose is load-bearing — a tighter
 * fraction bound would disagree with the px clamp on a wide monitor and snap
 * the splitter away from where the user released it. 0.02 stays out of the way
 * up to a ~10000px band.
 */
export const MIN_PROJECTS_SPLIT = 0.02;
export const MAX_PROJECTS_SPLIT = 0.98;
export const DEFAULT_PROJECTS_SPLIT = 0.32;
