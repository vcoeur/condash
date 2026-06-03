// Task scheduling + run tracking: the trigger / run-mode enums, the per-task
// persisted config, the spawn-time run context, and the in-flight / on-disk
// run records the Tasks and Logs panes surface. (The task *definitions*
// parsed from the tree live in `shared/tasks.ts`; this module is the runtime
// side — schedules, contexts, and run artefacts.)

/** Which trigger produced a task run. Routes its console log out of the
 *  normal `.condash/logs/` tree and into `.condash/<trigger>/<task-slug>/`. */
export type TaskTrigger = 'scheduled' | 'manual';

/** Task-run context carried on a spawn so the SessionLogger can route the
 *  run's console output to the segregated `.condash/<trigger>/<slug>/` store
 *  instead of `.condash/logs/`. Present only for task runs that opt out of the
 *  normal logs (a `manual` run of an `excludeFromLogs` task, or any
 *  `scheduled` run — those are always segregated). Absent → normal logging. */
export interface TaskRunContext {
  taskSlug: string;
  trigger: TaskTrigger;
}

/** Per-task config persisted under `taskConfig` in `.condash/settings.json`
 *  (capability 1). Absent entry → not scheduled, normal logging. */
export interface TaskConfigEntry {
  /** Cadence string (e.g. `2m`, `30s`, `1h`). Absent = not scheduled. */
  schedule?: string;
  /** Hard cap on a scheduled headless run (cadence string, e.g. `5m`); the run
   *  is killed and discarded once it elapses. Absent = the scheduler default
   *  (10m). The cap is the discard mechanism for agents that finish their work
   *  but don't exit (e.g. `--prompt`), so keep it ≤ the schedule interval or
   *  single-flight will stretch the effective cadence to the timeout. */
  timeout?: string;
  /** Per-task default for routing manual runs out of `.condash/logs/`;
   *  overridable per run in the run popup. */
  excludeFromLogs?: boolean;
  /** Per-task default for how the agent is driven (a `promptFlags` agent only):
   *  `interactive` seeds the prompt with agedum's `--prompt` and keeps the
   *  session open; `oneshot` uses `--run`, which runs the prompt and exits.
   *  Absent = `interactive` (back-compat). Overridable per run in the run popup.
   *  A scheduled task should prefer `oneshot` so the headless run exits cleanly
   *  instead of being killed at its `timeout`. */
  runMode?: RunMode;
  /** Per-task opt-in for the scheduler's per-tab growth gate. When `true`, a
   *  due tick is **skipped** unless some open tab produced new output since the
   *  task's last run — the changed subset is then handed to the run as
   *  `{UPDATED_TABS}`. Absent/`false` = no gate: the task runs on every interval
   *  regardless of tab activity. Only meaningful for a task that acts on
   *  `{UPDATED_TABS}`. */
  gateOnUpdatedTabs?: boolean;
}

/** How a task drives its agent: `interactive` → agedum `--prompt` (session stays
 *  open); `oneshot` → agedum `--run` (runs the prompt once, then exits). Only
 *  meaningful for a `promptFlags` agent — an opaque agent always uses the
 *  interactive keystroke path. */
export type RunMode = 'interactive' | 'oneshot';

/** A headless scheduled run that is currently in flight (capability 1).
 *  Surfaced in the Tasks pane's "Running" section so the user can peek at its
 *  output or kill it. */
export interface RunningTaskRun {
  /** Task slug whose schedule launched this run. */
  slug: string;
  /** Session id of the background pty (the run-file's `<sid>` suffix). */
  sid: string;
  /** Epoch ms the run was launched — the renderer renders elapsed time. */
  startedAt: number;
  /** Absolute path to the segregated run log being written live, readable via
   *  `logsReadSession`. */
  logPath: string;
}

/** One segregated task-run file under `.condash/<trigger>/<slug>/`,
 *  surfaced by the Logs pane's "Task runs" view. */
export interface TaskRunEntry {
  /** Absolute path to the `.txt`. */
  path: string;
  /** Spawn-time `HH:MM:SS` parsed from the filename prefix. */
  time: string;
  /** `YYYY-MM-DD` parsed from the filename prefix. */
  day: string;
  /** Session id (the `<sid>` suffix). */
  sid: string;
  /** File size in bytes. */
  bytes: number;
}

/** All runs of one task under one trigger, newest-first. */
export interface TaskRunGroup {
  taskSlug: string;
  trigger: TaskTrigger;
  runs: TaskRunEntry[];
}
