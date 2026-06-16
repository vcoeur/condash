import { For, Show } from 'solid-js';
import type { OpenWithSlotKey, OpenWithSlots, RepoEntry, Worktree } from '@shared/types';
import { createDropdownMenu } from '../../dropdown-menu';
import { ChevronDownIcon, FolderIcon, RunIcon, StopIcon, TerminalIcon } from '../../icons';
import { LAUNCHER_GLYPH, LAUNCHER_SLOTS } from './data';

/**
 * Per-branch action group. Two direct buttons — Run and Open shell in the
 * condash terminal tab — plus a chevron that toggles the open_with menu.
 * The menu carries every configured launcher (main IDE, secondary IDE,
 * external terminal) plus the OS file manager entry. The dropdown is
 * rendered as a `position: fixed` overlay anchored to the trigger to
 * escape the parent's stacking context, fixing the long-standing "menu
 * hides under neighbouring cards" bug.
 */
export function BranchActions(props: {
  repo: RepoEntry;
  worktree: Worktree;
  slots: OpenWithSlots;
  hasRun: boolean;
  /** True when this branch row owns the currently live session — drives
   * the run-vs-stop swap so the user controls the running process from
   * the row that actually represents it. */
  running: boolean;
  onOpen: (path: string) => void;
  onPull: (path: string) => void;
  onLaunch: (slot: OpenWithSlotKey, path: string) => void;
  onRun: (repo: RepoEntry, worktree?: Worktree) => void;
  onStop: (repo: RepoEntry) => void;
  onOpenInTerm: (repo: RepoEntry, worktree: Worktree) => void;
}) {
  const menu = createDropdownMenu();

  const launcherEntries = (): OpenWithSlotKey[] =>
    LAUNCHER_SLOTS.filter((slot) => !!props.slots[slot]);

  // "Pull branch" only makes sense for a real git checkout sitting on a
  // branch — hidden for a missing path, a plain (non-git) directory, or a
  // detached HEAD (no branch to fast-forward).
  const canPull = (): boolean =>
    !props.repo.missing && props.repo.isGit !== false && props.worktree.branch != null;

  return (
    <div class="branch-actions">
      <Show when={props.hasRun}>
        <Show
          when={props.running}
          fallback={
            <button
              class="repo-action run"
              onClick={() => props.onRun(props.repo, props.worktree)}
              disabled={props.repo.missing}
              title={
                props.worktree.primary
                  ? 'Run configured run: command'
                  : `Run configured run: command in ${props.worktree.branch ?? '(no branch)'}`
              }
              aria-label="Run"
            >
              <RunIcon />
            </button>
          }
        >
          <button
            class="repo-action stop"
            onClick={() => props.onStop(props.repo)}
            title={`Stop the running session for ${props.repo.name}`}
            aria-label={`Stop ${props.repo.name}`}
          >
            <StopIcon />
          </button>
        </Show>
      </Show>
      <button
        class="repo-action icon"
        onClick={() => props.onOpenInTerm(props.repo, props.worktree)}
        disabled={props.repo.missing}
        title="Open shell in condash terminal tab"
        aria-label="Open in terminal tab"
      >
        <TerminalIcon />
      </button>
      <button
        ref={menu.setTrigger}
        class="repo-action icon"
        onClick={menu.toggle}
        aria-haspopup="menu"
        aria-expanded={menu.isOpen()}
        title="Open with…"
        aria-label="Open with…"
      >
        <ChevronDownIcon />
      </button>
      <Show when={menu.isOpen() && menu.anchor()}>
        <div
          ref={menu.setMenu}
          class="branch-action-menu portal"
          role="menu"
          style={{
            top: `${menu.anchor()!.top}px`,
            left: `${menu.anchor()!.left}px`,
          }}
        >
          <For each={launcherEntries()}>
            {(slot) => (
              <button
                class="branch-action-menu-item"
                role="menuitem"
                onClick={() => {
                  menu.close();
                  props.onLaunch(slot, props.worktree.path);
                }}
              >
                <span class="glyph">{LAUNCHER_GLYPH[slot]}</span>
                <span>{props.slots[slot]!.label}</span>
              </button>
            )}
          </For>
          <button
            class="branch-action-menu-item"
            role="menuitem"
            disabled={props.repo.missing}
            onClick={() => {
              menu.close();
              props.onOpen(props.worktree.path);
            }}
          >
            <span class="glyph">
              <FolderIcon />
            </span>
            <span>Open in file manager</span>
          </button>
          <Show when={canPull()}>
            <button
              class="branch-action-menu-item"
              role="menuitem"
              title="Fast-forward this branch to its upstream (git pull --ff-only)"
              onClick={() => {
                menu.close();
                props.onPull(props.worktree.path);
              }}
            >
              <span class="glyph">↓</span>
              <span>Pull branch</span>
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
