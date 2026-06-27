import { BrowserWindow } from 'electron';
import { EVENT_CHANNELS } from '../../shared/ipc-channels';
import type {
  DashboardConfig,
  DashboardConfigView,
  DashboardEnginePhase,
  DashboardEngineStatus,
  DashboardState,
  TabInfo,
  TabSummary,
} from '../../shared/types';
import { tabRecentText, tabsBytes, tabsContext } from '../terminals';
import { DASHBOARD_DEFAULTS, readDashboardConfig, toDashboardConfigView } from './config';
import {
  emptyDashboardState,
  loadDashboardState,
  pruneDashboardState,
  saveDashboardState,
} from './state';
import {
  clearSummarizerError,
  getSummarizerError,
  makeEvent,
  summarizeTab,
  synthesizeOverview,
} from './summarizer';

/** Base poll interval. Each tick re-reads config (cheap, like the task
 *  scheduler) and runs only when the resolved `intervalSec` has elapsed AND a
 *  tab changed — so settings edits (enable, key, cadence) take effect within
 *  one tick without a restart. */
const TICK_MS = 15_000;

interface Armed {
  path: string;
  interval: ReturnType<typeof setInterval>;
}

let current: Armed | null = null;
let state: DashboardState = emptyDashboardState(0);
/** Per-sid `bytesSeen` captured at the last actual run — the growth gate. */
let prevBytes = new Map<string, number>();
let lastRunAt = 0;
let inFlight = false;

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send(channel, payload);
  }
}

function pushState(): void {
  broadcast(EVENT_CHANNELS.dashboardState, state);
  broadcast(EVENT_CHANNELS.dashboardTabSummaries, { summaries: state.tabs });
}

/** Publish the live loop status (phase + next-run ETA), pushing only when it
 *  changed. Cheap (no LLM) — called at each tick's decision points so the pane
 *  shows the engine is alive even before any tab has a summary. */
function publishEngine(next: DashboardEngineStatus): void {
  const cur = state.engine;
  if (
    cur &&
    cur.phase === next.phase &&
    cur.nextRunAt === next.nextRunAt &&
    cur.lastRunAt === next.lastRunAt
  ) {
    return;
  }
  state = { ...state, engine: next };
  pushState();
}

/**
 * Arm (or re-point) the dashboard engine for `conceptionPath`, or tear it down
 * with `null`. Mirrors the task-scheduler / log-janitor lifecycle: clears the
 * prior interval and per-run state on a conception switch so a stale cadence or
 * summary from the old tree doesn't carry over. Loads any persisted state for
 * the new tree so the Dashboard pane shows the last snapshot immediately.
 */
export async function setDashboardConception(conceptionPath: string | null): Promise<void> {
  if (current?.path === conceptionPath) return;
  if (current) {
    clearInterval(current.interval);
    current = null;
  }
  prevBytes = new Map();
  lastRunAt = 0;
  inFlight = false;
  state = emptyDashboardState(0);
  if (!conceptionPath) return;
  const persisted = await loadDashboardState(conceptionPath);
  if (persisted) state = persisted;
  const interval = setInterval(() => void tick(conceptionPath), TICK_MS);
  current = { path: conceptionPath, interval };
  pushState();
  // Run one tick immediately so the roster and live engine status appear at once
  // instead of after a full TICK_MS of a blank-looking pane. inFlight guards any
  // overlap with the scheduled interval.
  void tick(conceptionPath);
}

/** Latest dashboard snapshot, or null when the engine is not armed. */
export function getDashboardState(): DashboardState | null {
  return current ? state : null;
}

/** Resolved, secret-free config view for the active conception. Returns a
 *  disabled default when no conception is active. */
export async function getDashboardConfigView(): Promise<DashboardConfigView> {
  if (!current) {
    return {
      enabled: false,
      provider: DASHBOARD_DEFAULTS.provider,
      hasApiKey: false,
      model: DASHBOARD_DEFAULTS.model,
      intervalSec: DASHBOARD_DEFAULTS.intervalSec,
      gateOnActivity: DASHBOARD_DEFAULTS.gateOnActivity,
      historyLimit: DASHBOARD_DEFAULTS.historyLimit,
    };
  }
  return toDashboardConfigView(await readDashboardConfig(current.path));
}

/** True when the open-tab set differs by membership (a tab opened or closed).
 *  cmd/cwd are fixed at spawn, so a sid-set comparison catches every change. */
function rosterChanged(before: TabInfo[], after: TabInfo[]): boolean {
  if (before.length !== after.length) return true;
  const sids = new Set(before.map((tab) => tab.sid));
  return after.some((tab) => !sids.has(tab.sid));
}

/** One dashboard cycle: refresh the open-tab roster, then (when enabled, keyed,
 *  and due) summarize the changed tabs and synthesize the cross-tab overview.
 *  A no-op when not armed for `conceptionPath`, already in flight, disabled, or
 *  the config read throws. Exported for unit testing. */
