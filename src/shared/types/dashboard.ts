// Live terminal-tab summarization ("Dashboard"). The main-process engine
// periodically summarizes the active terminal tabs via a direct call to an
// OpenAI-compatible LLM endpoint and pushes the result to the renderer; these
// shapes are the wire contract for
// that data plus the resolved (defaulted) config the engine and Settings UI
// share. The raw on-disk config shape lives in `main/config-schema.ts`
// (`dashboard` block); these are the runtime/IPC views of it.

import type { TabInfo } from './terminal';

/** One past event in a tab's (or the global) rolling history. */
export interface DashboardEvent {
  /** Epoch ms when the event was recorded. */
  at: number;
  /** One-line description of what happened. */
  text: string;
}

/** Coarse machine-readable state of a tab, derived by the summarizer from the
 *  latest output. Drives the colour a card is rendered with.
 *  - `working` — output is still progressing.
 *  - `awaiting` — the program asked a question or shows a menu/prompt that needs
 *    the user to answer (the question itself is in `TabSummary.awaitingPrompt`).
 *  - `idle` — the work finished or nothing is pending (an agent resting at an
 *    empty prompt is idle, not blocked). The default when the model omits it.
 *  - `error` — a command crashed or failed and is not recovering. Distinct from
 *    `DashboardState.lastError`, which is the engine's own summarization failure. */
export type TabState = 'working' | 'awaiting' | 'idle' | 'error';

/** Finer-grained work stage for a tab, classified from what the operator is
 *  doing NOW (not the tool in use) — distinct from the coarse `TabState`, which
 *  stays the health colour. Drives the per-card activity badge. Defaulted to
 *  `idle` when the model reply omits or garbles it.
 *  - `implementing` — writing or editing code.
 *  - `designing` — planning/architecting before code is written.
 *  - `reviewing` — reading or answering a code review or diff.
 *  - `making-pr` — opening or updating a pull request.
 *  - `documenting` — writing docs, a README, or notes.
 *  - `testing` — running or writing tests.
 *  - `debugging` — diagnosing a failure or crash.
 *  - `researching` — reading/searching to decide what to do.
 *  - `awaiting` — blocked on a concrete prompt that needs the operator.
 *  - `idle` — nothing in progress. The default. */
export type ActivityStage =
  | 'implementing'
  | 'designing'
  | 'reviewing'
  | 'making-pr'
  | 'documenting'
  | 'testing'
  | 'debugging'
  | 'researching'
  | 'awaiting'
  | 'idle';

/** Live summary for a single terminal tab. */
export interface TabSummary {
  /** Terminal session id — matches `TermSession.id` / `TabInfo.sid`. */
  sid: string;
  /** Few-word title shown on the tab. */
  title: string;
  /** One sentence (<=140 chars) naming the context + purpose of the current
   *  work — distinct from the <=5-word `title`. Defaulted to `''` when the
   *  writer model declines or fails. */
  subtitle: string;
  /** Few-line "current context" shown in the hover popover. */
  contextLines: string[];
  /** One-line "what is happening now". */
  currentAction: string;
  /** Coarse state used to colour the card. Always present — the parser defaults
   *  it to `idle` when the model reply omits or garbles it. */
  state: TabState;
  /** Finer-grained work stage (distinct from `state`). Always present — defaults
   *  to `idle` when the model reply omits or garbles it. */
  activity: ActivityStage;
  /** When `state === 'awaiting'`, the one-line question or selection the tab is
   *  blocked on (e.g. "overwrite state.json? (y/n)"). Absent otherwise. */
  awaitingPrompt?: string;
  /** Provenance: the app `#handle` the tab's cwd belongs to, stored WITHOUT the
   *  leading `#` (the UI adds it). Absent when the cwd maps to no known app. */
  app?: string;
  /** Provenance: the worktree/branch directory name when the tab's cwd is under
   *  `<worktrees_path>/<branch>/<repo>/`. Absent for non-worktree cwds. */
  worktree?: string;
  /** Provenance: the conception projects whose README `branch:` matches this
   *  tab's `worktree`. Absent/empty when none match. */
  projects?: { slug: string; title: string }[];
  /** Epoch ms of the last update. */
  updatedAt: number;
  /** Bounded history of notable events for this tab, oldest first. */
  events: DashboardEvent[];
}

/** What the summarizer loop is doing right now. Surfaced so an idle-but-running
 *  engine (nothing to summarize yet) is distinguishable from a dead one.
 *  - `summarizing` — a cycle is in flight (the LLM call is running).
 *  - `waiting` — armed, tabs open, counting down to the next cycle (default
 *    resting state; with the activity gate on this is "waiting for activity").
 *  - `idle` — armed but no open terminal tabs to summarize.
 *  - `no-api-key` — enabled but no key, so summaries can't run. */
export type DashboardEnginePhase = 'summarizing' | 'waiting' | 'idle' | 'no-api-key';

/** Liveness of the summarizer loop, independent of whether any tab has a
 *  summary yet. Live-only: rebuilt each tick, never trusted from disk. */
export interface DashboardEngineStatus {
  /** Current loop phase. */
  phase: DashboardEnginePhase;
  /** Epoch ms when the next summarize cycle is due (`lastRunAt + interval`).
   *  At/under "now" means due imminently. Meaningless for `no-api-key`. */
  nextRunAt: number;
  /** Epoch ms of the last completed summarize cycle, 0 if none yet. */
  lastRunAt: number;
}

