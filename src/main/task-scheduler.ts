/**
 * Capability 1 — schedule any task, headless, without polluting the logs.
 *
 * A main-side recurring interval (the same pattern that drives the log
 * janitor, `index.ts`) ticks over the per-task `taskConfig` map in the
 * effective config. For each task carrying a `schedule` cadence it:
 *   - single-flights (skips while a prior run of the same task is in flight),
 *   - growth-gates (skips when no open tab produced new output since the last
 *     run — an idle workspace costs nothing),
 *   - and, when due, runs the bound task in a **background pty** with no tab,
 *     no `TermSession` broadcast, and output teed to
 *     `.condash/scheduled/<slug>/` (always — independent of the user's global
 *     logging toggle), keeping the last ~5 runs.
 *
 * condash never captures the run's *product*: the task writes
 * `.condash/term-titles.json` itself and the watcher applies it. There is no
 * capture-on-exit handshake here.
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
import { SessionLogger } from './terminal-logger';
import { tabsContext, totalBytesSeen } from './terminals';
import type { Agent, RunningTaskRun, TaskConfigEntry } from '../shared/types';

/** How often the scheduler wakes to check for due tasks. */
const TICK_MS = 20_000;

/** Default cap on a single headless run before it is killed — a runaway or
 *  hung agent must not accumulate background ptys. Overridable per task via
 *  `taskConfig[slug].timeout`. The cap doubles as the discard mechanism for
 *  agents that finish their work but never exit (e.g. `agedum … --prompt`):
 *  until that's fixed (`--run`), keep the timeout ≤ the schedule interval, or
 *  single-flight stretches the effective cadence out to the timeout. */
const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000;

/** Resolve a task's run timeout (ms): its `timeout` cadence override, else the
 *  default. Exported for unit testing. */
export function resolveRunTimeout(entry: TaskConfigEntry | undefined): number {
  return parseCadence(entry?.timeout) ?? DEFAULT_RUN_TIMEOUT_MS;
}

interface TaskState {
  /** Epoch ms of the last time we launched (or deliberately skipped) this task. */
  lastCheckedAt: number;
  /** True while a headless run of this task is still alive (single-flight). */
  inFlight: boolean;
  /** `totalBytesSeen()` captured at the last actual launch — the growth gate. */
  bytesAtLastRun: number;
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

/** POSIX single-quote so the substituted prompt survives `-c "<cmd>"`. */
function shellSingleQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function makeSid(): string {
  return `t-${randomBytes(4).toString('hex')}`;
}

function resolveShell(configured?: string): string {
  if (configured && configured.trim()) return configured;
  if (process.platform !== 'win32' && process.env.SHELL) return process.env.SHELL;
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe';
  return '/bin/bash';
}

function wrap(command: string): string[] {
  if (process.platform === 'win32') return ['/d', '/s', '/c', command];
  return ['-c', command];
}

/**
 * Run one task headlessly. Resolves the bound task + agent, substitutes the
 * prompt (including the `{TABS}` provided var), spawns a background pty seeded
 * with the agent's `--prompt`, and tees output to `.condash/scheduled/<slug>/`
 * via a forced-on `SessionLogger`. Registers the live run so the UI can peek at
 * or kill it, and de-registers it on settle. Resolves when the pty exits, is
 * killed via the UI, or hits `timeoutMs`. Throws on any setup error so the
 * caller can clear in-flight.
 */
async function runHeadless(conceptionPath: string, slug: string, timeoutMs: number): Promise<void> {
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
  const shell = resolveShell(config.terminal?.shell ?? settings.terminal?.shell);

  const prompt = substitute(task.prompt, { TABS: JSON.stringify(tabsContext()) });
  const command = `${agent.command} --prompt ${shellSingleQuote(prompt)}`;
  const argv = wrap(command);

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

  const child = pty.spawn(shell, argv, {
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
    const timer = setTimeout(() => {
      killProcess();
      finish();
    }, timeoutMs);
    // Register the live run so the Tasks pane can list it and kill it. The kill
    // mirrors the timeout path (SIGKILL then settle); node-pty's onExit still
    // fires afterwards but finish() is idempotent.
    running.set(sid, {
      slug,
      sid,
      startedAt: Date.now(),
      logPath,
      kill: () => {
        killProcess();
        finish();
      },
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
  const now = Date.now();
  for (const [slug, entry] of Object.entries(taskConfig)) {
    const cadence = parseCadence(entry?.schedule);
    if (cadence === null) continue;
    let state = states.get(slug);
    if (!state) {
      state = { lastCheckedAt: 0, inFlight: false, bytesAtLastRun: -1 };
      states.set(slug, state);
    }
    if (state.inFlight) continue;
    if (now - state.lastCheckedAt < cadence) continue;

    // Growth gate: after the first run, skip when no tab produced new output.
    const bytes = totalBytesSeen();
    if (state.bytesAtLastRun >= 0 && bytes === state.bytesAtLastRun) {
      state.lastCheckedAt = now;
      continue;
    }

    state.inFlight = true;
    state.lastCheckedAt = now;
    state.bytesAtLastRun = bytes;
    void runHeadless(conceptionPath, slug, resolveRunTimeout(entry))
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
