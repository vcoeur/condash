// Persisted settings: the top-level `Settings` shape plus the per-pane prefs
// it nests (tree expansion, card min-widths, skill scope) and the "open with"
// editor slots.

import type { Theme } from './common';
import type { LayoutState } from './layout';
import type { TerminalPrefs } from './terminal';
import type { TaskConfigEntry } from './task-runs';

/** Scope toggle in the Skills pane. `conception` reads the active
 *  conception's `AGENTS.md` + `.agents/skills/` tree; `user` reads the
 *  per-machine agedum sources at `~/.config/agents/AGENTS.md` +
 *  `~/.config/agents/skills/`. The pane is read-only in both scopes; condash
 *  surfaces the agedum source-of-truth and never edits it. */
export type SkillScope = 'conception' | 'user';

export const SKILL_SCOPES: readonly SkillScope[] = ['conception', 'user'] as const;

export interface Settings {
  /** Currently-open conception path. Replaces the legacy `conceptionPath`
   * field; a one-shot migration in `readSettings` rewrites old files. */
  lastConceptionPath: string | null;
  /** Most-recently-opened conception paths, newest first. Capped on every
   * write — oldest evicted on overflow. Drives the File → Open Recent
   * submenu and the Global tab's recents list. */
  recentConceptionPaths: string[];
  theme: Theme;
  /** Per-machine terminal prefs. Moved here from condash.json so each
   * laptop carries its own font/screenshot/keybinding choices. */
  terminal?: TerminalPrefs;
  /** Composite-layout visibility + sizes. Persisted globally (per-machine)
   * so a fresh launch reopens with the last layout. */
  layout?: LayoutState;
  /** First-launch welcome screen state. The screen shows automatically when
   * the conception tree has no items and no knowledge entries; setting
   * `dismissed` hides it permanently for users who manage trees entirely
   * outside the dashboard. */
  welcome?: { dismissed?: boolean };
  /** Per-pane card grid min-width (CSS pixels). The grid uses
   * `minmax(min(<min>, 100%), 1fr)` so a row of *n* cards reflows to *n+1*
   * once the pane is wide enough to fit *n+1* cards each at this width.
   * Smaller values pack more cards per row at the same window size; larger
   * values keep cards roomy. Per-machine because what feels right depends
   * on the monitor, not the team. */
  cardMinWidth?: CardMinWidthPrefs;
  /** Per-pane set of expanded directory `relPath`s in the Knowledge,
   * Resources, and Skills panes. Empty (or missing) means every directory
   * is collapsed — that is the on-purpose first-load state per the issue
   * #89 spec. The empty-string entry stands in for the pane's root
   * directory; everything else matches a `relPath` returned by the tree
   * reader. The Skills pane uses one `skills` set per scope (the user/
   * conception toggle is a small dimension, so two sets are stored under
   * a single key — see `TreeExpansionPrefs`). Per-machine because the
   * answer is "what was I last looking at on this laptop", not a team
   * convention. */
  treeExpansion?: TreeExpansionPrefs;
  /** Branch names that the Code pane's top-of-pane filter pins as visible
   * on every app card. The primary worktree row is always rendered; this
   * set is additive on top of it. Per-machine because the answer is "what
   * I'm actively working on right now on this laptop", not a team rule. */
  selectedBranches?: string[];
  /** Whether the branch-pin selector is in "All (sticky)" mode: every
   *  branch is shown and any branch created later is implicitly pinned.
   *  False = custom (`selectedBranches` is honoured exactly; empty means
   *  "only main"). Defaults to true on first read when `selectedBranches`
   *  is empty/undefined, false otherwise — preserves existing behaviour
   *  for users with an explicit selection. Issue #169. */
  branchFilterStickyAll?: boolean;
  /** Active scope toggle in the Skills pane (conception vs user). The
   *  user-scope reads agedum sources at `~/.config/agents/`; the conception
   *  scope reads `<conception>/.agents/`. Persisted per-machine; defaults
   *  to `conception`. */
  skillsActiveScope?: SkillScope;
  /** Per-task schedule / log-routing config keyed by task slug (capability
   *  1). Conception-scoped (`SCOPE_OF.taskConfig === 'conception'`): the writer
   *  (`setTaskConfig`) and reader (`getTaskConfig`) target
   *  `<conception>/.condash/settings.json`, never this per-machine global file.
   *  Declared here only so a global settings.json written by a pre-scope-fix
   *  build — which misrouted the key into the global file — still type-checks
   *  on read until the scope-partition migrator lifts it to the conception. */
  taskConfig?: Record<string, TaskConfigEntry>;
}

/** Sets of expanded directory `relPath`s for the three tree panes. The
 * empty-string entry is the root of that pane. */
export interface TreeExpansionPrefs {
  knowledge?: string[];
  resources?: string[];
  /** Conception-scope skills tree (`<conception>/.agents/skills/`). The
   *  pre-reframe per-harness keys (`skillsGeneric`, `skillsClaude`,
   *  `skillsKimi`, `skillsOpencode`) collapsed into this single key when
   *  the Skills pane switched to agedum sources. The legacy `skills` key
   *  is read for back-compat but never written. */
  skills?: string[];
  /** User-scope skills tree (`~/.config/agents/skills/`). */
  skillsUser?: string[];
}

/** Per-pane card min-width in CSS pixels. Used in the grid template
 * `minmax(min(<min>, 100%), 1fr)`. Each field is optional — a missing
 * field falls back to the built-in default (`DEFAULT_CARD_MIN_WIDTH`). */
export interface CardMinWidthPrefs {
  projects?: number;
  code?: number;
  knowledge?: number;
  resources?: number;
  skills?: number;
  logs?: number;
  tasks?: number;
  deliverables?: number;
}

/** Built-in defaults for the eight card grids. Match the literal pixel
 * values previously baked into the pane stylesheets — changing one of
 * these silently changes the layout on every machine that hasn't set the
 * matching key in settings.json, so do it deliberately. */
export const DEFAULT_CARD_MIN_WIDTH = {
  projects: 650,
  code: 650,
  knowledge: 520,
  resources: 280,
  skills: 280,
  logs: 400,
  tasks: 340,
  deliverables: 340,
} as const satisfies Required<CardMinWidthPrefs>;

/** Canonical list of card-grid keys, derived from the one place the panes are
 * enumerated (`DEFAULT_CARD_MIN_WIDTH`). The config schema and the settings IPC
 * import this rather than hand-maintaining their own copies — a stale copy is
 * exactly how `logs` / `tasks` / `deliverables` shipped unsavable. Adding a pane
 * to `DEFAULT_CARD_MIN_WIDTH` extends every consumer automatically. */
export const CARD_MIN_WIDTH_KEYS = Object.keys(
  DEFAULT_CARD_MIN_WIDTH,
) as (keyof CardMinWidthPrefs)[];

export type OpenWithSlotKey = 'main_ide' | 'secondary_ide' | 'terminal';

export interface OpenWithSlot {
  label: string;
  command: string;
}

export type OpenWithSlots = Partial<Record<OpenWithSlotKey, OpenWithSlot>>;