/** Full dashboard snapshot: the per-tab summaries plus live roster. */
export interface DashboardState {
  /** Epoch ms of the last engine cycle that produced this state. */
  updatedAt: number;
  /** Per-tab summaries, one per live tab the engine has produced a summary for.
   *  A tab with no readable output yet (or before the first summary cycle) is
   *  absent here but still present in `roster`. */
  tabs: TabSummary[];
  /** Every currently-open terminal tab, refreshed each engine tick. The renderer
   *  renders one card per entry: a tab present in `tabs` shows its rich summary,
   *  one that isn't shows a fallback row from its cmd/cwd — so no open tab is
   *  ever invisible. Live-only: reset to `[]` on load and rebuilt from the live
   *  session map each tick, never trusted from disk. */
  roster: TabInfo[];
  /** Bounded global history of notable cross-tab events, oldest first. */
  history: DashboardEvent[];
  /** Liveness of the summarizer loop (next-run ETA + current phase), so the
   *  pane shows it's alive even before any tab has a summary. Live-only: reset
   *  on load and rebuilt each tick. Absent only before the first tick. */
  engine?: DashboardEngineStatus;
  /** SIDs whose summary is being recomputed in the in-flight cycle (the LLM call
   *  is running for them). The renderer marks these cards with a small pulsing
   *  dot so an actively-refreshing tab reads as live; the card keeps its own
   *  state badge and colour. Empty between cycles. Live-only: never trusted from
   *  disk, rebuilt each tick. */
  summarizingSids?: string[];
  /** Last error from a summarization cycle (e.g. auth/model/network failure),
   *  surfaced in the Dashboard so a silent no-op is explainable. Absent when the
   *  last cycle's API calls all succeeded. */
  lastError?: string;
}

/** The per-tab summaries pushed each cycle — the lightweight payload that drives
 *  tab titles + hover popovers without re-shipping the whole `DashboardState`. */
export interface DashboardTabSummariesMessage {
  summaries: TabSummary[];
}

/** Raw on-disk dashboard config block — mirrors the `dashboard` zod schema in
 *  `main/config-schema.ts` (all fields optional). The engine resolves this into
 *  a `DashboardConfig` with defaults applied and the interval clamped. */
export interface DashboardSettings {
  enabled?: boolean;
  provider?: 'deepseek';
  apiKey?: string;
  /** OpenAI-compatible API base URL. Blank → the provider's built-in endpoint. */
  baseUrl?: string;
  /** Per-tab "card" model — the cheap, high-volume tier that extracts each tab's
   *  state + facts. Legacy single-tier configs that set only `model` get it as
   *  the card model. Default `deepseek-v4-flash`. */
  model?: string;
  /** "Writer" model — the richer tier that composes each card's one-sentence
   *  subtitle (the work's context + purpose) from the card facts and the tab's
   *  derived provenance. Default `deepseek-v4-pro`. */
  writerModel?: string;
  /** Whether the card model reasons. Default false: card work is mechanical
   *  state+fact extraction, where reasoning only adds latency (~3–5× slower). */
  cardReasoning?: boolean;
  /** Whether the writer model reasons. Default true: composing the per-tab
   *  subtitle is the one place reasoning measurably improves the wording. */
  writerReasoning?: boolean;
  /** Chars of recent tab output fed to the card model. Default 16000 — larger
   *  than the legacy 6000 because the cheap tier can afford a wider window. */
  cardInputChars?: number;
  intervalSec?: number;
  gateOnActivity?: boolean;
  historyLimit?: number;
}

/** Resolved dashboard config (defaults applied, interval clamped) used inside
 *  the main process. Carries the secret `apiKey`; never sent to the renderer. */
export interface DashboardConfig {
  enabled: boolean;
  provider: 'deepseek';
  apiKey?: string;
  /** OpenAI-compatible API base URL; undefined → the provider's built-in endpoint. */
  baseUrl?: string;
  /** Per-tab "card" model (cheap tier). */
  model: string;
  /** Cross-tab "writer" model (richer tier). */
  writerModel: string;
  /** Whether the card model reasons (default false). */
  cardReasoning: boolean;
  /** Whether the writer model reasons (default true). */
  writerReasoning: boolean;
  /** Chars of recent tab output fed to the card model. */
  cardInputChars: number;
  intervalSec: number;
  gateOnActivity: boolean;
  historyLimit: number;
}

/** What the renderer is allowed to see: the resolved config minus the raw key,
 *  plus a flag telling whether a key is stored (so the Dashboard pane can show
 *  an accurate "off" / "no key" / "waiting" empty state without the secret). */
export interface DashboardConfigView {
  enabled: boolean;
  provider: 'deepseek';
  hasApiKey: boolean;
  /** OpenAI-compatible API base URL; undefined → the provider's built-in endpoint. */
  baseUrl?: string;
  /** Per-tab "card" model (cheap tier). */
  model: string;
  /** Cross-tab "writer" model (richer tier). */
  writerModel: string;
  /** Whether the card model reasons. */
  cardReasoning: boolean;
  /** Whether the writer model reasons. */
  writerReasoning: boolean;
  /** Chars of recent tab output fed to the card model. */
  cardInputChars: number;
  intervalSec: number;
  gateOnActivity: boolean;
  historyLimit: number;
}
