import { BrowserWindow } from 'electron';
import { EVENT_CHANNELS } from '../../shared/ipc-channels';
import { safeSend } from '../safe-send';
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
  clearWriterCache,
  makeEvent,
  summarizeTab,
  type TabSummaryResult,
  type SummaryOwner,
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
interface SummaryJob {
  sid: string;
  generation: number;
  path: string;
  manual: boolean;
  invalid: boolean;
  sequence: number;
  attempted: boolean;
  error?: string;
  batch?: ScheduledBatch;
  done: Promise<void>;
  resolve(): void;
}

interface ScheduledBatch {
  generation: number;
  members: Set<SummaryJob>;
  outcomes: SummaryJob[];
  done: Promise<void>;
  resolve(): void;
  finishing?: boolean;
}

interface JobError {
  sid: string;
  generation: number;
  sequence: number;
  error: string;
  scheduled: boolean;
}

const SUMMARY_JOB_LIMIT = 3;
const jobs = new Map<string, SummaryJob>();
const activeJobs = new Set<SummaryJob>();
let scheduledQueue: SummaryJob[] = [];
let manualQueue: SummaryJob[] = [];
let scheduledBatch: ScheduledBatch | null = null;
let manualStreak = 0;
let admissionSequence = 0;
let dispatching = false;
let saveChain = Promise.resolve();
let latestConfig: DashboardConfig | null = null;
let errors: JobError[] = [];
/** Consecutive failed summarization cycles (any cycle that ends with lastError). */
let consecutiveFailures = 0;
/** Epoch ms of the last cycle that failed. */
let lastFailureAt = 0;
/** Maximum backoff delay between retries, capping exponential growth. */
const MAX_BACKOFF_MS = 300_000;
/** Bumped on every engine re-point / teardown. A tick / refreshTab captures it
 *  at entry and re-checks after each await, so a cycle whose 60 s LLM round-trips
 *  straddle a conception switch neither overwrites the new tree's reset state,
 *  pushes the old tree's cards to the new dashboard, nor unlatches a running new
 *  cycle's `inFlight` in its `finally` (E3). Same idiom as the task scheduler (E1). */
let generation = 0;

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    safeSend(win.webContents, channel, payload);
  }
}

/** Backoff delay grows exponentially with consecutive failures: 30s, 60s, 120s,
 *  240s, capped at 5 min. Returns 0 when there are no consecutive failures. */
export function getBackoffDelayMs(): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(30_000 * 2 ** (consecutiveFailures - 1), MAX_BACKOFF_MS);
}

/** True when the engine is inside the backoff window after repeated failures. */
export function isInBackoff(now: number): boolean {
  if (consecutiveFailures <= 0) return false;
  return now - lastFailureAt < getBackoffDelayMs();
}

/** Record a failed summarization cycle and return the current backoff delay. */
export function recordFailure(now: number): number {
  consecutiveFailures += 1;
  lastFailureAt = now;
  return getBackoffDelayMs();
}

