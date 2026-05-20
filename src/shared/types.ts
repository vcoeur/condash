/** Subset of `NodeJS.Platform` we actually care about. The renderer doesn't
 *  link `@types/node` so it can't reach the full union — we mirror the three
 *  values that influence per-OS behaviour and leave a string fallback for
 *  the rare exotic (`freebsd`, `aix`, ...). */
export type Platform = 'linux' | 'darwin' | 'win32' | (string & {});

export type ItemKind = 'project' | 'incident' | 'document' | 'unknown';

/**
 * Names of the bundled help docs the renderer can request via `readHelpDoc`.
 * Lifted to `shared/` so the IPC contract (`shared/api.ts`) and the main
 * loader's `PATHS` allowlist (`main/help.ts`) reference one canonical union —
 * additions/renames touch one file instead of two.
 */
export type HelpDocName =
  | 'welcome'
  | 'quick-start'
  | 'shortcuts'
  | 'configuration'
  | 'cli'
  | 'why-markdown';

export type KnownStatus = 'now' | 'review' | 'later' | 'backlog' | 'done';

export const KNOWN_STATUSES: readonly KnownStatus[] = ['now', 'review', 'later', 'backlog', 'done'];

export interface StepCounts {
  todo: number;
  doing: number;
  done: number;
  blocked: number;
  dropped: number;
}

export type StepMarker = ' ' | '~' | 'x' | '!' | '-';

export const STEP_MARKERS: readonly StepMarker[] = [' ', '~', 'x', '!', '-'];

export interface Step {
  lineIndex: number;
  marker: StepMarker;
  text: string;
  section: string;
}

export interface Deliverable {
  /** Label as written between the [ ] of `- [label](path) — desc`. */
  label: string;
  /** The link target. A local file is a resolved absolute (posix) path on
   *  disk; an http(s) link is kept verbatim as the URL. Callers distinguish
   *  the two by an `https?://` prefix test. */
  path: string;
  /** Optional trailing description after ' — '. */
  description?: string;
}

/** Single `## Timeline` entry parsed from a project README. The
 * `<date> — <text>` shape is canonical; lines that don't match it are
 * skipped at parse time. */
