import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  Suspense,
  type Component,
  type JSX,
} from 'solid-js';
import { ALL_SCOPES, type SearchResults } from '@shared/types';
import { groupHits } from './search/grouping';
import { Modal } from './modal';
import { KnowledgeIcon, LogsIcon, ProjectsIcon, ResourcesIcon, SkillsIcon } from './icons';
import { FileResultRow, LogResultRow, ProjectGroupRow } from './search-modal-parts/result-rows';
import { SearchTips } from './search-modal-parts/search-tips';
import './search-modal.css';

const EMPTY_RESULTS: SearchResults = { hits: [], terms: [], totalBeforeCap: 0, truncated: false };

/** Minimum query length before hitting the backend. A 1-char query matches
 *  nearly everything and produces the worst-case scan for no useful result. */
const MIN_QUERY_LEN = 2;

// The default "All" filter forwards ALL_SCOPES (shared constant in
// `src/shared/types/search.ts`) — the four indexed markdown buckets, never the
// heavy, unindexed logs. Forwarding these scopes (rather than `undefined` =
// "everything") keeps the default search on the ~45 ms index path; logs stay
// one click away behind the Logs pill, which forwards `['logs']` and triggers
// the on-demand disk scan.

/**
 * Modal-shell around the search backend. Top-anchored (command-palette
 * feel) — expands downward as results arrive.
 *
 * Heavy lifting lives elsewhere:
 * - `search/highlight.tsx` — multi-token `<mark>` segmenter.
 * - `search/grouping.ts` — collapse project-side hits into per-project cards.
 *
 * This file owns shell behaviour (input state, debounce, keyboard, layout).
 * Row components live as siblings below so Solid sees them as stable
 * references (declaring them inside SearchModal means each render call
 * re-creates the function identity, which trips Solid's reactive tracking).
 */
/** Which source bucket(s) to surface in the result list. `all` shows
 *  both — projects (with their notes) and knowledge files. The pill
 *  filter sits on the search modal header. The backend doesn't know
 *  about the filter; we just hide non-matching buckets in the UI. */
type SourceFilter = 'all' | 'projects' | 'knowledge' | 'resources' | 'skills' | 'logs';

interface SourceMeta {
  label: string;
  icon: Component;
  color: string;
}

const SOURCE_META: Record<SourceFilter, SourceMeta> = {
  all: { label: 'All', icon: () => null, color: 'var(--text-muted)' },
  projects: { label: 'Projects', icon: ProjectsIcon, color: 'var(--kind-project)' },
  knowledge: { label: 'Knowledge', icon: KnowledgeIcon, color: 'var(--col-later)' },
  resources: { label: 'Resources', icon: ResourcesIcon, color: 'var(--col-soon)' },
  skills: { label: 'Skills', icon: SkillsIcon, color: 'var(--col-review)' },
  logs: { label: 'Logs', icon: LogsIcon, color: 'var(--text-muted)' },
};

