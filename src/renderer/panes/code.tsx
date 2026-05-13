import { createMemo, createSignal, For, Show } from 'solid-js';
import './code-pane.css';
import type {
  OpenWithSlotKey,
  OpenWithSlots,
  RepoEntry,
  TermSession,
  TerminalXtermPrefs,
  Worktree,
} from '@shared/types';
import { CodeRunRows } from '../code-runs';
import { BranchFilter } from './code-parts/branch-filter';
import { collectFilterableBranches, groupRepos, orderedRepos } from './code-parts/data';
import { RepoRow } from './code-parts/repo-row';
import { usePaneScrollMemory } from './pane-scroll-memory';

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
  /** Branches pinned by the top-of-pane filter — non-primary rows render
   *  only when their branch is in this set. The primary worktree row is
   *  always rendered regardless. */
  selectedBranches: ReadonlySet<string>;
  /** Branches referenced by an active conception project (`status ∈
   *  {now, review}`). The filter dropdown badges these so the most
   *  meaningful picks stand out from ad-hoc local branches. */
  activeProjectBranches: ReadonlySet<string>;
  /** Toggle a single branch in the pinned set and persist. */
  onToggleBranch: (branch: string) => void;
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
  const grouped = createMemo(() => groupRepos(ordered()));
  // In-memory only — section collapse state is intentionally not persisted
  // (per the 2026-05-13 design call: keep the renderer simple, re-expand on
  // every reload).
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const toggleSection = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  // The filter dropdown lists every non-primary branch known across the
  // currently-visible cards. Recomputed when the repo list changes;
  // detached / no-branch worktrees are skipped (no name to pin).
  const filterable = createMemo<readonly string[]>(() => collectFilterableBranches(ordered()));
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
        <BranchFilter
          available={filterable()}
          selected={props.selectedBranches}
          activeProjectBranches={props.activeProjectBranches}
          onToggle={props.onToggleBranch}
        />
        <For each={grouped()}>
          {(group) => {
            const isCollapsed = (): boolean => collapsed().has(group.key);
            const renderCard = (repo: RepoEntry): ReturnType<typeof RepoRow> => {
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
                  selectedBranches={props.selectedBranches}
                  onOpen={props.onOpen}
                  onLaunch={props.onLaunch}
                  onForceStop={props.onForceStop}
                  onStop={props.onStop}
                  onRun={props.onRun}
                  onOpenInTerm={props.onOpenInTerm}
                />
              );
            };
            return (
              <Show
                when={group.section !== null}
                fallback={
                  <div class="repos-grid">
                    <For each={group.repos}>{renderCard}</For>
                  </div>
                }
              >
                <div class="repos-section">
                  <button
                    type="button"
                    class="repos-section-header"
                    aria-expanded={!isCollapsed()}
                    onClick={() => toggleSection(group.key)}
                  >
                    <span class="repos-section-chevron">{isCollapsed() ? '▸' : '▾'}</span>
                    <span class="repos-section-title">{group.section}</span>
                    <span class="repos-section-count">{group.repos.length}</span>
                  </button>
                  <Show when={!isCollapsed()}>
                    <div class="repos-grid">
                      <For each={group.repos}>{renderCard}</For>
                    </div>
                  </Show>
                </div>
              </Show>
            );
          }}
        </For>
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