/** Reset failure state after a successful cycle. */
export function recordSuccess(): void {
  consecutiveFailures = 0;
  lastFailureAt = 0;
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
  // Invalidate every in-flight tick / refreshTab captured against the prior
  // generation so none of them mutate `state` or push for the torn-down tree (E3).
  generation += 1;
  const myGeneration = generation;
  if (current) {
    clearInterval(current.interval);
    current = null;
  }
  prevBytes = new Map();
  nextDueAt = new Map();
  jitterBySid = new Map();
  lastRunAt = 0;
  for (const job of [...scheduledQueue, ...manualQueue]) {
    job.invalid = true;
    settleJob(job);
  }
  scheduledQueue = [];
  manualQueue = [];
  scheduledBatch = null;
  manualStreak = 0;
  latestConfig = null;
  errors = [];
  consecutiveFailures = 0;
  lastFailureAt = 0;
  clearWriterCache();
  state = emptyDashboardState(0);
  if (!conceptionPath) return;
  const persisted = await loadDashboardState(conceptionPath);
  if (generation !== myGeneration) return;
  if (persisted) state = persisted;
  const interval = setInterval(() => void tick(conceptionPath), TICK_MS);
  current = { path: conceptionPath, interval };
  pushState();
  // Observe immediately; the shared dispatcher owns overlapping admissions.
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
      skipIdle: DASHBOARD_DEFAULTS.skipIdle,
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
  recentText: string,
  owner: SummaryOwner,
): Promise<TabSummary | null> {
  if (!owner.isCurrent() || !recentText.trim()) return null;
  const result = await summarizeTab(
    config,
    {
      sid: tabMeta.sid,
      cmd: tabMeta.cmd,
      cwd: tabMeta.cwd,
      recentText,
      prior,
    },
    owner,
  );
  if (!owner.isCurrent() || !result) return null;
  // Correct a mid-turn agent the card model misread as resting (see
  // forceWorkingOnUserTail). Done before the writer call so the subtitle is
  // composed from the corrected state.
  forceWorkingOnUserTail(result, recentText);
  // Provenance is local (no LLM): config + tree reads, fed to the writer for the
  // title + subtitle and attached to the card for the UI pills.
  const provenance = await deriveProvenance(conceptionPath, tabMeta);
  if (!owner.isCurrent()) return null;
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
    owner,
  );
  if (!owner.isCurrent()) return null;
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
    ...(provenance.appPath ? { appPath: provenance.appPath } : {}),
    ...(provenance.worktree ? { worktree: provenance.worktree } : {}),
    ...(provenance.worktreePath ? { worktreePath: provenance.worktreePath } : {}),
    ...(provenance.projects && provenance.projects.length > 0
      ? { projects: provenance.projects }
      : {}),
    updatedAt: now,
    events,
  };
}

function jobKey(ownerGeneration: number, sid: string): string {
  return `${ownerGeneration}:${sid}`;
}

function isJobCurrent(job: SummaryJob): boolean {
  if (job.invalid || job.generation !== generation || current?.path !== job.path) return false;
  if (jobs.get(jobKey(job.generation, job.sid)) !== job) return false;
  if (!dashboardRoster().some((tab) => tab.sid === job.sid)) {
    job.invalid = true;
    invalidateBatchMember(job);
    return false;
  }
  return true;
}

async function finishBatch(batch: ScheduledBatch): Promise<void> {
  if (batch.members.size || batch.finishing) return;
  batch.finishing = true;
  if (batch.generation === generation && scheduledBatch === batch) {
    const outcomes = batch.outcomes.filter(
      (job) => !job.invalid && dashboardRoster().some((tab) => tab.sid === job.sid),
    );
    if (outcomes.length) {
      if (outcomes.some((job) => job.error)) recordFailure(Date.now());
      else {
        recordSuccess();
        const watermark = Math.max(...outcomes.map((job) => job.sequence));
        errors = errors.filter((job) => !job.scheduled || job.sequence > watermark);
      }
    }
    publishLiveStatus();
    if (outcomes.length && current) await persistCurrent(batch.generation, current.path);
    if (scheduledBatch === batch) scheduledBatch = null;
  }
  batch.resolve();
}

function invalidateBatchMember(job: SummaryJob): void {
  if (!job.batch) return;
  job.batch.members.delete(job);
  void finishBatch(job.batch);
}

async function settleJob(job: SummaryJob): Promise<void> {
  const key = jobKey(job.generation, job.sid);
  if (job.batch) {
    if (
      job.batch.members.has(job) &&
      job.attempted &&
      !job.invalid &&
      job.generation === generation
    ) {
      job.batch.outcomes.push(job);
    }
    job.batch.members.delete(job);
    await finishBatch(job.batch);
  }
  if (jobs.get(key) === job) jobs.delete(key);
  if (!activeJobs.has(job)) job.resolve();
}

