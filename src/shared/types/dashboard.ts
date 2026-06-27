// Live terminal-tab summarization ("Dashboard"). The main-process engine
// periodically summarizes the active terminal tabs with the pi coding-agent SDK
// and pushes the result to the renderer; these shapes are the wire contract for
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

/** Live summary for a single terminal tab. */
export interface TabSummary {
  /** Terminal session id — matches `TermSession.id` / `TabInfo.sid`. */
  sid: string;
  /** Few-word title shown on the tab. */
  title: string;
  /** Few-line "current context" shown in the hover popover. */
  contextLines: string[];
  /** One-line "what is happening now". */
  currentAction: string;
  /** Coarse state used to colour the card. Always present — the parser defaults
   *  it to `idle` when the model reply omits or garbles it. */
  state: TabState;
  /** When `state === 'awaiting'`, the one-line question or selection the tab is
   *  blocked on (e.g. "overwrite state.json? (y/n)"). Absent otherwise. */
  awaitingPrompt?: string;
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

/** Full dashboard snapshot: the cross-tab narrative plus per-tab summaries. */
export interface DashboardState {
  /** Epoch ms of the last engine cycle that produced this state. */
  updatedAt: number;
  /** Cross-tab "what's going on" narrative — a few lines, referencing tabs. */
  overview: string[];
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
  model?: string;
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
  model: string;
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
  model: string;
  intervalSec: number;
  gateOnActivity: boolean;
  historyLimit: number;
}
