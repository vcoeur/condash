import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import type { ActionTemplate, Project, Step } from '@shared/types';
import './projects-pane.css';
import './app-pill.css';
import {
  COLLAPSED_BY_DEFAULT,
  EMPTY_PROJECT_FILTER,
  type Group,
  type ProjectFilter,
  applyProjectFilter,
  collectAppHandles,
  groupDone,
  projectFilterActive,
  projectsTabGroups,
  todayIso,
} from './projects-parts/data';
import { ProjectsFilterBar } from './projects-parts/filter-bar';
import {
  GroupBlock,
  ParentInfoContext,
  SubGroup,
  type ChildRow,
  type ParentInfo,
} from './projects-parts/cards';
import { compareByStatusThenSlug } from '@shared/projects';
import { familyRootOf } from '@shared/project-color';
import { starredSlugs } from '../star-store';
import { usePaneScrollMemory } from './pane-scroll-memory';
import { ActionDropdownButton } from '../action-dropdown-button';

// Public API re-exports — kept here so existing consumers
// (`./panes/projects`) keep importing from the same module path.
export {
  applyStatus,
  applyStepMarker,
  firstDate,
  groupByStatus,
  groupDone,
  lastDate,
  nextMarker,
} from './projects-parts/data';
export type { Group } from './projects-parts/data';
export { KindGlyph, StepIcon } from './projects-parts/icons';