function enqueueJob(sid: string, manual: boolean): SummaryJob {
  const key = jobKey(generation, sid);
  const existing = jobs.get(key);
  if (existing) {
    if (manual && !existing.manual && !activeJobs.has(existing)) {
      existing.manual = true;
      scheduledQueue = scheduledQueue.filter((job) => job !== existing);
      manualQueue.push(existing);
    }
    return existing;
  }
  let resolve!: () => void;
  const done = new Promise<void>((settle) => {
    resolve = settle;
  });
  const job: SummaryJob = {
    sid,
    generation,
    path: current!.path,
    manual,
    invalid: false,
    sequence: 0,
    attempted: false,
    done,
    resolve,
  };
  jobs.set(key, job);
  (manual ? manualQueue : scheduledQueue).push(job);
  return job;
}

function publishLiveStatus(): void {
  if (!current || !latestConfig) return;
  const roster = dashboardRoster();
  const liveSids = new Set(roster.map((tab) => tab.sid));
  const summarizingSids = [...activeJobs]
    .filter((job) => job.generation === generation && !job.invalid && liveSids.has(job.sid))
    .map((job) => job.sid);
  errors = errors.filter((job) => job.generation === generation && liveSids.has(job.sid));
  const lastError = errors.reduce<JobError | undefined>(
    (latest, job) => (!latest || job.sequence > latest.sequence ? job : latest),
    undefined,
  )?.error;
  const changed =
    rosterChanged(state.roster, roster) ||
    state.tabs.some((tab) => !liveSids.has(tab.sid)) ||
    state.lastError !== lastError ||
    (state.summarizingSids ?? []).join('\0') !== summarizingSids.join('\0');
  state = {
    ...state,
    roster,
    tabs: state.tabs.filter((tab) => liveSids.has(tab.sid)),
    summarizingSids,
    lastError,
  };
  const now = Date.now();
  let phase: DashboardEnginePhase = roster.length ? 'waiting' : 'idle';
  if (!latestConfig.apiKey) phase = 'no-api-key';
  if (isInBackoff(now)) phase = 'backoff';
  if (summarizingSids.length) phase = 'summarizing';
  publishEngine({
    phase,
    lastRunAt,
    nextRunAt:
      phase === 'no-api-key'
        ? 0
        : isInBackoff(now)
          ? lastFailureAt + getBackoffDelayMs()
          : earliestDue(now, liveSids, latestConfig.intervalSec * 1000),
  });
  if (changed) pushState();
}

function persistCurrent(ownerGeneration: number, path: string): Promise<void> {
  const save = saveChain.then(async () => {
    if (generation !== ownerGeneration || current?.path !== path) return;
    try {
      const snapshot = structuredClone(state);
      await saveDashboardState(path, snapshot);
    } catch (err) {
      process.stderr.write(`condash dashboard: state persist failed: ${(err as Error).message}\n`);
    }
  });
  saveChain = save;
  return save;
}

async function runJob(
  job: SummaryJob,
  config: DashboardConfig,
  tabMeta: TabInfo,
  recentText: string,
  now: number,
): Promise<void> {
  const owner: SummaryOwner = {
    isCurrent: () => isJobCurrent(job),
    reportError: (error) => {
      if (isJobCurrent(job)) job.error = error;
    },
  };
  try {
    let summary: TabSummary | null = null;
    try {
      summary = await buildSummary(
        config,
        job.path,
        tabMeta,
        state.tabs.find((tab) => tab.sid === job.sid),
        now,
        recentText,
        owner,
      );
    } catch (err) {
      owner.reportError((err as Error).message);
    }
    if (!isJobCurrent(job)) return;
    if (job.error) {
      const scheduled = !!job.batch;
      errors = errors.filter((error) => error.sid !== job.sid || error.scheduled !== scheduled);
      errors.push({
        sid: job.sid,
        generation: job.generation,
        sequence: job.sequence,
        error: job.error,
        scheduled,
      });
    } else if (!job.batch) {
      errors = errors.filter(
        (error) => error.scheduled || error.sid !== job.sid || error.sequence > job.sequence,
      );
    }
    if (summary) {
      state = pruneDashboardState(
        {
          ...state,
          updatedAt: Date.now(),
          tabs: [...state.tabs.filter((tab) => tab.sid !== job.sid), summary],
        },
        config.historyLimit,
      );
    }
    publishLiveStatus();
    pushState();
    await persistCurrent(job.generation, job.path);
  } finally {
    // A departed generation keeps its logical slot until its sent phase/save settles.
    if (job.generation !== generation || !isJobCurrent(job)) job.invalid = true;
    await settleJob(job);
    activeJobs.delete(job);
    if (job.generation === generation) publishLiveStatus();
    job.resolve();
    void dispatchJobs();
  }
}