export interface TimelineEntry {
  date: string;
  text: string;
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
  /** Auth value from `**Branch**: \`<name>\` …`. The first backticked token
   * is authoritative per `projects/SKILL.md` — trailing prose is ignored.
   * Null when the header has no `**Branch**` line. Populated alongside
   * `apps` so the renderer can show the branch on the card without a
   * second IPC call. */
  branch: string | null;
  /** Auth value from `**Base**`. Null when the header has no `**Base**` line. */
  base: string | null;
  summary?: string;
  steps: Step[];
  stepCounts: StepCounts;
  deliverables: Deliverable[];
  deliverableCount: number;
  /** ISO date `YYYY-MM-DD` of the most recent `## Timeline` line matching
   * `- <date> — Closed.`. `null` when no such line exists (the project was
   * never closed, or its timeline pre-dates the convention). Populated for
   * every project, not only `status === 'done'`, so a reopened-then-reclosed
   * item retains the date the latest close left behind. */
  closedAt: string | null;
  /** Parsed `## Timeline` entries in source order. Empty when the section
   * is absent. Powers the popup's collapsed-by-default Timeline pane and
   * the card's first/last-date display. */
  timeline: TimelineEntry[];
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

/** Per-session log file summary — what the Logs pane's session selector
 * renders as one row per spawn. Pairs an absolute `.txt` path with
 * sidecar metadata. */
export interface TermLogSessionMeta {
  /** Absolute path to the `.txt` file. */
  path: string;
  /** Day directory this session lives in, `YYYY-MM-DD`. */
  day: string;
  /** Spawn-time HH:MM:SS, parsed from the filename prefix. */
  time: string;
  /** Total size of the `.txt` in bytes. */
  bytes: number;
  /** Session id (the `<sid>` suffix in the filename). */
  sid: string;
  /** Optional repo name from the spawn event. */
  repo?: string;
  /** Cwd captured at spawn. */
  cwd?: string;
  /** Spawn command argv joined (truncated to 80 chars in the renderer). */
  cmd?: string;
  /** Exit code, if `exit` was reached; undefined while a long-running
   * session is still alive; `null` when the boot-time orphan-seal pass
   * found a session without a footer (process gone before the footer
   * could flush) — UI renders this as "ended (unknown)" instead of
   * "running". */
  exitCode?: number | null;
  /** True when the footer was synthesised by the orphan-seal recovery
   * (i.e. condash exited before SessionLogger.exit() could flush). UI
   * uses this to render a distinct status pill. */
  exitSealed?: boolean;
}

/** Contents of a session — plain-text body + parsed metadata. Returned
 * by `logsReadSession`. */
export interface TermLogSessionRead {
  /** Rendered terminal buffer as plain UTF-8 text. Metadata header /
   * footer lines (`# condash: {...}`) have been stripped before return —
   * the renderer sees just the body. */
  text: string;
  /** Metadata parsed from the header line (and footer line, if the
   * session has exited). Best-effort — null if the file has no
   * recognisable header. */
  meta: TermLogSessionMeta | null;
}

/** External "open this log" request — posted by the global-search modal
 * when the user activates a log hit. The Logs pane reacts by swapping
 * day + session to point at `path`. The hit offset is informational
 * (future scroll-to-line); the search box is left as the user typed. */
export interface LogsOpenRequest {
  path: string;
  /** Identity nonce so the same path activated twice in a row still
   * fires the reaction effect. */
  nonce: number;
}

/** Right-slot working surface — picks which of Code / Knowledge / Resources /
 * Skills is shown in the top-band right pane, or `null` to leave it hidden.
 * All four are mutually exclusive: showing one swaps the others out. */
export type WorkingSurface = 'code' | 'knowledge' | 'resources' | 'skills' | 'logs' | null;

/** Left-band view — which pane fills the left band when it is visible.
 * Switched by the `[Projects][Outputs]` tab strip at the top of the band. */
export type LeftView = 'projects' | 'outputs';

/** Active tab in the Skills pane. */
export type SkillTab = 'generic' | 'claude' | 'kimi';

export const SKILL_TABS: readonly SkillTab[] = ['generic', 'claude', 'kimi'] as const;

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
   * reader. Per-machine because the answer is "what was I last looking
   * at on this laptop", not a team convention. */
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
  /** Active tab in the Skills pane. Persisted per-machine so the next
   *  launch reopens whichever tab the user last looked at. Defaults to
   *  `claude` (preserves pre-tabs behaviour for existing users). */
  skillsActiveTab?: SkillTab;
}

/** Sets of expanded directory `relPath`s for the three tree panes. The
 * empty-string entry is the root of that pane. */
export interface TreeExpansionPrefs {
  knowledge?: string[];
  resources?: string[];
  /** Legacy key — migrated to `skillsClaude` on first read. Kept for
   *  backwards compatibility during load; writers always emit the three
   *  per-tab keys below. */
  skills?: string[];
  skillsGeneric?: string[];
  skillsClaude?: string[];
  skillsKimi?: string[];
}

/** Discriminator for the three tree panes. Used by the `tree.*` IPC verbs
 * to pick the correct on-disk root (knowledge is hardcoded to `knowledge/`;
 * resources and skills come from `condash.json`). */
export type TreeRoot = 'knowledge' | 'resources' | 'skills';

/** Per-pane card min-width in CSS pixels. Used in the grid template
 * `minmax(min(<min>, 100%), 1fr)`. Each field is optional — a missing
 * field falls back to the built-in default (`DEFAULT_CARD_MIN_WIDTH`). */
export interface CardMinWidthPrefs {
  projects?: number;
  code?: number;
  knowledge?: number;
  resources?: number;
  skills?: number;
}

/** Built-in defaults for the five card grids. Match the literal pixel
 * values previously baked into the pane stylesheets — changing one of
 * these silently changes the layout on every machine that hasn't set the
 * matching key in settings.json, so do it deliberately. */
export const DEFAULT_CARD_MIN_WIDTH = {
  projects: 650,
  code: 650,
  knowledge: 520,
  resources: 280,
  skills: 280,
} as const satisfies Required<CardMinWidthPrefs>;

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

/** One unpushed commit on the local branch (i.e. on `HEAD` but not yet on
 *  the upstream tracking ref). Surfaced in the dirty popover so the user
 *  sees what's queued for the next push, not just the count. */
export interface UnpushedCommit {
  /** Short SHA (`%h`). */
  sha: string;
  /** Subject line (`%s`). */
  subject: string;
}

/** Upstream tracking summary for one worktree. The badge needs only `ahead`
 *  + the existence of an upstream; `upstreamRef` is shown in the popover so
 *  the user knows which remote/branch they're being told about. */
