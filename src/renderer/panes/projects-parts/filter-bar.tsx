import { For, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { appColorClass, appPillText } from '@shared/app-color';
import { Button, IconButton } from '../../actions';
import { createDropdownMenu } from '../../dropdown-menu';
import { ChevronDownIcon, IconClose } from '../../icons';
import { SearchIcon, StarIcon } from './icons';
import { EMPTY_PROJECT_FILTER, type ProjectFilter } from './data';

/**
 * Search + filter bar at the top of the Projects pane: a README-content search
 * field, a starred-only toggle, and an apps multiselect. Purely presentational
 * — the filter value is owned by ProjectsView, which also runs the search,
 * decides when the filter counts as active (`active`: a typed query only once
 * its answer is in), and applies the three predicates (`applyProjectFilter` in
 * data.ts). Every control writes back through `onChange` with a fresh filter
 * object. Buttons are the shared action vocabulary (`actions.css`), so the bar
 * restyles with every other toolbar.
 */
export function ProjectsFilterBar(props: {
  filter: ProjectFilter;
  /** Whether the pane is currently filtering on this value — drives the
   *  "N of M · Clear filters" tail, so the bar and the pane cannot disagree. */
  active: boolean;
  /** Every app handle the current project list mentions, sorted — the
   *  multiselect's option list. */
  appOptions: string[];
  /** Cards left after filtering, shown next to the clear button while a
   *  filter is active so an empty result reads as "0 of N", not as a bug. */
  matchCount: number;
  totalCount: number;
  onChange: (next: ProjectFilter) => void;
}) {
  const appsMenu = createDropdownMenu({ align: 'left' });
  const patch = (partial: Partial<ProjectFilter>): void =>
    props.onChange({ ...props.filter, ...partial });
  const toggleApp = (handle: string): void => {
    const current = props.filter.apps;
    patch({
      apps: current.includes(handle) ? current.filter((a) => a !== handle) : [...current, handle],
    });
  };
  return (
    <div class="projects-filter" role="search" aria-label="Filter projects">
      <label class="projects-filter-search">
        <span class="projects-filter-search-icon" aria-hidden="true">
          <SearchIcon />
        </span>
        <input
          type="text"
          class="projects-filter-input"
          placeholder="Search READMEs…"
          aria-label="Search project READMEs"
          value={props.filter.query}
          onInput={(event) => patch({ query: event.currentTarget.value })}
          onKeyDown={(event) => {
            // Esc clears the field (and only the field) instead of bubbling
            // to whatever modal-level Esc handler is listening.
            if (event.key === 'Escape' && props.filter.query !== '') {
              event.preventDefault();
              event.stopPropagation();
              patch({ query: '' });
            }
          }}
        />
        <Show when={props.filter.query !== ''}>
          <IconButton
            variant="ghost"
            size="sm"
            class="projects-filter-clear-query"
            title="Clear search"
            aria-label="Clear search"
            onClick={() => patch({ query: '' })}
          >
            <IconClose />
          </IconButton>
        </Show>
      </label>

      <Button
        size="sm"
        class="projects-filter-starred"
        classList={{ 'btn--active': props.filter.starredOnly }}
        aria-pressed={props.filter.starredOnly}
        title={props.filter.starredOnly ? 'Showing starred items only' : 'Show starred items only'}
        onClick={() => patch({ starredOnly: !props.filter.starredOnly })}
      >
        <StarIcon filled={props.filter.starredOnly} />
        <span>Starred</span>
      </Button>

      <Button
        size="sm"
        class="projects-filter-apps"
        classList={{ 'btn--active': props.filter.apps.length > 0 }}
        aria-haspopup="true"
        aria-expanded={appsMenu.isOpen()}
        title="Filter by app"
        ref={appsMenu.setTrigger}
        onClick={(event) => appsMenu.toggle(event)}
      >
        <span>Apps</span>
        <Show when={props.filter.apps.length > 0}>
          <span class="projects-filter-chip-count">{props.filter.apps.length}</span>
        </Show>
        <span class="projects-filter-chip-caret" aria-hidden="true">
          <ChevronDownIcon />
        </span>
      </Button>
      <Show when={appsMenu.isOpen() && appsMenu.anchor()}>
        <Portal>
          <div
            ref={appsMenu.setMenu}
            class="projects-filter-apps-menu portal"
            role="group"
            aria-label="Filter by app"
            style={{
              position: 'fixed',
              top: `${appsMenu.anchor()!.top}px`,
              left: `${appsMenu.anchor()!.left}px`,
              'z-index': '1000',
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <Show
              when={props.appOptions.length > 0}
              fallback={<div class="projects-filter-apps-empty">No apps on any item</div>}
            >
              <For each={props.appOptions}>
                {(handle) => (
                  <label class="projects-filter-apps-option">
                    <input
                      type="checkbox"
                      checked={props.filter.apps.includes(handle)}
                      onChange={() => toggleApp(handle)}
                    />
                    <span class={`app-pill ${appColorClass(handle)}`}>{appPillText(handle)}</span>
                  </label>
                )}
              </For>
            </Show>
            <Show when={props.filter.apps.length > 0}>
              <Button
                variant="ghost"
                size="sm"
                class="projects-filter-apps-clear"
                onClick={() => patch({ apps: [] })}
              >
                Clear apps
              </Button>
            </Show>
          </div>
        </Portal>
      </Show>

      <Show when={props.active}>
        <span class="projects-filter-count" aria-live="polite">
          {props.matchCount} of {props.totalCount}
        </span>
        <Button
          variant="ghost"
          size="sm"
          class="projects-filter-reset"
          onClick={() => props.onChange(EMPTY_PROJECT_FILTER)}
        >
          Clear filters
        </Button>
      </Show>
    </div>
  );
}
