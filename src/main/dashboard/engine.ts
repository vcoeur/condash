import { BrowserWindow } from 'electron';
import { EVENT_CHANNELS } from '../../shared/ipc-channels';
import type { DashboardConfigView, DashboardState, TabSummary } from '../../shared/types';
import { tabRecentText, tabsBytes, tabsContext } from '../terminals';
import { DASHBOARD_DEFAULTS, readDashboardConfig, toDashboardConfigView } from './config';
import {
  emptyDashboardState,
  loadDashboardState,
  pruneDashboardState,
  saveDashboardState,
} from './state';
import { makeEvent, summarizeTab, synthesizeOverview } from './summarizer';

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

async function tick(conceptionPath: string): Promise<void> {
  if (current?.path !== conceptionPath || inFlight) return;
  const config = await readDashboardConfig(conceptionPath);
  if (!config.enabled || !config.apiKey) return;

  const now = Date.now();
  if (now - lastRunAt < config.intervalSec * 1000) return;

  const meta = new Map(tabsContext().map((tab) => [tab.sid, tab]));
  const liveSids = new Set(meta.keys());
  const bytes = tabsBytes();
  // Tabs whose byte count moved since the last run (new tabs read as updated —
  // no prior snapshot). Removed tabs are detected separately so a closed tab
  // still refreshes the overview even with no growth.
  const updated = [...liveSids].filter((sid) => bytes.get(sid) !== prevBytes.get(sid));
  const removed = state.tabs.some((tab) => !liveSids.has(tab.sid));
  if (config.gateOnActivity && updated.length === 0 && !removed) return;

  inFlight = true;
  lastRunAt = now;
  prevBytes = bytes;
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
      { updatedAt: now, overview, tabs: nextTabs, history },
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
