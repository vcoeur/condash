/** Subset of `NodeJS.Platform` we actually care about. The renderer doesn't
 *  link `@types/node` so it can't reach the full union — we mirror the three
 *  values that influence per-OS behaviour and leave a string fallback for
 *  the rare exotic (`freebsd`, `aix`, ...). */
export type Platform = 'linux' | 'darwin' | 'win32' | (string & {});

export type ItemKind = 'project' | 'incident' | 'document' | 'unknown';

export type KnownStatus = 'now' | 'review' | 'later' | 'backlog' | 'done';

export const KNOWN_STATUSES: readonly KnownStatus[] = ['now', 'review', 'later', 'backlog', 'done'];

export interface StepCounts {
  todo: number;
  doing: number;
  done: number;
  dropped: number;
}

export type StepMarker = ' ' | '~' | 'x' | '-';

export const STEP_MARKERS: readonly StepMarker[] = [' ', '~', 'x', '-'];

export interface Step {
  lineIndex: number;
  marker: StepMarker;
  text: string;
  section: string;
}

export interface Deliverable {
  /** Label as written between the [ ] of `- [label](path) — desc`. */
  label: string;
  /** Resolved absolute path on disk. */
  path: string;
  /** Optional trailing description after ' — '. */
  description?: string;
}

export interface Project {
  slug: string;
  path: string;
  title: string;
  kind: ItemKind;
  status: KnownStatus | string;
  /** Apps backticked on the **Apps** header line, parsed into the bare slugs
   * (e.g. `[\`alicepeintures\`]` → `['alicepeintures']`). Empty when the line
   * is missing or has no backticks — never `undefined`, so call sites can
   * iterate without an existence guard. */
  apps: string[];
  summary?: string;
  steps: Step[];
  stepCounts: StepCounts;
  deliverables: Deliverable[];
  deliverableCount: number;
}

export interface ProjectFileEntry {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the project directory (e.g. "README.md", "notes/01-foo.md"). */
  relPath: string;
  /** Last segment of relPath. */
  name: string;
}

export type Theme = 'light' | 'dark' | 'system';

/** Right-slot working surface — picks which of Code / Knowledge is shown
 * in the top-band right pane, or `null` to leave it hidden. The two are
 * mutually exclusive: showing one swaps the other out. */
export type WorkingSurface = 'code' | 'knowledge' | null;

/** Composite-layout state. The unified window has a top band (Projects on
 * the left, working surface on the right) and a bottom band (Terminal).
 * Each band can be hidden independently; the working surface is also
 * tristate. Sizes are persisted alongside visibility so re-showing a pane
 * restores its previous dimensions. */
export interface LayoutState {
  projects: boolean;
  /** Code / Knowledge / hidden — single right-slot tristate. */
  working: WorkingSurface;
  terminal: boolean;
  /** Width of the Projects pane in CSS pixels when both Projects and the
   * working surface are visible. The working surface fills the rest. */
  projectsWidth: number;
}