export interface UpstreamStatus {
  /** Tracking ref shorthand, e.g. `origin/main`. Null only when the lookup
   *  ran but git returned an unexpected shape — `hasUpstream:false` cases
   *  return a top-level null instead of this struct. */
  upstreamRef: string | null;
  /** Commits on local but not on upstream (i.e. unpushed). */
  ahead: number;
}

/** Click-to-inspect payload for the per-branch dirty badge. One row per
 *  dirty file (capped at a fixed file limit) with totals for the footer.
 *  Also carries unpushed-commit context so the popover can list them in a
 *  separate section without a second round-trip. */
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
  /** Upstream summary (null when the branch has no tracking ref). */
  upstream: UpstreamStatus | null;
  /** Unpushed commits (newest first, capped at a fixed limit). Empty when
   *  there's no upstream or the branch is in sync. */
  unpushedCommits: UnpushedCommit[];
  /** True when the unpushed-commit list was truncated to fit the cap. */
  unpushedTruncated: boolean;
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
  /** Upstream tracking summary; null when the branch has no upstream
   *  (fresh local branch, detached HEAD, etc.). Drives the per-branch
   *  upstream badge alongside `dirty`. */
  upstream?: UpstreamStatus | null;
}

export interface RepoEntry {
  /** Display name (typically the repo directory name; submodules use `parent/child`). */
  name: string;
  /** Optional human-friendly label from `condash.json`. Rendered as a
   * small subtitle on the card when present — useful when the directory name
   * is a slug and a friendlier descriptor is wanted alongside it. */
  label?: string;
  /** Absolute path on disk. */
  path: string;
  /** When set, this entry is a submodule of the named parent repo. */
  parent?: string;
  /** Count of modified+staged+untracked files; null if git status couldn't run. */
  dirty: number | null;
  /** True when path doesn't exist or isn't a git repo. */
  missing: boolean;
  /** True when the path exists and is a git repository. False or omitted
   *  for plain directories that are not under git. */
  isGit?: boolean;
  /** True when condash.json sets a `force_stop:` for this entry. */
  hasForceStop?: boolean;
  /** True when condash.json sets a `run:` for this entry. The renderer
   * uses this to decide whether to render the per-branch run button — REPO
   * cards without a configured run target should not surface it. */
  hasRun?: boolean;
  /** Worktrees attached to this repo (always includes the primary checkout). */
  worktrees?: Worktree[];
  /** Name of the most-recent `{ section: … }` marker that preceded this
   *  entry in `repositories[]`. Undefined for entries before the first
   *  marker (the implicit default bucket). Submodules inherit their parent's
   *  section. Drives Code-pane card grouping. */
  section?: string;
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

/** One configurable launcher entry. Each renders as an option in the
 *  terminal tab-strip dropdown when `command` is non-empty.
 *  `label` is the user-defined name shown in the dropdown.
 *  `title`, when set, becomes the pinned tab label at spawn time; an
 *  inline rename (`customName`) still wins forever after. */
export interface LauncherConfig {
  label: string;
  command: string;
  title?: string;
}

/** One user-configurable action template. Substituted at click time and
 *  typed into the focused terminal. */
export interface ActionTemplate {
  /** User-facing label in the dropdown menu. */
  label: string;
  /** Template string with `{placeholder}` tokens. */
  template: string;
  /** When true, press Enter after typing. Default false. */
  submit?: boolean;
  /** When set, names one of `terminal.launchers[].label`. The action then
   *  spawns a fresh tab using that launcher's command before typing the
   *  template (e.g. bind "Start new project" to a Claude / Kimi / shell
   *  launcher). Empty / missing → type into the focused tab, spawning the
   *  default launcher only if no tab exists. */
  launcher?: string;
}

export interface TerminalPrefs {
  shell?: string;
  shortcut?: string;
  screenshot_dir?: string;
  screenshot_paste_shortcut?: string;
  /** Configurable launcher slots. Each entry renders a button on the tab
   *  strip; the legacy scalar `launcher_command` is migrated transparently
   *  into `launchers[0]` (label: 'λ') on first load. */
  launchers?: LauncherConfig[];
  move_tab_left_shortcut?: string;
  move_tab_right_shortcut?: string;
  xterm?: TerminalXtermPrefs;
  /** Per-session capture of stdin / stdout / spawn / exit to
   * `<conception>/.condash/logs/YYYY/MM/DD/HHMMSS-<sid>.jsonl`. The folder
   * is fully gitignored by default. */
  logging?: TerminalLoggingPrefs;
  /** Custom per-project actions exposed in the card / preview dropdown.
   *  Empty or missing → only the built-in "Work on <slug>" default. */
  projectActions?: ActionTemplate[];
  /** Custom starter prompts exposed in the dropdown next to "+ New project".
   *  Empty or missing → the button stays a single button that opens
   *  NewProjectModal as today. */
  newProjectActions?: ActionTemplate[];
}

/** Configuration for the per-session terminal log writer. Defaults are
 * applied by the writer when fields are absent (`enabled: false`,
 * `scrollback: 10000`, `retentionDays: 14`, `maxDirMb: 500`) — the
 * schema's defaults track the same values. */
export interface TerminalLoggingPrefs {
  /** Toggle capture entirely. Default: false (opt-in for privacy). The
   * Logs pane stays usable for browsing existing transcripts even when
   * disabled — flipping the toggle off does not sweep prior logs. */
  enabled?: boolean;
  /** Days of log history retained by the janitor. Older day-directories
   * are evicted on next janitor run. Default: 14. */
  retentionDays?: number;
  /** Total size cap for the per-conception logs/ tree. The janitor
   * evicts oldest day-directories first when over cap. Default: 500. */
  maxDirMb?: number;
  /** Scrollback lines retained by the headless xterm that produces the
   * rendered `.txt`. Larger value → more history kept, larger per-session
   * file. Default: 10000. */
  scrollback?: number;
}

/** Snapshot of a live (or recently-exited) terminal session, broadcast on
 * spawn/exit/close so renderers can keep their tab strip and Code-pane LIVE
 * badges in sync without polling. */
export interface TermSession {
  id: string;
  side: TermSide;
  /** When the session was launched via the Run button on a repo, the repo
   * display name (e.g. `condash`, `PaintingManager/app`). */
  repo?: string;
  /** Resolved cwd the pty was spawned in. The Code pane uses this to match a
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
  /** Where the file lives. Drives the result-grouping in the search UI and
   * the per-source facet pills in the search modal. */
  source: 'project' | 'knowledge' | 'resources' | 'skills' | 'logs';
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
  | { kind: 'resources'; op: 'add' | 'change' | 'unlink'; path: string }
  | { kind: 'skills'; op: 'add' | 'change' | 'unlink'; path: string }
  | { kind: 'logs'; op: 'add' | 'change' | 'unlink'; path: string }
  | { kind: 'config'; path: string }
  | { kind: 'unknown' };

/** Repo-tree event broadcast by the per-repo FS watcher (worktree + .git/
 *  meta) so the renderer can patch one repo (or one worktree) in place
 *  without re-fetching the whole repo list. `path` matches a `RepoEntry.path`
 *  or one of its `worktrees[].path`.
 *
 *  - `repo-dirty`: dirty-file count changed (or recomputed); null when git
 *    couldn't run.
 *  - `repo-upstream`: upstream tracking summary changed (push, fetch, local
 *    commit, branch switch); null when the branch has no upstream.
 *  - `repo-worktrees-changed`: structural change for a primary repo — a
 *    worktree was added/removed, or the primary checkout itself switched
 *    branches. The renderer responds by reloading just this primary
 *    (and its submodule children) rather than the whole repo list.
 *    `repoPath` is the primary's `RepoEntry.path`. */
export type RepoEvent =
  | { kind: 'repo-dirty'; path: string; dirty: number | null }
  | { kind: 'repo-upstream'; path: string; upstream: UpstreamStatus | null }
  | { kind: 'repo-worktrees-changed'; repoPath: string };

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
 * Coarse file category used by the Resources pane to pick the right icon
 * and action set without re-reading the file. Computed from the extension
 * during the tree walk; binaries fall through to `binary`, anything not
 * matched by the table lands in `other`.
 */
export type ResourceCategory =
  | 'markdown'
  | 'pdf'
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'archive'
  | 'binary'
  | 'other';

/**
 * Tree node for the Resources pane. Same shape as `KnowledgeNode` but every
 * file is surfaced (not just `.md`), and each file carries its mime hint
 * plus the coarse `category` used by the renderer's icon picker.
 */
export interface ResourceNode {
  /** Path relative to <conception>/<resources_path>. Empty string for the root. */
  relPath: string;
  /** Absolute path on disk. */
  path: string;
  /** Last segment of relPath, or 'resources' for the root. */
  name: string;
  /** Title from the .md (first h1) when this is a markdown file; the directory or basename otherwise. */
  title: string;
  /** Directory or file. */
  kind: 'directory' | 'file';
  /** Children (only for directories). Sorted: directories first, then files, both alphabetical. */
  children?: ResourceNode[];
  /** First non-heading paragraph, trimmed to ~240 chars. Markdown files only. */
  summary?: string;
  /** Coarse category (drives icon + action set). Files only. */
  category?: ResourceCategory;
  /** Best-effort mime type (e.g. "text/markdown", "image/png"). Files only. */
  mime?: string;
  /** Size in bytes. Files only. */
  size?: number;
}

/**
 * Tracked-shipping metadata for a skill file. Populated only when the file
 * appears in `<skills_path>/.condash-skills.json`. Used by the renderer to
 * surface a "shipped" chip and a "diverged from shipped" banner when local
 * edits would be flagged on the next `condash skills install`.
 */
export interface SkillShippedInfo {
  /** SHA-256 from the manifest (the hash of the version condash shipped). */
  manifestSha: string;
  /** SHA-256 of the file currently on disk. */
  diskSha: string;
  /** True when the two hashes differ. */
  diverged: boolean;
  /** Condash version that shipped this file, when recorded in the manifest. */
  shippedVersion?: string;
}

/**
 * Tree node for the Skills pane. Same shape as `KnowledgeNode` plus the
 * optional `shipped` stamp on `SKILL.md` and shipped body files.
 */
export interface SkillNode {
  /** Path relative to <conception>/<skills_path>. Empty string for the root. */
  relPath: string;
  /** Absolute path on disk. */
  path: string;
  /** Last segment of relPath, or 'skills' for the root. */
  name: string;
  /** Title from the .md (first h1) when this is a file; the directory name otherwise. */
  title: string;
  /** Directory or file. Files end with .md; everything else is skipped. */
  kind: 'directory' | 'file';
  /** Children (only for directories). */
  children?: SkillNode[];
  /** First non-heading paragraph, trimmed to ~240 chars. Files only. */
  summary?: string;
  /** Shipped-file tracking, when the manifest covers this file. Files only. */
  shipped?: SkillShippedInfo;
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
  /** Both projects/ and condash.json (or legacy configuration.json) present. */
  looksInitialised: boolean;
}

/**
 * Result of a status transition (`setStatus` IPC, `condash projects status
 * set` / `close` / `reopen`). `timelineAppended` is non-null only on
 * done-edges (close or reopen) — that's the entire signal the renderer needs
 * to surface a "Closed." / "Reopened." toast and refresh the timeline pane.
 */
export interface TransitionResult {
  previousStatus: string | null;
  newStatus: string;
  timelineAppended: string | null;
  /** Set on close (done-edge) when the project's `**Branch**` has a stale
   * worktree on disk or a local branch left behind. The renderer surfaces
   * this as a toast so the user remembers to run `condash worktrees remove`
   * before forgetting. Undefined for non-close transitions and for closes
   * that didn't touch a branch. */
  branchWarning?: string;
}

/**
 * Input for the GUI's "+ New project" form, mirrored on the CLI as the
 * `condash projects create` flag set. Apps / Branch / Base intentionally
 * omitted from the form: minimal-info create only. The renderer normalises
 * the slug (via `slugify`) before dispatching; the main process re-validates
 * against `^[a-z0-9-]+$`.
 */
export interface ProjectCreateInput {
  title: string;
  slug: string;
  kind: 'project' | 'incident' | 'document';
  status: 'now' | 'review' | 'later' | 'backlog';
  /** Incident-only: PROD / STAGING / DEV. */
  environment?: 'PROD' | 'STAGING' | 'DEV';
  /** Incident-only: low / medium / high. */
  severity?: 'low' | 'medium' | 'high';
  /** Incident-only: free-text impact line. */
  severityImpact?: string;
}

export interface ProjectCreateResult {
  /** Folder name (e.g. `2026-05-02-foo`). */
  slug: string;
  /** Absolute path to the new project directory. */
  path: string;
  /** Path relative to the conception root. */
  relPath: string;
  /** Absolute path to the new README.md. */
  readme: string;
}