async function dispatchJobs(): Promise<void> {
  if (dispatching) return;
  dispatching = true;
  try {
    while (activeJobs.size < SUMMARY_JOB_LIMIT && (manualQueue.length || scheduledQueue.length)) {
      const armed = current;
      const ownerGeneration = generation;
      if (!armed) break;
      let config: DashboardConfig;
      try {
        config = await readDashboardConfig(armed.path);
      } catch {
        for (const job of [...manualQueue, ...scheduledQueue]) {
          if (job.generation === ownerGeneration) {
            job.invalid = true;
            settleJob(job);
          }
        }
        manualQueue = manualQueue.filter((job) => !job.invalid);
        scheduledQueue = scheduledQueue.filter((job) => !job.invalid);
        continue;
      }
      if (generation !== ownerGeneration || current !== armed) continue;
      latestConfig = config;
      const scheduledWaiting = scheduledQueue.length > 0;
      if (!scheduledWaiting) manualStreak = 0;
      const chooseManual =
        manualQueue.length > 0 &&
        (!scheduledWaiting || manualStreak < 2 || isInBackoff(Date.now()));
      if (!chooseManual && isInBackoff(Date.now()) && config.enabled && config.apiKey) break;
      const job = (chooseManual ? manualQueue : scheduledQueue).shift()!;
      if (!isJobCurrent(job) || !config.enabled || !config.apiKey) {
        job.invalid = true;
        settleJob(job);
        continue;
      }
      const tabMeta = dashboardRoster().find((tab) => tab.sid === job.sid)!;
      const recentText = tabRecentText(job.sid);
      if (!recentText.trim()) {
        job.invalid = true;
        settleJob(job);
        continue;
      }
      const now = Date.now();
      job.attempted = true;
      job.sequence = ++admissionSequence;
      activeJobs.add(job);
      if (chooseManual && scheduledWaiting) manualStreak += 1;
      else manualStreak = 0;
      lastRunAt = now;
      nextDueAt.set(job.sid, now + config.intervalSec * 1000 + jitterFor(job.sid));
      prevBytes.set(job.sid, tabsBytes().get(job.sid) ?? 0);
      publishLiveStatus();
      void runJob(job, config, tabMeta, recentText, now);
    }
  } finally {
    dispatching = false;
    publishLiveStatus();
  }
}

/** One dashboard tick: refresh the open-tab roster, decay stale cards, then
 *  (when enabled and keyed) summarize exactly the tabs whose own per-tab clock
 *  is due and whose activity gate passes. A no-op when not armed for
 *  `conceptionPath` or the config read throws. Observation continues during jobs
 *  and backoff; only one scheduled batch is outstanding at a time.
 *  Exported for unit testing. */
