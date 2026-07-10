/**
 * Types for the auto-sync engine — a GUI-driven periodic committer that runs
 * `condash sync run` on a timer while a conception is open. The heavy lifting
 * (lock, quiet period, per-item/knowledge/meta grouping, push-retry) lives in
 * `src/main/sync/run.ts`; the engine is only the clock around it.
 */

/** Raw on-disk `autoSync` config block — mirrors the zod schema in
 *  `main/config-schema.ts` (all fields optional). Resolved into an
 *  {@link AutoSyncConfig} with defaults applied and the numbers clamped. */
export interface AutoSyncSettings {
  /** Master switch. Off by default — the engine ticks but never commits. */
  enabled?: boolean;
  /** How often to sweep and commit, in minutes. Clamped to 1–120 at read time. */
  intervalMinutes?: number;
  /** Files edited within this many seconds are left for the next sweep — the
   *  mid-edit guard. Clamped to 0–3600 at read time. */
  quietPeriodSeconds?: number;
  /** Push after committing. Default true. */
  push?: boolean;
}

/** Resolved auto-sync config (defaults applied, numbers clamped), used inside
 *  the main process. */
export interface AutoSyncConfig {
  enabled: boolean;
  intervalMinutes: number;
  quietPeriodSeconds: number;
  push: boolean;
}

/** Where the engine is in its cycle — drives the Settings status line. */
export type AutoSyncPhase =
  /** Not enabled — the engine is armed but idle. */
  | 'disabled'
  /** Enabled and waiting for the next due time. */
  | 'idle'
  /** A sweep is in progress. */
  | 'syncing'
  /** The last sweep threw (mid-merge/conflict, or an unexpected error). */
  | 'error';

/** What the last completed sweep did — shown in the Settings status line. */
export interface AutoSyncLastResult {
  /** Number of commits the sweep produced (0 when nothing had settled). */
  committed: number;
  /** Whether the branch was pushed. */
  pushed: boolean;
  /** A skipped/rejected push message, else null. */
  pushError: string | null;
}

/** Renderer-safe snapshot of the engine, pushed on every state change. */
export interface AutoSyncStatus {
  phase: AutoSyncPhase;
  enabled: boolean;
  intervalMinutes: number;
  /** Epoch ms of the last completed sweep, or null if none yet this session. */
  lastRunAt: number | null;
  /** Epoch ms the next sweep is due, or null when disabled. */
  nextRunAt: number | null;
  lastResult: AutoSyncLastResult | null;
  /** A refusal/error from the last sweep (mid-merge, conflict, …), else null. */
  lastError: string | null;
}
