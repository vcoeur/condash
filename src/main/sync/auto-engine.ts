/**
 * The auto-sync engine — a GUI-driven clock that runs `syncRun` on a timer
 * while a conception is open. Every hard part (lock, quiet period, per-group
 * commits, push-retry, mid-op refusal) already lives in {@link syncRun}; this
 * file is only scheduling + status, and mirrors the dashboard engine's
 * arm/re-point/teardown + generation-guard idioms.
 */
import { BrowserWindow } from 'electron';
import { EVENT_CHANNELS } from '../../shared/ipc-channels';
import { safeSend } from '../safe-send';
import type { AutoSyncConfig, AutoSyncLastResult, AutoSyncStatus } from '../../shared/types';
import { AUTO_SYNC_DEFAULTS, readAutoSyncConfig } from './auto-config';
import { syncRun } from './run';

/** Base poll interval. Each tick re-reads config (cheap) and checks whether the
 *  cadence has elapsed, so an enable/interval change in Settings takes effect
 *  within one tick without a restart. Commit cadence is minutes, so 30 s is ample. */
const TICK_MS = 30_000;

interface Armed {
  path: string;
  interval: ReturnType<typeof setInterval>;
}

let current: Armed | null = null;
/** Epoch ms the next sweep is due. 0 = disabled, or armed/re-enabled and
 *  awaiting a baseline: the next enabled tick sets it to `now + interval`
 *  without committing, so the first sweep lands one full interval after the
 *  feature is enabled rather than the instant the app opens. */
let nextDueAt = 0;
/** Epoch ms of the last *completed* sweep (for display), or 0 if none yet. */
let lastSweepAt = 0;
let inFlight = false;
let status: AutoSyncStatus = disabledStatus();
/** Bumped on every re-point / teardown; a cycle captures it at entry and
 *  re-checks after each await, so a sweep straddling a conception switch cannot
 *  publish or mutate state for the wrong tree, nor unlatch a new cycle's
 *  `inFlight`. Same idiom as the dashboard engine + task scheduler. */
let generation = 0;

function disabledStatus(): AutoSyncStatus {
  return {
    phase: 'disabled',
    enabled: false,
    intervalMinutes: AUTO_SYNC_DEFAULTS.intervalMinutes,
    lastRunAt: null,
    nextRunAt: null,
    lastResult: null,
    lastError: null,
  };
}

function sameResult(a: AutoSyncLastResult | null, b: AutoSyncLastResult | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.committed === b.committed && a.pushed === b.pushed && a.pushError === b.pushError;
}

function broadcast(next: AutoSyncStatus): void {
  status = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    safeSend(win.webContents, EVENT_CHANNELS.autoSyncStatus, next);
  }
}

/** Publish, but only when a field the Settings UI shows actually changed. */
function publish(next: AutoSyncStatus): void {
  if (
    status.phase === next.phase &&
    status.enabled === next.enabled &&
    status.intervalMinutes === next.intervalMinutes &&
    status.lastRunAt === next.lastRunAt &&
    status.nextRunAt === next.nextRunAt &&
    status.lastError === next.lastError &&
    sameResult(status.lastResult, next.lastResult)
  ) {
    return;
  }
  broadcast(next);
}

/** Latest engine status; the disabled default when unarmed. */
export function getAutoSyncStatus(): AutoSyncStatus {
  return status;
}

/**
 * Arm (or re-point) the engine for `conceptionPath`, or tear it down with
 * `null`. Clears the prior interval and resets the cadence so a stale clock
 * from the old tree can't carry over. Mirrors the dashboard-engine lifecycle.
 */
export async function setSyncConception(conceptionPath: string | null): Promise<void> {
  if (current?.path === conceptionPath) return;
  generation += 1;
  if (current) {
    clearInterval(current.interval);
    current = null;
  }
  nextDueAt = 0;
  lastSweepAt = 0;
  inFlight = false;
  status = disabledStatus();
  if (!conceptionPath) return;
  const interval = setInterval(() => void tick(conceptionPath), TICK_MS);
  current = { path: conceptionPath, interval };
  // One immediate tick so the Settings status line reflects reality at once. It
  // never commits — an enabled first tick only establishes the baseline.
  void tick(conceptionPath);
}