export interface Settings {
  conceptionPath: string | null;
  theme: Theme;
  /** Per-machine terminal prefs. Moved here from configuration.json so each
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
}

/** One row of `git status --porcelain=v1` output, joined with the
 *  matching `git diff --numstat HEAD` row when present. */
export interface DirtyFile {
  /** Two-character porcelain status (e.g. ` M`, `??`, `D `). Whitespace
   * preserved so the renderer can render the column verbatim. */
  code: string;
  /** Path relative to the worktree root. Rename arrows are collapsed to the
   * new path (rename targets are usually the more interesting filename). */
  path: string;
  /** Lines added per `git diff --numstat HEAD`. Null when the file is
   *  untracked, binary, or numstat had no row for it (fresh repo, etc.). */
  added: number | null;
  /** Lines deleted. Same null semantics as `added`. */
  deleted: number | null;
  /** True when numstat reports the path as binary (`- - <path>`). */
  binary: boolean;
}

/** Click-to-inspect payload for the per-branch dirty badge. One row per
 *  dirty file (capped at a fixed file limit) with totals for the footer. */
export interface DirtyDetails {
  files: DirtyFile[];
  /** Aggregate `+` count across the returned files. Untracked / binary
   *  files contribute 0. */
  totalAdded: number;
  /** Aggregate `-` count across the returned files. */
  totalDeleted: number;
  /** True when the file list was truncated to fit the fixed limit. */
  truncated: boolean;
  /** Total number of dirty files before truncation. */
  totalCount: number;
}

export interface Worktree {
  /** Absolute path on disk. */
  path: string;
  /** Branch name (without the `refs/heads/` prefix); null when detached. */
  branch: string | null;
  /** True when this worktree is the primary checkout (the one in `repositories`). */
  primary: boolean;
  /** Count of modified + staged + untracked files in this worktree; null
   * when git status couldn't run for any reason. */
  dirty?: number | null;
}

export interface RepoEntry {
  /** Display name (typically the repo directory name; submodules use `parent/child`). */
  name: string;
  /** Optional human-friendly label from `configuration.json`. Rendered as a
   * small subtitle on the card when present — useful when the directory name
   * is a slug and a friendlier descriptor is wanted alongside it. */
  label?: string;
  /** Absolute path on disk. */
  path: string;
  /** primary | secondary — matches the configuration.json layout. */
  kind: 'primary' | 'secondary';
  /** When set, this entry is a submodule of the named parent repo. */
  parent?: string;
  /** Count of modified+staged+untracked files; null if git status couldn't run. */
  dirty: number | null;
  /** True when path doesn't exist or isn't a git repo. */
  missing: boolean;
  /** True when configuration.json sets a `force_stop:` for this entry. */
  hasForceStop?: boolean;
  /** True when configuration.json sets a `run:` for this entry. The renderer
   * uses this to decide whether to render the per-branch run button — REPO
   * cards without a configured run target should not surface it. */
  hasRun?: boolean;
  /** Worktrees attached to this repo (always includes the primary checkout). */
  worktrees?: Worktree[];
}

export type TermSide = 'my' | 'code';

export interface TerminalXtermColors {
  foreground?: string;
  background?: string;
  cursor?: string;
  cursor_accent?: string;
  selection_background?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  bright_black?: string;
  bright_red?: string;
  bright_green?: string;
  bright_yellow?: string;
  bright_blue?: string;
  bright_magenta?: string;
  bright_cyan?: string;
  bright_white?: string;
}

export interface TerminalXtermPrefs {
  font_family?: string;
  font_size?: number;
  line_height?: number;
  letter_spacing?: number;
  font_weight?: string | number;
  font_weight_bold?: string | number;
  cursor_style?: 'block' | 'underline' | 'bar';
  cursor_blink?: boolean;
  scrollback?: number;
  ligatures?: boolean;
  colors?: TerminalXtermColors;
}

export interface TerminalPrefs {
  shell?: string;
  shortcut?: string;
  screenshot_dir?: string;
  screenshot_paste_shortcut?: string;
  launcher_command?: string;
  move_tab_left_shortcut?: string;
  move_tab_right_shortcut?: string;
  xterm?: TerminalXtermPrefs;
}

/** Snapshot of a live (or recently-exited) terminal session, broadcast on
 * spawn/exit/close so renderers can keep their tab strip and Code-tab LIVE
 * badges in sync without polling. */
export interface TermSession {
  id: string;
  side: TermSide;
  /** When the session was launched via the Run button on a repo, the repo
   * display name (e.g. `condash`, `PaintingManager/app`). */
  repo?: string;
  /** Resolved cwd the pty was spawned in. The Code tab uses this to match a
   * live session back to a specific worktree (and therefore branch) so the
   * card face can label which branch is currently running. */
  cwd?: string;
  /** Process exit code if the pty has terminated; undefined while live. */
  exited?: number;
}

export interface TermSpawnRequest {
  side: TermSide;
  /** When set, looks up the repo's `run:` and uses its cwd. */
  repo?: string;
  /** Free-form command to run via `bash -lc`. Mutually exclusive with `repo`. */
  command?: string;
  /** Override the cwd; defaults to $HOME (or the resolved repo cwd). */
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface TermDataMessage {
  id: string;
  data: string;
}

export interface TermExitMessage {
  id: string;
  code: number;
}

export type OpenWithSlotKey = 'main_ide' | 'secondary_ide' | 'terminal';

export interface OpenWithSlot {
  label: string;
  command: string;
}

export type OpenWithSlots = Partial<Record<OpenWithSlotKey, OpenWithSlot>>;

/** One token in the parsed search query. The `index` is the position in the
 * user-typed query, used downstream as the per-token highlight-colour key. */
export interface SearchTerm {
  /** Lowercased token / phrase value. */
  value: string;
  /** True when the user wrote `"two words"` — must match contiguously. */
  phrase: boolean;
  /** 0-based position in the parsed query. */
  index: number;
}

/** Region of a file that produced a match. Used by the scorer for weighting
 * and by the renderer for "where in the file" hints. */
export type SearchRegion = 'h1' | 'meta' | 'heading' | 'body' | 'path';

/** Inline highlight inside a string of text — matched token + offset relative
 * to that string. Used for snippet highlights and path-line highlights. */
export interface SearchHighlight {
  tokenIndex: number;
  start: number;
  length: number;
}

/** A single excerpted snippet from a matched file. */
export interface SearchSnippet {
  text: string;
  /** Inline highlights, offsets relative to `text`. */
  matches: SearchHighlight[];
  region: SearchRegion;
}

export interface SearchHit {
  /** Absolute path of the matched file. */
  path: string;
  /** Path relative to the conception root, for display. */
  relPath: string;
  /** Best-effort title (first H1 line) for display. */
  title: string;
  /** 'project' if the file lives under projects/<…>/, 'knowledge' otherwise. */
  source: 'project' | 'knowledge';
  /** Relevance score — higher is better. */
  score: number;
  /** Total occurrence count across all query terms. */
  matchCount: number;
  /** First few snippets, prioritised by region (meta > h1 > heading > body). */
  snippets: SearchSnippet[];
  /** Highlights into the file path itself, when the path was part of the
   * match — surfaced as a dimmed highlight on the path line. */
  pathMatches?: SearchHighlight[];
  /**
   * Absolute path to the owning project directory when `source === 'project'`.
   * The renderer groups project hits by this field so a project's README +
   * notes/* matches collapse into a single entry — the header opens the
   * project popup, each file row opens the note viewer.
   */
  projectPath?: string;
}

export interface SearchResults {
  hits: SearchHit[];
  /** Tokens parsed from the query, in user-typed order. The renderer uses
   * these for client-side multi-token highlighting. */
  terms: SearchTerm[];
  /** Total matched files before the cap was applied. */
  totalBeforeCap: number;
  /** True when results were truncated to the cap. */
  truncated: boolean;
}

export type TreeEvent =
  | { kind: 'project'; op: 'add' | 'change' | 'unlink'; path: string }
  | { kind: 'knowledge'; op: 'add' | 'change' | 'unlink'; path: string }
  | { kind: 'config'; path: string }
  | { kind: 'unknown' };

/** Repo-tree event broadcast by the per-repo FS watcher (worktree + .git/
 *  meta) so the renderer can patch one repo (or one worktree) in place
 *  without re-fetching the whole repo list. `path` matches a `RepoEntry.path`
 *  or one of its `worktrees[].path`. `dirty` is the freshly-recomputed count
 *  (or null when `git status` couldn't run). */
export type RepoEvent = { kind: 'repo-dirty'; path: string; dirty: number | null };

export interface KnowledgeNode {
  /** Path relative to <conception>/knowledge/. Empty string for the root. */
  relPath: string;
  /** Absolute path on disk. */
  path: string;
  /** Last segment of relPath, or 'knowledge' for the root. */
  name: string;
  /** Title from the .md (first h1) when this is a file; the directory name otherwise. */
  title: string;
  /** Directory or file. Files end with .md; everything else is skipped. */
  kind: 'directory' | 'file';
  /** Children (only for directories). Sorted: directories first, then files, both alphabetical. */
  children?: KnowledgeNode[];
  /** First non-heading paragraph, trimmed to ~240 chars. Files only. */
  summary?: string;
  /** ISO date (YYYY-MM-DD) extracted from a `**Verified:**` line, when present. Files only. */
  verifiedAt?: string;
}

/**
 * Result of probing a candidate conception path. The renderer uses this to
 * decide whether to surface the bundled-template init prompt after the user
 * picks a folder.
 */
export interface ConceptionInitState {
  pathExists: boolean;
  hasProjects: boolean;
  hasConfiguration: boolean;
  /** Both projects/ and configuration.json present. */
  looksInitialised: boolean;
}
