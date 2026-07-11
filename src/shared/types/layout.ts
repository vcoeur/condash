// Renderer view-state: which panes are visible and how the composite window
// is arranged. This is conceptually the renderer's UI state, peeled out of the
// general IPC-contract grab-bag into its own module. It stays under `shared/`
// (rather than `renderer/`) because the layout is persisted through the
// settings IPC contract — `getLayout` / `setLayout` in `shared/api.ts`, the
// `layout` field on `Settings`, and the native menu's checkbox sync in
// `main/menu.ts` all reference these shapes — so the main process and the
// renderer must agree on one definition.

/** Right-slot working surface — picks which of Code / Knowledge / Resources /
 * Skills / Logs is shown in the top-band right pane, or `null` to leave it
 * hidden. All are mutually exclusive: showing one swaps the others out. (The
 * Dashboard is not a working surface — it lives in the bottom band next to
 * Terminal.) */
export type WorkingSurface = 'code' | 'knowledge' | 'resources' | 'skills' | 'logs' | null;

/** Left-band view — which pane fills the left band when it is visible.
 * Selected by the left activity-rail items (Projects / Tasks / Deliverables). */
export type LeftView = 'projects' | 'tasks' | 'deliverables';

/** Composite-layout state. The unified window has a top band (Projects on
 * the left, working surface on the right) and a bottom band (Terminal).
 * Each band can be hidden independently; the working surface is also
 * tristate. Sizes are persisted alongside visibility so re-showing a pane
 * restores its previous dimensions. */
export interface LayoutState {
  projects: boolean;
  /** Which view fills the left band when it is visible. Projects is the
   * default; Outputs aggregates every project's `## Deliverables`. Switched
   * by the left-band tab strip; the band's visibility is still `projects`. */
  leftView: LeftView;
  /** Code / Knowledge / hidden — single right-slot tristate. */
  working: WorkingSurface;
  terminal: boolean;
  /** Width of the Projects pane in CSS pixels when both Projects and the
   * working surface are visible. The working surface fills the rest. */
  projectsWidth: number;
}
