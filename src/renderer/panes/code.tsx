import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import './code-pane.css';
import type {
  DirtyDetails,
  DirtyFile,
  OpenWithSlotKey,
  OpenWithSlots,
  RepoEntry,
  TermSession,
  TerminalXtermPrefs,
  UnpushedCommit,
  Worktree,
} from '@shared/types';
import { CodeRunRows } from '../code-runs';
import { createDropdownMenu } from '../dropdown-menu';
import { ChevronDownIcon, FolderIcon, KillIcon, RunIcon, StopIcon, TerminalIcon } from '../icons';
import { createPositionedPopover } from '../popover';
import { usePaneScrollMemory } from './pane-scroll-memory';

type RepoStatus = 'missing' | 'unknown' | 'clean' | 'dirty';

const LAUNCHER_SLOTS: readonly OpenWithSlotKey[] = ['main_ide', 'secondary_ide', 'terminal'];
const LAUNCHER_GLYPH: Record<OpenWithSlotKey, string> = {
  main_ide: '⌘',
  secondary_ide: '⌥',
  terminal: '▶',
};

/** Flatten the configured repo list into one ordered card sequence, with each
 *  submodule parent immediately followed by its children. Top-level entries
 *  with no children pass through in declaration order. */
export function orderedRepos(repos: readonly RepoEntry[]): RepoEntry[] {
  const childrenByParent = new Map<string, RepoEntry[]>();
  for (const r of repos) {
    if (!r.parent) continue;
    const arr = childrenByParent.get(r.parent) ?? [];
    arr.push(r);
    childrenByParent.set(r.parent, arr);
  }
  const out: RepoEntry[] = [];
  for (const r of repos) {
    if (r.parent) continue;
    out.push(r);
    const kids = childrenByParent.get(r.name);
    if (kids) out.push(...kids);
  }
  return out;
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

  /** Card title — prefers `label` from `condash.json` when set, falls
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
        <Show when={props.repo.parent}>
          <span class="repo-kind-tag" title="Submodule, configured under repositories">
            submodule
          </span>
        </Show>
        <RepoCardMenu repo={props.repo} onForceStop={props.onForceStop} />
      </header>
      <ul class="branches">
        <For each={orderedWorktrees(props.repo)}>
          {(wt) => (
            <li class="branch-row" data-status={branchStatus(wt)}>
              <span class="branch-dot" aria-hidden="true" />
              <span
                class="branch-name"
                title={
                  wt.branch
                    ? wt.branch
                    : 'Detached HEAD — git is on a specific commit, not a branch'
                }
              >
                {wt.branch ?? '(no branch)'}
              </span>
              <BranchInfoBadges worktree={wt} subtreeScoped={!!props.repo.parent} />
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
 * header — always rendered for layout consistency, even when no entry
 * is currently actionable. Carries one entry today (Force-stop), which
 * is disabled when the repo has no `force_stop:` configured. Future
 * per-repo actions land in the same dropdown. Portaled (position:
 * fixed) so it always paints above neighbouring cards.
 */
function RepoCardMenu(props: { repo: RepoEntry; onForceStop: (repo: RepoEntry) => void }) {
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
  const menu = createDropdownMenu();

  const launcherEntries = (): OpenWithSlotKey[] =>
    LAUNCHER_SLOTS.filter((slot) => !!props.slots[slot]);

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
        </div>
      </Show>
    </div>
  );
}

/** Bar width (chars) for the +/- visual on each dirty row. Single-file
 *  diffs map line count → bar width 1:1 up to BAR_WIDTH; bigger diffs
 *  scale proportionally so a 200-line edit and a 2000-line edit both fill
 *  the bar but keep their `+`/`-` ratio readable. */
const BAR_WIDTH = 10;

function buildBar(added: number, deleted: number): string {
  const total = added + deleted;
  if (total === 0) return '';
  if (total <= BAR_WIDTH) {
    return '+'.repeat(added) + '-'.repeat(deleted);
  }
  let plus = Math.round((BAR_WIDTH * added) / total);
  // Don't render an empty bar for a non-zero `added` (or vice versa) just
  // because rounding pushed it to 0. The opposite side gives up one cell.
  if (added > 0 && plus === 0) plus = 1;
  if (deleted > 0 && plus === BAR_WIDTH) plus = BAR_WIDTH - 1;
  return '+'.repeat(plus) + '-'.repeat(BAR_WIDTH - plus);
}

function DirtyFileRow(props: { file: DirtyFile }) {
  const counts = (): string => {
    const f = props.file;
    if (f.binary) return '(bin)';
    if (f.added === null && f.deleted === null) return '(new)';
    const a = f.added ?? 0;
    const d = f.deleted ?? 0;
    if (a > 0 && d > 0) return `+${a} −${d}`;
    if (a > 0) return `+${a}`;
    if (d > 0) return `−${d}`;
    return '';
  };
  const bar = (): string => {
    const f = props.file;
    if (f.binary) return '';
    return buildBar(f.added ?? 0, f.deleted ?? 0);
  };
  return (
    <li class="branch-dirty-popover-row" data-status={props.file.code.trim() || 'mod'}>
      <span class="branch-dirty-popover-code">{props.file.code}</span>
      <span class="branch-dirty-popover-file" title={props.file.path}>
        {props.file.path}
      </span>
      <span class="branch-dirty-popover-counts">{counts()}</span>
      <span class="branch-dirty-popover-bar" aria-hidden="true">
        {bar()}
      </span>
    </li>
  );
}

