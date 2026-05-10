import { createMemo, For } from 'solid-js';
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
import { orderedRepos } from './code-parts/data';
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
