import { createMemo, For, Show } from 'solid-js';
import type { ActionTemplate, Project, Step } from '@shared/types';
import './projects-pane.css';
import './app-pill.css';
import {
  COLLAPSED_BY_DEFAULT,
  type Group,
  groupDone,
  projectsTabGroups,
  todayIso,
} from './projects-parts/data';
import { GroupBlock, ParentInfoContext, SubGroup, type ParentInfo } from './projects-parts/cards';
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
  // Materialise the section groups once per bucket change, reusing the prior
  // Group object for any status whose membership is unchanged so the
  // reference-keyed `<For>` below doesn't remount an untouched section's
  // GroupBlock (and its synchronous localStorage collapse read) on an unrelated
  // status/step change (R2).
  const groups = createMemo<Group[]>((prev) => projectsTabGroups(props.buckets, prev));
  // List-wide parent/child lookup shared with every Card via context: a slug →
  // title map for the "Part of" banner, and a parent-slug → child-count map for
  // the subproject count chip. Rebuilt whenever the buckets change.
  const parentInfo = createMemo<ParentInfo>(() => {
    const titleBySlug = new Map<string, string>();
    const childCountByParent = new Map<string, number>();
    for (const items of props.buckets.values()) {
      for (const item of items) {
        titleBySlug.set(item.slug, item.title);
        if (item.parent) {
          childCountByParent.set(item.parent, (childCountByParent.get(item.parent) ?? 0) + 1);
        }
      }
    }
    return {
      parentTitleOf: (slug) => titleBySlug.get(slug),
      childCountOf: (slug) => childCountByParent.get(slug) ?? 0,
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
        <div class="projects-stack" ref={scrollRef}>
          <For each={groups()}>
            {(group) => {
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
                const grouping = groupDone(group.items, todayIso());
                return (
                  <GroupBlock
                    group={group}
                    collapsedByDefault={COLLAPSED_BY_DEFAULT.has(group.status)}
                    onOpen={props.onOpen}
                    onDropProject={props.onDropProject}
                    onWorkOn={props.onWorkOn}
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
                            hint="Sliding window — projects move into their close month after 7 days."
                            onOpen={props.onOpen}
                            onWorkOn={props.onWorkOn}
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
                              onOpen={props.onOpen}
                              onWorkOn={props.onWorkOn}
                              onChangeStatus={props.onDropProject}
                              projectActions={props.projectActions}
                              onProjectAction={props.onProjectAction}
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
                  onDropProject={props.onDropProject}
                  onWorkOn={props.onWorkOn}
                  projectActions={props.projectActions}
                  onProjectAction={props.onProjectAction}
                  headerAction={headerAction}
                />
              );
            }}
          </For>
        </div>
      </div>
    </ParentInfoContext.Provider>
  );
}
