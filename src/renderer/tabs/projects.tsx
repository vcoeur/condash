import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import type {
  Project,
  SearchHit,
  SearchResults,
  SearchSnippet,
  Step,
  StepCounts,
  StepMarker,
} from '@shared/types';
import { KNOWN_STATUSES, STEP_MARKERS } from '@shared/types';
import { countSteps } from '@shared/projects';
import { TerminalIcon } from '../icons';
import { HighlightedText } from '../search/highlight';
import { groupHits, type ProjectGroup } from '../search/grouping';
import './projects-tab.css';

const EMPTY_SEARCH_RESULTS: SearchResults = {
  hits: [],
  terms: [],
  totalBeforeCap: 0,
  truncated: false,
};

/* StepIcon — single shape vocabulary for the four step states. Drawn as a
 * 16×16 SVG so the same component renders the card's next-step marker, the
 * expanded step list in the card, and the popup's step list. Colour comes
 * from `currentColor` so the per-state color tokens cascade through.
 *
 *   ' ' (todo)    → outlined rounded square
 *   '~' (doing)   → outlined square + concentric inner filled square
 *   'x' (done)    → filled square with negative-space check mark
 *   '-' (dropped) → outlined square crossed out */
export function StepIcon(props: { marker: StepMarker }) {
  if (props.marker === '~') {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="2.5" y="2.5" width="11" height="11" rx="2.25" />
        <rect
          x="5.75"
          y="5.75"
          width="4.5"
          height="4.5"
          rx="0.75"
          fill="currentColor"
          stroke="none"
        />
      </svg>
    );
  }
  if (props.marker === 'x') {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect
          x="2.5"
          y="2.5"
          width="11"
          height="11"
          rx="2.25"
          fill="currentColor"
          stroke="currentColor"
        />
        <path d="M5.25 8.25l2 2L10.75 6.5" stroke="var(--bg-elevated)" stroke-width="1.8" />
      </svg>
    );
  }
  if (props.marker === '-') {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="2.5" y="2.5" width="11" height="11" rx="2.25" />
        <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.25" />
    </svg>
  );
}

const MARKER_LABEL: Record<StepMarker, string> = {
  ' ': 'todo',
  '~': 'doing',
  x: 'done',
  '-': 'dropped',
};

export const DRAG_MIME = 'application/x-condash-project-path';

const UNKNOWN = '?';

/** Order of stacked sections on the Projects tab. `backlog` and `done`
 * render collapsed-by-default — heavy buckets the user usually skips past. */
const PROJECT_SECTION_ORDER = ['now', 'review', 'later', 'backlog', 'done'] as const;
const COLLAPSED_BY_DEFAULT = new Set<string>(['backlog', 'done']);

/** localStorage key for the per-status collapse map. Stores a sparse object
 * `{ status: boolean }` — true means user-expanded, false means user-collapsed.
 * Statuses missing from the map fall back to `COLLAPSED_BY_DEFAULT`. */
const COLLAPSE_STORAGE_KEY = 'condash:projects:section-collapse';

