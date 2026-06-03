/**
 * Pure logic for the Tasks pane — types, run-mode/timeout choices, and the
 * cadence/draft/elapsed helpers extracted from `tasks.tsx`. Dependency-free
 * (no Solid, no `window.condash`) so it unit-tests without the renderer graph.
 */

import type { Agent, Project, RunMode } from '@shared/types';
import type { TaskDef } from '@shared/tasks';

/** One app the `{APP}` picker can select. `alias` is the `#<name>` form. */
export interface AppOption {
  alias: string;
  name: string;
  path: string;
}

/** Editor draft. `editingSlug` is null when creating, the prior slug when
 *  editing (so a slug change becomes a rename). `slugDirty` tracks whether the
 *  user has hand-edited the slug, so name-driven auto-slugging stops once they
 *  take over. */
export interface Draft {
  slug: string;
  slugDirty: boolean;
  name: string;
  agent: string;
  prompt: string;
  editingSlug: string | null;
  /** Free-text schedule cadence (`<n>` + `s`/`m`/`h`/`d`, e.g. `5m`/`2h`/`1d`);
   *  empty = not scheduled (capability 1). Parsed via `parseCadence`; the editor
   *  shows the computed interval beside the field. Persisted to
   *  `taskConfig[slug]` in settings.json, not task.json. */
  schedule: string;
  /** Run-timeout cadence for scheduled runs (`1m`…`1h`); the headless run is
   *  killed + discarded once it elapses. Only persisted when scheduled. */
  timeout: string;
  /** Per-task default for routing manual runs out of `.condash/logs/`
   *  (capability 4). Persisted alongside `schedule`. */
  excludeFromLogs: boolean;
  /** Per-task default run mode (a `promptFlags` agent only): `interactive` →
   *  `--prompt` (session stays open), `oneshot` → `--run` (runs and exits).
   *  Overridable per run in the run popup. Persisted alongside `schedule`. */
  runMode: RunMode;
  /** Opt-in to the scheduler's per-tab growth gate: when set, a scheduled tick
   *  is skipped unless a tab produced new output since the last run. Only
   *  persisted (and only meaningful) when scheduled. */
  gateOnUpdatedTabs: boolean;
}

/** Fill state: the read task plus the picker selections and per-marker field
 *  values that feed substitution. `fields` holds only the plain (non-reserved)
 *  markers — the `{APP_*}` / `{PROJECT_*}` families come from the pickers.
 *  `agent` is the run-time agent id, seeded from the task's stored `def.agent`
 *  but overridable in the run popup. */
export interface FillState {
  slug: string;
  def: TaskDef;
  agent: string;
  app: AppOption | null;
  project: Project | null;
  fields: Record<string, string>;
  /** condash-provided substitutions (e.g. `{TABS}`), fetched once when the
   *  fill opens — never user-editable. */
  provided: Record<string, string>;
  /** Effective per-run "route this run out of the logs" flag (capability 4),
   *  seeded from the task's `excludeFromLogs` default and toggleable here. */
  excludeFromLogs: boolean;
  /** Effective per-run mode, seeded from the task's `runMode` default and
   *  switchable here (interactive `--prompt` vs one-shot `--run`). */
  runMode: RunMode;
}

/** Options carried alongside a task run launch. */
export interface RunOptions {
  taskSlug: string;
  excludeFromLogs: boolean;
  runMode: RunMode;
}

/** Run-mode choices offered in the editor + run popup. `interactive` keeps the
 *  session open (agedum `--prompt`); `oneshot` runs once and exits (`--run`) —
 *  the mode a scheduled task wants so its headless run exits cleanly. */
export const RUN_MODE_CHOICES: ReadonlyArray<{ value: RunMode; label: string }> = [
  { value: 'interactive', label: 'Interactive (--prompt)' },
  { value: 'oneshot', label: 'One-shot, then exit (--run)' },
];

/** Fixed run-timeout choices for scheduled runs. Keep these ≤ the schedule
 *  interval: a non-exiting agent holds the single-flight slot until the timeout
 *  kills it. */
export const TIMEOUT_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: '1m', label: '1 minute' },
  { value: '5m', label: '5 minutes' },
  { value: '10m', label: '10 minutes' },
  { value: '30m', label: '30 minutes' },
  { value: '1h', label: '1 hour' },
];

/** Default run timeout when a task is scheduled but none is chosen — matches
 *  the scheduler's built-in default. */
export const DEFAULT_TIMEOUT = '10m';

/** Render a parsed cadence (ms) as a compact, normalised interval for the live
 *  readout beside the free-text schedule field: `300000` → `5m`, `5400000` →
 *  `1h 30m`, `604800000` → `7d`. Confirms the typed cadence parsed and folds an
 *  odd input like `90m` into `1h 30m`; an unparseable value never reaches here
 *  (the field flags it instead). */
export function formatCadence(ms: number): string {
  const units: ReadonlyArray<readonly [number, string]> = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
    [1_000, 's'],
  ];
  let rest = ms;
  const parts: string[] = [];
  for (const [size, label] of units) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(`${n}${label}`);
      rest -= n * size;
    }
  }
  return parts.join(' ');
}

/** `123456` ms → `2m 03s` / `1h 04m`. Coarse — the row only needs a sense of
 *  how long a run has been alive. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** Last `max` chars of `text`, prefixed with `…` when truncated. */
export function tailText(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return `…${text.slice(text.length - max)}`;
}

/** Build a blank editor draft, defaulting the agent to the first
 *  prompt-seedable one — tasks hand the filled prompt to the agent via
 *  `--prompt` (see the agent picker's disabled rows), so an agent without
 *  `promptFlags` can't carry one. */
export function blankDraft(agents: readonly Agent[]): Draft {
  const seedable = agents.find((a) => a.promptFlags === true) ?? agents[0];
  return {
    slug: '',
    slugDirty: false,
    name: '',
    agent: seedable?.id ?? '',
    prompt: '',
    editingSlug: null,
    schedule: '',
    timeout: DEFAULT_TIMEOUT,
    excludeFromLogs: false,
    runMode: 'interactive',
    gateOnUpdatedTabs: false,
  };
}
