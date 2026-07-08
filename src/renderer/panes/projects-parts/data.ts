import type { Project, Step, StepCounts, StepMarker } from '@shared/types';
import { KNOWN_STATUSES } from '@shared/types';
import { countSteps } from '@shared/projects';

export const MARKER_LABEL: Record<StepMarker, string> = {
  ' ': 'todo',
  '~': 'doing',
  x: 'done',
  '!': 'blocked',
  '-': 'dropped',
};

/** Click-toggle cycle for the in-card step button. Skips `!` (blocked) on
 * purpose — that state is set deliberately when the work is stuck, not
 * cycled through on every click. Keeps the toggle aligned with the
 * pre-`!` user habit: todo → doing → done → dropped → back to todo. */
const CLICK_CYCLE: readonly StepMarker[] = [' ', '~', 'x', '-'];

export const DRAG_MIME = 'application/x-condash-project-path';

export const UNKNOWN = '?';

/** Order of stacked sections on the Projects pane. `backlog` and `done`
 * render collapsed-by-default — heavy buckets the user usually skips past. */
export const PROJECT_SECTION_ORDER = ['now', 'review', 'later', 'backlog', 'done'] as const;
export const COLLAPSED_BY_DEFAULT = new Set<string>(['backlog', 'done']);

/** localStorage key for the per-status collapse map. Stores a sparse object
 * `{ status: boolean }` — true means user-expanded, false means user-collapsed.
 * Statuses missing from the map fall back to `COLLAPSED_BY_DEFAULT`. */
const COLLAPSE_STORAGE_KEY = 'condash:projects:section-collapse';

export function readCollapseMap(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'boolean') out[k] = v;
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

export function writeCollapseEntry(status: string, expanded: boolean): void {
  try {
    const current = readCollapseMap();
    current[status] = expanded;
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(current));
  } catch {
    // localStorage unavailable / quota — best-effort, drop silently.
  }
}

/** First 10 chars of a project slug = its creation date in ISO. The CLI's
 * regex (`^\d{4}-\d{2}-\d{2}-…`) makes this slice safe for every persisted
 * project, so callers never need to validate. */
function slugDate(slug: string): string {
  return slug.slice(0, 10);
}

/** Date displayed on the card's meta row. Prefers `closedAt` for done items
 * (the "when did this finish" question matters more than "when was it
 * created" once a project is shipped), falls back to slug date for both
 * non-done items and the long tail of done items closed before the
 * `## Timeline` convention took hold. */
function cardDate(p: Project): string {
  if (p.status === 'done' && p.closedAt) return p.closedAt;
  return slugDate(p.slug);
}

/** First date for the card / popup timeline header. Always the slug's
 * creation date — the project's start is canonical and not subject to
 * timeline edits. */
export function firstDate(p: Project): string {
  return slugDate(p.slug);
}

/** Last date for the card / popup timeline header. Prefers the precomputed
 * `lastActivity` scalar — the resident list carries it but not the full
 * `timeline[]` (G1 projection). Falls back to scanning `timeline` for a full
 * project that predates the scalar (e.g. a hand-built object), then to the slug
 * date when there's no timeline at all (legacy items pre-template). */
export function lastDate(p: Project): string {
  if (p.lastActivity) return p.lastActivity;
  if (p.timeline && p.timeline.length > 0) {
    let max = p.timeline[0].date;
    for (const e of p.timeline) {
      if (e.date > max) max = e.date;
    }
    return max;
  }
  return slugDate(p.slug);
}

/** Render the first/last range as a single date when they coincide, an
 * en-dash range otherwise. Drives both the card meta row and the popup
 * Timeline pane's collapsed header. */
