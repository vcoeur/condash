import { createMemo, createSignal, For, Show } from 'solid-js';
import type { Project, Step, StepCounts, StepMarker } from '@shared/types';
import { KNOWN_STATUSES, STEP_MARKERS } from '@shared/types';

const MARKER_GLYPH: Record<StepMarker, string> = {
  ' ': '☐',
  '~': '◐',
  x: '☑',
  '-': '✕',
};

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
const PROJECT_SECTION_ORDER = ['now', 'review', 'soon', 'later', 'backlog', 'done'] as const;
const COLLAPSED_BY_DEFAULT = new Set<string>(['backlog', 'done']);

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

function countSteps(steps: readonly Step[]): StepCounts {
  const c: StepCounts = { todo: 0, doing: 0, done: 0, dropped: 0 };
  for (const s of steps) {
    if (s.marker === ' ') c.todo++;
    else if (s.marker === '~') c.doing++;
    else if (s.marker === 'x') c.done++;
    else if (s.marker === '-') c.dropped++;
  }
  return c;
}

function hasSteps(c: StepCounts): boolean {
  return c.todo + c.doing + c.done + c.dropped > 0;
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

function projectMatches(item: Project, needle: string): boolean {
  if (!needle) return true;
  return (
    item.title.toLowerCase().includes(needle) ||
    item.slug.toLowerCase().includes(needle) ||
    (item.summary?.toLowerCase().includes(needle) ?? false) ||
    (item.apps?.toLowerCase().includes(needle) ?? false)
  );
}

function markerClass(m: StepMarker): string {
  if (m === ' ') return 'todo';
  if (m === '~') return 'doing';
  if (m === 'x') return 'done';
  return 'dropped';
}

function StepProgress(props: { counts: StepCounts }) {
  const total = (): number =>
    props.counts.todo + props.counts.doing + props.counts.done + props.counts.dropped;
  const ratio = (): number => {
    const t = total();
    return t === 0 ? 0 : Math.min(1, props.counts.done / t);
  };
  const title = (): string =>
    `${props.counts.todo} todo, ${props.counts.doing} doing, ${props.counts.done} done, ${props.counts.dropped} dropped`;
  return (
    <span class="step-progress-inner" title={title()}>
      <span class="progress-track">
        <span class="progress-fill" style={{ width: `${ratio() * 100}%` }} />
      </span>
      <span class="progress-text">
        {props.counts.done}/{total()}
      </span>
    </span>
  );
}

const KIND_ICON: Record<string, () => any> = {
  project: () => (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.5L14.5 8 8 14.5 1.5 8z" />
    </svg>
  ),
  incident: () => (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2L14.5 13.5h-13z" />
      <path d="M8 6.5v3" />
      <circle cx="8" cy="11.5" r="0.4" fill="currentColor" stroke="none" />
    </svg>
  ),
  document: () => (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 1.5h6L13 5v9.5H3.5z" />
      <path d="M9.5 1.5V5H13" />
      <path d="M5.5 8h5M5.5 10.5h5M5.5 5.5h2" />
    </svg>
  ),
};

function KindIcon(props: { kind: string }) {
  const Icon = KIND_ICON[props.kind];
  if (!Icon) return null;
  return <Icon />;
}

function AppsIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M2 4.5l6-3 6 3-6 3z" />
      <path d="M2 8l6 3 6-3" />
      <path d="M2 11.5l6 3 6-3" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2v8" />
      <path d="M4.5 7L8 10.5 11.5 7" />
      <path d="M2.5 13.5h11" />
    </svg>
  );
}

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
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 5v3.5" />
      <circle cx="8" cy="11" r="0.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ProjectsView(props: {
  buckets: Map<string, Project[]>;
  onOpen: (project: Project) => void;
  onToggleStep: (project: Project, step: Step) => void;
  onDropProject: (path: string, newStatus: string) => void;
}) {
  const [filter, setFilter] = createSignal('');
  const trimmedQuery = createMemo(() => filter().trim().toLowerCase());
  const filteredGroups = createMemo<Group[]>(() => {
    const q = trimmedQuery();
    const buckets = props.buckets;
    if (!q) return projectsTabGroups(buckets);
    const filtered = new Map<string, Project[]>();
    for (const [status, items] of buckets) {
      filtered.set(
        status,
        items.filter((it) => projectMatches(it, q)),
      );
    }
    return projectsTabGroups(filtered);
  });
  return (
    <div class="projects-stack">
      <div class="projects-filter">
        <input
          class="projects-filter-input"
          type="search"
          placeholder="Filter projects (title, slug, app, summary)…"
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
      </div>
      <For each={filteredGroups()}>
        {(group) => (
          <GroupBlock
            group={group}
            collapsedByDefault={COLLAPSED_BY_DEFAULT.has(group.status)}
            forceOpen={trimmedQuery().length > 0 && group.items.length > 0}
            onOpen={props.onOpen}
            onToggleStep={props.onToggleStep}
            onDropProject={props.onDropProject}
          />
        )}
      </For>
    </div>
  );
}

