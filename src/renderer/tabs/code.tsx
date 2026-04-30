import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import type { OpenWithSlotKey, OpenWithSlots, RepoEntry, Worktree } from '@shared/types';

type RepoStatus = 'missing' | 'unknown' | 'clean' | 'dirty';

export type RepoGroup = { id: string; label: string; entries: RepoEntry[] };

const LAUNCHER_SLOTS: readonly OpenWithSlotKey[] = ['main_ide', 'secondary_ide', 'terminal'];
const LAUNCHER_GLYPH: Record<OpenWithSlotKey, string> = {
  main_ide: '⌘',
  secondary_ide: '⌥',
  terminal: '▶',
};

export function groupRepos(repos: readonly RepoEntry[]): RepoGroup[] {
  const childrenByParent = new Map<string, RepoEntry[]>();
  for (const r of repos) {
    if (!r.parent) continue;
    const arr = childrenByParent.get(r.parent) ?? [];
    arr.push(r);
    childrenByParent.set(r.parent, arr);
  }
  const primary: RepoEntry[] = [];
  const secondary: RepoEntry[] = [];
  const submoduleParents: { parent: RepoEntry; children: RepoEntry[] }[] = [];
  for (const r of repos) {
    if (r.parent) continue;
    const kids = childrenByParent.get(r.name);
    if (kids && kids.length > 0) {
      submoduleParents.push({ parent: r, children: kids });
    } else if (r.kind === 'primary') {
      primary.push(r);
    } else {
      secondary.push(r);
    }
  }
  const groups: RepoGroup[] = [];
  if (primary.length > 0) groups.push({ id: 'primary', label: 'PRIMARY', entries: primary });
  for (const { parent, children } of submoduleParents) {
    groups.push({
      id: parent.name,
      label: parent.name.toUpperCase(),
      entries: [parent, ...children],
    });
  }
  if (secondary.length > 0)
    groups.push({ id: 'secondary', label: 'SECONDARY', entries: secondary });
  return groups;
}

/** Synthesise the primary checkout as a Worktree-shaped row when the data
 * layer didn't return any worktrees (e.g. repo missing or git failed). The
 * branch is unknown so we leave it null. */
function ensureWorktrees(repo: RepoEntry): Worktree[] {
  if (repo.worktrees && repo.worktrees.length > 0) return repo.worktrees;
  return [
    {
      path: repo.path,
      branch: null,
      primary: true,
      dirty: repo.dirty,
    },
  ];
}

/** Sort: primary checkout first, then worktrees alphabetically. */
function orderedWorktrees(repo: RepoEntry): Worktree[] {
  const list = ensureWorktrees(repo).slice();
  list.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    return (a.branch ?? '').localeCompare(b.branch ?? '');
  });
  return list;
}

export function RepoRow(props: {
  repo: RepoEntry;
  slots: OpenWithSlots;
  /** True when at least one terminal session is currently running for this repo. */
  live?: boolean;
  /** Branch name of the live session, when known — surfaced on the card face
   * so the user can see what's running at a glance. */
  liveBranch?: string | null;
  onOpen: (path: string) => void;
  onLaunch: (slot: OpenWithSlotKey, path: string) => void;
  onForceStop: (repo: RepoEntry) => void;
  onStop: (repo: RepoEntry) => void;
  onRun: (repo: RepoEntry, worktree?: Worktree) => void;
  onOpenInTerm: (repo: RepoEntry, worktree: Worktree) => void;
}) {
  const displayName = (): string => {
    if (props.repo.parent && props.repo.name.startsWith(`${props.repo.parent}/`)) {
      return props.repo.name.slice(props.repo.parent.length + 1);
    }
    return props.repo.name;
  };

  const branchStatus = (wt: Worktree): RepoStatus => {
    if (props.repo.missing) return 'missing';
    if (wt.dirty == null) return 'unknown';
    return wt.dirty === 0 ? 'clean' : 'dirty';
  };

  const hasRun = (): boolean => !props.repo.missing && !!props.repo.hasRun;

  const liveBranchLabel = (): string | null => {
    if (!props.live) return null;
    if (props.liveBranch) return props.liveBranch;
    // No branch known — fall back to a generic running marker so the card
    // still surfaces the live state on the face.
    return '(running)';
  };

  return (
    <article
      class="repo-row"
      classList={{
        missing: props.repo.missing,
      }}
    >
      <header class="repo-head">
        <span class="repo-name">{displayName()}</span>
        <Show when={liveBranchLabel()}>
          <span
            class="repo-live-branch"
            title={`Running: ${liveBranchLabel()}`}
            aria-label={`Running on ${liveBranchLabel()}`}
          >
            <span class="repo-live-dot-inline" aria-hidden="true" />
            <span class="repo-live-branch-label">{liveBranchLabel()}</span>
          </span>
        </Show>
        <span class="spacer" />
        <Show when={props.live}>
          <button
            class="repo-action stop repo-stop-button"
            onClick={() => props.onStop(props.repo)}
            title={`Stop the running session for ${props.repo.name}`}
            aria-label={`Stop ${props.repo.name}`}
          >
            ⏹
          </button>
        </Show>
        <Show when={props.repo.hasForceStop}>
          <button
            class="repo-action warn repo-killswitch"
            onClick={() => props.onForceStop(props.repo)}
            title={`Run ${props.repo.name} force_stop (free its port)`}
            aria-label={`Force-stop ${props.repo.name}`}
          >
            ⛒
          </button>
        </Show>
        <span class="repo-kind-tag" title={`Configured under repositories.${props.repo.kind}`}>
          {props.repo.parent ? 'SUB' : 'REPO'}
        </span>
      </header>
      <ul class="branches">
        <For each={orderedWorktrees(props.repo)}>
          {(wt) => (
            <li class="branch-row" data-status={branchStatus(wt)}>
              <span class="branch-dot" aria-hidden="true" />
              <span class="branch-name">{wt.branch ?? '(detached)'}</span>
              <Show when={(wt.dirty ?? 0) > 0}>
                <span class="branch-dirty">{wt.dirty} dirty</span>
              </Show>
              <Show when={props.live && (props.liveBranch ?? null) === (wt.branch ?? null)}>
                <span class="branch-live-dot" title="Running" aria-label="Running" />
              </Show>
              <span class="spacer" />
              <BranchActions
                repo={props.repo}
                worktree={wt}
                slots={props.slots}
                hasRun={hasRun()}
                onLaunch={props.onLaunch}
                onRun={props.onRun}
                onOpenInTerm={props.onOpenInTerm}
                onOpen={props.onOpen}
              />
            </li>
          )}
        </For>
      </ul>
    </article>
  );
}

