import { Show } from 'solid-js';
import type { RepoEntry } from '@shared/types';
import { createDropdownMenu } from '../../dropdown-menu';
import { ChevronDownIcon, KillIcon } from '../../icons';

/**
 * Card-level menu for per-repo actions. Sits at the right of the card
 * header — always rendered for layout consistency, even when no entry
 * is currently actionable. Carries one entry today (Force-stop), which
 * is disabled when the repo has no `force_stop:` configured. Future
 * per-repo actions land in the same dropdown. Portaled (position:
 * fixed) so it always paints above neighbouring cards.
 */
export function RepoCardMenu(props: { repo: RepoEntry; onForceStop: (repo: RepoEntry) => void }) {
  const menu = createDropdownMenu();

  return (
    <>
      <button
        ref={menu.setTrigger}
        class="repo-action icon repo-card-menu-trigger"
        onClick={menu.toggle}
        aria-haspopup="menu"
        aria-expanded={menu.isOpen()}
        title="Repo actions"
        aria-label={`Actions for ${props.repo.name}`}
      >
        <ChevronDownIcon />
      </button>
      <Show when={menu.isOpen() && menu.anchor()}>
        <div
          ref={menu.setMenu}
          class="branch-action-menu portal repo-card-menu"
          role="menu"
          style={{
            top: `${menu.anchor()!.top}px`,
            left: `${menu.anchor()!.left}px`,
          }}
        >
          <button
            class="branch-action-menu-item warn"
            classList={{ disabled: !props.repo.hasForceStop }}
            role="menuitem"
            disabled={!props.repo.hasForceStop}
            title={
              props.repo.hasForceStop
                ? undefined
                : 'No force_stop: configured for this repo in condash.json'
            }
            onClick={() => {
              if (!props.repo.hasForceStop) return;
              menu.close();
              props.onForceStop(props.repo);
            }}
          >
            <span class="glyph">
              <KillIcon />
            </span>
            <span>Force-stop {props.repo.name}</span>
          </button>
        </div>
      </Show>
    </>
  );
}
