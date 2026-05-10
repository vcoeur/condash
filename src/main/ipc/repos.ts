import { ipcMain } from 'electron';
import { listRepos, listReposForPrimary } from '../repos';
import { invalidateAll } from '../git-status-cache';
import { recomputeAllWatchedRepos, setRepoWatchers, watchTargetsFromRepos } from '../repo-watchers';
import { getDirtyDetails } from '../git-details';
import { forceStopRepo, launchOpenWith, listOpenWith } from '../launchers';
import { requirePathUnderWorkspace } from '../path-bounds';
import { readSettings } from '../settings';
import type { OpenWithSlotKey } from '../../shared/types';
import { requireConception, withConception } from './utils';

/**
 * Wire repo / git-status / launcher IPC handlers. The two listRepos verbs
 * also drive watcher reconciliation: every renderer-driven repo refresh
 * re-syncs the per-repo FS watchers to the live repo set so config edits
 * that add or remove a repo are reflected without a full reload.
 */
export function registerReposIpc(): void {
  ipcMain.handle('listRepos', () =>
    withConception(async (conceptionPath) => {
      const repos = await listRepos(conceptionPath);
      // Sync the per-repo FS watchers to the live repo set: a config edit
      // that adds or removes a repo is reflected here, since this handler
      // re-runs on every renderer-driven repos refresh.
      await setRepoWatchers(watchTargetsFromRepos(repos));
      return repos;
    }, []),
  );

  // Per-primary partial reload — driven by the structural FS watcher when
  // `.git/HEAD` or `.git/worktrees/` changes. Returns the primary's
  // RepoEntry plus its submodule children, freshly re-read. Watchers are
  // re-synced for the affected paths so a freshly-added worktree gets a
  // scalar watcher pair right away (and a freshly-removed one is dropped).
  ipcMain.handle('listReposForPrimary', (_, primaryName: string) =>
    withConception(async (conceptionPath) => {
      const entries = await listReposForPrimary(conceptionPath, primaryName);
      // Re-list the *full* watcher set: the simplest correct way to make sure
      // an added or removed worktree under this primary is reflected in the
      // watch set without diffing the per-primary subset against the global
      // one. The cost is one extra `listRepos` call on a structural event,
      // which is rare (worktree mutation, branch checkout) — far cheaper
      // than getting the watch-set delta logic wrong.
      const repos = await listRepos(conceptionPath);
      await setRepoWatchers(watchTargetsFromRepos(repos));
      return entries;
    }, []),
  );

  // Drop the per-worktree git status cache + force-recompute every watched
  // repo and broadcast `repo-events`. Wired to the renderer's F5 / Refresh
  // path so the user sees fresh counts without waiting for an FS event,
  // and without the renderer needing to refetch the whole repo list (which
  // would tear down dropdowns/popovers).
  ipcMain.handle('invalidateGitStatus', async () => {
    invalidateAll();
    await recomputeAllWatchedRepos();
  });

  // Click-to-inspect on the per-branch dirty badge. Returns the parsed
  // `git status` line set + a `git diff --stat HEAD` snippet so the user
  // can see what's dirty without dropping into a shell. Bound to the
  // workspace + worktrees roots so a compromised renderer can't drive a
  // shell-out `git status` against an arbitrary directory on disk.
  ipcMain.handle(
    'getDirtyDetails',
    async (_, path: string, opts?: { scopeToSubtree?: boolean }) => {
      const realPath = await requirePathUnderWorkspace(path);
      return getDirtyDetails(realPath, opts ?? {});
    },
  );

  ipcMain.handle('listOpenWith', async () => {
    const { lastConceptionPath: conceptionPath } = await readSettings();
    if (!conceptionPath) return {};
    return listOpenWith(conceptionPath);
  });

  ipcMain.handle('launchOpenWith', (_, slot: OpenWithSlotKey, path: string) =>
    requireConception(async (conceptionPath) => {
      // Bound to workspace + worktrees + conception so the renderer can
      // launch the user's IDE on a project README, a workspace repo, or a
      // worktree — but not on `/etc/passwd` or `~/.ssh/`.
      const realPath = await requirePathUnderWorkspace(path);
      return launchOpenWith(conceptionPath, slot, realPath);
    }),
  );

  ipcMain.handle('forceStopRepo', (_, repoName: string) =>
    requireConception((conceptionPath) => forceStopRepo(conceptionPath, repoName)),
  );
}
