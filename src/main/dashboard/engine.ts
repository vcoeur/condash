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
import { dashboardRoster, tabRecentText, tabsBytes } from '../terminals';
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
      writerModel: DASHBOARD_DEFAULTS.writerModel,
      cardReasoning: DASHBOARD_DEFAULTS.cardReasoning,
      writerReasoning: DASHBOARD_DEFAULTS.writerReasoning,
      cardInputChars: DASHBOARD_DEFAULTS.cardInputChars,
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

/** A `working` tab that has produced no new output for this many summarize
 *  intervals is treated as finished — the multiplier that sizes the idle-decay
 *  grace window. Two cycles of silence keeps a momentarily-quiet but genuinely
 *  working tab (a slow build between progress lines) from flickering to idle. */
export const DECAY_INTERVALS = 2;

/**
 * Locally retire tabs stuck on a `working` badge after going quiet to `idle`,
 * with no LLM call. The summarize gate keys on byte growth, so a tab that
 * finished and fell silent is never re-summarized and would otherwise stay
 * frozen on its last `working` state — the very transition to idle (output
 * stopping) is exactly what the gate reads as "nothing to do". A tab qualifies
 * only when it is `working`, its byte count has not grown since the last
 * summarize run, and its summary is older than the grace window. `awaiting`
 * (legitimately blocked on a prompt) and `error` are left untouched — their
 * quiet is real, not a finished turn.
 *
 * @param tabs - Current per-tab summaries.
 * @param bytes - Live byte counts per sid for this tick.
 * @param prev - Byte counts captured at the last summarize run (the growth gate).
 * @param now - Current epoch ms.
 * @param intervalMs - Resolved summarize cadence; the grace is `DECAY_INTERVALS`× it.
 * @returns A new tabs array when anything decayed, else the input array unchanged
 *   (referential equality) so the caller can skip a redundant push.
 */
export function decayStaleWorkingTabs(
  tabs: TabSummary[],
  bytes: Map<string, number>,
  prev: Map<string, number>,
  now: number,
  intervalMs: number,
): TabSummary[] {
  const graceMs = intervalMs * DECAY_INTERVALS;
  let changed = false;
  const next = tabs.map((tab) => {
    if (tab.state !== 'working') return tab;
    // Grew since the last run → still active; it gets re-summarized, not decayed.
    if (bytes.get(tab.sid) !== prev.get(tab.sid)) return tab;
    if (now - tab.updatedAt < graceMs) return tab;
    changed = true;
    return {
      ...tab,
      state: 'idle' as const,
      currentAction: 'Idle — no recent output',
      updatedAt: now,
    };
  });
  return changed ? next : tabs;
}

/**
 * Run one tab through the summarizer and fold the result into a TabSummary,
 * carrying the prior summary's event history and appending an event when the
 * current action changes. Returns null when the tab has no readable recent
 * output or the model declines — the caller leaves any prior summary in place.
 * Shared by the scheduled cycle and the per-card `refreshTab`.
 *
 * @param config Resolved dashboard config (provider / key / model).
 * @param tabMeta The tab's identity (sid, cmd, cwd) from the roster.
 * @param prior The tab's existing summary, if any.
 * @param now Epoch ms stamped onto the summary and any new event.
 * @returns The new summary, or null when nothing could be summarized.
 */
