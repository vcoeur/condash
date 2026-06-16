import type { OpenWithSlotKey, RepoEntry, TermSession, Worktree } from '@shared/types';
import type { TerminalPaneHandle } from '../terminal-pane';

export interface UseRepoActionsDeps {
  allSessions: () => readonly TermSession[];
  getTerminalHandle: () => TerminalPaneHandle | null;
  setForceStopState: (next: RepoEntry | null) => void;
  flashToast: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

export interface UseRepoActions {
  handleLaunch: (slot: OpenWithSlotKey, path: string) => Promise<void>;
  /** Code-pane per-branch "Pull branch" — `git pull --ff-only` in the
   *  worktree, toasting updated / up-to-date / diverged / dirty. Drops the
   *  git-status cache after a real fast-forward so the card's badges refresh. */
  handlePull: (path: string) => Promise<void>;
  handleForceStop: (repo: RepoEntry) => void;
  runForceStop: (repo: RepoEntry) => Promise<void>;
  /** Per-card ⏹ — close the live code-side session for this repo, which
   *  routes through the full Stop pipeline (process-group SIGTERM,
   *  force_stop, SIGKILL fallback) in main/terminals.ts. No window.confirm:
   *  the button is only visible when the repo is live, and the icon reads
   *  as destructive. */
  handleStopRepo: (repo: RepoEntry) => void;
  handleRunRepo: (repo: RepoEntry, worktree?: Worktree) => Promise<void>;
}

export function useRepoActions(deps: UseRepoActionsDeps): UseRepoActions {
  const handleLaunch = async (slot: OpenWithSlotKey, path: string): Promise<void> => {
    try {
      await window.condash.launchOpenWith(slot, path);
    } catch (err) {
      deps.flashToast(`Launch failed: ${(err as Error).message}`, 'error');
    }
  };

  const handlePull = async (path: string): Promise<void> => {
    try {
      const result = await window.condash.pullBranch(path);
      const kind =
        result.status === 'updated' ? 'success' : result.status === 'up-to-date' ? 'info' : 'error';
      deps.flashToast(result.message, kind);
      // Only a real fast-forward moves HEAD / dirty / ahead — drop the git
      // status cache so the card's badges reflect the new tip right away.
      if (result.status === 'updated') await window.condash.invalidateGitStatus();
    } catch (err) {
      deps.flashToast(`Pull failed: ${(err as Error).message}`, 'error');
    }
  };

  const handleForceStop = (repo: RepoEntry): void => {
    deps.setForceStopState(repo);
  };

  const runForceStop = async (repo: RepoEntry): Promise<void> => {
    try {
      await window.condash.forceStopRepo(repo.name);
      deps.flashToast(`Force-stopped ${repo.name}`, 'success');
    } catch (err) {
      deps.flashToast(`Force-stop failed: ${(err as Error).message}`, 'error');
    }
  };

  const handleStopRepo = (repo: RepoEntry): void => {
    const live = deps
      .allSessions()
      .find((s) => s.side === 'code' && s.repo === repo.name && s.exited === undefined);
    if (!live) return;
    void window.condash.termClose(live.id);
  };

  const handleRunRepo = async (repo: RepoEntry, worktree?: Worktree): Promise<void> => {
    // The Code-pane Run button spawns a `side: 'code'` session that renders
    // in the inline CodeRunRow inside the Code pane — *not* in the bottom
    // terminal pane. So we no longer auto-open the pane on Run; the pane
    // stays mounted (but visually collapsed) so terminalHandle is still
    // available for spawn.
    const handle = deps.getTerminalHandle();
    if (!handle) return;
    const isPrimary = !worktree || worktree.primary;
    const label = isPrimary ? repo.name : `${repo.name} · ${worktree.branch ?? '(detached)'}`;
    try {
      await handle.spawn(
        {
          side: 'code',
          repo: repo.name,
          cwd: isPrimary ? undefined : worktree.path,
        },
        label,
      );
    } catch (err) {
      deps.flashToast(`Run failed: ${(err as Error).message}`, 'error');
    }
  };

  return { handleLaunch, handlePull, handleForceStop, runForceStop, handleStopRepo, handleRunRepo };
}
