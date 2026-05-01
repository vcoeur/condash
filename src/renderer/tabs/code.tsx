import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import './code-tab.css';
import type {
  DirtyDetails,
  OpenWithSlotKey,
  OpenWithSlots,
  RepoEntry,
  TermSession,
  TerminalXtermPrefs,
  Worktree,
} from '@shared/types';
import { CodeRunRows } from '../code-runs';
import { ChevronDownIcon, FolderIcon, KillIcon, RunIcon, StopIcon, TerminalIcon } from '../icons';

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

  /** Card title — prefers `label` from `configuration.json` when set, falls
   * back to the directory name. */
  const cardTitle = (): string => props.repo.label ?? displayName();

  /** Secondary directory-name pill: only when a label is set AND it actually
   * differs from the directory name (otherwise the pill would just repeat the
   * title). */
  const secondaryName = (): string | null => {
    if (!props.repo.label) return null;
    const name = displayName();
    return props.repo.label === name ? null : name;
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
        <span class="repo-name">{cardTitle()}</span>
        <Show when={secondaryName()}>
          <span class="repo-dirname" title={`Directory: ${displayName()}`}>
            {secondaryName()}
          </span>
        </Show>
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
        <Show when={props.repo.hasForceStop}>
          <RepoCardMenu repo={props.repo} onForceStop={props.onForceStop} />
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
                <DirtyBadge worktree={wt} subtreeScoped={!!props.repo.parent} />
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
                running={!!props.live && (props.liveBranch ?? null) === (wt.branch ?? null)}
                onLaunch={props.onLaunch}
                onRun={props.onRun}
                onStop={props.onStop}
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
 * Card-level menu for per-repo actions. Sits at the right of the card
 * header. Currently carries one entry — Force-stop — which runs the
 * repo's configured `force_stop:` shell command. Future per-repo actions
 * land in the same dropdown. The menu is portaled (position: fixed) so
 * it always paints above neighbouring cards.
 */
function RepoCardMenu(props: { repo: RepoEntry; onForceStop: (repo: RepoEntry) => void }) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuAnchor, setMenuAnchor] = createSignal<{ top: number; left: number } | null>(null);
  let triggerRef: HTMLButtonElement | undefined;
  let menuRef: HTMLDivElement | undefined;

  // Same anchoring recipe as BranchActions: anchor `left` at the trigger's
  // right edge; the `.branch-action-menu.portal` CSS rule applies a
  // `translateX(-100%)` so the menu's right edge lines up with the
  // trigger's right edge (keeps right-column cards inside the viewport).
  // Flip above when the rendered menu would overflow the viewport bottom.
  const positionMenu = (): void => {
    if (!triggerRef) return;
    const rect = triggerRef.getBoundingClientRect();
    const margin = 8;
    let top = rect.bottom + 4;
    const menuH = menuRef?.getBoundingClientRect().height ?? 0;
    if (menuH > 0 && top + menuH > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - 4 - menuH);
    }
    setMenuAnchor({ top, left: rect.right });
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
    <>
      <button
        ref={(el) => (triggerRef = el)}
        class="repo-action icon repo-card-menu-trigger"
        onClick={toggleMenu}
        aria-haspopup="menu"
        aria-expanded={menuOpen()}
        title="Repo actions"
        aria-label={`Actions for ${props.repo.name}`}
      >
        <ChevronDownIcon />
      </button>
      <Show when={menuOpen() && menuAnchor()}>
        <div
          ref={(el) => {
            menuRef = el;
            if (el) requestAnimationFrame(positionMenu);
          }}
          class="branch-action-menu portal repo-card-menu"
          role="menu"
          style={{
            top: `${menuAnchor()!.top}px`,
            left: `${menuAnchor()!.left}px`,
          }}
        >
          <button
            class="branch-action-menu-item warn"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
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

/**
 * Per-branch action group. Two direct buttons — Run and Open shell in the
 * condash terminal tab — plus a chevron that toggles the open_with menu.
 * The menu carries every configured launcher (main IDE, secondary IDE,
 * external terminal) plus the OS file manager entry. The dropdown is
 * rendered as a `position: fixed` overlay anchored to the trigger to
 * escape the parent's stacking context, fixing the long-standing "menu
 * hides under neighbouring cards" bug.
 */
