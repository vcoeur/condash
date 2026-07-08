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
import { lastTranscriptRole } from '../osc-transcript';
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
  type TabSummaryResult,
  writeCard,
} from './summarizer';
import { deriveProvenance } from './provenance';

/** Base poll interval. Each tick re-reads config (cheap, like the task
 *  scheduler) and refreshes exactly the tabs whose own per-tab clock is due AND
 *  whose activity gate passes — so settings edits (enable, key, cadence) take
 *  effect within one tick without a restart. */
const TICK_MS = 15_000;

/** Per-tab jitter window. A tab's reschedule is `now + intervalMs + jitter`,
 *  where `jitter ∈ [0, JITTER_WINDOW_MS)` is fixed per sid — wide enough (one
 *  tick) that tabs which would otherwise come due on the same tick desync and
 *  stop hammering the LLM endpoint in lockstep. */
const JITTER_WINDOW_MS = TICK_MS;

interface Armed {
  path: string;
  interval: ReturnType<typeof setInterval>;
}

let current: Armed | null = null;
let state: DashboardState = emptyDashboardState(0);
/** Per-sid `bytesSeen` captured at each tab's last summarize attempt — the
 *  per-tab growth gate baseline. */
let prevBytes = new Map<string, number>();
/** Per-sid next-refresh timestamp (epoch ms). A sid with no entry is treated as
 *  due immediately, so a freshly-opened tab gets its first summary promptly;
 *  after each attempt the clock is set to `now + intervalMs + jitter`. */
let nextDueAt = new Map<string, number>();
/** Per-sid fixed jitter offset, assigned on first sight, in `[0, JITTER_WINDOW_MS)`. */
let jitterBySid = new Map<string, number>();
/** Epoch ms of the last tick that actually summarized a tab — engine status only. */
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
  nextDueAt = new Map();
  jitterBySid = new Map();
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

/** Fixed per-tab jitter offset, assigned lazily on first sight. */
function jitterFor(sid: string): number {
  let jitter = jitterBySid.get(sid);
  if (jitter === undefined) {
    jitter = Math.floor(Math.random() * JITTER_WINDOW_MS);
    jitterBySid.set(sid, jitter);
  }
  return jitter;
}

/** Drop scheduler bookkeeping for sids that are no longer live, so a closed
 *  tab's clock / byte baseline / jitter doesn't linger or leak. */
function pruneSchedulerMaps(liveSids: Set<string>): void {
  for (const sid of [...prevBytes.keys()]) if (!liveSids.has(sid)) prevBytes.delete(sid);
  for (const sid of [...nextDueAt.keys()]) if (!liveSids.has(sid)) nextDueAt.delete(sid);
  for (const sid of [...jitterBySid.keys()]) if (!liveSids.has(sid)) jitterBySid.delete(sid);
}

/** Earliest next-refresh time across the live tabs — drives the engine-status
 *  countdown. A sid with no clock yet (brand new) counts as one interval out so
 *  the ETA never reports a stale "due now". Returns a stable `0` when no tab is
 *  open: a moving `now + intervalMs` sentinel would change on every tick and
 *  defeat `publishEngine`'s change guard, pushing an unchanged empty-roster state
 *  to the renderer every tick (review finding T7-main). The renderer treats
 *  nextRunAt 0 as "soon" and, with an empty roster, renders no pending cards at
 *  all — so the ETA is never actually shown for the empty case. */