export function SearchModal(props: {
  onClose: () => void;
  onOpenProject: (projectPath: string) => void;
  onOpenFile: (path: string, projectPath?: string, projectTitle?: string) => void;
  /** Optional — when provided, log hits are surfaced as their own row
   * type that, on click, opens the Logs pane and selects that session. */
  onOpenLog?: (logPath: string) => void;
}) {
  const [input, setInput] = createSignal('');
  const [query, setQuery] = createSignal('');
  const [sourceFilter, setSourceFilter] = createSignal<SourceFilter>('all');
  const [selectedIndex, setSelectedIndex] = createSignal<number>(-1);
  let inputEl: HTMLInputElement | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Re-runs whenever the query OR the active source filter changes. The scope
  // is always forwarded to the backend so it scans only what's needed: a
  // specific filter narrows to that one bucket, and the default 'all' narrows to
  // the four indexed markdown sources (ALL_SCOPES) — never the heavy, unindexed
  // logs tree. Logs are searched only when the Logs filter is active. Sub-
  // MIN_QUERY_LEN queries never reach the backend.
  const [results] = createResource(
    () => ({ q: query(), filter: sourceFilter() }),
    async ({ q, filter }) => {
      if (q.trim().length < MIN_QUERY_LEN) return EMPTY_RESULTS;
      const scopes = filter === 'all' ? [...ALL_SCOPES] : [filter];
      return window.condash.search(q, scopes);
    },
  );

  const grouped = createMemo(() => groupHits(results()?.hits ?? []));
  const truncated = createMemo(() => !!results()?.truncated);
  const totalBeforeCap = createMemo(() => results()?.totalBeforeCap ?? 0);

  // Counts shown on the filter pills — derived from the unfiltered
  // groups so each pill always reflects "how many hits I'd see if I
  // picked this filter," even while a different one is selected.
  const projectCount = createMemo(() =>
    grouped().projects.reduce((acc, g) => acc + 1 + g.files.length, 0),
  );
  const knowledgeCount = createMemo(() => grouped().knowledge.length);
  const resourcesCount = createMemo(() => grouped().resources.length);
  const skillsCount = createMemo(() => grouped().skills.length);
  const logsCount = createMemo(() => grouped().logs.length);
  const totalCount = createMemo(
    () => projectCount() + knowledgeCount() + resourcesCount() + skillsCount() + logsCount(),
  );

  const counts = createMemo(() => ({
    all: totalCount(),
    projects: projectCount(),
    knowledge: knowledgeCount(),
    resources: resourcesCount(),
    skills: skillsCount(),
    logs: logsCount(),
  }));

  const showProjects = (): boolean => sourceFilter() === 'all' || sourceFilter() === 'projects';
  const showKnowledge = (): boolean => sourceFilter() === 'all' || sourceFilter() === 'knowledge';
  const showResources = (): boolean => sourceFilter() === 'all' || sourceFilter() === 'resources';
  const showSkills = (): boolean => sourceFilter() === 'all' || sourceFilter() === 'skills';
  const showLogs = (): boolean => sourceFilter() === 'all' || sourceFilter() === 'logs';

  // Long enough to search — below this we keep showing the tips rather than
  // flashing a premature "no matches" while the user is still typing.
  const queryLongEnough = (): boolean => input().trim().length >= MIN_QUERY_LEN;

  // Visible-results count under the active filter — drives the
  // "no matches in this source" empty state.
  const visibleCount = createMemo(() => {
    if (sourceFilter() === 'projects') return projectCount();
    if (sourceFilter() === 'knowledge') return knowledgeCount();
    if (sourceFilter() === 'resources') return resourcesCount();
    if (sourceFilter() === 'skills') return skillsCount();
    if (sourceFilter() === 'logs') return logsCount();
    return totalCount();
  });

  const filterHints = createMemo(() => {
    const current = sourceFilter();
    const hints: { label: string; filter: SourceFilter; count: number }[] = [];
    if (current !== 'projects' && projectCount() > 0)
      hints.push({ label: 'Projects', filter: 'projects', count: projectCount() });
    if (current !== 'knowledge' && knowledgeCount() > 0)
      hints.push({ label: 'Knowledge', filter: 'knowledge', count: knowledgeCount() });
    if (current !== 'resources' && resourcesCount() > 0)
      hints.push({ label: 'Resources', filter: 'resources', count: resourcesCount() });
    if (current !== 'skills' && skillsCount() > 0)
      hints.push({ label: 'Skills', filter: 'skills', count: skillsCount() });
    if (current !== 'logs' && logsCount() > 0)
      hints.push({ label: 'Logs', filter: 'logs', count: logsCount() });
    return hints;
  });

  createEffect(() => {
    const idx = selectedIndex();
    // Track results so the effect re-runs when rows are added/removed.
    results();
    document.querySelectorAll('.search-row').forEach((el, i) => {
      el.toggleAttribute('data-selected', i === idx);
    });
  });

  const changeFilter = (filter: SourceFilter): void => {
    setSelectedIndex(-1);
    setSourceFilter(filter);
  };

  const onInput = (value: string): void => {
    setInput(value);
    setSelectedIndex(-1);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => setQuery(value), 200);
  };

  const handleKeydown = (e: KeyboardEvent): void => {
    // Esc → close and backdrop dismissal are owned by the shared <Modal>
    // shell. This handler covers the search-specific arrow/Enter navigation.
    const rows = document.querySelectorAll('.search-row');
    const totalVisibleResults = rows.length;
    if (totalVisibleResults === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, totalVisibleResults - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter' && selectedIndex() >= 0) {
      e.preventDefault();
      const selected = rows[selectedIndex()] as HTMLElement | undefined;
      selected?.click();
      return;
    }
  };

  onMount(() => {
    document.addEventListener('keydown', handleKeydown, true);
    queueMicrotask(() => inputEl?.focus());
  });
  onCleanup(() => {
    document.removeEventListener('keydown', handleKeydown, true);
    if (debounceTimer) clearTimeout(debounceTimer);
  });

  const openProjectAndClose = (path: string): void => {
    props.onOpenProject(path);
    props.onClose();
  };
  const openFileAndClose = (path: string): void => {
    props.onOpenFile(path);
    props.onClose();
  };
  const openLogAndClose = (path: string): void => {
    if (props.onOpenLog) props.onOpenLog(path);
    props.onClose();
  };

  const meta = (filter: SourceFilter): SourceMeta => SOURCE_META[filter];

  const filterCount = (filter: SourceFilter): number => {
    if (filter === 'logs') {
      // Logs aren't scanned in the 'all' view (ALL_SCOPES excludes them),
      // so their count is only known when the Logs filter is active.
      return sourceFilter() === 'logs' ? counts().logs : 0;
    }
    return counts()[filter];
  };

  const FilterButton = (p: { filter: SourceFilter }): JSX.Element => {
    const active = (): boolean => sourceFilter() === p.filter;
    const Icon = meta(p.filter).icon;
    return (
      <button
        class="search-filter-btn"
        classList={{ active: active() }}
        role="radio"
        aria-checked={active()}
        onClick={() => changeFilter(p.filter)}
        style={{ '--source-color': meta(p.filter).color }}
      >
        <Show when={p.filter !== 'all'}>
          <span class="search-filter-icon">
            <Icon />
          </span>
        </Show>
        <span class="search-filter-label">{meta(p.filter).label}</span>
        <span class="search-filter-count">{filterCount(p.filter) || ''}</span>
      </button>
    );
  };

  const SectionHeader = (p: { filter: SourceFilter; count: number }): JSX.Element => {
    const Icon = meta(p.filter).icon;
    return (
      <li class="search-section-header" style={{ '--source-color': meta(p.filter).color }}>
        <span class="search-section-icon">
          <Icon />
        </span>
        <span class="search-section-label">{meta(p.filter).label}</span>
        <span class="search-section-count">{p.count}</span>
      </li>
    );
  };

  return (
    <Modal
      class="search-modal"
      ariaLabel="Search"
      backdropClass="search-modal-backdrop"
      headClass="search-modal-head"
      onClose={props.onClose}
      headLeading={
        <input
          ref={(el) => (inputEl = el)}
          class="search-input search-modal-input"
          type="search"
          placeholder='Search projects, knowledge, logs — "phrases" stay together'
          value={input()}
          onInput={(e) => onInput(e.currentTarget.value)}
        />
      }
    >
      <Show when={queryLongEnough()}>
        <div class="search-filter-bar" role="radiogroup" aria-label="Filter by source">
          <FilterButton filter="all" />
          <FilterButton filter="projects" />
          <FilterButton filter="knowledge" />
          <FilterButton filter="resources" />
          <FilterButton filter="skills" />
          <FilterButton filter="logs" />
        </div>
      </Show>
      <div class="search-modal-body">
        <Show when={queryLongEnough()} fallback={<SearchTips />}>
          <Suspense fallback={<div class="empty">Searching…</div>}>
            <Show
              when={visibleCount() > 0}
              fallback={
                <div class="empty">
                  {grouped().total === 0 ? 'No matches.' : `No matches in ${sourceFilter()}.`}
                  <Show when={grouped().total > 0 && sourceFilter() !== 'all'}>
                    <div class="search-source-hints">
                      Also found in{' '}
                      <For each={filterHints()}>
                        {(hint, i) => (
                          <span class="search-source-hint-item">
                            <Show when={i() > 0}>, </Show>
                            <button
                              class="search-source-hint-link"
                              onClick={() => changeFilter(hint.filter)}
                            >
                              {hint.label} ({hint.count})
                            </button>
                          </span>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              }
            >
              <ul class="search-results search-results-sectioned">
                <Show when={showProjects() && projectCount() > 0}>
                  <SectionHeader filter="projects" count={projectCount()} />
                  <For each={grouped().projects}>
                    {(g) => (
                      <ProjectGroupRow
                        group={g}
                        onOpenProject={openProjectAndClose}
                        onOpenFile={openFileAndClose}
                      />
                    )}
                  </For>
                </Show>
                <Show when={showKnowledge() && knowledgeCount() > 0}>
                  <SectionHeader filter="knowledge" count={knowledgeCount()} />
                  <For each={grouped().knowledge}>
                    {(hit) => <FileResultRow hit={hit} onOpen={openFileAndClose} />}
                  </For>
                </Show>
                <Show when={showResources() && resourcesCount() > 0}>
                  <SectionHeader filter="resources" count={resourcesCount()} />
                  <For each={grouped().resources}>
                    {(hit) => <FileResultRow hit={hit} onOpen={openFileAndClose} />}
                  </For>
                </Show>
                <Show when={showSkills() && skillsCount() > 0}>
                  <SectionHeader filter="skills" count={skillsCount()} />
                  <For each={grouped().skills}>
                    {(hit) => <FileResultRow hit={hit} onOpen={openFileAndClose} />}
                  </For>
                </Show>
                <Show when={showLogs() && logsCount() > 0}>
                  <SectionHeader filter="logs" count={logsCount()} />
                  <For each={grouped().logs}>
                    {(hit) => <LogResultRow hit={hit} onOpen={openLogAndClose} />}
                  </For>
                </Show>
              </ul>
              <Show when={truncated()}>
                <div class="search-truncated-hint">
                  Showing top 100 of {totalBeforeCap()} matches — refine the query for more.
                </div>
              </Show>
            </Show>
          </Suspense>
        </Show>
      </div>
    </Modal>
  );
}