export async function tick(conceptionPath: string): Promise<void> {
  if (current?.path !== conceptionPath) return;
  // Snapshot the generation at entry: setDashboardConception bumps it on every
  // re-point / teardown, so this cycle can tell — after any await below — that it
  // now belongs to a switched-away tree and bail before touching `state` (E3).
  const myGeneration = generation;
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
  // A conception switch during the config read must abort this cycle before it
  // mutates the (now reset) module state for the wrong tree.
  if (generation !== myGeneration) return;
  latestConfig = config;

  // Refresh the open-tab roster every tick — cheap, no LLM — so a newly opened
  // tab becomes visible within one tick even before its first summary (and even
  // with no API key), and a closed tab drops out. The renderer renders a card
  // per roster entry, falling back to cmd/cwd for a tab with no summary yet.
  // Only the user's terminal tabs (`side: 'my'`) — Code-pane Run dev servers are
  // not agent tabs and must not inflate the count or appear as idle cards (#366).
  const roster = dashboardRoster();
  const liveSids = new Set(roster.map((tab) => tab.sid));
  for (const job of jobs.values()) {
    if (job.generation === generation && !liveSids.has(job.sid)) {
      job.invalid = true;
      invalidateBatchMember(job);
      if (!activeJobs.has(job)) settleJob(job);
    }
  }
  scheduledQueue = scheduledQueue.filter((job) => !job.invalid);
  manualQueue = manualQueue.filter((job) => !job.invalid);
  errors = errors.filter((job) => liveSids.has(job.sid));
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

  if (!config.enabled || !config.apiKey) {
    publishLiveStatus();
    void dispatchJobs();
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
    publishLiveStatus();
    void dispatchJobs();
    return;
  }

  // Per-tab activity gate: a due tab summarizes when the gate is off or its
  // bytes grew since its own last attempt. When skipIdle is on, idle tabs that
  // have not grown are also held back, even with the activity gate off.
  const priorBySid = new Map(state.tabs.map((tab) => [tab.sid, tab]));
  const gatePass = (sid: string): boolean => {
    const grew = bytes.get(sid) !== prevBytes.get(sid);
    if (config.gateOnActivity) return grew;
    if (config.skipIdle) {
      const prior = priorBySid.get(sid);
      if (prior?.state === 'idle' && !grew) return false;
    }
    return true;
  };
  const toSummarize = dueSids.filter((sid) => gatePass(sid) && !jobs.has(jobKey(generation, sid)));

  // Re-window a due-but-gated tab (no LLM): it waits one more interval, its byte
  // baseline left intact so activity since its last attempt still trips the gate.
  for (const sid of dueSids) {
    if (!jobs.has(jobKey(generation, sid)) && !gatePass(sid)) {
      nextDueAt.set(sid, now + intervalMs + jitterFor(sid));
    }
  }

  let batch: ScheduledBatch | null = null;
  if (!scheduledBatch && toSummarize.length && !isInBackoff(now)) {
    let resolve!: () => void;
    const done = new Promise<void>((settle) => {
      resolve = settle;
    });
    batch = { generation, members: new Set(), outcomes: [], done, resolve };
    scheduledBatch = batch;
    for (const sid of toSummarize) {
      const job = enqueueJob(sid, false);
      job.batch = batch;
      batch.members.add(job);
    }
  }
  publishLiveStatus();
  void dispatchJobs();
  if (batch) await batch.done;
}

/**
 * Force an immediate re-summarization of a single tab — the per-card "Update
 * now" button — bypassing both the interval and the activity gate so the user
 * can refresh a card whose status looks stale on demand. A no-op when the engine
 * isn't armed for an enabled, keyed conception, the
 * sid isn't a live tab, or the tab has no readable output yet. Refreshes only
 * that card through the shared queue; repeated clicks await its existing job.
 * Admission pushes its clock and byte baseline out even on a failed/null result.
 *
 * @param sid The tab to refresh.
 */
export async function refreshTab(sid: string): Promise<void> {
  const armed = current;
  if (!armed) return;
  // Same generation guard as `tick` (E3): a conception switch during either await
  // below must abort before this refresh clobbers the new tree's state.
  const myGeneration = generation;
  let config: DashboardConfig;
  try {
    config = await readDashboardConfig(armed.path);
  } catch {
    return;
  }
  if (generation !== myGeneration) return;
  if (!config.enabled || !config.apiKey) return;
  latestConfig = config;
  const tabMeta = dashboardRoster().find((tab) => tab.sid === sid);
  if (!tabMeta) return;

  const job = enqueueJob(sid, true);
  void dispatchJobs();
  await job.done;
}