function earliestDue(now: number, liveSids: Set<string>, intervalMs: number): number {
  let min = Infinity;
  for (const sid of liveSids) {
    const due = nextDueAt.get(sid) ?? now + intervalMs;
    if (due < min) min = due;
  }
  return min === Infinity ? 0 : min;
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
 * Force a mid-turn agent's card to `working` when the transcript tail is a
 * `[user]` message. The OSC sidecar transcript only gains an assistant chunk at
 * the agent's next `Stop`, so a long in-flight turn leaves it frozen on the
 * user's just-submitted request; the card model — blind to the live spinner,
 * which lives only in the grid the transcript path never reads — then misreads
 * that `[user]` tail as `awaiting` or `idle`, showing a busy agent as resting. A
 * `[user]` tail is an unambiguous mid-turn signal, so override to `working`,
 * lift an `awaiting`/`idle` activity to `implementing`, and drop any stale
 * `awaitingPrompt`. `error` is left intact — a real crash must not read as work —
 * and `decayStaleWorkingTabs` is the backstop for the rare case the agent exited
 * right after the prompt (no assistant frame → it goes byte-quiet and decays back
 * to idle past the grace window). A non-transcript grid fallback has no `[user]`
 * marker, so this is a no-op there. Mutates and returns `result`. Exported for
 * unit testing.
 *
 * @param result - The card model's parsed summary for this tab (mutated in place).
 * @param recentText - The exact text the card model was given (the transcript).
 * @returns The same `result`, corrected when a `[user]` tail was detected.
 */
export function forceWorkingOnUserTail(
  result: TabSummaryResult,
  recentText: string,
): TabSummaryResult {
  if (result.state !== 'error' && lastTranscriptRole(recentText) === 'user') {
    result.state = 'working';
    if (result.activity === 'awaiting' || result.activity === 'idle') {
      result.activity = 'implementing';
    }
    result.awaitingPrompt = '';
  }
  return result;
}

/**
 * Run one tab through the two-tier summarizer and fold the result into a
 * TabSummary: the cheap card model pre-processes the raw output into facts +
 * state/activity + a draft title, local provenance is derived (app / worktree /
 * projects), and the richer writer model composes the published title + subtitle
 * from those facts. The writer never sees the raw output, so it polishes rather
 * than re-grounds; its title falls back to the cheap draft when the (pricier,
 * occasionally flaky) writer call empties — so the card's most prominent field
 * never depends on that call. Carries the prior summary's event history and
 * appends an event when the current action changes. Returns null when the tab has
 * no readable recent output or the card model declines — the caller leaves any
 * prior summary in place. Shared by the scheduled cycle and the per-card
 * `refreshTab`.
 *
 * @param config Resolved dashboard config (provider / key / model).
 * @param conceptionPath The active conception root, for provenance derivation.
 * @param tabMeta The tab's identity (sid, cmd, cwd, repo) from the roster.
 * @param prior The tab's existing summary, if any.
 * @param now Epoch ms stamped onto the summary and any new event.
 * @returns The new summary, or null when nothing could be summarized.
 */
async function buildSummary(
  config: DashboardConfig,
  conceptionPath: string,
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
  // Correct a mid-turn agent the card model misread as resting (see
  // forceWorkingOnUserTail). Done before the writer call so the subtitle is
  // composed from the corrected state.
  forceWorkingOnUserTail(result, recentText);
  // Provenance is local (no LLM): config + tree reads, fed to the writer for the
  // title + subtitle and attached to the card for the UI pills.
  const provenance = await deriveProvenance(conceptionPath, tabMeta);
  const written = await writeCard(
    config,
    {
      title: result.title,
      currentAction: result.currentAction,
      contextLines: result.contextLines,
      activity: result.activity,
      state: result.state,
    },
    provenance,
  );
  // The writer owns the published title but falls back to the cheap pre-pass's
  // draft when its (pricier, occasionally empty) reply has none, so the card's
  // most prominent field never blanks.
  const title = written.title || result.title;
  const subtitle = written.subtitle;
  const events = prior ? [...prior.events] : [];
  // Record an event whenever the "current action" changes — the rolling history
  // of what the tab has done over time.
  if (!prior || prior.currentAction !== result.currentAction) {
    if (result.currentAction) events.push(makeEvent(result.currentAction, now));
  }
  return {
    sid: tabMeta.sid,
    title,
    subtitle,
    contextLines: result.contextLines,
    currentAction: result.currentAction,
    state: result.state,
    activity: result.activity,
    ...(result.awaitingPrompt ? { awaitingPrompt: result.awaitingPrompt } : {}),
    ...(provenance.app ? { app: provenance.app } : {}),
    ...(provenance.worktree ? { worktree: provenance.worktree } : {}),
    ...(provenance.projects && provenance.projects.length > 0
      ? { projects: provenance.projects }
      : {}),
    updatedAt: now,
    events,
  };
}

/** One dashboard tick: refresh the open-tab roster, decay stale cards, then
 *  (when enabled and keyed) summarize exactly the tabs whose own per-tab clock
 *  is due and whose activity gate passes. A no-op when not armed for
 *  `conceptionPath`, already in flight, disabled, or the config read throws.
 *  Exported for unit testing. */
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
  // Retire scheduler bookkeeping for closed tabs (clock / baseline / jitter).
  pruneSchedulerMaps(liveSids);
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
  const bytes = tabsBytes();

  // Retire any `working` tab that has gone silent past the grace window to
  // `idle` (no LLM call) — otherwise a finished-but-quiet tab, never in the
  // due+grown set, is never re-summarized and stays frozen on its last
  // `working` badge. Runs every tick regardless of dueness or the gate.
  const decayed = decayStaleWorkingTabs(state.tabs, bytes, prevBytes, now, intervalMs);
  if (decayed !== state.tabs) {
    state = { ...state, tabs: decayed };
    pushState();
  }

  // Tabs whose own clock is due this tick (no entry ⇒ due immediately).
  const dueSids = roster.map((tab) => tab.sid).filter((sid) => (nextDueAt.get(sid) ?? 0) <= now);
  if (dueSids.length === 0) {
    publishEngine({
      phase: restingPhase,
      nextRunAt: earliestDue(now, liveSids, intervalMs),
      lastRunAt,
    });
    return;
  }

  // Per-tab activity gate: a due tab summarizes when the gate is off or its
  // bytes grew since its own last attempt.
  const gatePass = (sid: string): boolean =>
    !config.gateOnActivity || bytes.get(sid) !== prevBytes.get(sid);
  const toSummarize = dueSids.filter(gatePass);

  // Re-window a due-but-gated tab (no LLM): it waits one more interval, its byte
  // baseline left intact so activity since its last attempt still trips the gate.
  for (const sid of dueSids) {
    if (!toSummarize.includes(sid)) nextDueAt.set(sid, now + intervalMs + jitterFor(sid));
  }

  if (toSummarize.length === 0) {
    // Every due tab is gate-held — nothing to summarize this tick.
    publishEngine({
      phase: restingPhase,
      nextRunAt: earliestDue(now, liveSids, intervalMs),
      lastRunAt,
    });
    return;
  }

  inFlight = true;
  lastRunAt = now;
  // Advance the clock + byte baseline for each tab we will summarize. The
  // baseline moves only on an actual attempt, so a not-yet-due tab's growth is
  // still detected when its own clock comes due.
  for (const sid of toSummarize) {
    nextDueAt.set(sid, now + intervalMs + jitterFor(sid));
    prevBytes.set(sid, bytes.get(sid) ?? 0);
  }
  clearSummarizerError();
  // Enter the summarizing window: publish the phase AND the set of tabs being
  // recomputed this tick, so the renderer can badge exactly those cards
  // "Summarizing" while their LLM call is in flight. A direct push (not
  // publishEngine) because the per-tab overlay rides alongside the phase change.
  state = {
    ...state,
    engine: {
      phase: 'summarizing',
      nextRunAt: earliestDue(now, liveSids, intervalMs),
      lastRunAt: now,
    },
    summarizingSids: toSummarize,
  };
  pushState();
  try {
    const meta = new Map(roster.map((tab) => [tab.sid, tab]));
    const priorBySid = new Map(state.tabs.map((tab) => [tab.sid, tab]));
    // Carry forward summaries for still-live tabs; drop the closed ones.
    const nextTabs: TabSummary[] = state.tabs.filter((tab) => liveSids.has(tab.sid));
    const indexOf = (sid: string): number => nextTabs.findIndex((tab) => tab.sid === sid);

    // Summarize the due tabs concurrently — each is an independent, tool-free
    // pair of HTTP completions (cheap pre-pass + writer), so a board of N tabs
    // costs ~one tab's latency instead of N in series. Folded in `toSummarize`
    // order so placement stays deterministic.
    const built = await Promise.all(
      toSummarize.map((sid) => {
        const tabMeta = meta.get(sid);
        if (!tabMeta) return Promise.resolve(null);
        return buildSummary(config, conceptionPath, tabMeta, priorBySid.get(sid), now);
      }),
    );
    for (const summary of built) {
      if (!summary) continue;
      const at = indexOf(summary.sid);
      if (at >= 0) nextTabs[at] = summary;
      else nextTabs.push(summary);
    }

    state = pruneDashboardState(
      {
        updatedAt: now,
        tabs: nextTabs,
        roster,
        history: state.history,
        // Tick done — back to resting, counting down to the next due tab.
        engine: {
          phase: restingPhase,
          nextRunAt: earliestDue(now, liveSids, intervalMs),
          lastRunAt: now,
        },
        // Window closed — drop the transient per-tab summarizing overlay.
        summarizingSids: [],
        lastError: getSummarizerError() ?? undefined,
      },
      config.historyLimit,
    );
    // Push the freshly computed state to the renderer FIRST, then persist.
    // Persistence is a best-effort next-launch seed; a save failure must never
    // suppress the live UI update. The previous order (save, then push) meant a
    // throwing save skipped the push entirely — so every summary and the
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
 * that card and pushes its per-tab clock a full interval out.
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
    const summary = await buildSummary(config, armed.path, tabMeta, prior, now);
    if (summary) {
      const others = state.tabs.filter((tab) => tab.sid !== sid);
      // Bank this sid's byte count and push its clock a full interval out so the
      // next scheduled cycle's growth gate doesn't redundantly re-summarize a tab
      // the user just refreshed.
      prevBytes.set(sid, tabsBytes().get(sid) ?? prevBytes.get(sid) ?? 0);
      nextDueAt.set(sid, now + config.intervalSec * 1000 + jitterFor(sid));
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
