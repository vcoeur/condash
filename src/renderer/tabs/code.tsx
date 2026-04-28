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

/** Per-card status pill text — collapses worktree dirtiness into one of:
 * "CLEAN", "1 BRANCH DIRTY", "N BRANCHES DIRTY", "MISSING", "?". */
function cardStatusLabel(repo: RepoEntry): string {
  if (repo.missing) return 'MISSING';
  const wts = ensureWorktrees(repo);
  const dirtyCount = wts.filter((w) => (w.dirty ?? 0) > 0).length;
  if (dirtyCount === 0) {
    if (wts.every((w) => w.dirty === null || w.dirty === undefined)) return '?';
    return 'CLEAN';
  }
  return dirtyCount === 1 ? '1 BRANCH DIRTY' : `${dirtyCount} BRANCHES DIRTY`;
}

function cardStatus(repo: RepoEntry): RepoStatus {
  if (repo.missing) return 'missing';
  const wts = ensureWorktrees(repo);
  if (wts.every((w) => w.dirty === null || w.dirty === undefined)) return 'unknown';
  return wts.some((w) => (w.dirty ?? 0) > 0) ? 'dirty' : 'clean';
}

export function RepoRow(props: {
  repo: RepoEntry;
  slots: OpenWithSlots;
  /** True when at least one terminal session is currently running for this repo. */
  live?: boolean;
  onOpen: (path: string) => void;
  onLaunch: (slot: OpenWithSlotKey, path: string) => void;
  onForceStop: (repo: RepoEntry) => void;
  onStop: (repo: RepoEntry) => void;
  onRun: (repo: RepoEntry, worktree?: Worktree) => void;
}) {
  const status = (): RepoStatus => cardStatus(props.repo);
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

  const hasRun = (): boolean => !props.repo.missing;

  return (
    <article
      class="repo-row"
      classList={{
        missing: props.repo.missing,
        submodule: !!props.repo.parent,
      }}
      data-status={status()}
    >
      <header class="repo-head">
        <span class="repo-name">{displayName()}</span>
        <span class="repo-status-badge" data-status={status()}>
          {cardStatusLabel(props.repo)}
        </span>
        <Show when={props.live}>
          <span class="repo-live-badge" title="A terminal session is running for this repo">
            LIVE
          </span>
        </Show>
        <Show when={props.live && props.repo.hasForceStop}>
          <button
            class="repo-action stop repo-stop-button"
            onClick={() => props.onStop(props.repo)}
            title={`Stop the running session for ${props.repo.name} (runs force_stop)`}
            aria-label={`Stop ${props.repo.name}`}
          >
            ⏹
          </button>
        </Show>
        <span class="spacer" />
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
              <span class="branch-role">{wt.primary ? 'CHECKOUT' : 'WORKTREE'}</span>
              <Show when={(wt.dirty ?? 0) > 0}>
                <span class="branch-dirty">{wt.dirty} dirty</span>
              </Show>
              <Show when={wt.primary && props.live}>
                <span class="branch-live-dot" title="Running" aria-label="Running" />
              </Show>
              <span class="spacer" />
              <BranchActions
                repo={props.repo}
                worktree={wt}
                slots={props.slots}
                hasRun={hasRun()}
                onOpen={props.onOpen}
                onLaunch={props.onLaunch}
                onForceStop={props.onForceStop}
                onRun={props.onRun}
              />
            </li>
          )}
        </For>
      </ul>
      <span class="repo-path" title={props.repo.path}>
        {props.repo.path}
      </span>
    </article>
  );
}

/** Per-branch action group: a primary Run + Open pair always visible, plus
 * the editor / terminal launchers and force_stop tucked behind a ▼ menu so
 * the row stays compact at narrower card widths. */
function BranchActions(props: {
  repo: RepoEntry;
  worktree: Worktree;
  slots: OpenWithSlots;
  hasRun: boolean;
  onOpen: (path: string) => void;
  onLaunch: (slot: OpenWithSlotKey, path: string) => void;
  onForceStop: (repo: RepoEntry) => void;
  onRun: (repo: RepoEntry, worktree?: Worktree) => void;
}) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  let menuRoot: HTMLDivElement | undefined;

  const onDocClick = (e: MouseEvent) => {
    if (!menuOpen()) return;
    if (menuRoot && !menuRoot.contains(e.target as Node)) setMenuOpen(false);
  };
  onMount(() => document.addEventListener('click', onDocClick, true));
  onCleanup(() => document.removeEventListener('click', onDocClick, true));

  const showForceStop = (): boolean => props.worktree.primary && !!props.repo.hasForceStop;
  const launcherEntries = (): OpenWithSlotKey[] =>
    LAUNCHER_SLOTS.filter((slot) => !!props.slots[slot]);
  const hasOverflow = (): boolean => showForceStop() || launcherEntries().length > 0;

  return (
    <div class="branch-actions" ref={(el) => (menuRoot = el)}>
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
        >
          ▶
        </button>
      </Show>
      <button
        class="repo-action icon"
        onClick={() => props.onOpen(props.worktree.path)}
        disabled={props.repo.missing}
        title="Open in OS file manager"
      >
        📁
      </button>
      <Show when={hasOverflow()}>
        <button
          class="repo-action icon"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          aria-haspopup="menu"
          aria-expanded={menuOpen()}
          title="More actions"
        >
          ▾
        </button>
      </Show>
      <Show when={menuOpen() && hasOverflow()}>
        <div class="branch-action-menu" role="menu">
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
          <Show when={showForceStop()}>
            <button
              class="branch-action-menu-item warn"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                props.onForceStop(props.repo);
              }}
            >
              <span class="glyph">⏹</span>
              <span>Force-stop</span>
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
