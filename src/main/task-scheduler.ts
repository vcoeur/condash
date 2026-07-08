/**
 * Capability 1 — schedule any task, headless, without polluting the logs.
 *
 * A main-side recurring interval (the same pattern that drives the log
 * janitor, `index.ts`) ticks over the per-task `taskConfig` map in the
 * effective config. For each task carrying a `schedule` cadence it:
 *   - single-flights (skips while a prior run of the same task is in flight),
 *   - per-tab growth-gates (skips when no open tab produced new output since the
 *     last run — an idle workspace costs nothing — and hands a task that does
 *     run just the changed tabs via the `{UPDATED_TABS}` provided var),
 *   - and, when due, runs the bound task in a **background pty** with no tab,
 *     no `TermSession` broadcast, and output teed to
 *     `.condash/scheduled/<slug>/` (always — independent of the user's global
 *     logging toggle), keeping the last ~5 runs.
 *
 * condash never captures the run's *product*: a task writes whatever output it
 * produces itself. There is no capture-on-exit handshake here.
 *
 * No default schedule and no default agent: a task runs only when its
 * `taskConfig` entry sets a cadence, and it carries its own agent.
 */
import { randomBytes } from 'node:crypto';
import * as pty from 'node-pty';
import { listAgents } from './agents';
import { getEffectiveConceptionConfig } from './effective-config';
import { readSettings } from './settings';
import { readTask } from './tasks';
import { spawnEnv } from './shell-env';
import { substitute } from '../shared/action-template';
import { parseCadence } from '../shared/cadence';
import { quoteForShell, shellCommandArgv, shellFamily } from '../shared/shell-quote';
import { SessionLogger } from './terminal-logger';
import { defaultShell, tabsContext, tabsBytes } from './terminals';
import { wrapWithMemoryScope } from './tab-scope';
import type { Agent, RunMode, RunningTaskRun, TabInfo, TaskConfigEntry } from '../shared/types';

/** How often the scheduler wakes to check for due tasks. */
const TICK_MS = 20_000;

/** Default cap on a single headless run before it is killed — a runaway or
 *  hung agent must not accumulate background ptys. Overridable per task via
 *  `taskConfig[slug].timeout`. With `runMode: 'oneshot'` (agedum `--run`) the
 *  agent exits on its own and this is a pure backstop; with the default
 *  `interactive` (`--prompt`) the agent finishes its work but never exits, so
 *  the cap doubles as the discard mechanism — keep it ≤ the schedule interval,
 *  or single-flight stretches the effective cadence out to the timeout. */
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000;

/** Resolve a task's run timeout (ms): its `timeout` cadence override, else the
 *  default. Exported for unit testing. */
export function resolveRunTimeout(entry: TaskConfigEntry | undefined): number {
  return parseCadence(entry?.timeout) ?? DEFAULT_RUN_TIMEOUT_MS;
}

/** Resolve a task's run mode: its `runMode` override, else `interactive`
 *  (back-compat). Exported for unit testing. */
export function resolveRunMode(entry: TaskConfigEntry | undefined): RunMode {
  return entry?.runMode === 'oneshot' ? 'oneshot' : 'interactive';
}

/** Whether a task opts in to the per-tab growth gate (skip a due tick when no
 *  open tab produced new output since its last run). Opt-in per task — absent =
 *  no gate, so the task runs on every interval. Exported for unit testing. */
export function resolveGate(entry: TaskConfigEntry | undefined): boolean {
  return entry?.gateOnUpdatedTabs === true;
}

/** Whether a task is due to run this tick: at least `cadence` ms have elapsed
 *  since it was last launched (or deliberately skipped). Pure, for unit testing
 *  without a real timer. Exported for unit testing.
 *
 *  @param now Current epoch-ms.
 *  @param lastCheckedAt Epoch-ms of the last launch/skip (0 before the first).
 *  @param cadence The task's schedule interval in ms.
 *  @returns True when the task should be considered this tick. */
export function isTaskDue(now: number, lastCheckedAt: number, cadence: number): boolean {
  return now - lastCheckedAt >= cadence;
}

/** The open tabs whose cumulative byte count moved since a task's last run —
 *  the `{UPDATED_TABS}` subset and the input to the per-tab growth gate. On the
 *  first run `previous` is empty, so every open tab reads as updated. Pure, for
 *  unit testing without live ptys. Exported for unit testing.
 *
 *  @param tabs The currently-open tabs (`tabsContext()` at tick time).
 *  @param current Per-sid live byte counts (`tabsBytes()` at tick time).
 *  @param previous Per-sid byte counts captured at the task's last launch.
 *  @returns The subset of `tabs` whose byte count differs from `previous`. */
export function selectUpdatedTabs(
  tabs: TabInfo[],
  current: Map<string, number>,
  previous: Map<string, number>,
): TabInfo[] {
  return tabs.filter((tab) => current.get(tab.sid) !== previous.get(tab.sid));
}

/** The agedum prompt-seeding flag for a run mode: `--run` runs the prompt once
 *  and exits; `--prompt` seeds it and stays interactive. */
function promptFlag(mode: RunMode): string {
  return mode === 'oneshot' ? '--run' : '--prompt';
}

