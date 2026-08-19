import { For, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import { appColorClass, appPillText } from '@shared/app-color';
import { createDropdownMenu } from '../../dropdown-menu';
import { ChevronDownIcon, IconClose } from '../../icons';
import { StarIcon } from './icons';
import type { ProjectFilter } from './data';

/** Magnifier for the search field — same stroked, rounded vocabulary as the
 *  shared icon set; local because nothing else in the app draws one. */
function SearchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.25 10.25L13.5 13.5" />
    </svg>
  );
}

/**
 * Search + filter bar at the top of the Projects pane: a README-content search
 * field, a starred-only toggle, and an apps multiselect. Purely presentational
 * — the filter value is owned by ProjectsView, which also runs the search and
 * applies the three predicates (see `applyProjectFilter` in data.ts). Every
 * control writes back through `onChange` with a fresh filter object.
 */
export function ProjectsFilterBar(props: {
  filter: ProjectFilter;
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
  const active = (): boolean =>
    props.filter.starredOnly || props.filter.apps.length > 0 || props.filter.query.trim() !== '';
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
          <button
            type="button"
            class="projects-filter-clear-query"
            title="Clear search"
            aria-label="Clear search"
            onClick={() => patch({ query: '' })}
          >
            <IconClose />
          </button>
        </Show>
      </label>

      <button
        type="button"
        class="projects-filter-chip projects-filter-starred"
        classList={{ active: props.filter.starredOnly }}
        aria-pressed={props.filter.starredOnly}
        title={props.filter.starredOnly ? 'Showing starred items only' : 'Show starred items only'}
        onClick={() => patch({ starredOnly: !props.filter.starredOnly })}
      >
        <StarIcon filled={props.filter.starredOnly} />
        <span>Starred</span>
      </button>

      <button
        type="button"
        class="projects-filter-chip projects-filter-apps"
        classList={{ active: props.filter.apps.length > 0 }}
        aria-haspopup="listbox"
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
      </button>
      <Show when={appsMenu.isOpen() && appsMenu.anchor()}>
        <Portal>
          <div
            ref={appsMenu.setMenu}
            class="projects-filter-apps-menu portal"
            role="listbox"
            aria-multiselectable="true"
            aria-label="Apps"
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
                {(handle) => {
                  const selected = (): boolean => props.filter.apps.includes(handle);
                  return (
                    <label class="projects-filter-apps-option" classList={{ selected: selected() }}>
                      <input
                        type="checkbox"
                        checked={selected()}
                        onChange={() => toggleApp(handle)}
                      />
                      <span class={`app-pill ${appColorClass(handle)}`}>{appPillText(handle)}</span>
                    </label>
                  );
                }}
              </For>
            </Show>
            <Show when={props.filter.apps.length > 0}>
              <button
                type="button"
                class="projects-filter-apps-clear"
                onClick={() => patch({ apps: [] })}
              >
                Clear apps
              </button>
            </Show>
          </div>
        </Portal>
      </Show>

      <Show when={active()}>
        <span class="projects-filter-count" aria-live="polite">
          {props.matchCount} of {props.totalCount}
        </span>
        <button
          type="button"
          class="projects-filter-reset"
          onClick={() => props.onChange({ starredOnly: false, apps: [], query: '' })}
        >
          Clear filters
        </button>
      </Show>
    </div>
  );
}