/**
 * Per-branch action group. Three primary direct icons — Run ▶, Open in
 * condash term tab ⌗, and a triangle that toggles the open_with menu —
 * plus a file-manager affordance. The open_with dropdown is rendered as
 * a `position: fixed` overlay (anchored to the trigger button) to escape
 * the parent's stacking context, fixing the long-standing "menu hides
 * under neighbouring cards" bug.
 */
function BranchActions(props: {
  repo: RepoEntry;
  worktree: Worktree;
  slots: OpenWithSlots;
  hasRun: boolean;
  onOpen: (path: string) => void;
  onLaunch: (slot: OpenWithSlotKey, path: string) => void;
  onRun: (repo: RepoEntry, worktree?: Worktree) => void;
  onOpenInTerm: (repo: RepoEntry, worktree: Worktree) => void;
}) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuAnchor, setMenuAnchor] = createSignal<{ top: number; left: number } | null>(null);
  let triggerRef: HTMLButtonElement | undefined;
  let menuRef: HTMLDivElement | undefined;

  const launcherEntries = (): OpenWithSlotKey[] =>
    LAUNCHER_SLOTS.filter((slot) => !!props.slots[slot]);
  const hasLaunchers = (): boolean => launcherEntries().length > 0;

  const positionMenu = (): void => {
    if (!triggerRef) return;
    const rect = triggerRef.getBoundingClientRect();
    setMenuAnchor({ top: rect.bottom + 4, left: rect.right });
  };

  const onDocClick = (e: MouseEvent): void => {
    if (!menuOpen()) return;
    const target = e.target as Node;
    if (triggerRef?.contains(target)) return;
    if (menuRef?.contains(target)) return;
    setMenuOpen(false);
  };

  const onScrollOrResize = (): void => {
    if (menuOpen()) positionMenu();
  };

  onMount(() => {
    document.addEventListener('click', onDocClick, true);
    window.addEventListener('resize', onScrollOrResize, true);
    window.addEventListener('scroll', onScrollOrResize, true);
  });
  onCleanup(() => {
    document.removeEventListener('click', onDocClick, true);
    window.removeEventListener('resize', onScrollOrResize, true);
    window.removeEventListener('scroll', onScrollOrResize, true);
  });

  const toggleMenu = (e: MouseEvent): void => {
    e.stopPropagation();
    if (menuOpen()) {
      setMenuOpen(false);
      return;
    }
    positionMenu();
    setMenuOpen(true);
  };

  return (
    <div class="branch-actions">
      <Show when={props.hasRun}>
        <button
          class="repo-action run"
          onClick={() => props.onRun(props.repo, props.worktree)}
          disabled={props.repo.missing}
          title={
            props.worktree.primary
              ? 'Run configured run: command'
              : `Run configured run: command in ${props.worktree.branch ?? '(detached)'}`
          }
          aria-label="Run"
        >
          ▶
        </button>
      </Show>
      <button
        class="repo-action icon"
        onClick={() => props.onOpenInTerm(props.repo, props.worktree)}
        disabled={props.repo.missing}
        title="Open shell in condash terminal tab"
        aria-label="Open in terminal tab"
      >
        ⌗
      </button>
      <button
        class="repo-action icon"
        onClick={() => props.onOpen(props.worktree.path)}
        disabled={props.repo.missing}
        title="Open in OS file manager"
        aria-label="Open in file manager"
      >
        📁
      </button>
      <Show when={hasLaunchers()}>
        <button
          ref={(el) => (triggerRef = el)}
          class="repo-action icon"
          onClick={toggleMenu}
          aria-haspopup="menu"
          aria-expanded={menuOpen()}
          title="Open with…"
        >
          ▾
        </button>
      </Show>
      <Show when={menuOpen() && hasLaunchers() && menuAnchor()}>
        <div
          ref={(el) => (menuRef = el)}
          class="branch-action-menu portal"
          role="menu"
          style={{
            top: `${menuAnchor()!.top}px`,
            left: `${menuAnchor()!.left}px`,
          }}
        >
          <For each={launcherEntries()}>
            {(slot) => (
              <button
                class="branch-action-menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  props.onLaunch(slot, props.worktree.path);
                }}
              >
                <span class="glyph">{LAUNCHER_GLYPH[slot]}</span>
                <span>{props.slots[slot]!.label}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