/** One unpushed-commit row in the branch popover. SHA + subject, monospace. */
function UnpushedCommitRow(props: { commit: UnpushedCommit }) {
  return (
    <li class="branch-popover-commit-row">
      <span class="branch-popover-commit-sha">{props.commit.sha}</span>
      <span class="branch-popover-commit-subject" title={props.commit.subject}>
        {props.commit.subject}
      </span>
    </li>
  );
}

/**
 * Per-branch info badges + shared click-to-inspect popover. Renders up to
 * two badges side by side on a branch row:
 *
 *   - **Dirty badge** — shown when the worktree has uncommitted changes
 *     (`wt.dirty > 0`). Click opens the popover.
 *   - **Upstream badge** — shown when the branch has an upstream tracking
 *     ref (`wt.upstream != null`). Renders a count-bearing pill (`↑N`)
 *     when ahead of upstream, or a faint `↑` glyph when in sync. Only
 *     clickable when ahead > 0; the in-sync glyph is purely informational.
 *
 * Both badges share a single popover. The popover fetches a
 * `DirtyDetails` payload — which carries both the dirty-file list and the
 * unpushed-commit list — via one round-trip, then renders whichever
 * sections are non-empty. Clicking either badge anchors the popover to
 * that badge.
 *
 * The popover is a portaled `position: fixed` overlay so it always paints
 * above neighbouring cards (same recipe as the open_with menu).
 */
