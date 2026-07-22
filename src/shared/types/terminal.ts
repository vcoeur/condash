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
  /** Per-tab memory containment via a transient systemd user scope. See
   *  TerminalMemoryPrefs. No-op on unsupported platforms. */
  memory?: TerminalMemoryPrefs;
  /** Main-process performance recording. See TerminalPerfPrefs. Off by default. */
  perf?: TerminalPerfPrefs;
  /** When true (the default), switching to a terminal tab automatically runs
   *  the Refresh action on the newly-active tab — repainting it after the
   *  hidden-tab serialize/hydrate round-trip so a live full-screen TUI (Claude
   *  Code, Ink, ncurses) never shows a stale snapshot. Set explicitly to false
   *  to restrict auto-refresh to alternate-buffer tabs only. */
  autoRefreshOnTabSwitch?: boolean;
}

/** Per-tab memory containment. When enabled — and the host supports it (Linux
 * with a reachable systemd **user** manager and cgroup v2) — each terminal tab's
 * pty is spawned inside its own transient `systemd-run --user --scope` carrying
 * these limits. A runaway tab then trips its **own** cgroup's OOM killer and
 * dies alone, instead of the leak pressuring the whole system into a global OOM
 * that can take the entire dashboard (and every other tab) down with it. On an
 * unsupported host the spawn is unchanged. Sizes are systemd size strings
 * ("6G", "512M", "infinity"). */
export interface TerminalMemoryPrefs {
  /** Toggle containment. Default: enabled on supported hosts. Set `false` to
   * force plain spawns everywhere. */
  enabled?: boolean;
  /** Soft limit (systemd `MemoryHigh`): past this the kernel throttles and
   * reclaims the tab's cgroup, buying time before the hard wall. Default "6G". */
  high?: string;
  /** Hard limit (systemd `MemoryMax`): the tab's cgroup is OOM-killed at this
   * ceiling. This is the guarantee that a leak kills only the one tab. Default
   * "8G". */
  max?: string;
  /** Swap ceiling (systemd `MemorySwapMax`) so a capped tab can't instead
   * exhaust system swap (what turned this crash into a global OOM). Default
   * "2G". */
  swapMax?: string;
  /** Backstop cap on condash's **own** app scope. The per-tab caps above only
   * bind processes spawned through the tab path; a child that skips it (a tab
   * left uncapped by a probe edge case, a stale pre-cap condash instance, or a
   * non-tab helper) stays in condash's uncapped `app-gnome-condash-*.scope` and
   * a runaway there escalates to a global OOM that kills the whole session
   * (incident 2026-07-05). Capping that scope at startup makes a global OOM
   * impossible: an uncapped child trips condash's own cgroup OOM instead. */
  appScope?: AppScopeMemoryPrefs;
}

/** Backstop memory limits applied to condash's own app scope at startup, via
 * `systemctl --user set-property`. Linux + systemd + cgroup v2 only; a clean
 * no-op elsewhere, exactly like the per-tab cap. Sizes are systemd size strings
 * ("12G", "2G", "infinity"); when unset, `max` defaults to physical RAM minus a
 * reserve (so condash's cgroup trips before the system's global OOM) and
 * `swapMax` defaults to "2G". */
export interface AppScopeMemoryPrefs {
  /** Toggle the backstop. Default: enabled on supported hosts. Set `false` to
   * leave condash's app scope uncapped (per-tab caps still apply). */
  enabled?: boolean;
  /** Hard limit (systemd `MemoryMax`) on condash + every child that isn't in
   * its own tab scope. Default: physical RAM minus a reserve, floored at half
   * RAM. */
  max?: string;
  /** Swap ceiling (systemd `MemorySwapMax`) on the app scope — the lever that
   * stops a runaway from thrashing all of system swap into a global OOM.
   * Default "2G". */
  swapMax?: string;
}

/** Configuration for the per-session terminal log writer. Defaults are
 * applied by the writer when fields are absent (`enabled: false`,
 * `scrollback: 5000`, `retentionDays: 14`, `maxDirMb: 500`,
 * `markerIntervalSec: 60`) — the schema's defaults track the same values. */
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
  /** Wall-clock seconds between in-body `<!-- YYYY-MM-DD:HH:MM -->` timestamp
   * markers. A marker is emitted only when new output has arrived since the
   * previous one, so an idle session is never stamped. Applies to both
   * transcript and grid logs. Default: 60. `0` disables periodic markers. */
  markerIntervalSec?: number;
}

/** Process-level performance vitals for the perf pane. A read-only peek for
 * display that never resets the recorder's accumulators — polling the pane must
 * not steal data from the recorded windows. */
