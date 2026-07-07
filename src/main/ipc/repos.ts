import { ipcMain } from 'electron';
import { listRepos, listReposForPrimary } from '../repos';
import { invalidateAll } from '../git-status-cache';
import { recomputeAllWatchedRepos, setRepoWatchers, watchTargetsFromRepos } from '../repo-watchers';
import { getDirtyDetails } from '../git-details';
import { forceStopRepo, launchOpenWith, listOpenWith } from '../launchers';
import { pullBranch } from '../pull-branch';
import { listOpenPullRequests, lookupPullRequest } from '../pr-lookup';
import { readConfig, repoLookupMap, resolveAppRepo } from '../worktree/shared';
import { requirePathUnderWorkspace } from '../path-bounds';
import { readSettings } from '../settings';
import type { OpenWithSlotKey } from '../../shared/types';
import {
  requireConception,
  requireMainWindowSender,
  requireNonEmptyString,
  withConception,
} from './utils';

/**
 * Wire repo / git-status / launcher IPC handlers. The two listRepos verbs
 * also drive watcher reconciliation: every renderer-driven repo refresh
 * re-syncs the per-repo FS watchers to the live repo set so config edits
 * that add or remove a repo are reflected without a full reload.
 */
export function registerReposIpc(): void {
  ipcMain.handle('listRepos', (event) => {
    requireMainWindowSender(event);
    return withConception(async (conceptionPath) => {
      const repos = await listRepos(conceptionPath);
      // Sync the per-repo FS watchers to the live repo set: a config edit
      // that adds or removes a repo is reflected here, since this handler
      // re-runs on every renderer-driven repos refresh.
      await setRepoWatchers(watchTargetsFromRepos(repos));
      return repos;
    }, []);
  });

  // Per-primary partial reload — driven by the structural FS watcher when
  // `.git/HEAD` or `.git/worktrees/` changes. Returns the primary's
  // RepoEntry plus its submodule children, freshly re-read. Watchers are
  // re-synced for the affected paths so a freshly-added worktree gets a
  // scalar watcher pair right away (and a freshly-removed one is dropped).
  ipcMain.handle('listReposForPrimary', (event, primaryName: string) => {
    requireMainWindowSender(event);
    return withConception(async (conceptionPath) => {
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
    }, []);
  });

  // Drop the per-worktree git status cache + force-recompute every watched
  // repo and broadcast `repo-events`. Wired to the renderer's F5 / Refresh
  // path so the user sees fresh counts without waiting for an FS event,
  // and without the renderer needing to refetch the whole repo list (which
  // would tear down dropdowns/popovers).
  ipcMain.handle('invalidateGitStatus', async (event) => {
    requireMainWindowSender(event);
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
    async (event, path: string, opts?: { scopeToSubtree?: boolean }) => {
      requireMainWindowSender(event);
      const realPath = await requirePathUnderWorkspace(path);
      return getDirtyDetails(realPath, opts ?? {});
    },
  );

  ipcMain.handle('listOpenWith', async (event) => {
    requireMainWindowSender(event);
    const { lastConceptionPath: conceptionPath } = await readSettings();
    if (!conceptionPath) return {};
    return listOpenWith(conceptionPath);
  });

  ipcMain.handle('launchOpenWith', (event, slot: OpenWithSlotKey, path: string) => {
    requireMainWindowSender(event);
    return requireConception(async (conceptionPath) => {
      // Bound to workspace + worktrees + conception so the renderer can
      // launch the user's IDE on a project README, a workspace repo, or a
      // worktree — but not on `/etc/passwd` or `~/.ssh/`.
      const realPath = await requirePathUnderWorkspace(path);
      return launchOpenWith(conceptionPath, slot, realPath);
    });
  });

  // Code-pane per-branch "Pull branch": fast-forward the worktree to its
  // upstream. Bounded to the workspace + worktrees roots so the renderer can
  // only drive a `git pull` inside a known checkout, never an arbitrary
  // directory on disk.
  ipcMain.handle('pullBranch', async (event, path: string) => {
    requireMainWindowSender(event);
    requireNonEmptyString('pullBranch', path);
    const realPath = await requirePathUnderWorkspace(path);
    return pullBranch(realPath);
  });

  // Code-pane per-branch "Open PR": resolve the open GitHub PR whose head is
  // this worktree's branch (via `gh pr list --head`). Bounded to the workspace
  // + worktrees roots so the renderer can only drive a `gh` lookup from inside
  // a known checkout, never an arbitrary directory. Returns null when there's
  // no open PR (or gh can't run) — the menu simply omits the row.
  ipcMain.handle('lookupPullRequest', async (event, path: string, branch: string) => {
    requireMainWindowSender(event);
    requireNonEmptyString('lookupPullRequest', path);
    requireNonEmptyString('lookupPullRequest', branch);
    const realPath = await requirePathUnderWorkspace(path);
    return lookupPullRequest(realPath, branch);
  });

  // Projects-pane card badges: list every open GitHub PR for the repo an
  // `apps:` token resolves to (`gh pr list --state open`, one call per repo).
  // The renderer passes an app handle / repo name — never a path — and this
  // resolves it to the configured repo's checkout via the same name/handle/
  // alias map the worktree resolver uses, so a compromised renderer can't
  // point `gh` at an arbitrary directory. Returns [] for an unknown app, no
  // conception, or a lookup that can't run — the pane simply shows no badges.
  ipcMain.handle('listOpenPullRequests', (event, app: string) => {
    requireMainWindowSender(event);
    requireNonEmptyString('listOpenPullRequests', app);
    return withConception(async (conceptionPath) => {
      const config = await readConfig(conceptionPath);
      const repo = resolveAppRepo(app, repoLookupMap(config));
      if (!repo) return [];
      return listOpenPullRequests(repo.cwd);
    }, []);
  });

  ipcMain.handle('forceStopRepo', (event, repoName: string) => {
    requireMainWindowSender(event);
    return requireConception((conceptionPath) => forceStopRepo(conceptionPath, repoName));
  });
}