function BranchInfoBadges(props: { worktree: Worktree; subtreeScoped: boolean }) {
  const [details, setDetails] = createSignal<DirtyDetails | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  let dirtyRef: HTMLButtonElement | undefined;
  let upstreamRef: HTMLButtonElement | undefined;
  let popoverRef: HTMLDivElement | undefined;

  const hasDirty = (): boolean => (props.worktree.dirty ?? 0) > 0;
  const upstream = (): Worktree['upstream'] => props.worktree.upstream ?? null;
  const ahead = (): number => upstream()?.ahead ?? 0;
  const upstreamShown = (): boolean => upstream() != null;
  const upstreamClickable = (): boolean => ahead() > 0;

  const popover = createPositionedPopover({
    popoverRef: () => popoverRef,
    triggerRefs: () => [dirtyRef, upstreamRef],
    onClose: () => {
      popover.setOpen(false);
      setError(null);
    },
  });

  // Re-anchor on async content arrival: the dirty-details fetch grows
  // the popover after the first paint, and the flip-above check needs
  // the real height to make the right call.
  createEffect(() => {
    details();
    error();
    if (popover.open() && popoverRef) requestAnimationFrame(popover.reposition);
  });

  const toggle = async (which: 'dirty' | 'upstream', e: MouseEvent): Promise<void> => {
    e.stopPropagation();
    popover.setActiveTrigger(which === 'dirty' ? (dirtyRef ?? null) : (upstreamRef ?? null));
    if (popover.open()) {
      popover.setOpen(false);
      setError(null);
      return;
    }
    popover.reposition();
    popover.setOpen(true);
    setError(null);
    try {
      const next = await window.condash.getDirtyDetails(props.worktree.path, {
        scopeToSubtree: props.subtreeScoped,
      });
      // The popover may have been dismissed (or this card unmounted)
      // while getDirtyDetails was in flight — drop the late result so
      // setDetails / setError don't write into a disposed scope.
      if (!popover.open()) return;
      setDetails(next);
      if (!next) setError('git status failed for this path');
    } catch (err) {
      if (!popover.open()) return;
      setError((err as Error).message);
    }
  };

  return (
    <>
      <Show when={hasDirty()}>
        <button
          ref={(el) => (dirtyRef = el)}
          type="button"
          class="branch-dirty"
          onClick={(e) => void toggle('dirty', e)}
          aria-haspopup="dialog"
          aria-expanded={popover.open()}
          title="Show dirty files"
        >
          {props.worktree.dirty} dirty
        </button>
      </Show>
      <Show when={upstreamShown()}>
        <Show
          when={upstreamClickable()}
          fallback={
            <span
              class="branch-upstream insync"
              title={`In sync with ${upstream()?.upstreamRef ?? 'upstream'}`}
              aria-label={`In sync with ${upstream()?.upstreamRef ?? 'upstream'}`}
            >
              ↑
            </span>
          }
        >
          <button
            ref={(el) => (upstreamRef = el)}
            type="button"
            class="branch-upstream ahead"
            onClick={(e) => void toggle('upstream', e)}
            aria-haspopup="dialog"
            aria-expanded={popover.open()}
            title={`${ahead()} commit${ahead() === 1 ? '' : 's'} not pushed to ${upstream()?.upstreamRef ?? 'upstream'}`}
          >
            ↑{ahead()}
          </button>
        </Show>
      </Show>
      <Show when={popover.open() && popover.anchor()}>
        <div
          ref={(el) => {
            popoverRef = el;
            if (el) requestAnimationFrame(popover.reposition);
          }}
          class="branch-dirty-popover"
          role="dialog"
          aria-label={`Branch info for ${props.worktree.branch ?? '(no branch)'}`}
          style={{
            top: `${popover.anchor()!.top}px`,
            left: `${popover.anchor()!.left}px`,
          }}
        >
          <header class="branch-dirty-popover-head">
            <span class="branch-dirty-popover-branch">
              {props.worktree.branch ?? '(no branch)'}
            </span>
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
                <Show when={d().files.length > 0}>
                  <ul class="branch-dirty-popover-files">
                    <For each={d().files}>{(f) => <DirtyFileRow file={f} />}</For>
                    <Show when={d().truncated}>
                      <li class="branch-dirty-popover-truncated">
                        … +{d().totalCount - d().files.length} more
                      </li>
                    </Show>
                  </ul>
                  <Show when={d().totalAdded > 0 || d().totalDeleted > 0}>
                    <footer class="branch-dirty-popover-totals">
                      {`${d().totalCount} file${d().totalCount === 1 ? '' : 's'} changed`}
                      <Show when={d().totalAdded > 0}>
                        <span class="branch-dirty-popover-added">{`, +${d().totalAdded}`}</span>
                      </Show>
                      <Show when={d().totalDeleted > 0}>
                        <span class="branch-dirty-popover-deleted">{`, −${d().totalDeleted}`}</span>
                      </Show>
                    </footer>
                  </Show>
                </Show>
                <Show when={d().unpushedCommits.length > 0}>
                  <section class="branch-popover-section">
                    <h3 class="branch-popover-section-head">
                      Unpushed commits
                      <Show when={d().upstream}>
                        <span class="branch-popover-section-sub">
                          {' '}
                          → {d().upstream!.upstreamRef}
                        </span>
                      </Show>
                    </h3>
                    <ul class="branch-popover-commits">
                      <For each={d().unpushedCommits}>
                        {(c) => <UnpushedCommitRow commit={c} />}
                      </For>
                      <Show when={d().unpushedTruncated}>
                        <li class="branch-dirty-popover-truncated">
                          … +{(d().upstream?.ahead ?? 0) - d().unpushedCommits.length} more
                        </li>
                      </Show>
                    </ul>
                  </section>
                </Show>
                <Show when={d().files.length === 0 && d().unpushedCommits.length === 0}>
                  <p class="branch-dirty-popover-empty">
                    No dirty files{' '}
                    <Show when={d().upstream}>and in sync with {d().upstream!.upstreamRef}</Show>.
                  </p>
                </Show>
              </>
            )}
          </Show>
        </div>
      </Show>
    </>
  );
}

/** Top-level Code-pane view. Renders one flat grid of repo cards in a
 *  scrollable top region, with ACTIVE RUNS pinned at the bottom so the
 *  live-process list never scrolls out of view. */
export function CodeView(props: {
  repos: readonly RepoEntry[];
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
  // Pane scroll memory binds to the inner scroller so position survives
  // pane switches; the outer .repos-pane is no longer the scrolling box.
  const scrollRef = usePaneScrollMemory('code');
  const ordered = createMemo<readonly RepoEntry[]>(() => orderedRepos(props.repos));
  // Sort active runs to mirror the on-screen repo card order — sessions for
  // the topmost card come first, regardless of when they were spawned.
  // Memoised so a parent re-render doesn't re-allocate the array on every
  // pass and force every <CodeRunRow> to remount.
  const dockSessions = createMemo<readonly TermSession[]>(() => {
    const order = new Map(ordered().map((r, i) => [r.name, i]));
    return props.codeRunSessions.slice().sort((a, b) => {
      const ai = a.repo ? (order.get(a.repo) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      const bi = b.repo ? (order.get(b.repo) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });
  });
  return (
    <div class="repos-pane">
      <div class="repos-pane-scroll" ref={scrollRef}>
        <div class="repos-grid">
          <For each={ordered()}>
            {(repo) => {
              const liveBranch = (): string | null => {
                const cwd = props.liveSessionCwds.get(repo.name);
                if (!cwd) return null;
                const wt = (repo.worktrees ?? []).find((w) => w.path === cwd);
                if (wt) return wt.branch ?? '(no branch)';
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
      </div>
      <div class="code-runs-dock">
        <CodeRunRows
          sessions={dockSessions()}
          repos={props.repos}
          xtermPrefs={props.xtermPrefs}
          onClose={props.onCloseSession}
        />
      </div>
    </div>
  );
}