export function dateRangeLabel(p: Project): string {
  const first = firstDate(p);
  const last = lastDate(p);
  return first === last ? first : `${first} – ${last}`;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface DoneSubgroup {
  /** Storage / display month, ISO `YYYY-MM`. */
  month: string;
  projects: Project[];
}

export interface DoneGrouping {
  /** Done projects whose effective close date is within the last 7 days.
   * Sliding window — these projects are excluded from `byMonth` so each
   * project appears in exactly one subgroup. Empty array when nothing
   * closed recently. */
  recent: Project[];
  /** Per-close-month subgroups, descending. Empty months omitted. Excludes
   * projects already shown in `recent`. */
  byMonth: DoneSubgroup[];
  /** The month that should be expanded by default on first render: the
   * current calendar month if it has any done items, otherwise the most
   * recent month that does, otherwise null. User toggles override. */
  defaultExpandMonth: string | null;
}

/** Split a Done bucket into the Recent window + per-close-month subgroups.
 * `today` is injected so tests can pin time without mocking Date. */
export function groupDone(done: readonly Project[], today: string): DoneGrouping {
  const sevenDaysAgo = (() => {
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  })();
  const recent: Project[] = [];
  const byMonthMap = new Map<string, Project[]>();
  for (const p of done) {
    const date = cardDate(p);
    if (date >= sevenDaysAgo) {
      recent.push(p);
      continue;
    }
    const month = date.slice(0, 7);
    let bucket = byMonthMap.get(month);
    if (!bucket) {
      bucket = [];
      byMonthMap.set(month, bucket);
    }
    bucket.push(p);
  }
  const sortDesc = (a: Project, b: Project): number => {
    const da = cardDate(a);
    const db = cardDate(b);
    if (da !== db) return da < db ? 1 : -1;
    return a.slug < b.slug ? 1 : a.slug > b.slug ? -1 : 0;
  };
  recent.sort(sortDesc);
  for (const list of byMonthMap.values()) list.sort(sortDesc);
  const byMonth: DoneSubgroup[] = [...byMonthMap.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([month, projects]) => ({ month, projects }));
  const currentMonth = today.slice(0, 7);
  const defaultExpandMonth = byMonthMap.has(currentMonth)
    ? currentMonth
    : (byMonth[0]?.month ?? null);
  return { recent, byMonth, defaultExpandMonth };
}

export type Group = { status: string; items: Project[] };

export function nextMarker(current: StepMarker): StepMarker {
  const idx = CLICK_CYCLE.indexOf(current);
  // `!` is not in the cycle; clicking on a blocked step advances it back to
  // todo so the user can re-take ownership of the workflow.
  if (idx === -1) return CLICK_CYCLE[0];
  return CLICK_CYCLE[(idx + 1) % CLICK_CYCLE.length];
}

export function applyStepMarker(
  items: Project[],
  path: string,
  lineIndex: number,
  marker: StepMarker,
): Project[] {
  return items.map((p) => {
    if (p.path !== path) return p;
    const steps = p.steps.map((s) => (s.lineIndex === lineIndex ? { ...s, marker } : s));
    return { ...p, steps, stepCounts: countSteps(steps) };
  });
}

export function applyStatus(items: Project[], path: string, status: string): Project[] {
  return items.map((p) => (p.path === path ? { ...p, status } : p));
}

export function hasSteps(c: StepCounts): boolean {
  return c.todo + c.doing + c.done + c.blocked + c.dropped > 0;
}

/** True when no step is still open (todo, doing, or blocked). Resolved-by-drop
 * counts as "done enough" to dim the expander — the bar reaches 100%
 * the moment every step has been decided one way or the other. Blocked
 * steps keep the project incomplete because they're surfacing a problem
 * that still needs a decision. */
export function isStepCountsComplete(c: StepCounts): boolean {
  const total = c.todo + c.doing + c.done + c.blocked + c.dropped;
  return total > 0 && c.todo === 0 && c.doing === 0 && c.blocked === 0;
}

/** First *actionable* step — skips both `x` (done) and `-` (dropped/abandoned),
 * matching how `countSteps` treats `-` as settled. Returns undefined if every
 * step has been decided one way or the other. */
export function nextOpenStep(item: Project): Step | undefined {
  return item.steps.find((s) => s.marker !== 'x' && s.marker !== '-');
}

export function groupByStatus(items: Project[]): Map<string, Project[]> {
  const buckets = new Map<string, Project[]>();
  for (const status of KNOWN_STATUSES) buckets.set(status, []);
  buckets.set(UNKNOWN, []);

  for (const item of items) {
    const key = (KNOWN_STATUSES as readonly string[]).includes(item.status) ? item.status : UNKNOWN;
    buckets.get(key)!.push(item);
  }
  // Sort each bucket most-recent-first. Slugs are `YYYY-MM-DD-…` so descending
  // alpha sort is equivalent to descending date.
  for (const list of buckets.values()) {
    list.sort((a, b) => (a.slug < b.slug ? 1 : a.slug > b.slug ? -1 : 0));
  }
  return buckets;
}

/** Shallow reference-equality on two project lists — same length, same objects
 * in the same order. `groupByStatus` rebuilds each bucket array on every
 * projects() change but reuses the unchanged Project objects, so this is enough
 * to tell a genuinely-changed bucket from a merely-rebuilt one. */
function sameProjectList(a: readonly Project[], b: readonly Project[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Materialise the ordered `Group[]` the Projects pane renders, iterating the
 * stable `PROJECT_SECTION_ORDER`. Pass the previous result as `prev` to keep
 * object identity for any status whose item list is unchanged (R2): the pane's
 * `<For>` is reference-keyed, so a reused `Group` object means its `GroupBlock`
 * (and every card + the synchronous localStorage collapse read it does on
 * mount) survives untouched when an unrelated status changes. Called with no
 * `prev` it allocates fresh groups, exactly as before.
 */
export function projectsTabGroups(
  buckets: Map<string, Project[]>,
  prev?: readonly Group[],
): Group[] {
  const prevByStatus = prev ? new Map(prev.map((g) => [g.status, g])) : undefined;
  const reuseOrBuild = (status: string, items: Project[]): Group => {
    const previous = prevByStatus?.get(status);
    return previous && sameProjectList(previous.items, items) ? previous : { status, items };
  };
  const out: Group[] = [];
  for (const status of PROJECT_SECTION_ORDER) {
    out.push(reuseOrBuild(status, buckets.get(status) ?? []));
  }
  const unknown = buckets.get(UNKNOWN) ?? [];
  if (unknown.length > 0) out.push(reuseOrBuild(UNKNOWN, unknown));
  return out;
}

export function markerClass(m: StepMarker): string {
  if (m === ' ') return 'todo';
  if (m === '~') return 'doing';
  if (m === 'x') return 'done';
  if (m === '!') return 'blocked';
  return 'dropped';
}
