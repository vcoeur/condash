import { For, Show } from 'solid-js';
import type { Project, Step } from '@shared/types';
import './projects-pane.css';
import {
  COLLAPSED_BY_DEFAULT,
  groupDone,
  projectsTabGroups,
  todayIso,
} from './projects-parts/data';
import { GroupBlock, SubGroup } from './projects-parts/cards';

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
  onOpen: (project: Project) => void;
  onToggleStep: (project: Project, step: Step) => void;
  onDropProject: (path: string, newStatus: string) => void;
  onWorkOn: (project: Project) => void;
  /** Open the "+ New project" modal. Rendered as a top-of-pane button when
   * the user isn't searching. Optional so consumers that don't expose the
   * create flow keep working unchanged. */
  onNewProject?: () => void;
}) {
  return (
    <div class="projects-stack">
      <For each={projectsTabGroups(props.buckets)}>
        {(group) => {
          // The "+ New project" button rides the NOW section header so it
          // sits on the same row as the section title. Other sections
          // don't get the action — creating an item from "later" or
          // "backlog" would still land in NOW and the affordance reads
          // most clearly when it's anchored to the active-work section.
          const headerAction =
            group.status === 'now' && props.onNewProject
              ? () => (
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
                )
              : undefined;
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
              headerAction={headerAction}
            />
          );
        }}
      </For>
    </div>
  );
}
