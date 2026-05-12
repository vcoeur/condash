import { For, Show } from 'solid-js';
import { createDropdownMenu } from '../../dropdown-menu';
import { ChevronDownIcon } from '../../icons';

/**
 * Top-of-Code-pane branch filter. The control opens a checkbox list of
 * every non-primary branch known across the visible cards; ticking a
 * branch reveals that row on every card that carries it. The primary
 * worktree row is always rendered — the filter is additive on top of it,
 * which is why there is no "Clear all" / "Select all" affordance.
 *
 * Empty `available` ⇒ the bar renders nothing (no non-primary worktrees
 * to filter). Visual states:
 *
 *   - `selected.size === 0` — trigger label is "Branches (none pinned)".
 *   - otherwise — "Branches (N selected)" with `selected.size`.
 *
 * Branches that match an active conception project (`status ∈ {now,
 * review}` with a non-null `**Branch**`) get a "project" badge so the
 * "what am I working on right now" choices stand out from ad-hoc local
 * branches.
 */
export function BranchFilter(props: {
  available: readonly string[];
  selected: ReadonlySet<string>;
  activeProjectBranches: ReadonlySet<string>;
  onToggle: (branch: string) => void;
}) {
  const menu = createDropdownMenu();

  const triggerLabel = (): string => {
    const n = props.selected.size;
    if (n === 0) return 'Branches (none pinned)';
    return `Branches (${n} selected)`;
  };

  return (
    <Show when={props.available.length > 0}>
      <div class="branch-filter-bar">
        <button
          ref={menu.setTrigger}
          type="button"
          class="branch-filter-trigger"
          classList={{ active: props.selected.size > 0 }}
          aria-haspopup="menu"
          aria-expanded={menu.isOpen()}
          aria-label="Pin branches visible on every app card"
          title="Pin branches visible on every app card"
          onClick={menu.toggle}
        >
          <span class="branch-filter-trigger-label">{triggerLabel()}</span>
          <ChevronDownIcon />
        </button>
        <Show when={menu.isOpen() && menu.anchor()}>
          <div
            ref={menu.setMenu}
            class="branch-filter-menu portal"
            role="menu"
            style={{
              top: `${menu.anchor()!.top}px`,
              left: `${menu.anchor()!.left}px`,
            }}
          >
            <header class="branch-filter-menu-head">
              <span>Pin branches</span>
              <span class="branch-filter-menu-hint">
                Main row always visible · selection is additive
              </span>
            </header>
            <ul class="branch-filter-list">
              <For each={props.available}>
                {(branch) => {
                  const checked = (): boolean => props.selected.has(branch);
                  const isActiveProject = (): boolean => props.activeProjectBranches.has(branch);
                  return (
                    <li>
                      <label
                        class="branch-filter-item"
                        classList={{ 'active-project': isActiveProject() }}
                      >
                        <input
                          type="checkbox"
                          checked={checked()}
                          onChange={() => props.onToggle(branch)}
                          aria-label={`Pin branch ${branch}`}
                        />
                        <span class="branch-filter-item-name">{branch}</span>
                        <Show when={isActiveProject()}>
                          <span
                            class="branch-filter-item-badge"
                            title="An active conception project is on this branch"
                          >
                            project
                          </span>
                        </Show>
                      </label>
                    </li>
                  );
                }}
              </For>
            </ul>
          </div>
        </Show>
      </div>
    </Show>
  );
}