async function buildSummary(
  config: DashboardConfig,
  tabMeta: TabInfo,
  prior: TabSummary | undefined,
  now: number,
): Promise<TabSummary | null> {
  const recentText = tabRecentText(tabMeta.sid);
  if (!recentText.trim()) return null;
  const result = await summarizeTab(config, {
    sid: tabMeta.sid,
    cmd: tabMeta.cmd,
    cwd: tabMeta.cwd,
    recentText,
    prior,
  });
  if (!result) return null;
  const events = prior ? [...prior.events] : [];
  // Record an event whenever the "current action" changes — the rolling history
  // of what the tab has done over time.
  if (!prior || prior.currentAction !== result.currentAction) {
    if (result.currentAction) events.push(makeEvent(result.currentAction, now));
  }
  return {
    sid: tabMeta.sid,
    title: result.title,
    contextLines: result.contextLines,
    currentAction: result.currentAction,
    state: result.state,
    ...(result.awaitingPrompt ? { awaitingPrompt: result.awaitingPrompt } : {}),
    updatedAt: now,
    events,
  };
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
  // Only the user's terminal tabs (`side: 'my'`) — Code-pane Run dev servers are
  // not agent tabs and must not inflate the count or appear as idle cards (#366).
  const roster = dashboardRoster();
  const liveSids = new Set(roster.map((tab) => tab.sid));
  // Drop summaries for closed tabs every tick — no LLM, no API key, independent
  // of the summarize gate — so a closed tab's working/idle tally entry (and any
  // stuck status badge) comes off immediately instead of lingering until the next
  // summarize cycle, which the activity gate or a missing key could defer
  // indefinitely. Without this the status could outlive the tab it describes.
  const liveTabs = state.tabs.filter((tab) => liveSids.has(tab.sid));
  if (rosterChanged(state.roster, roster) || liveTabs.length !== state.tabs.length) {
    state = { ...state, roster, tabs: liveTabs };
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
  const bytes = tabsBytes();
  // Tabs whose byte count moved since the last run (new tabs read as updated —
  // no prior snapshot). A tab that closed since the last run still forces a cycle
  // so the cross-tab overview drops it even with no byte growth — detected from
  // last run's sid snapshot (`prevBytes`), which survives the per-tick tab prune
  // above (where `state.tabs` is already pruned, so it can't carry the signal).
  const updated = [...liveSids].filter((sid) => bytes.get(sid) !== prevBytes.get(sid));
  const removed = [...prevBytes.keys()].some((sid) => !liveSids.has(sid));

  // Retire any `working` tab that has gone silent past the grace window to
  // `idle` (no LLM call) before the gate can hold the cycle — otherwise a
  // finished-but-quiet tab is never re-summarized and stays frozen on its last
  // `working` badge. Runs every due tick regardless of the gate, since a quiet
  // tab is never in `updated` and so is never refreshed by the summarize loop.
  const decayed = decayStaleWorkingTabs(state.tabs, bytes, prevBytes, now, intervalMs);
  if (decayed !== state.tabs) {
    state = { ...state, tabs: decayed };
    pushState();
  }

  if (config.gateOnActivity && updated.length === 0 && !removed) {
    // Due, but nothing changed — the activity gate holds the cycle. Re-window the
    // ETA so the pane keeps counting down (alive) instead of sitting at "due now".
    publishEngine({ phase: restingPhase, nextRunAt: now + intervalMs, lastRunAt });
    return;
  }

  inFlight = true;
  lastRunAt = now;
  // Snapshot only the dashboard's own (my-side) live sids: the next cycle reads
  // this both to gate on byte growth and to detect a tab that closed since this
  // run, so it must not carry code-side dev-server sids that would read as
  // perpetually "removed".
  prevBytes = new Map([...liveSids].map((sid) => [sid, bytes.get(sid) ?? 0]));
  clearSummarizerError();
  // Enter the summarizing window: publish the phase AND the set of tabs being
  // recomputed this cycle, so the renderer can badge exactly those cards
  // "Summarizing" while their LLM call is in flight. A direct push (not
  // publishEngine) because the per-tab overlay rides alongside the phase change.
  state = {
    ...state,
    engine: { phase: 'summarizing', nextRunAt: now + intervalMs, lastRunAt: now },
    summarizingSids: updated,
  };
  pushState();
  try {
    const priorBySid = new Map(state.tabs.map((tab) => [tab.sid, tab]));
    // Carry forward summaries for still-live tabs; drop the closed ones.
    const nextTabs: TabSummary[] = state.tabs.filter((tab) => liveSids.has(tab.sid));
    const indexOf = (sid: string): number => nextTabs.findIndex((tab) => tab.sid === sid);

    // Summarize the changed tabs concurrently — each is an independent, tool-free
    // HTTP completion, so a board of N tabs costs ~one call's latency instead of
    // N in series (the dominant win once per-tab reasoning is off). Results are
    // folded in `updated` order so placement stays deterministic.
    const built = await Promise.all(
      updated.map((sid) => {
        const tabMeta = meta.get(sid);
        if (!tabMeta) return Promise.resolve(null);
        return buildSummary(config, tabMeta, priorBySid.get(sid), now);
      }),
    );
    for (const summary of built) {
      if (!summary) continue;
      const at = indexOf(summary.sid);
      if (at >= 0) nextTabs[at] = summary;
      else nextTabs.push(summary);
    }

    let overview = state.overview;
    let globalWork = state.globalWork;
    let history = state.history;
    if (nextTabs.length === 0) {
      overview = [];
      globalWork = undefined;
    } else {
      const synthesized = await synthesizeOverview(config, nextTabs);
      if (synthesized) {
        overview = synthesized.overview;
        globalWork = synthesized.globalWork || undefined;
        history = [...history, ...synthesized.events.map((text) => makeEvent(text, now))];
      }
    }

    state = pruneDashboardState(
      {
        updatedAt: now,
        globalWork,
        overview,
        tabs: nextTabs,
        roster,
        history,
        // Cycle done — back to resting, counting down to the next one.
        engine: { phase: restingPhase, nextRunAt: now + intervalMs, lastRunAt: now },
        // Window closed — drop the transient per-tab summarizing overlay.
        summarizingSids: [],
        lastError: getSummarizerError() ?? undefined,
      },
      config.historyLimit,
    );
    // Push the freshly computed state to the renderer FIRST, then persist.
    // Persistence is a best-effort next-launch seed; a save failure must never
    // suppress the live UI update. The previous order (save, then push) meant a
    // throwing save skipped the push entirely — so every summary, overview and
    // resting-phase reset was computed but never reached the pane.
    pushState();
    try {
      await saveDashboardState(conceptionPath, state);
    } catch (err) {
      process.stderr.write(`condash dashboard: state persist failed: ${(err as Error).message}\n`);
    }
  } catch (err) {
    process.stderr.write(`condash dashboard: tick failed: ${(err as Error).message}\n`);
    // A throw before the resting-state push leaves the summarizing overlay set;
    // clear it so cards don't stay stuck reading "Summarizing".
    if (state.summarizingSids?.length) {
      state = { ...state, summarizingSids: [] };
      pushState();
    }
  } finally {
    inFlight = false;
  }
}

/**
 * Force an immediate re-summarization of a single tab — the per-card "Update
 * now" button — bypassing both the interval and the activity gate so the user
 * can refresh a card whose status looks stale on demand. A no-op when the engine
 * isn't armed for an enabled, keyed conception, a cycle is already in flight, the
 * sid isn't a live tab, or the tab has no readable output yet. Refreshes only
 * that card; the cross-tab overview refreshes on the next scheduled cycle.
 *
 * @param sid The tab to refresh.
 */
export async function refreshTab(sid: string): Promise<void> {
  const armed = current;
  if (!armed || inFlight) return;
  let config: DashboardConfig;
  try {
    config = await readDashboardConfig(armed.path);
  } catch {
    return;
  }
  if (!config.enabled || !config.apiKey) return;
  const tabMeta = dashboardRoster().find((tab) => tab.sid === sid);
  if (!tabMeta) return;

  inFlight = true;
  const now = Date.now();
  clearSummarizerError();
  // Badge just this card "Summarizing" while its single LLM call is in flight.
  state = { ...state, summarizingSids: [sid] };
  pushState();
  try {
    const prior = state.tabs.find((tab) => tab.sid === sid);
    const summary = await buildSummary(config, tabMeta, prior, now);
    if (summary) {
      const others = state.tabs.filter((tab) => tab.sid !== sid);
      // Bank this sid's byte count so the next scheduled cycle's growth gate
      // doesn't redundantly re-summarize a tab the user just refreshed.
      prevBytes.set(sid, tabsBytes().get(sid) ?? prevBytes.get(sid) ?? 0);
      state = {
        ...state,
        tabs: [...others, summary],
        updatedAt: now,
        summarizingSids: [],
        lastError: getSummarizerError() ?? undefined,
      };
    } else {
      // Nothing summarizable (no output yet / model declined): clear the overlay
      // and surface any error, leaving the prior summary in place.
      state = { ...state, summarizingSids: [], lastError: getSummarizerError() ?? undefined };
    }
    pushState();
    try {
      await saveDashboardState(armed.path, state);
    } catch (err) {
      process.stderr.write(`condash dashboard: state persist failed: ${(err as Error).message}\n`);
    }
  } catch (err) {
    process.stderr.write(`condash dashboard: tab refresh failed: ${(err as Error).message}\n`);
    state = { ...state, summarizingSids: [] };
    pushState();
  } finally {
    inFlight = false;
  }
}
