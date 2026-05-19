import { For, Show } from 'solid-js';
import { createPositionedPopover } from '../../popover';
import { ChevronDownIcon } from '../../icons';

/**
 * Top-of-Code-pane branch filter. The control opens a checkbox list of
 * every non-primary branch known across the visible cards plus two
 * header quick-actions (issue #169):
 *
 *   - **All (sticky)** — pin every branch *and* auto-pin any branch that
 *     appears later. The state is persisted, so the user gets a true
 *     "show everything, including future branches" mode in one click.
 *   - **None** — clear every check; only the main row stays visible.
 *
 * Tickling an individual branch flips the popover into the implicit
 * Custom mode (the parent store drops `stickyAll` automatically).
 *
 * Trigger label reflects the active mode:
 *
 *   - sticky-all → "Branches (all + future)"
 *   - empty / custom → "Branches (N pinned)" or "Branches (none)"
 *
 * Empty `available` ⇒ the bar renders nothing (no non-primary worktrees
 * to filter).
 *
 * Branches that match an active conception project (`status ∈ {now,
 * review}` with a non-null `**Branch**`) get a "project" badge so the
 * "what am I working on right now" choices stand out from ad-hoc local
 * branches.
 *
 * Uses `createPositionedPopover` (anchors at the trigger's *left* edge)
 * rather than `createDropdownMenu` (anchors at the *right*) — the bar
 * sits at the left of the pane, so a right-edge-aligned dropdown would
 * extend off-screen.
 */
export function BranchFilter(props: {
  available: readonly string[];
  selected: ReadonlySet<string>;
  stickyAll: boolean;
  activeProjectBranches: ReadonlySet<string>;
  onToggle: (branch: string) => void;
  onSetAllSticky: () => void;
  onSetNone: () => void;
}) {
  let triggerEl: HTMLElement | undefined;
  let popoverEl: HTMLElement | undefined;

  const popover = createPositionedPopover({
    popoverRef: () => popoverEl,
    triggerRefs: () => [triggerEl],
    onClose: () => popover.setOpen(false),
  });

  const triggerLabel = (): string => {
    if (props.stickyAll) return 'Branches (all + future)';
    const n = props.selected.size;
    if (n === 0) return 'Branches (none)';
    return `Branches (${n} pinned)`;
  };

  const hintText = (): string => {
    if (props.stickyAll) {
      return 'Main row always visible · All-sticky: every branch shown, new branches auto-pinned';
    }
    return 'Main row always visible · empty selection shows only main';
  };

  const toggleOpen = (e: MouseEvent): void => {
    e.stopPropagation();
    if (popover.open()) {
      popover.setOpen(false);
      return;
    }
    popover.reposition();
    popover.setOpen(true);
  };

  const isNoneMode = (): boolean => !props.stickyAll && props.selected.size === 0;

  return (
    <Show
      when={props.available.length > 0}
      fallback={
        <div class="branch-filter-bar">
          <button
            type="button"
            class="branch-filter-trigger"
            disabled
            title="No multi-branch repos to filter"
          >
            <span class="branch-filter-trigger-label">Branches (none)</span>
            <ChevronDownIcon />
          </button>
        </div>
      }
    >
      <div class="branch-filter-bar">
        <button
          ref={(el) => {
            triggerEl = el;
            popover.setActiveTrigger(el);
          }}
          type="button"
          class="branch-filter-trigger"
          classList={{ active: props.stickyAll || props.selected.size > 0 }}
          aria-haspopup="menu"
          aria-expanded={popover.open()}
          aria-label="Pin branches visible on every app card"
          title="Pin branches visible on every app card"
          onClick={toggleOpen}
        >
          <span class="branch-filter-trigger-label">{triggerLabel()}</span>
          <ChevronDownIcon />
        </button>
        <Show when={popover.open() && popover.anchor()}>
          <div
            ref={(el) => {
              popoverEl = el;
              // Re-measure with the rendered height so the flip-above
              // decision uses the real popover size, not zero.
              if (el) requestAnimationFrame(() => popover.reposition());
            }}
            class="branch-filter-menu portal"
            role="menu"
            style={{
              top: `${popover.anchor()!.top}px`,
              left: `${popover.anchor()!.left}px`,
            }}
          >
            <header class="branch-filter-menu-head">
              <div class="branch-filter-menu-head-row">
                <span>Pin branches</span>
                <div class="branch-filter-menu-actions" role="group" aria-label="Quick actions">
                  <button
                    type="button"
                    class="branch-filter-quick"
                    classList={{ active: props.stickyAll }}
                    aria-pressed={props.stickyAll}
                    title="Show every branch · auto-pin new ones"
                    onClick={() => props.onSetAllSticky()}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    class="branch-filter-quick"
                    classList={{ active: isNoneMode() }}
                    aria-pressed={isNoneMode()}
                    title="Only the main row"
                    onClick={() => props.onSetNone()}
                  >
                    None
                  </button>
                </div>
              </div>
              <span class="branch-filter-menu-hint">{hintText()}</span>
            </header>
            <ul class="branch-filter-list">
              <For each={props.available}>
                {(branch) => {
                  const checked = (): boolean => props.stickyAll || props.selected.has(branch);
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
                        <span class="branch-filter-item-name" title={branch}>
                          {branch}
                        </span>
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