function idleStatus(config: AutoSyncConfig, dueAt: number): AutoSyncStatus {
  return {
    phase: 'idle',
    enabled: true,
    intervalMinutes: config.intervalMinutes,
    lastRunAt: lastSweepAt || null,
    nextRunAt: dueAt,
    lastResult: status.lastResult,
    lastError: status.lastError,
  };
}

/**
 * One tick: re-read config, then establish a baseline, wait, or sweep. A no-op
 * when not armed for `conceptionPath`, already in flight, or the config read
 * throws (a malformed settings file must not crash the bare interval). Exported
 * for unit testing.
 */
export async function tick(conceptionPath: string): Promise<void> {
  if (current?.path !== conceptionPath || inFlight) return;
  const myGeneration = generation;
  let config: AutoSyncConfig;
  try {
    config = await readAutoSyncConfig(conceptionPath);
  } catch {
    return;
  }
  if (generation !== myGeneration) return;

  if (!config.enabled) {
    nextDueAt = 0;
    publish(disabledStatus());
    return;
  }

  const intervalMs = config.intervalMinutes * 60_000;
  const now = Date.now();

  // Establish the baseline on the first enabled tick — no commit — so the first
  // sweep lands one interval after enabling, not the instant the app opens.
  if (nextDueAt === 0) {
    nextDueAt = now + intervalMs;
    publish(idleStatus(config, nextDueAt));
    return;
  }
  if (now < nextDueAt) {
    publish(idleStatus(config, nextDueAt));
    return;
  }
  await sweep(conceptionPath, config, myGeneration);
}

/**
 * Run one sweep now, regardless of the cadence, and return the resulting
 * status — backs the Settings "Commit & push now" button. A no-op returning the
 * current status when unarmed or a tick is already in flight.
 */
export async function syncNow(): Promise<AutoSyncStatus> {
  const path = current?.path;
  if (!path || inFlight) return status;
  const myGeneration = generation;
  let config: AutoSyncConfig;
  try {
    config = await readAutoSyncConfig(path);
  } catch {
    return status;
  }
  if (generation !== myGeneration) return status;
  await sweep(path, config, myGeneration);
  return status;
}

/** Run `syncRun` under the inFlight guard and publish the outcome. Sets both the
 *  display timestamp and the next-due clock, so a manual sweep also defers the
 *  next automatic one by a full interval. */
async function sweep(path: string, config: AutoSyncConfig, myGeneration: number): Promise<void> {
  const intervalMs = config.intervalMinutes * 60_000;
  inFlight = true;
  publish({
    ...status,
    phase: 'syncing',
    enabled: config.enabled,
    intervalMinutes: config.intervalMinutes,
  });
  try {
    const report = await syncRun(path, {
      dryRun: false,
      push: config.push,
      quietPeriodSeconds: config.quietPeriodSeconds,
    });
    if (generation !== myGeneration) return;
    lastSweepAt = Date.now();
    nextDueAt = config.enabled ? lastSweepAt + intervalMs : 0;
    publish({
      phase: config.enabled ? 'idle' : 'disabled',
      enabled: config.enabled,
      intervalMinutes: config.intervalMinutes,
      lastRunAt: lastSweepAt,
      nextRunAt: config.enabled ? nextDueAt : null,
      lastResult: {
        committed: report.commits.length,
        pushed: report.pushed,
        pushError: report.pushError,
      },
      lastError: null,
    });
  } catch (err) {
    if (generation !== myGeneration) return;
    // A refusal (mid-merge, conflict) or unexpected error: record it and retry
    // next interval — treat it like a completed attempt so it doesn't hot-loop.
    lastSweepAt = Date.now();
    nextDueAt = config.enabled ? lastSweepAt + intervalMs : 0;
    publish({
      phase: 'error',
      enabled: config.enabled,
      intervalMinutes: config.intervalMinutes,
      lastRunAt: lastSweepAt,
      nextRunAt: config.enabled ? nextDueAt : null,
      lastResult: status.lastResult,
      lastError: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (generation === myGeneration) inFlight = false;
  }
}