export async function tick(conceptionPath: string): Promise<void> {
  if (current?.path !== conceptionPath || inFlight) return;
  // Read config inside a guard: a malformed `.condash/settings.json` makes the
  // effective-config read throw, and the tick is fired as `void tick(...)` from
  // a bare interval with no global rejection handler — so a bad config must make
  // the tick a no-op rather than an unhandled rejection every interval. Mirrors
  // the task scheduler's tick.
  let config: DashboardConfig;
  try {
    config = await readDashboardConfig(conceptionPath);
  } catch {
    return;
  }
  if (!config.enabled) return;

  // Refresh the open-tab roster every tick — cheap, no LLM — so a newly opened
  // tab becomes visible within one tick even before its first summary (and even
  // with no API key), and a closed tab drops out. The renderer renders a card
  // per roster entry, falling back to cmd/cwd for a tab with no summary yet.
  const roster = tabsContext();
  if (rosterChanged(state.roster, roster)) {
    state = { ...state, roster };
    pushState();
  }

  // Resting phase between cycles: `idle` with no open tabs, else `waiting`
  // (with the gate on, that reads as "waiting for activity").
  const restingPhase: DashboardEnginePhase = roster.length === 0 ? 'idle' : 'waiting';

  if (!config.apiKey) {
    publishEngine({ phase: 'no-api-key', nextRunAt: 0, lastRunAt });
    return;
  }

  const now = Date.now();
  const intervalMs = config.intervalSec * 1000;
  if (now - lastRunAt < intervalMs) {
    // Counting down to the next cycle.
    publishEngine({ phase: restingPhase, nextRunAt: lastRunAt + intervalMs, lastRunAt });
    return;
  }

  const meta = new Map(roster.map((tab) => [tab.sid, tab]));
  const liveSids = new Set(meta.keys());
  const bytes = tabsBytes();
  // Tabs whose byte count moved since the last run (new tabs read as updated —
  // no prior snapshot). Removed tabs are detected separately so a closed tab
  // still refreshes the overview even with no growth.
  const updated = [...liveSids].filter((sid) => bytes.get(sid) !== prevBytes.get(sid));
  const removed = state.tabs.some((tab) => !liveSids.has(tab.sid));
  if (config.gateOnActivity && updated.length === 0 && !removed) {
    // Due, but nothing changed — the activity gate holds the cycle. Re-window the
    // ETA so the pane keeps counting down (alive) instead of sitting at "due now".
    publishEngine({ phase: restingPhase, nextRunAt: now + intervalMs, lastRunAt });
    return;
  }

  inFlight = true;
  lastRunAt = now;
  prevBytes = bytes;
  clearSummarizerError();
  publishEngine({ phase: 'summarizing', nextRunAt: now + intervalMs, lastRunAt: now });
  try {
    const priorBySid = new Map(state.tabs.map((tab) => [tab.sid, tab]));
    // Carry forward summaries for still-live tabs; drop the closed ones.
    const nextTabs: TabSummary[] = state.tabs.filter((tab) => liveSids.has(tab.sid));
    const indexOf = (sid: string): number => nextTabs.findIndex((tab) => tab.sid === sid);

    for (const sid of updated) {
      const tabMeta = meta.get(sid);
      if (!tabMeta) continue;
      const recentText = tabRecentText(sid);
      if (!recentText.trim()) continue;
      const result = await summarizeTab(config, {
        sid,
        cmd: tabMeta.cmd,
        cwd: tabMeta.cwd,
        recentText,
        prior: priorBySid.get(sid),
      });
      if (!result) continue;
      const prior = priorBySid.get(sid);
      const events = prior ? [...prior.events] : [];
      // Record an event whenever the "current action" changes — this is the
      // rolling history of what the tab has done over time.
      if (!prior || prior.currentAction !== result.currentAction) {
        if (result.currentAction) events.push(makeEvent(result.currentAction, now));
      }
      const summary: TabSummary = {
        sid,
        title: result.title,
        contextLines: result.contextLines,
        currentAction: result.currentAction,
        updatedAt: now,
        events,
      };
      const at = indexOf(sid);
      if (at >= 0) nextTabs[at] = summary;
      else nextTabs.push(summary);
    }

    let overview = state.overview;
    let history = state.history;
    if (nextTabs.length === 0) {
      overview = [];
    } else {
      const synthesized = await synthesizeOverview(config, nextTabs);
      if (synthesized) {
        overview = synthesized.overview;
        history = [...history, ...synthesized.events.map((text) => makeEvent(text, now))];
      }
    }

    state = pruneDashboardState(
      {
        updatedAt: now,
        overview,
        tabs: nextTabs,
        roster,
        history,
        // Cycle done — back to resting, counting down to the next one.
        engine: { phase: restingPhase, nextRunAt: now + intervalMs, lastRunAt: now },
        lastError: getSummarizerError() ?? undefined,
      },
      config.historyLimit,
    );
    await saveDashboardState(conceptionPath, state);
    pushState();
  } catch (err) {
    process.stderr.write(`condash dashboard: tick failed: ${(err as Error).message}\n`);
  } finally {
    inFlight = false;
  }
}