interface TaskState {
  /** Epoch ms of the last time we launched (or deliberately skipped) this task. */
  lastCheckedAt: number;
  /** True while a headless run of this task is still alive (single-flight). */
  inFlight: boolean;
  /** Per-sid `bytesSeen` captured at the last actual launch — the per-tab
   *  growth gate. The next due tick diffs the live counts against this to find
   *  tabs with new output; an empty diff means nothing changed, so the run is
   *  skipped. Empty until the first launch, so the first due tick always runs
   *  (every open tab reads as new against an empty snapshot). */
  bytesPerSid: Map<string, number>;
}

/** A live headless run, with the handle the UI needs to discard it. */
interface RunHandle extends RunningTaskRun {
  /** SIGKILL the pty group and settle the run (idempotent). */
  kill: () => void;
}

let current: { path: string; interval: ReturnType<typeof setInterval> } | null = null;
const states = new Map<string, TaskState>();
/** In-flight headless runs keyed by sid — surfaced + killable from the UI. */
const running = new Map<string, RunHandle>();

/** Snapshot of the currently-running headless task runs (capability 1). */
export function listRunningTaskRuns(): RunningTaskRun[] {
  return [...running.values()].map(({ slug, sid, startedAt, logPath }) => ({
    slug,
    sid,
    startedAt,
    logPath,
  }));
}

/** Kill (and discard) the in-flight run with this sid. Returns false when no
 *  such run is live — e.g. it already exited between list and kill. */
export function killTaskRun(sid: string): boolean {
  const run = running.get(sid);
  if (!run) return false;
  run.kill();
  return true;
}

function makeSid(): string {
  return `t-${randomBytes(4).toString('hex')}`;
}

/** Footer exit code stamped when a run is killed (timeout or UI discard)
 *  rather than exiting on its own: 128 + SIGKILL, the conventional shell
 *  encoding. Without it the run's log carries no footer and looks "running"
 *  forever. */
const KILLED_EXIT_CODE = 137;

/**
 * Run one task headlessly. Resolves the bound task + agent, substitutes the
 * prompt (the `{TABS}` provided var carries every open tab; `{UPDATED_TABS}`
 * the changed subset the caller's growth gate found), spawns a background pty
 * seeded via the agent's prompt flag (`--run` for `oneshot`, else `--prompt`),
 * and tees output to `.condash/scheduled/<slug>/` via a forced-on
 * `SessionLogger`. Registers the live run so the UI can peek at or kill it, and
 * de-registers it on settle. Resolves when the pty exits, is killed via the UI,
 * or hits `timeoutMs`. Throws on any setup error so the caller can clear
 * in-flight.
 */
async function runHeadless(
  conceptionPath: string,
  slug: string,
  updatedTabs: TabInfo[],
  timeoutMs: number,
  mode: RunMode,
): Promise<void> {
  const task = await readTask(conceptionPath, slug);
  if (!task) throw new Error(`task ${slug} not found`);
  const agents = await listAgents(conceptionPath);
  const agent: Agent | undefined = agents.find((a) => a.id === task.agent);
  if (!agent || !agent.command.trim()) {
    throw new Error(`task ${slug}: agent '${task.agent}' is not defined`);
  }
  // Headless runs can only deliver the prompt via argv — there is no live TUI
  // to keystroke into. Require a prompt-seedable agent.
  if (!agent.promptFlags) {
    throw new Error(`task ${slug}: agent '${agent.id}' has no promptFlags (cannot run headless)`);
  }

  const settings = await readSettings();
  const config = await getEffectiveConceptionConfig(conceptionPath);
  const shell = defaultShell(config.terminal?.shell ?? settings.terminal?.shell);
  // Quote + wrap for the shell that will actually run the command — the same
  // family detection as interactive spawns (terminals.ts wrapForShell), so a
  // pwsh-configured `terminal.shell` gets PowerShell quoting, cmd.exe gets
  // cmd-safe quoting, and `&` / `|` / `%VAR%` in a prompt never execute.
  const family = shellFamily(shell, process.platform === 'win32');

  const prompt = substitute(task.prompt, {
    TABS: JSON.stringify(tabsContext()),
    UPDATED_TABS: JSON.stringify(updatedTabs),
  });
  const command = `${agent.command} ${promptFlag(mode)} ${quoteForShell(prompt, family)}`;
  const argv = shellCommandArgv(family, command);

  const childEnv: NodeJS.ProcessEnv = { ...(await spawnEnv()), TERM: 'xterm-256color' };
  delete childEnv.npm_config_prefix;
  delete childEnv.npm_config_globalconfig;
  delete childEnv.npm_config_userconfig;

  const sid = makeSid();
  // Force-enable the logger: a scheduled run is always recorded to its
  // segregated dir regardless of the user's global terminal-logging toggle.
  const logger = new SessionLogger(
    conceptionPath,
    {
      sid,
      side: 'my',
      cwd: conceptionPath,
      spawn: { cmd: shell, argv },
      taskContext: { taskSlug: slug, trigger: 'scheduled' },
    },
    { ...(config.terminal?.logging ?? {}), enabled: true },
  );
  logger.spawn();
  const logPath = logger.filePath() ?? '';

  // Contain a headless scheduled run in its own memory-limited scope too — a
  // background agent can balloon just like an interactive tab. No-op on hosts
  // without systemd cgroup support. The negative-pid SIGKILL below still reaches
  // the scoped tree via the process group.
  const scoped = wrapWithMemoryScope(shell, argv, config.terminal?.memory);
  const child = pty.spawn(scoped.program, scoped.argv, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: conceptionPath,
    env: childEnv,
  });

  await new Promise<void>((resolve) => {
    let settled = false;
    const killProcess = (): void => {
      try {
        if (process.platform === 'win32') child.kill();
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    // Settle exactly once, then drop every handle to the run so a finished
    // agent is not retained in memory: clear the timer, de-register from the
    // running map, and close the logger. The pty itself is unreferenced once
    // this closure and the map entry are gone.
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(sid);
      void logger.close().finally(resolve);
    };
    // Kill path (timeout or UI discard): stamp a sealed footer before the
    // close — a killed run never reaches onExit's logger.exit(), and without
    // a footer the log looks "running" forever in the Logs / Task-runs views.
    const killAndSettle = (): void => {
      if (settled) return;
      logger.exit(KILLED_EXIT_CODE);
      killProcess();
      finish();
    };
    const timer = setTimeout(killAndSettle, timeoutMs);
    // Register the live run so the Tasks pane can list it and kill it. The kill
    // mirrors the timeout path (footer, SIGKILL, settle); node-pty's onExit
    // still fires afterwards but finish() is idempotent.
    running.set(sid, {
      slug,
      sid,
      startedAt: Date.now(),
      logPath,
      kill: killAndSettle,
    });
    child.onData((data) => logger.output(data));
    child.onExit(({ exitCode }) => {
      logger.exit(exitCode);
      finish();
    });
  });
}

