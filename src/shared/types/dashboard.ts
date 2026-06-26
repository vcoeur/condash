// Live terminal-tab summarization ("Dashboard"). The main-process engine
// periodically summarizes the active terminal tabs with the pi coding-agent SDK
// and pushes the result to the renderer; these shapes are the wire contract for
// that data plus the resolved (defaulted) config the engine and Settings UI
// share. The raw on-disk config shape lives in `main/config-schema.ts`
// (`dashboard` block); these are the runtime/IPC views of it.

/** One past event in a tab's (or the global) rolling history. */
export interface DashboardEvent {
  /** Epoch ms when the event was recorded. */
  at: number;
  /** One-line description of what happened. */
  text: string;
}

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
  /** Epoch ms of the last update. */
  updatedAt: number;
  /** Bounded history of notable events for this tab, oldest first. */
  events: DashboardEvent[];
}

/** Full dashboard snapshot: the cross-tab narrative plus per-tab summaries. */
export interface DashboardState {
  /** Epoch ms of the last engine cycle that produced this state. */
  updatedAt: number;
  /** Cross-tab "what's going on" narrative — a few lines, referencing tabs. */
  overview: string[];
  /** Per-tab summaries, one per live tab the engine has seen. */
  tabs: TabSummary[];
  /** Bounded global history of notable cross-tab events, oldest first. */
  history: DashboardEvent[];
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
