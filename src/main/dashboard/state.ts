import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { condashDir } from '../condash-dir';
import { atomicWrite } from '../atomic-write';
import type { DashboardEvent, DashboardState, TabSummary } from '../../shared/types';

/** Subdirectory under `.condash/` that holds the dashboard's persisted state. */
const DASHBOARD_SUBDIR = 'dashboard';
const STATE_FILENAME = 'state.json';

/** Absolute path to `<conception>/.condash/dashboard/state.json`. */
export function dashboardStatePath(conceptionPath: string): string {
  return join(condashDir(conceptionPath), DASHBOARD_SUBDIR, STATE_FILENAME);
}

/** A fresh, empty dashboard state. */
export function emptyDashboardState(updatedAt: number): DashboardState {
  return { updatedAt, overview: [], tabs: [], roster: [], history: [] };
}

function isEvent(value: unknown): value is DashboardEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DashboardEvent).at === 'number' &&
    typeof (value as DashboardEvent).text === 'string'
  );
}

function isTabSummary(value: unknown): value is TabSummary {
  if (typeof value !== 'object' || value === null) return false;
  const tab = value as TabSummary;
  return (
    typeof tab.sid === 'string' &&
    typeof tab.title === 'string' &&
    Array.isArray(tab.contextLines) &&
    typeof tab.currentAction === 'string' &&
    typeof tab.updatedAt === 'number' &&
    Array.isArray(tab.events)
  );
}

/** Defensively coerce a parsed JSON blob into a `DashboardState`, dropping any
 *  malformed parts rather than rejecting the whole file. Returns null when the
 *  shape is not recognisably a dashboard state. */
function coerceState(parsed: unknown): DashboardState | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const raw = parsed as Partial<DashboardState>;
  if (!Array.isArray(raw.tabs)) return null;
  return {
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    overview: Array.isArray(raw.overview) ? raw.overview.filter((l) => typeof l === 'string') : [],
    history: Array.isArray(raw.history) ? raw.history.filter(isEvent) : [],
    tabs: raw.tabs
      .filter(isTabSummary)
      .map((tab) => ({ ...tab, events: tab.events.filter(isEvent) })),
    // `roster` is live data (the currently-open tabs); a persisted copy is stale
    // the moment the app reopens, so always start empty and let the first tick
    // rebuild it from the live session map.
    roster: [],
    // `engine` is the live loop's status; a persisted copy is meaningless once
    // the app restarts, so drop it and let the first tick re-establish it.
  };
}

/**
 * Load the persisted dashboard state for a conception. Returns null when no
 * state file exists yet or it can't be read/parsed (a corrupt file is treated
 * as "no state" rather than surfacing an error — the engine just starts fresh).
 */
export async function loadDashboardState(conceptionPath: string): Promise<DashboardState | null> {
  try {
    const text = await readFile(dashboardStatePath(conceptionPath), 'utf8');
    return coerceState(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Persist the dashboard state atomically. */
export async function saveDashboardState(
  conceptionPath: string,
  state: DashboardState,
): Promise<void> {
  const path = dashboardStatePath(conceptionPath);
  // `.condash/dashboard/` is created lazily on the first save and never
  // scaffolded elsewhere, so on a fresh conception it doesn't exist yet.
  // `atomicWrite` needs the parent dir present (same convention as the config
  // writers) — without this mkdir every save throws ENOENT, which the engine's
  // catch swallows, so the dashboard never persists and never pushes a summary.
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, JSON.stringify(state, null, 2) + '\n');
}

/** Clamp every bounded array (global history + each tab's events) to the last
 *  `historyLimit` entries, keeping the most recent. Mutates a returned copy. */
export function pruneDashboardState(state: DashboardState, historyLimit: number): DashboardState {
  const limit = Math.max(0, historyLimit);
  // `slice(-0)` returns the whole array, so guard the zero case explicitly.
  const tail = <T>(items: T[]): T[] =>
    limit === 0 ? [] : items.length > limit ? items.slice(-limit) : items;
  return {
    ...state,
    history: tail(state.history),
    tabs: state.tabs.map((tab) => ({ ...tab, events: tail(tab.events) })),
  };
}