export interface PerfVitals {
  /** Whether recording is on. The pane stays useful when off: per-tab memory,
   * growth rate, and throttle state come from the always-on sampler. The
   * event-loop figures do not. */
  recording: boolean;
  /** True when a record write has failed since recording was enabled — the disk
   * filled, the tree went read-only. Recording is then on in name only and
   * nothing further reaches disk, so a display must say so instead of
   * continuing to claim it is recording. */
  writeFailed: boolean;
  /** Event-loop delay in ms over the current window, measured **in excess of the
   * sampler's own 10 ms interval**; present only while recording. The most
   * direct measure of UI lag on the shared main thread. A raw
   * `monitorEventLoopDelay` reading has a floor equal to its resolution, so an
   * idle app would otherwise report ~10 ms of lag that does not exist. Delays
   * genuinely below the interval are not resolvable and read as 0. */
  loop?: { p50: number; p99: number; max: number };
  /** Main-process heap use in bytes. */
  heapUsed: number;
}

/** Main-process performance recording. Off by default, like disk logging: while
 * disabled every instrumentation entry point is an immediate return, so an
 * ordinary user pays nothing. Records land in `<conception>/.condash/perf/` as
 * one JSONL file per day. */
export interface TerminalPerfPrefs {
  /** Toggle recording. Default: false. */
  enabled?: boolean;
}

/** Coarse classification of how a terminal session ended, in decreasing
 * severity. Derived in `src/main/term-death.ts`; carried here because the
 * renderer renders it. */
export type TermDeathKind =
  /** The tab's own cgroup OOM killer fired — it hit its `MemoryMax` cap. */
  | 'oom-cap'
  /** Killed from outside under memory pressure (systemd-oomd reacting to PSI)
   *  while the cgroup was throttling at `MemoryHigh`. The cgroup's own
   *  `oom_kill` does NOT fire in this case, so it needs its own verdict. */
  | 'oom-pressure'
  /** SIGKILL with no memory evidence — killed externally, cause unknown. */
  | 'killed'
  /** Terminated by some other signal (SIGTERM, SIGHUP, …). */
  | 'signal'
  /** Ran to completion with a non-zero status. */
  | 'failed'
  /** condash terminated it — a Stop, a tab close, or app quit. Its own kill
   *  pipeline ends in SIGKILL, so without this verdict a deliberate shutdown of
   *  a tab resting near `MemoryHigh` records as an OOM kill and corrupts the
   *  longitudinal evidence the verdicts exist to provide. */
  | 'stopped'
  /** Ran to completion with status 0. */
  | 'clean';

/** Why a terminal session ended: the classification plus the raw evidence, so a
 * tab row can show a short label and a log footer can carry the full picture. */
export interface TermDeath {
  kind: TermDeathKind;
  /** Process exit status, when the process exited rather than being signalled. */
  exitCode?: number;
  /** Signal number that terminated the process, when it was signalled. */
  signal?: number;
  /** Increase in the cgroup's own OOM-kill count across the death. */
  oomKillDelta?: number;
  /** Increase in the `MemoryHigh` throttle count across the death — the marker
   * of sustained reclaim, which is what generates the pressure an external OOM
   * killer reacts to. */
  highDelta?: number;
  /** Short human label for the tab row. */
  label: string;
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
  /** Why the session ended, derived at exit from the exit code, the terminating
   * signal, and the movement in the tab cgroup's `memory.events`. Undefined
   * while live. An OOM kill and a clean `exit 0` are indistinguishable by
   * `exited` alone — this is the field that tells them apart. */
  death?: TermDeath;
  /** Live memory usage (bytes) of the tab's own cgroup scope, when the tab was
   * spawned in a memory scope (Linux + systemd). Undefined for unscoped tabs and
   * before the first sample. Drives the per-tab memory meter. */
  memBytes?: number;
  /** The tab scope's hard memory cap (bytes), when scoped with a numeric
   * `MemoryMax`. The renderer warns as `memBytes` approaches it. */
  memMaxBytes?: number;
  /** Bytes/second the tab's cgroup grew over the last sampling interval.
   * `memBytes` alone is a level, so a tab climbing 2G→8G inside one sampling
   * window gave no warning before it died; the rate warns on trajectory. */
  memGrowthBytesPerSec?: number;
  /** True while the kernel is reclaiming against this tab (its cgroup
   * `MemoryHigh` throttle counter moved on the last sample). Previously
   * invisible — the user saw an unexplained slowdown with nothing to attribute
   * it to — and it is the state tabs are actually dying in. */
  memThrottled?: boolean;
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
  /** Flow-control epoch of the session at send time. The preload ack echoes it
   *  back so an ack that raced a flow reset (renderer re-attach) is ignored
   *  instead of debiting the fresh epoch's backlog. */
  epoch: number;
}

export interface TermExitMessage {
  id: string;
  code: number;
  /** Why the session ended. Undefined only for a session that exited before the
   * verdict machinery could run (defensive — main always populates it). */
  death?: TermDeath;
  /** Convenience mirror of `death.kind !== 'clean'`. The renderer keeps the tab
   * row on screen when this is true instead of auto-closing, so the user can
   * read the verdict and restart. */
  abnormal?: boolean;
}
