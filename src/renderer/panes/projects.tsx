import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import type { Project, SearchResults, Step } from '@shared/types';
import { groupHits, type ProjectGroup } from '../search/grouping';
import './projects-pane.css';
import {
  COLLAPSED_BY_DEFAULT,
  EMPTY_SEARCH_RESULTS,
  groupDone,
  projectsTabGroups,
  todayIso,
} from './projects-parts/data';
import { GroupBlock, SearchResultCard, SubGroup } from './projects-parts/cards';

// Public API re-exports — kept here so existing consumers
// (`./panes/projects`) keep importing from the same module path.
export {
  applyStatus,
  applyStepMarker,
  dateRangeLabel,
  firstDate,
  groupByStatus,
  groupDone,
  lastDate,
  nextMarker,
} from './projects-parts/data';
export type { Group } from './projects-parts/data';
export { KindGlyph, NewNoteIcon, StepIcon } from './projects-parts/icons';

export function ProjectsView(props: {
  buckets: Map<string, Project[]>;
  /** Live search-input value, owned by the toolbar. Debounced internally
   * to a `query` signal that drives the actual backend fetch. */
  searchInput: string;
  onOpen: (project: Project) => void;
  onToggleStep: (project: Project, step: Step) => void;
  onDropProject: (path: string, newStatus: string) => void;
  onWorkOn: (project: Project) => void;
  /** Open the "+ New project" modal. Rendered as a top-of-pane button when
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
                            hint="Sliding window — projects move into their close month after 7 days."
                            onOpen={props.onOpen}
                            onToggleStep={props.onToggleStep}
                            onWorkOn={props.onWorkOn}
                            onChangeStatus={props.onDropProject}
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
                              onChangeStatus={props.onDropProject}
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