function BranchActions(props: {
  repo: RepoEntry;
  worktree: Worktree;
  slots: OpenWithSlots;
  hasRun: boolean;
  /** True when this branch row owns the currently live session — drives
   * the run-vs-stop swap so the user controls the running process from
   * the row that actually represents it. */
  running: boolean;
  onOpen: (path: string) => void;
  onLaunch: (slot: OpenWithSlotKey, path: string) => void;
  onRun: (repo: RepoEntry, worktree?: Worktree) => void;
  onStop: (repo: RepoEntry) => void;
  onOpenInTerm: (repo: RepoEntry, worktree: Worktree) => void;
}) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [menuAnchor, setMenuAnchor] = createSignal<{ top: number; left: number } | null>(null);
  let triggerRef: HTMLButtonElement | undefined;
  let menuRef: HTMLDivElement | undefined;

  const launcherEntries = (): OpenWithSlotKey[] =>
    LAUNCHER_SLOTS.filter((slot) => !!props.slots[slot]);

  /** Anchor the menu below the trigger by default, but flip above when
   * the rendered menu would overflow the viewport bottom. The first call
   * (before the menu has mounted) positions optimistically below; the
   * menu's ref callback re-runs this once `menuRef` is set, at which
   * point we know the actual height and can flip if needed. */
  const positionMenu = (): void => {
    if (!triggerRef) return;
    const rect = triggerRef.getBoundingClientRect();
    const margin = 8;
    let top = rect.bottom + 4;
    const menuH = menuRef?.getBoundingClientRect().height ?? 0;
    if (menuH > 0 && top + menuH > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - 4 - menuH);
    }
    setMenuAnchor({ top, left: rect.right });
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
                  : `Run configured run: command in ${props.worktree.branch ?? '(detached)'}`
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
        ref={(el) => (triggerRef = el)}
        class="repo-action icon"
        onClick={toggleMenu}
        aria-haspopup="menu"
        aria-expanded={menuOpen()}
        title="Open with…"
        aria-label="Open with…"
      >
        <ChevronDownIcon />
      </button>
      <Show when={menuOpen() && menuAnchor()}>
        <div
          ref={(el) => {
            menuRef = el;
            // Re-position with the actual rendered height so we can flip
            // above the trigger when the menu would otherwise spill below
            // the viewport (e.g. card sitting near the bottom of the page).
            if (el) requestAnimationFrame(positionMenu);
          }}
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
          <button
            class="branch-action-menu-item"
            role="menuitem"
            disabled={props.repo.missing}
            onClick={() => {
              setMenuOpen(false);
              props.onOpen(props.worktree.path);
            }}
          >
            <span class="glyph">
              <FolderIcon />
            </span>
            <span>Open in file manager</span>
          </button>
        </div>
      </Show>
    </div>
  );
}

/**
 * Per-branch dirty pill that opens a popover listing every dirty path
 * (`git status -s`) plus a `git diff --stat HEAD` snippet. The popover is
 * a portaled `position: fixed` overlay so it always paints above
 * neighbouring cards (same recipe as the open_with menu).
 */
