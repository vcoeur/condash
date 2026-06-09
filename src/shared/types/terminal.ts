// Terminal subsystem: xterm appearance, launcher agents + action templates,
// per-machine terminal prefs, live-session snapshots, and the spawn / data /
// exit messages exchanged over IPC.

import type { TaskRunContext } from './task-runs';

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

/** One user-configurable action template. Substituted at click time and
 *  typed into the focused terminal. */
export interface ActionTemplate {
  /** User-facing label in the dropdown menu. */
  label: string;
  /** Template string with `{placeholder}` tokens. */
  template: string;
  /** When true, press Enter after typing. Default false. */
  submit?: boolean;
  /** When set, the `id` of an agent in the `agents` settings list. The action
   *  then spawns a fresh tab running that agent's command before typing the
   *  template (e.g. bind "Start new project" to a specific agent). Empty /
   *  missing → type into the focused tab, spawning a plain shell only if no tab
   *  exists. */
  agent?: string;
}

/** A terminal-launcher agent: a named shell command surfaced in the tab-strip
 *  spawn dropdown and bindable from Tasks / action templates. Configured under
 *  `agents` in `condash.json` / `settings.json`; picking one opens a new
 *  terminal tab running `command`. */
export interface Agent {
  /** Stable identity referenced by tasks and action templates. */
  id: string;
  /** Display label shown in the spawn dropdown and on the tab. */
  label: string;
  /** Shell command run when the agent is launched. */
  command: string;
  /** When true, `command` understands agedum's `--prompt` flag, so a task or
   *  agent-bound action passes the prompt in argv — `<command> --prompt "<text>"`
   *  (interactive: the prompt runs and the session stays open) — instead of
   *  spawning the bare command and keystroke-injecting the prompt into the live
   *  TUI. Omit for an opaque agent: the default keystroke path works for any
   *  harness but races the TUI's boot. */
  promptFlags?: boolean;
  /** When true, the agent is surfaced directly in the tab-strip spawn dropdown;
   *  non-favourite agents are tucked behind a `More ▸` fly-out. When NO agent is
   *  marked favourite, the dropdown lists every agent inline (the pre-favourites
   *  behaviour) — so this only takes effect once at least one agent opts in. */
  favorite?: boolean;
}

export interface TerminalPrefs {
  shell?: string;
  shortcut?: string;
  screenshot_dir?: string;
  screenshot_paste_shortcut?: string;
  move_tab_left_shortcut?: string;
  move_tab_right_shortcut?: string;
  xterm?: TerminalXtermPrefs;
  /** Per-session capture of rendered pty output to a plain-text
   * `<conception>/.condash/logs/YYYY/MM/DD/HHMMSS-<sid>.txt` (since
   * v2.27.0; stdin is deliberately not captured — the pty echoes it back
   * through stdout). The folder is fully gitignored by default. */
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
 * `scrollback: 5000`, `retentionDays: 14`, `maxDirMb: 500`) — the
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
   * file. Default: 5000. */
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
  /** Free-form command to run via `bash -lc`. Mutually exclusive with `repo`.
   *  An agent launch is just this with the agent's `command`. */
  command?: string;
  /** Override the cwd; defaults to $HOME (or the resolved repo cwd). */
  cwd?: string;
  cols?: number;
  rows?: number;
  /** When set, the session is a task run whose console output is routed to
   *  `.condash/<trigger>/<taskSlug>/` instead of `.condash/logs/`. */
  taskContext?: TaskRunContext;
}

/** One open terminal tab, as injected into a task's `{TABS}` / `{UPDATED_TABS}`
 *  provided vars (capability 2). Built from the main session map — a task acts
 *  on the tabs that currently exist; condash keeps no per-tab state for it. */
export interface TabInfo {
  sid: string;
  cwd: string;
  repo?: string;
  cmd?: string;
}

export interface TermDataMessage {
  id: string;
  data: string;
}

export interface TermExitMessage {
  id: string;
  code: number;
}