function GroupBlock(props: {
  group: Group;
  /** When true, the section starts collapsed and shows an expand affordance. */
  collapsedByDefault?: boolean;
  /** Override collapsed state — e.g. when a search filter is active and the
   * group has matches, force it open so results aren't hidden. */
  forceOpen?: boolean;
  onOpen: (project: Project) => void;
  onToggleStep: (project: Project, step: Step) => void;
  onDropProject: (path: string, newStatus: string) => void;
}) {
  const [over, setOver] = createSignal(false);
  const [userExpanded, setUserExpanded] = createSignal<boolean | null>(null);
  const isOpen = (): boolean => {
    if (props.forceOpen) return true;
    const ux = userExpanded();
    if (ux !== null) return ux;
    return !props.collapsedByDefault;
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

  return (
    <section
      class="group-block"
      classList={{ 'drag-over': over(), collapsed: !isOpen() }}
      data-status={props.group.status}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header
        class="group-header"
        onClick={() => setUserExpanded(!isOpen())}
        title={isOpen() ? 'Collapse section' : 'Expand section'}
      >
        <span class="caret" aria-hidden="true">
          {isOpen() ? '▾' : '▸'}
        </span>
        <span class="dot" aria-hidden="true" />
        <span class="name">{props.group.status}</span>
        <span class="count">{props.group.items.length}</span>
        <span class="rule" aria-hidden="true" />
      </header>
      <Show when={isOpen()}>
        <div class="group-body">
          <For each={props.group.items}>
            {(item) => <Card item={item} onOpen={props.onOpen} onToggleStep={props.onToggleStep} />}
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
  draggable?: boolean;
}) {
  const [expanded, setExpanded] = createSignal(false);

  const handleHeaderClick = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('.step-toggle, .expander')) return;
    props.onOpen(props.item);
  };

  const handleDragStart = (event: DragEvent) => {
    if (!event.dataTransfer) return;
    event.dataTransfer.setData(DRAG_MIME, props.item.path);
    event.dataTransfer.effectAllowed = 'move';
  };

  const isDraggable = (): boolean => props.draggable !== false;

  return (
    <article
      class="row"
      title={props.item.path}
      data-status-card={props.item.status}
      draggable={isDraggable()}
      onDragStart={isDraggable() ? handleDragStart : undefined}
    >
      <div class="row-head" onClick={handleHeaderClick}>
        <h3 class="title">
          <Show when={props.item.kind !== 'unknown'}>
            <span class="title-kind" data-kind={props.item.kind} title={props.item.kind}>
              <KindIcon kind={props.item.kind} />
            </span>
          </Show>
          <span class="title-text">{props.item.title}</span>
        </h3>
        <Show when={nextOpenStep(props.item)} keyed>
          {(step) => (
            <p class="summary next-step" data-marker={markerClass(step.marker)}>
              <span class="next-step-marker" aria-hidden="true">
                {step.marker === '~' ? '◐' : step.marker === '-' ? '⨯' : '○'}
              </span>
              {step.text}
            </p>
          )}
        </Show>
        <div class="meta">
          <Show when={props.item.apps}>
            <span class="meta-icon apps" title={props.item.apps}>
              <AppsIcon />
              {props.item.apps}
            </span>
          </Show>
          <Show when={props.item.deliverableCount > 0}>
            <span class="meta-icon" title="deliverables">
              <DownloadIcon />
              {props.item.deliverableCount}
            </span>
          </Show>
          <Show when={!(KNOWN_STATUSES as readonly string[]).includes(props.item.status)}>
            <span class="meta-icon warn" title={`Unknown status: ${props.item.status}`}>
              <WarnIcon />
              {props.item.status}
            </span>
          </Show>
          <span class="slug">{props.item.slug}</span>
          <Show when={hasSteps(props.item.stepCounts)}>
            <button
              class="meta-icon expander step-bar-right"
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
                  {MARKER_GLYPH[step.marker]}
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