function readCollapseMap(): Record<string, boolean> {
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

function writeCollapseEntry(status: string, expanded: boolean): void {
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

/** Last date for the card / popup timeline header. Most recent entry's
 * date in `## Timeline`; falls back to the slug date when the timeline
 * is empty (legacy items pre-template). */
export function lastDate(p: Project): string {
  if (!p.timeline || p.timeline.length === 0) return slugDate(p.slug);
  let max = p.timeline[0].date;
  for (const e of p.timeline) {
    if (e.date > max) max = e.date;
  }
  return max;
}

/** Render the first/last range as a single date when they coincide, an
 * en-dash range otherwise. Drives both the card meta row and the popup
 * Timeline pane's collapsed header. */
export function dateRangeLabel(p: Project): string {
  const first = firstDate(p);
  const last = lastDate(p);
  return first === last ? first : `${first} – ${last}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface DoneSubgroup {
  /** Storage / display month, ISO `YYYY-MM`. */
  month: string;
  projects: Project[];
}

export interface DoneGrouping {
  /** Done projects whose effective close date is within the last 7 days.
   * Sliding window — these projects also appear in their own month subgroup
   * below, on purpose. Empty array when nothing closed recently. */
  recent: Project[];
  /** Per-close-month subgroups, descending. Empty months omitted. */
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
  const recent = done.filter((p) => cardDate(p) >= sevenDaysAgo);
  const byMonthMap = new Map<string, Project[]>();
  for (const p of done) {
    const month = cardDate(p).slice(0, 7);
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
  const idx = STEP_MARKERS.indexOf(current);
  return STEP_MARKERS[(idx + 1) % STEP_MARKERS.length];
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

function hasSteps(c: StepCounts): boolean {
  return c.todo + c.doing + c.done + c.dropped > 0;
}

/** True when no step is still open (todo or doing). Resolved-by-drop
 * counts as "done enough" to dim the expander — the bar reaches 100%
 * the moment every step has been decided one way or the other. */
function isStepCountsComplete(c: StepCounts): boolean {
  const total = c.todo + c.doing + c.done + c.dropped;
  return total > 0 && c.todo === 0 && c.doing === 0;
}

/** First step whose marker is not 'x' (done). Returns undefined if every step
 * is done — the card body collapses in that case. */
function nextOpenStep(item: Project): Step | undefined {
  return item.steps.find((s) => s.marker !== 'x');
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

function projectsTabGroups(buckets: Map<string, Project[]>): Group[] {
  const out: Group[] = [];
  for (const status of PROJECT_SECTION_ORDER) {
    out.push({ status, items: buckets.get(status) ?? [] });
  }
  const unknown = buckets.get(UNKNOWN) ?? [];
  if (unknown.length > 0) out.push({ status: UNKNOWN, items: unknown });
  return out;
}

function markerClass(m: StepMarker): string {
  if (m === ' ') return 'todo';
  if (m === '~') return 'doing';
  if (m === 'x') return 'done';
  return 'dropped';
}

/* Step progress — both done and dropped count as "resolved" so the bar
 * fills when every step has been decided one way or the other. The X/Y
 * text uses the same numerator (done + dropped). Reaches 100% when no
 * todo or doing steps remain, even if some were dropped along the way. */
function StepProgress(props: { counts: StepCounts }) {
  const total = (): number =>
    props.counts.todo + props.counts.doing + props.counts.done + props.counts.dropped;
  const resolved = (): number => props.counts.done + props.counts.dropped;
  const ratio = (): number => {
    const t = total();
    return t === 0 ? 0 : Math.min(1, resolved() / t);
  };
  const title = (): string =>
    `${props.counts.todo} todo, ${props.counts.doing} doing, ${props.counts.done} done, ${props.counts.dropped} dropped`;
  return (
    <span class="step-progress-inner" title={title()}>
      <span class="progress-track">
        <span class="progress-fill" style={{ width: `${ratio() * 100}%` }} />
      </span>
      <span class="progress-text">
        {resolved()}/{total()}
      </span>
    </span>
  );
}

/* Icon system — Projects tab.
 *
 * All icons share a 16×16 viewBox, currentColor stroke, round caps and joins,
 * and a duotone accent (currentColor at fill-opacity 0.16-0.22) inside the
 * stroked silhouette. Stroke weights come from CSS (.title-kind svg vs .meta
 * vs .row-action) so the icons read consistently in every container.
 *
 * Each icon is hand-tuned for its meaning rather than being a stock library
 * glyph — see the comments above each definition. */

const KIND_ICON: Record<string, () => any> = {
  // Project — gem-cut diamond outline with a soft horizontal facet line
  // and a small filled core. Reads as "waypoint with depth" rather than
  // a flat rhombus. Leftmost path point at viewBox x=2.5 to align with
  // the step icon's rect (also x=2.5) and the other kind icons.
  project: () => (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.5L13.5 8 8 13.5 2.5 8z" />
      <path d="M5 8h6" stroke-opacity="0.45" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  ),
  // Incident — alert triangle with a soft duotone wash plus a clean
  // exclamation glyph (line + dot). Leftmost path point at x=2.5 (base's
  // bottom-left) to match the rest of the icon set.
  incident: () => (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M8 3L13.5 13.5h-11z" fill="currentColor" fill-opacity="0.18" stroke="currentColor" />
      <path d="M8 6.75v3" />
      <circle cx="8" cy="11.5" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  ),
  // Document — page outline with an elegant filled corner-fold (duotone
  // triangle) and two text lines, the second shorter for natural text
  // rhythm. Pretty in a literary, archival way. Leftmost path point
  // at x=2.5, matching the rest of the icon set.
  document: () => (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 2h6L12 5.5v9H2.5z" />
      <path d="M8.5 2L12 5.5h-3.5z" fill="currentColor" fill-opacity="0.28" stroke="currentColor" />
      <path d="M4.75 9h4.5M4.75 11.5h2.75" />
    </svg>
  ),
};

function KindIcon(props: { kind: string }) {
  const Icon = KIND_ICON[props.kind];
  if (!Icon) return null;
  return <Icon />;
}

const KIND_LABEL: Record<string, string> = {
  project: 'Project',
  incident: 'Incident',
  document: 'Document',
};

/* Kind glyph — small tinted-tile icon that marks a card or modal with
 * its kind (project / incident / document). No text label: the icon
 * carries the meaning (helped by the `aria-label` and `title` for screen
 * readers and tooltips). Sits at the start of the title in cards and
 * inline in the popup's metadata row. */
export function KindGlyph(props: { kind: string }) {
  if (!KIND_ICON[props.kind]) return null;
  return (
    <span
      class="kind-glyph"
      data-kind={props.kind}
      title={KIND_LABEL[props.kind]}
      aria-label={KIND_LABEL[props.kind]}
    >
      <KindIcon kind={props.kind} />
    </span>
  );
}

// New note — page silhouette with a small detached "+" glyph in the top-
// right corner. Detached (rather than centred-on-page) so it reads as
// "add a note" rather than "new file" — and so it doesn't collide with
// the document kind glyph used elsewhere on the card.
export function NewNoteIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="1.5" y="3.25" width="8.5" height="11" rx="1.25" />
      <path d="M3.5 6.5h4.5M3.5 9h4.5M3.5 11.5h2.5" />
      <path d="M12.5 2.5v3.5M10.75 4.25h3.5" stroke-width="1.8" />
    </svg>
  );
}

// Unknown-status warning — circle with a duotone wash, a bold short
// vertical bar, and a slightly larger dot below. Reads cleanly at 12 px.
function WarnIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" fill="currentColor" fill-opacity="0.14" />
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.75v3.75" />
      <circle cx="8" cy="11.25" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ProjectsView(props: {
  buckets: Map<string, Project[]>;
  /** Live search-input value, owned by the toolbar. Debounced internally
   * to a `query` signal that drives the actual backend fetch. */
  searchInput: string;
  onOpen: (project: Project) => void;
  onToggleStep: (project: Project, step: Step) => void;
  onDropProject: (path: string, newStatus: string) => void;
  onWorkOn: (project: Project) => void;
  /** Open the "+ New project" modal. Rendered as a top-of-tab button when
   * the user isn't searching. Optional so consumers that don't expose the
   * create flow keep working unchanged. */
  onNewProject?: () => void;
}) {
  const [query, setQuery] = createSignal('');
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Debounce the toolbar-owned input value into a local query signal so
  // we don't fire a fetch on every keystroke.
  createEffect(() => {
    const value = props.searchInput;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => setQuery(value), 200);
  });
  onCleanup(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
  });

  // Empty query → render the existing status-grouped view. Non-empty
  // query → route to the global-search backend so the user gets the same
  // ranked AND/phrase semantics, region weighting, and snippet highlights
  // as the ⌘K modal — restricted to project-side hits.
  //
  // Using a manual signal-based fetch (not createResource) on purpose: the
  // parent Suspense boundary in main.tsx would otherwise catch every
  // re-fetch and unmount this view + the input on each keystroke. Manual
  // signals keep the input mounted so focus survives typing.
  const [searchResults, setSearchResults] = createSignal<SearchResults>(EMPTY_SEARCH_RESULTS);
  const [searching, setSearching] = createSignal(false);

  createEffect(() => {
    const q = query();
    if (q.trim().length === 0) {
      setSearchResults(EMPTY_SEARCH_RESULTS);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    void window.condash.search(q).then((r) => {
      if (cancelled) return;
      setSearchResults(r);
      setSearching(false);
    });
    onCleanup(() => {
      cancelled = true;
    });
  });

  /** Lookup map: absolute project directory path → loaded Project. Drives
   * mapping from search-result project groups (which know `projectPath`,
   * the directory) back to the rich Project object the cards render from.
   * `Project.path` points at the README.md, so we strip the filename to
   * key by the project dir — that matches how the search backend reports
   * `hit.projectPath`. */
  const projectsByPath = createMemo<Map<string, Project>>(() => {
    const out = new Map<string, Project>();
    for (const items of props.buckets.values()) {
      for (const p of items) {
        const dir = p.path.replace(/\/README\.md$/i, '');
        out.set(dir, p);
      }
    }
    return out;
  });

  const projectGroups = createMemo<ProjectGroup[]>(() => {
    const grouped = groupHits(searchResults().hits);
    return grouped.projects;
  });

  const isSearching = (): boolean => props.searchInput.trim().length > 0;

  return (
    <div class="projects-stack">
      <Show when={!isSearching() && props.onNewProject}>
        <div class="projects-toolbar">
          <button
            type="button"
            class="new-project-button"
            onClick={() => props.onNewProject?.()}
            title="Create a new project / incident / document"
          >
            <span class="new-project-button-plus" aria-hidden="true">
              +
            </span>
            <span>New project</span>
          </button>
        </div>
      </Show>
      <Show
        when={isSearching()}
        fallback={
          <For each={projectsTabGroups(props.buckets)}>
            {(group) => {
              if (group.status === 'done' && group.items.length > 0) {
                const grouping = groupDone(group.items, todayIso());
                return (
                  <GroupBlock
                    group={group}
                    collapsedByDefault={COLLAPSED_BY_DEFAULT.has(group.status)}
                    onOpen={props.onOpen}
                    onToggleStep={props.onToggleStep}
                    onDropProject={props.onDropProject}
                    onWorkOn={props.onWorkOn}
                    bodySlot={() => (
                      <div class="group-body subgroups">
                        <Show when={grouping.recent.length > 0}>
                          <SubGroup
                            label="recent (7 days)"
                            items={grouping.recent}
                            storageKey="done.recent"
                            defaultExpanded={true}
                            hint="Sliding window — these projects also appear in their close month below."
                            onOpen={props.onOpen}
                            onToggleStep={props.onToggleStep}
                            onWorkOn={props.onWorkOn}
                          />
                        </Show>
                        <For each={grouping.byMonth}>
                          {(sub) => (
                            <SubGroup
                              label={sub.month}
                              items={sub.projects}
                              storageKey={`done.${sub.month}`}
                              defaultExpanded={sub.month === grouping.defaultExpandMonth}
                              onOpen={props.onOpen}
                              onToggleStep={props.onToggleStep}
                              onWorkOn={props.onWorkOn}
                            />
                          )}
                        </For>
                      </div>
                    )}
                  />
                );
              }
              return (
                <GroupBlock
                  group={group}
                  collapsedByDefault={COLLAPSED_BY_DEFAULT.has(group.status)}
                  onOpen={props.onOpen}
                  onToggleStep={props.onToggleStep}
                  onDropProject={props.onDropProject}
                  onWorkOn={props.onWorkOn}
                />
              );
            }}
          </For>
        }
      >
        <Show when={searching() && projectGroups().length === 0}>
          <div class="projects-empty">Searching…</div>
        </Show>
        <Show when={!searching() && projectGroups().length === 0}>
          <div class="projects-empty">No matches.</div>
        </Show>
        <Show when={projectGroups().length > 0}>
          <section class="group-block search-results-block">
            <header class="group-header">
              <span class="dot" aria-hidden="true" />
              <span class="name">results</span>
              <span class="count">{projectGroups().length}</span>
            </header>
            <div class="group-body">
              <For each={projectGroups()}>
                {(group) => {
                  const project = (): Project | undefined =>
                    projectsByPath().get(group.projectPath);
                  return (
                    <Show when={project()}>
                      {(p) => (
                        <SearchResultCard
                          item={p()}
                          group={group}
                          onOpen={props.onOpen}
                          onWorkOn={props.onWorkOn}
                        />
                      )}
                    </Show>
                  );
                }}
              </For>
            </div>
          </section>
        </Show>
      </Show>
    </div>
  );
}

/** Search-result variant of Card. Shares the `.row` chrome (stripe, hover
 * brightness, kind glyph, work-on action) so a search result and a normal
 * card sit next to each other comfortably, but the body is replaced by a
 * snippet list (meta / heading / body — backend-prioritised) plus an
 * optional dimmed path line. The h1 snippet's match offsets carry over to
 * the title so its highlights line up with the global search modal. */
function SearchResultCard(props: {
  item: Project;
  group: ProjectGroup;
  onOpen: (project: Project) => void;
  onWorkOn: (project: Project) => void;
}) {
  const handleHeaderClick = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('.row-action')) return;
    props.onOpen(props.item);
  };

  const headerHit = (): SearchHit | undefined => props.group.header;
  const titleSnippet = (): SearchSnippet | undefined =>
    headerHit()?.snippets.find((s) => s.region === 'h1');

  /** Snippets to surface on the card. Take the README's non-h1 snippets
   * first (highest-signal — meta, headings, body), then a few from notes
   * files. Cap the total so a project with many matches doesn't blow up
   * the card's height. */
  const cardSnippets = (): { snippet: SearchSnippet; from?: string }[] => {
    const out: { snippet: SearchSnippet; from?: string }[] = [];
    const header = headerHit();
    if (header) {
      for (const s of header.snippets) {
        if (s.region === 'h1') continue;
        out.push({ snippet: s });
      }
    }
    for (const file of props.group.files) {
      const tail = file.relPath.split('/').pop() ?? file.relPath;
      for (const s of file.snippets) {
        out.push({ snippet: s, from: tail });
      }
    }
    return out.slice(0, 4);
  };

  return (
    <article
      class="row search-result-row"
      title={props.item.path}
      data-status-card={props.item.status}
    >
      <div class="row-head" onClick={handleHeaderClick}>
        <div class="title-row">
          <h3 class="title">
            <Show when={props.item.kind !== 'unknown'}>
              <KindGlyph kind={props.item.kind} />
            </Show>
            <span class="title-text">
              <Show when={titleSnippet()} fallback={props.item.title}>
                {(s) => <HighlightedText text={s().text} matches={s().matches} />}
              </Show>
            </span>
          </h3>
          <div class="title-actions">
            <span class="search-score" title={`Match score ${props.group.totalScore}`}>
              {props.group.totalScore}
            </span>
            <button
              class="row-action work-on"
              onClick={(e) => {
                e.stopPropagation();
                props.onWorkOn(props.item);
              }}
              title={`Paste 'work on ${props.item.slug}' into the focused terminal`}
              aria-label={`Paste 'work on ${props.item.slug}' into the focused terminal`}
            >
              <TerminalIcon />
            </button>
          </div>
        </div>
        <Show when={cardSnippets().length > 0}>
          <ul class="search-result-snippets">
            <For each={cardSnippets()}>
              {(entry) => (
                <li
                  classList={{
                    'snippet-meta': entry.snippet.region === 'meta',
                    'snippet-heading': entry.snippet.region === 'heading',
                  }}
                >
                  <Show when={entry.snippet.region === 'meta'}>
                    <span class="snippet-region-tag">meta</span>
                  </Show>
                  <Show when={entry.snippet.region === 'heading'}>
                    <span class="snippet-region-tag">heading</span>
                  </Show>
                  <Show when={entry.from}>
                    <span class="snippet-region-tag">{entry.from}</span>
                  </Show>
                  <HighlightedText text={entry.snippet.text} matches={entry.snippet.matches} />
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </article>
  );
}

function GroupBlock(props: {
  group: Group;
  /** When true, the section starts collapsed and shows an expand affordance. */
  collapsedByDefault?: boolean;
  /** Override collapsed state — e.g. when a search filter is active and the
   * group has matches, force it open so results aren't hidden. */
  forceOpen?: boolean;
  /** Optional body override. When provided, replaces the default cards loop
   * — used by the Done section to render per-month subgroups instead of a
   * flat card list. The outer header / collapse / drag-drop chrome is
   * unchanged. */
  bodySlot?: () => any;
  onOpen: (project: Project) => void;
  onToggleStep: (project: Project, step: Step) => void;
  onDropProject: (path: string, newStatus: string) => void;
  onWorkOn: (project: Project) => void;
}) {
  const [over, setOver] = createSignal(false);
  const initialStored = readCollapseMap()[props.group.status];
  const [userExpanded, setUserExpanded] = createSignal<boolean | null>(
    typeof initialStored === 'boolean' ? initialStored : null,
  );
  const isOpen = (): boolean => {
    if (props.forceOpen) return true;
    const ux = userExpanded();
    if (ux !== null) return ux;
    return !props.collapsedByDefault;
  };
  const toggle = (): void => {
    const next = !isOpen();
    setUserExpanded(next);
    writeCollapseEntry(props.group.status, next);
  };

  const isAcceptable = (event: DragEvent): boolean => {
    const types = event.dataTransfer?.types;
    return types ? Array.from(types).includes(DRAG_MIME) : false;
  };

  const handleDragEnter = (e: DragEvent) => {
    if (!isAcceptable(e)) return;
    e.preventDefault();
    setOver(true);
  };

  const handleDragOver = (e: DragEvent) => {
    if (!isAcceptable(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  };

  const handleDragLeave = (e: DragEvent) => {
    if (e.currentTarget === e.target) setOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    if (!isAcceptable(e)) return;
    e.preventDefault();
    setOver(false);
    const path = e.dataTransfer?.getData(DRAG_MIME);
    if (path) props.onDropProject(path, props.group.status);
  };

  const isEmpty = (): boolean => props.group.items.length === 0;
  return (
    <section
      class="group-block"
      classList={{ 'drag-over': over(), collapsed: !isOpen() }}
      data-status={props.group.status}
      data-empty={isEmpty() ? 'true' : 'false'}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header
        class="group-header"
        onClick={isEmpty() ? undefined : toggle}
        title={isEmpty() ? undefined : isOpen() ? 'Collapse section' : 'Expand section'}
      >
        <span class="caret" aria-hidden="true">
          {isOpen() ? '▾' : '▸'}
        </span>
        <span class="dot" aria-hidden="true" />
        <span class="name">{props.group.status}</span>
        <span class="count">{props.group.items.length}</span>
      </header>
      <Show when={isOpen() && !isEmpty()}>
        <Show
          when={props.bodySlot}
          fallback={
            <div class="group-body">
              <For each={props.group.items}>
                {(item) => (
                  <Card
                    item={item}
                    onOpen={props.onOpen}
                    onToggleStep={props.onToggleStep}
                    onWorkOn={props.onWorkOn}
                  />
                )}
              </For>
            </div>
          }
        >
          {props.bodySlot!()}
        </Show>
      </Show>
    </section>
  );
}

/** Nested collapsible block used inside the Done section for the "Recent
 * (last 7 days)" pinned window and the per-close-month subgroups. Reuses
 * the GroupBlock chrome (caret, name, count) and the same persisted-collapse
 * map keyed under names like `done.recent` and `done.2026-05`, so user
 * toggles survive page reloads exactly like the outer status sections. */
function SubGroup(props: {
  label: string;
  items: Project[];
  storageKey: string;
  defaultExpanded: boolean;
  /** Title attribute on the header — used to explain non-obvious shapes
   * like the Recent window's deliberate overlap with the month subgroups. */
  hint?: string;
  onOpen: (project: Project) => void;
  onToggleStep: (project: Project, step: Step) => void;
  onWorkOn: (project: Project) => void;
}) {
  const initialStored = readCollapseMap()[props.storageKey];
  const [userExpanded, setUserExpanded] = createSignal<boolean | null>(
    typeof initialStored === 'boolean' ? initialStored : null,
  );
  const isOpen = (): boolean => {
    const ux = userExpanded();
    if (ux !== null) return ux;
    return props.defaultExpanded;
  };
  const toggle = (): void => {
    const next = !isOpen();
    setUserExpanded(next);
    writeCollapseEntry(props.storageKey, next);
  };
  return (
    <section class="group-block subgroup" classList={{ collapsed: !isOpen() }} data-status="done">
      <header
        class="group-header"
        onClick={toggle}
        title={props.hint ?? (isOpen() ? 'Collapse' : 'Expand')}
      >
        <span class="caret" aria-hidden="true">
          {isOpen() ? '▾' : '▸'}
        </span>
        <span class="name">{props.label}</span>
        <span class="count">{props.items.length}</span>
      </header>
      <Show when={isOpen()}>
        <div class="group-body">
          <For each={props.items}>
            {(item) => (
              <Card
                item={item}
                onOpen={props.onOpen}
                onToggleStep={props.onToggleStep}
                onWorkOn={props.onWorkOn}
              />
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}

function Card(props: {
  item: Project;
  onOpen: (project: Project) => void;
  onToggleStep: (project: Project, step: Step) => void;
  onWorkOn: (project: Project) => void;
  draggable?: boolean;
}) {
  const [expanded, setExpanded] = createSignal(false);

  const handleHeaderClick = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('.step-toggle, .expander, .row-action')) return;
    props.onOpen(props.item);
  };

  const handleDragStart = (event: DragEvent) => {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData(DRAG_MIME, props.item.path);
    event.dataTransfer.effectAllowed = 'move';
  };

  const isDraggable = (): boolean => props.draggable !== false;
  const statusUnknown = (): boolean =>
    !(KNOWN_STATUSES as readonly string[]).includes(props.item.status);

  return (
    <article
      class="row"
      title={props.item.path}
      data-status-card={props.item.status}
      draggable={isDraggable()}
      onDragStart={isDraggable() ? handleDragStart : undefined}
    >
      <div class="row-head" onClick={handleHeaderClick}>
        {/* Row 1: kind glyph + title (left, can wrap to 2 lines) and the
            work-on action pinned to the right. */}
        <div class="title-row">
          <h3 class="title">
            <Show when={props.item.kind !== 'unknown'}>
              <KindGlyph kind={props.item.kind} />
            </Show>
            <span class="title-text">{props.item.title}</span>
          </h3>
          <div class="title-actions">
            <button
              class="row-action work-on"
              onClick={(e) => {
                e.stopPropagation();
                props.onWorkOn(props.item);
              }}
              title={`Paste 'work on ${props.item.slug}' into the focused terminal`}
              aria-label={`Paste 'work on ${props.item.slug}' into the focused terminal`}
            >
              <TerminalIcon />
            </button>
          </div>
        </div>

        {/* Row 2: next task — the first open step's text. */}
        <Show when={nextOpenStep(props.item)} keyed>
          {(step) => (
            <p class="summary next-step" data-marker={markerClass(step.marker)}>
              <span class="next-step-marker" aria-hidden="true">
                <StepIcon marker={step.marker} />
              </span>
              {step.text}
            </p>
          )}
        </Show>

        {/* Row 3: apps + branch — the project's where/in. Pulled out of
            the packed meta row so the card has a clean "context" line
            independent of step progress. */}
        <Show when={props.item.apps.length > 0 || props.item.branch}>
          <div class="meta meta-context">
            <Show when={props.item.apps.length > 0}>
              <span class="meta-icon apps" title={props.item.apps.join(', ')}>
                <span class="apps-text">{props.item.apps.join(', ')}</span>
              </span>
            </Show>
            <Show when={props.item.branch}>
              <span class="meta-icon branch" title={`branch: ${props.item.branch}`}>
                <span class="branch-text">{props.item.branch}</span>
              </span>
            </Show>
          </div>
        </Show>

        {/* Row 4: step completion (left) + first/last dates (right).
            Last row on the card. The dates come from the slug
            (creation) and the most recent ## Timeline entry. */}
        <div class="meta meta-bottom">
          <Show when={hasSteps(props.item.stepCounts)}>
            <button
              class="meta-icon expander"
              data-complete={isStepCountsComplete(props.item.stepCounts) ? 'true' : undefined}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
              title={`${props.item.steps.length} steps · click to ${expanded() ? 'collapse' : 'expand'}`}
            >
              <StepProgress counts={props.item.stepCounts} />
              <span class="expander-arrow">{expanded() ? '▾' : '▸'}</span>
            </button>
          </Show>
          <Show when={statusUnknown()}>
            <span class="meta-icon warn" title={`Unknown status: ${props.item.status}`}>
              <WarnIcon />
              {props.item.status}
            </span>
          </Show>
          <span class="meta-spacer" />
          <span
            class="meta-icon date"
            title={`first: ${firstDate(props.item)} · last: ${lastDate(props.item)}`}
          >
            {dateRangeLabel(props.item)}
          </span>
        </div>
      </div>
      <Show when={expanded() && props.item.steps.length > 0}>
        <ul class="steps-list">
          <For each={props.item.steps}>
            {(step) => (
              <li class={`step step-marker-${markerClass(step.marker)}`}>
                <button
                  class="step-toggle"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onToggleStep(props.item, step);
                  }}
                  title={`${MARKER_LABEL[step.marker]} → ${MARKER_LABEL[nextMarker(step.marker)]}`}
                >
                  <StepIcon marker={step.marker} />
                </button>
                <span class="step-text">{step.text}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </article>
  );
}