function DirtyBadge(props: { worktree: Worktree; subtreeScoped: boolean }) {
  const [open, setOpen] = createSignal(false);
  const [details, setDetails] = createSignal<DirtyDetails | null>(null);
  const [anchor, setAnchor] = createSignal<{ top: number; left: number } | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let triggerRef: HTMLButtonElement | undefined;
  let popoverRef: HTMLDivElement | undefined;

  /** Anchor the popover below the badge by default, but flip above when
   * the rendered popover would overflow the viewport bottom. The popover
   * fetches `git status` async, so its height changes after the first
   * paint — the ref callback re-runs this once the content lands. */
  const positionPopover = (): void => {
    if (!triggerRef) return;
    const rect = triggerRef.getBoundingClientRect();
    const margin = 8;
    let top = rect.bottom + 4;
    const popH = popoverRef?.getBoundingClientRect().height ?? 0;
    if (popH > 0 && top + popH > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - 4 - popH);
    }
    setAnchor({ top, left: rect.left });
  };

  const close = (): void => {
    setOpen(false);
    setError(null);
  };

  const onDocClick = (e: MouseEvent): void => {
    if (!open()) return;
    const target = e.target as Node;
    if (triggerRef?.contains(target)) return;
    if (popoverRef?.contains(target)) return;
    close();
  };

  const onScrollOrResize = (): void => {
    if (open()) positionPopover();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && open()) close();
  };

  onMount(() => {
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onScrollOrResize, true);
    window.addEventListener('scroll', onScrollOrResize, true);
  });
  onCleanup(() => {
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', onScrollOrResize, true);
    window.removeEventListener('scroll', onScrollOrResize, true);
  });

  // The popover content grows after the async git-status fetch lands.
  // Re-position once details / error change so the flip-above check runs
  // against the final height, not the empty skeleton.
  createEffect(() => {
    details();
    error();
    if (open() && popoverRef) requestAnimationFrame(positionPopover);
  });

  const toggle = async (e: MouseEvent): Promise<void> => {
    e.stopPropagation();
    if (open()) {
      close();
      return;
    }
    positionPopover();
    setOpen(true);
    setError(null);
    try {
      const next = await window.condash.getDirtyDetails(props.worktree.path, {
        scopeToSubtree: props.subtreeScoped,
      });
      setDetails(next);
      if (!next) setError('git status failed for this path');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <button
        ref={(el) => (triggerRef = el)}
        type="button"
        class="branch-dirty"
        onClick={(e) => void toggle(e)}
        aria-haspopup="dialog"
        aria-expanded={open()}
        title="Show dirty files"
      >
        {props.worktree.dirty} dirty
      </button>
      <Show when={open() && anchor()}>
        <div
          ref={(el) => {
            popoverRef = el;
            // Re-position with the actual rendered height so we can flip
            // above the trigger when the popover would otherwise spill
            // below the viewport.
            if (el) requestAnimationFrame(positionPopover);
          }}
          class="branch-dirty-popover"
          role="dialog"
          aria-label={`Dirty files in ${props.worktree.branch ?? '(detached)'}`}
          style={{
            top: `${anchor()!.top}px`,
            left: `${anchor()!.left}px`,
          }}
        >
          <header class="branch-dirty-popover-head">
            <span class="branch-dirty-popover-branch">{props.worktree.branch ?? '(detached)'}</span>
            <span class="branch-dirty-popover-path" title={props.worktree.path}>
              {props.worktree.path}
            </span>
          </header>
          <Show when={error()}>
            <p class="branch-dirty-popover-error">{error()}</p>
          </Show>
          <Show when={details()}>
            {(d) => (
              <>
                <Show
                  when={d().files.length > 0}
                  fallback={<p class="branch-dirty-popover-empty">No dirty files.</p>}
                >
                  <ul class="branch-dirty-popover-files">
                    <For each={d().files}>
                      {(f) => (
                        <li>
                          <span class="branch-dirty-popover-code">{f.code}</span>
                          <span class="branch-dirty-popover-file">{f.path}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={d().diffstat}>
                  <pre class="branch-dirty-popover-diffstat">
                    {d().diffstat}
                    <Show when={d().diffstatTruncated}>
                      <span class="branch-dirty-popover-truncated">{'\n… (truncated)'}</span>
                    </Show>
                  </pre>
                </Show>
              </>
            )}
          </Show>
        </div>
      </Show>
    </>
  );
}

/** Top-level Code-tab view. Renders one section per group (PRIMARY,
 *  per-submodule parents, SECONDARY) with the repo cards and any inline
 *  CodeRunRow sessions slotted under their owning group. */
export function CodeView(props: {
  repos: readonly RepoEntry[];
  groups: readonly RepoGroup[];
  slots: OpenWithSlots;
  liveRepos: ReadonlySet<string>;
  liveSessionCwds: ReadonlyMap<string, string>;
  codeRunSessions: readonly TermSession[];
  xtermPrefs: TerminalXtermPrefs | undefined;
  onOpen: (path: string) => void;
  onLaunch: (slot: OpenWithSlotKey, path: string) => void;
  onForceStop: (repo: RepoEntry) => void;
  onStop: (repo: RepoEntry) => void;
  onRun: (repo: RepoEntry, worktree?: Worktree) => void;
  onOpenInTerm: (repo: RepoEntry, worktree: Worktree) => void;
  onCloseSession: (id: string) => void;
}) {
  return (
    <div class="repos-pane">
      <For each={props.groups}>
        {(group) => {
          // Active runs for this group only, sorted to mirror the section's
          // repo order so what's running for "condash" appears below the
          // "condash" card and so on.
          const groupSessions = (): readonly TermSession[] => {
            const order = new Map(group.entries.map((e, i) => [e.name, i]));
            return props.codeRunSessions
              .filter((s) => s.repo && order.has(s.repo))
              .slice()
              .sort((a, b) => (order.get(a.repo!) ?? 0) - (order.get(b.repo!) ?? 0));
          };
          return (
            <section class="repos-group" data-group={group.id}>
              <h2 class="repos-group-header">
                <span class="name">{group.label}</span>
                <span class="count">{group.entries.length}</span>
                <span class="rule" />
              </h2>
              <div class="repos-grid">
                <For each={group.entries}>
                  {(repo) => {
                    const liveBranch = (): string | null => {
                      const cwd = props.liveSessionCwds.get(repo.name);
                      if (!cwd) return null;
                      const wt = (repo.worktrees ?? []).find((w) => w.path === cwd);
                      if (wt) return wt.branch ?? '(detached)';
                      // Fallback: cwd matches the repo's primary path.
                      if (cwd === repo.path) {
                        const primary = (repo.worktrees ?? []).find((w) => w.primary);
                        return primary?.branch ?? null;
                      }
                      return null;
                    };
                    return (
                      <RepoRow
                        repo={repo}
                        slots={props.slots}
                        live={props.liveRepos.has(repo.name)}
                        liveBranch={liveBranch()}
                        onOpen={props.onOpen}
                        onLaunch={props.onLaunch}
                        onForceStop={props.onForceStop}
                        onStop={props.onStop}
                        onRun={props.onRun}
                        onOpenInTerm={props.onOpenInTerm}
                      />
                    );
                  }}
                </For>
              </div>
              <CodeRunRows
                sessions={groupSessions()}
                repos={props.repos}
                xtermPrefs={props.xtermPrefs}
                onClose={props.onCloseSession}
              />
            </section>
          );
        }}
      </For>
    </div>
  );
}