/** One scheduler tick: launch every due, non-in-flight, grown task. */
async function tick(conceptionPath: string): Promise<void> {
  let config;
  try {
    config = await getEffectiveConceptionConfig(conceptionPath);
  } catch {
    return;
  }
  const taskConfig = (config.taskConfig ?? {}) as Record<string, TaskConfigEntry>;
  // Early-out before any per-task bookkeeping when nothing is scheduled — the
  // common case (no task carries a `schedule`), so an idle scheduler tick costs
  // just the memoized config read (2 stats) plus this scan (review finding
  // B4/T7-main). Cadence is parsed once here and reused below.
  const scheduled: Array<[string, TaskConfigEntry, number]> = [];
  for (const [slug, entry] of Object.entries(taskConfig)) {
    const cadence = parseCadence(entry?.schedule);
    if (cadence !== null) scheduled.push([slug, entry, cadence]);
  }
  if (scheduled.length === 0) return;

  const now = Date.now();
  for (const [slug, entry, cadence] of scheduled) {
    let state = states.get(slug);
    if (!state) {
      state = { lastCheckedAt: 0, inFlight: false, bytesPerSid: new Map() };
      states.set(slug, state);
    }
    if (state.inFlight) continue;
    if (!isTaskDue(now, state.lastCheckedAt, cadence)) continue;

    // Per-tab growth: the open tabs whose byte count moved since the last run.
    // On the first run every tab reads as updated (no prior snapshot). The run
    // is always handed exactly this subset via `{UPDATED_TABS}`.
    const bytes = tabsBytes();
    const updated = selectUpdatedTabs(tabsContext(), bytes, state.bytesPerSid);
    // Growth gate, opt-in per task: a gated task skips a tick when nothing
    // changed (or nothing is open) rather than spend the agent. An ungated task
    // runs on every interval regardless — it may not act on `{UPDATED_TABS}`.
    if (resolveGate(entry) && updated.length === 0) {
      state.lastCheckedAt = now;
      continue;
    }

    state.inFlight = true;
    state.lastCheckedAt = now;
    state.bytesPerSid = bytes;
    void runHeadless(conceptionPath, slug, updated, resolveRunTimeout(entry), resolveRunMode(entry))
      .catch((err) => {
        process.stderr.write(`condash task-scheduler: ${slug}: ${(err as Error).message}\n`);
      })
      .finally(() => {
        const s = states.get(slug);
        if (s) s.inFlight = false;
      });
  }
}

/**
 * Arm (or re-point) the per-task scheduler for `conceptionPath`, or tear it
 * down with `null`. Clears prior per-task state on a conception switch so a
 * stale cadence from the old tree doesn't carry over.
 */
export async function setScheduledConception(conceptionPath: string | null): Promise<void> {
  if (current?.path === conceptionPath) return;
  if (current) {
    clearInterval(current.interval);
    current = null;
  }
  // Discard any run still in flight from the previous tree — a conception
  // switch or teardown must not leave orphaned background ptys alive.
  for (const run of [...running.values()]) run.kill();
  running.clear();
  states.clear();
  if (!conceptionPath) return;
  const interval = setInterval(() => void tick(conceptionPath), TICK_MS);
  current = { path: conceptionPath, interval };
}