export function ProjectsView(props: {
  buckets: Map<string, Project[]>;
  onOpen: (project: Project) => void;
  onToggleStep: (project: Project, step: Step) => void;
  onDropProject: (path: string, newStatus: string) => void;
  onWorkOn: (project: Project) => void;
  /** Flip the card's star. The starred state itself is read straight from the
   * star store by each Card; only the write is threaded, like every other card
   * action. */
  onToggleStar: (project: Project) => void;
  projectActions?: ActionTemplate[];
  onProjectAction?: (project: Project, action: ActionTemplate) => void;
  /** Open the "+ New project" modal. Rendered as a top-of-pane button when
   * the user isn't searching. Optional so consumers that don't expose the
   * create flow keep working unchanged. */
  onNewProject?: () => void;
  newProjectActions?: ActionTemplate[];
  onNewProjectAction?: (action: ActionTemplate) => void;
  /** Refresh the project list. Rendered as a pane-header icon button. */
  onRefresh?: () => void;
}) {
  const scrollRef = usePaneScrollMemory('projects');

  // Filter bar state. Session-local on purpose: a filter is a lens on the
  // current session's attention, not tree state, and it must not survive a
  // restart the way the star set does. The README search runs in the main
  // process (`searchProjectReadmes`, over the in-memory search index) and
  // answers with the matched `Project.path`s; `matchedPaths` is null while no
  // query is active so the other two predicates work without a round-trip.
  const [filter, setFilter] = createSignal<ProjectFilter>(EMPTY_PROJECT_FILTER);
  const [matchedPaths, setMatchedPaths] = createSignal<ReadonlySet<string> | null>(null);
  const trimmedQuery = createMemo(() => filter().query.trim());
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchSeq = 0;
  createEffect(() => {
    const query = trimmedQuery();
    // Re-run on any project-list change too: a README edited while a query is
    // active would otherwise keep (or miss) its card until the query changes.
    void props.buckets;
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    if (query === '') {
      searchSeq++;
      setMatchedPaths(null);
      return;
    }
    const seq = ++searchSeq;
    // Short debounce: typing must not fire an IPC per keystroke, but the pane
    // should still feel live — the search itself is an in-memory scan.
    searchTimer = setTimeout(() => {
      searchTimer = undefined;
      window.condash
        .searchProjectReadmes(query)
        .then((paths) => {
          // A stale answer (the query moved on, or was cleared) must not
          // overwrite the current one.
          if (seq === searchSeq) setMatchedPaths(new Set(paths));
        })
        .catch(() => {
          if (seq === searchSeq) setMatchedPaths(new Set<string>());
        });
    }, 150);
  });
  onCleanup(() => {
    if (searchTimer !== undefined) clearTimeout(searchTimer);
  });
  const filterActive = createMemo(() => projectFilterActive(filter()));
  const appOptions = createMemo(() => collectAppHandles(props.buckets));
  const filteredBuckets = createMemo(() =>
    applyProjectFilter(props.buckets, filter(), starredSlugs(), matchedPaths()),
  );
  const countItems = (buckets: Map<string, Project[]>): number => {
    let n = 0;
    for (const items of buckets.values()) n += items.length;
    return n;
  };
  const totalCount = createMemo(() => countItems(props.buckets));
  const matchCount = createMemo(() => countItems(filteredBuckets()));

  // Materialise the section groups once per bucket change, reusing the prior
  // Group object for any status whose membership is unchanged so the
  // reference-keyed `<For>` below doesn't remount an untouched section's
  // GroupBlock (and its synchronous localStorage collapse read) on an unrelated
  // status/step change (R2). Runs on the *filtered* buckets: with no filter
  // active that is `props.buckets` itself, identity included.
  const groups = createMemo<Group[]>((prev) => projectsTabGroups(filteredBuckets(), prev));
  // List-wide parent/child lookup shared with every Card via context: a slug →
  // Project map backing the "Part of" banner (title + status pill) and the
  // banner buttons' open-referenced-project action, and a parent-slug →
  // status-ordered child rows map for the bottom subprojects banner. Rebuilt
  // whenever the buckets change.
  const parentInfo = createMemo<ParentInfo>(() => {
    const projectBySlug = new Map<string, Project>();
    const childrenByParent = new Map<string, ChildRow[]>();
    for (const items of props.buckets.values()) {
      for (const item of items) {
        projectBySlug.set(item.slug, item);
        if (item.parent) {
          const row: ChildRow = { slug: item.slug, title: item.title, status: item.status };
          const rows = childrenByParent.get(item.parent);
          if (rows) rows.push(row);
          else childrenByParent.set(item.parent, [row]);
        }
      }
    }
    for (const rows of childrenByParent.values()) rows.sort(compareByStatusThenSlug);
    // A `parent:` link counts only when it resolves to a real item — the walk
    // in shared/project-color.ts stops at the last resolving node.
    const resolvedParentOf = (slug: string): string | undefined => {
      const parent = projectBySlug.get(slug)?.parent;
      return parent && projectBySlug.has(parent) ? parent : undefined;
    };
    return {
      projectOf: (slug) => projectBySlug.get(slug),
      childrenOf: (slug) => childrenByParent.get(slug) ?? [],
      familyRootOf: (slug) => familyRootOf(slug, resolvedParentOf),
    };
  });
  return (
    <ParentInfoContext.Provider value={parentInfo}>
      <div class="projects-pane">
        <header class="pane-header">
          <span class="pane-header-title">Projects</span>
          <span class="spacer" />
          <div class="pane-header-actions">
            <Show when={props.onNewProject}>
              <button
                type="button"
                class="pane-header-action"
                onClick={() => props.onNewProject?.()}
                title="Create a new project"
              >
                + New
              </button>
            </Show>
            <Show when={props.onRefresh}>
              <button
                type="button"
                class="pane-header-action icon-only"
                onClick={() => props.onRefresh?.()}
                title="Refresh projects"
                aria-label="Refresh projects"
              >
                ↻
              </button>
            </Show>
          </div>
        </header>
        <ProjectsFilterBar
          filter={filter()}
          appOptions={appOptions()}
          matchCount={matchCount()}
          totalCount={totalCount()}
          onChange={setFilter}
        />
        <div class="projects-stack" ref={scrollRef}>
          <Show when={filterActive() && matchCount() === 0}>
            <div class="projects-empty projects-filter-empty">
              No item matches the current filters.
            </div>
          </Show>
          <For each={groups()}>
            {(group) => {
              // Under an active filter a section that filtered down to nothing
              // is hidden rather than shown as an empty header, and any section
              // that still has items is forced open so the matches are visible
              // even in the collapsed-by-default `backlog` / `done`. Read
              // reactively (a `<Show>` below, not an early return): the group
              // object for an empty status is reused across filter changes, so
              // this callback does not re-run when the filter flips.
              const visible = (): boolean => !filterActive() || group.items.length > 0;
              // The "+ New project" button rides the NOW section header so it
              // sits on the same row as the section title. Other sections
              // don't get the action — creating an item from "later" or
              // "backlog" would still land in NOW and the affordance reads
              // most clearly when it's anchored to the active-work section.
              const headerAction =
                group.status === 'now' && props.onNewProject
                  ? () => (
                      <ActionDropdownButton
                        trigger={
                          <>
                            <span class="new-project-button-plus" aria-hidden="true">
                              +
                            </span>
                            <span>New project</span>
                          </>
                        }
                        triggerTitle="Create a new project / incident / document"
                        defaultLabel="New project (modal)"
                        items={props.newProjectActions ?? []}
                        onItem={(idx) => {
                          if (idx === -1) {
                            props.onNewProject?.();
                          } else {
                            const action = props.newProjectActions?.[idx];
                            if (action) props.onNewProjectAction?.(action);
                          }
                        }}
                        class="new-project-button"
                      />
                    )
                  : undefined;
              if (group.status === 'done' && group.items.length > 0) {
                const grouping = groupDone(group.items, todayIso(), starredSlugs());
                return (
                  <Show when={visible()}>
                    <GroupBlock
                      group={group}
                      collapsedByDefault={COLLAPSED_BY_DEFAULT.has(group.status)}
                      forceOpen={filterActive()}
                      onOpen={props.onOpen}
                      onDropProject={props.onDropProject}
                      onWorkOn={props.onWorkOn}
                      onToggleStar={props.onToggleStar}
                      projectActions={props.projectActions}
                      onProjectAction={props.onProjectAction}
                      headerAction={headerAction}
                      bodySlot={() => (
                        <div class="group-body subgroups">
                          <Show when={grouping.recent.length > 0}>
                            <SubGroup
                              label="recent (7 days)"
                              items={grouping.recent}
                              storageKey="done.recent"
                              defaultExpanded={true}
                              forceOpen={filterActive()}
                              hint="Sliding window — projects move into their close month after 7 days."
                              onOpen={props.onOpen}
                              onWorkOn={props.onWorkOn}
                              onToggleStar={props.onToggleStar}
                              onChangeStatus={props.onDropProject}
                              projectActions={props.projectActions}
                              onProjectAction={props.onProjectAction}
                            />
                          </Show>
                          <For each={grouping.byMonth}>
                            {(sub) => (
                              <SubGroup
                                label={sub.month}
                                items={sub.projects}
                                storageKey={`done.${sub.month}`}
                                defaultExpanded={sub.month === grouping.defaultExpandMonth}
                                forceOpen={filterActive()}
                                onOpen={props.onOpen}
                                onWorkOn={props.onWorkOn}
                                onToggleStar={props.onToggleStar}
                                onChangeStatus={props.onDropProject}
                                projectActions={props.projectActions}
                                onProjectAction={props.onProjectAction}
                              />
                            )}
                          </For>
                        </div>
                      )}
                    />
                  </Show>
                );
              }
              return (
                <Show when={visible()}>
                  <GroupBlock
                    group={group}
                    collapsedByDefault={COLLAPSED_BY_DEFAULT.has(group.status)}
                    forceOpen={filterActive()}
                    onOpen={props.onOpen}
                    onDropProject={props.onDropProject}
                    onWorkOn={props.onWorkOn}
                    onToggleStar={props.onToggleStar}
                    projectActions={props.projectActions}
                    onProjectAction={props.onProjectAction}
                    headerAction={headerAction}
                  />
                </Show>
              );
            }}
          </For>
        </div>
      </div>
    </ParentInfoContext.Provider>
  );
}
